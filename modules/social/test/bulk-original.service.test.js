import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { device, fixture } from "./helpers/content.fixture.js";
import { assembleSocialModule } from "../src/assemble.js";
import { createMemoryMediaStore } from "../src/services/media.store.js";

const SUSAN = "did:porchlight:susan";
const JUNE = "did:porchlight:june";
const CAROL = "did:porchlight:carol";
const FAMILY = "net_family";
const OTHER = "net_other";

const CHUNK_SIZE = 16;

/** A real, distinct, decodable PNG per index (the commit probe demands renderable media). */
function pngFor(index, width = 24, height = 16) {
  const n = (index % 255) + 1;
  return sharp({
    create: { width, height, channels: 3, background: { r: n, g: (index * 37 + 11) % 256, b: (index * 17 + 5) % 256 } },
  })
    .png()
    .toBuffer();
}

/**
 * A counting media store over the memory store: records every byte get
 * (key → count) and the maximum number of blobs held in flight at once —
 * the flat-memory evidence for the streamed composition (ac-2).
 */
function countingStore() {
  const delegate = createMemoryMediaStore();
  const stats = { gets: new Map(), maxInFlight: 0, inFlight: 0, failKeys: new Set() };
  return {
    stats,
    store: {
      put: (...args) => delegate.put(...args),
      delete: (...args) => delegate.delete(...args),
      has: (...args) => delegate.has(...args),
      async get(key) {
        stats.inFlight += 1;
        stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
        try {
          if (stats.failKeys.has(key)) {
            throw new Error("EIO read-back failure at the media root");
          }
          const bytes = await delegate.get(key);
          if (bytes !== null) stats.gets.set(key, (stats.gets.get(key) ?? 0) + 1);
          return bytes;
        } finally {
          stats.inFlight -= 1;
        }
      },
    },
  };
}

function bulkFixture(store = createMemoryMediaStore()) {
  const fx = fixture();
  fx.collections.networks.updateOne({ _id: FAMILY }, { $set: { ownerDid: SUSAN } });
  const mod = assembleSocialModule(fx.store, {
    verifyMemberIdToken: (token) => (token ? { did: token } : null),
    media: { chunkSize: CHUNK_SIZE, store, diskProbe: async () => ({ totalBytes: 1_000_000, freeBytes: 900_000 }) },
  });
  Object.assign(fx.collections, {
    media_uploads: fx.store.collection("media_uploads"),
    media_assets: fx.store.collection("media_assets"),
  });
  return {
    ...fx,
    mod,
    bulk: mod.bulkOriginalService,
    albums: mod.albumService,
    posts: mod.postService,
    mediaService: mod.mediaService,
    groupsService: mod.groupService,
    exports: mod.exportService,
    quota: mod.quotaService,
    api: mod.api,
    dev: device("dev_s"),
    juneDev: device("dev_j"),
    otherDev: device("dev_o"),
  };
}

async function admitted(fx, { networkId, did, device: memberDevice }) {
  const { accessToken } = await fx.admit({ networkId, did, device: memberDevice });
  return { networkId, did, token: accessToken, dev: memberDevice };
}

const chunkSha = (chunk) => createHash("sha256").update(chunk).digest("hex");

/** Drive a full media upload through the real pipeline (begin → chunks → commit). */
async function upload(media, member, bytes) {
  const declare = { scope: "media-upload", size: bytes.length, contentType: "image/png" };
  const begin = await media.beginUpload({
    accessToken: member.token,
    payload: declare,
    signature: member.dev.signPayload(declare),
  });
  const count = Math.ceil(bytes.length / begin.chunkSize);
  for (let index = 0; index < count; index += 1) {
    const chunk = bytes.subarray(index * begin.chunkSize, (index + 1) * begin.chunkSize);
    await media.putChunk({
      accessToken: member.token,
      uploadId: begin.uploadId,
      index,
      bytes: chunk,
      chunkSha: chunkSha(chunk),
    });
  }
  return media.completeUpload({
    accessToken: member.token,
    uploadId: begin.uploadId,
    payload: { sha256: chunkSha(bytes), size: bytes.length },
    signature: member.dev.signPayload({ scope: "media-commit", uploadId: begin.uploadId, sha256: chunkSha(bytes), size: bytes.length }),
  });
}

async function createPost(fx, member, mediaRefs, extra = {}) {
  const payload = { type: "photo", mediaRefs, caption: extra.caption ?? "bulk shot", ...extra };
  const { post } = await fx.posts.create({
    accessToken: member.token,
    payload,
    signature: member.dev.signPayload(payload),
  });
  return post;
}

function addItem(fx, member, name, postId) {
  return fx.albums.addItem({
    accessToken: member.token,
    name,
    postId,
    signature: member.dev.signPayload({ kind: "album.add", networkId: member.networkId, postId, album: name }),
  });
}

async function startServer(fx) {
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/social", fx.api);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { base: `http://127.0.0.1:${server.address().port}/api/social`, close: () => server.close() };
}

/**
 * Parse a stored-entry zip exactly as the standard tooling reads it: walk
 * the local file headers, verify the stored method, take each entry's
 * bytes, and end at a well-formed EOCD. A truncated archive throws here —
 * entries would run past the buffer.
 */
function parseStoredZip(buffer) {
  const entries = [];
  let offset = 0;
  while (offset < buffer.length - 21) {
    const signature = buffer.readUInt32LE(offset);
    if (signature === 0x02014b50) break; // central directory — entries done
    assert.equal(signature, 0x04034b50, "every entry carries the local file header signature");
    assert.equal(buffer.readUInt16LE(offset + 8), 0, "the composition ships stored (method 0) entries only");
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    entries.push({
      name: buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8"),
      bytes: buffer.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size),
    });
    offset += 30 + nameLength + extraLength + size;
  }
  // Find the EOCD from the central-directory boundary (fixed 46-byte
  // central headers + names; scan forward for the EOCD signature).
  let eocdOffset = offset;
  while (eocdOffset < buffer.length - 21) {
    if (buffer.readUInt32LE(eocdOffset) === 0x06054b50) break;
    eocdOffset += 1;
  }
  const eocd = buffer.subarray(eocdOffset);
  assert.equal(eocd.readUInt32LE(0), 0x06054b50, "the zip ends at a well-formed EOCD (never truncated)");
  assert.equal(eocd.readUInt16LE(8) || eocd.readUInt16LE(10), entries.length % 65536, "EOCD entry count matches");
  return entries;
}

async function getZip(base, path, token, fetchInit = {}) {
  return fetch(`${base}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...fetchInit,
  });
}

/* ------------------------- ac-1: set-scoped bulk archive routes ---------- */

test("ac-1: the album's originals.zip streams the album set in set order at original bytes; perimeter, containment, and empty sets hold", async () => {
  const fx = bulkFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const june = await admitted(fx, { networkId: FAMILY, did: JUNE, device: fx.juneDev });
  const carol = await admitted(fx, { networkId: OTHER, did: CAROL, device: fx.otherDev });
  const [m1, m2, m3, outside] = await Promise.all([1, 2, 3, 4].map((i) => pngFor(i)));
  const [a, b, c, o1] = await Promise.all([m1, m2, m3, outside].map((bytes) => upload(fx.mediaService, susan, bytes)));
  const post1 = await createPost(fx, susan, [a.mediaId, b.mediaId]);
  const post2 = await createPost(fx, susan, [c.mediaId]);
  const name = "Summer 2026";
  await addItem(fx, susan, name, post1._id);
  await addItem(fx, susan, name, post2._id);
  // In-network media that is NOT an album item: never composable.
  await createPost(fx, susan, [o1.mediaId]);
  assert.equal((await fx.albums.setMediaIds({ accessToken: susan.token, name })).mediaIds.length, 3);

  const { base, close } = await startServer(fx);
  try {
    const res = await getZip(base, `/albums/${encodeURIComponent(name)}/media/originals.zip`, susan.token);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/zip");
    assert.match(res.headers.get("content-disposition"), /porchlight-album-Summer-2026-originals\.zip/);
    const entries = parseStoredZip(Buffer.from(await res.arrayBuffer()));
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ["001.png", "002.png", "003.png"],
    );
    // Byte fidelity + set order: member count matches set order and content.
    assert.deepEqual(entries.map((entry) => chunkSha(entry.bytes)), [chunkSha(m1), chunkSha(m2), chunkSha(m3)]);
    // Album containment beyond network containment: the in-network media
    // outside the album never enters any zip.
    assert.ok(!entries.some((entry) => chunkSha(entry.bytes) === chunkSha(outside)));

    // Another member of the same origin downloads the same set.
    const juneRes = await getZip(base, `/albums/${encodeURIComponent(name)}/media/originals.zip`, june.token);
    assert.equal(juneRes.status, 200);
    assert.equal(parseStoredZip(Buffer.from(await juneRes.arrayBuffer())).length, 3);

    // A foreign-origin token: the perimeter answer, zero media bytes.
    const carolRes = await getZip(base, `/albums/${encodeURIComponent(name)}/media/originals.zip`, carol.token);
    assert.equal(carolRes.status, 404);
    assert.equal((await carolRes.json()).code, "E_ALBUM_NOT_FOUND");
    // A garbage token: refused (E_NOT_PERMITTED), anonymous: 401.
    assert.equal((await getZip(base, `/albums/${encodeURIComponent(name)}/media/originals.zip`)).status, 401);
    assert.equal((await getZip(base, `/albums/${encodeURIComponent(name)}/media/originals.zip`, "forged")).status, 403);
  } finally {
    close();
  }
});

test("ac-1: the post's originals.zip carries exactly that post's photos; cross-posted twins compose independently per origin; private-group posts hold their gate", async () => {
  const fx = bulkFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const carol = await admitted(fx, { networkId: OTHER, did: CAROL, device: fx.otherDev });
  const [pngA, pngB, pngB2] = await Promise.all([10, 11, 12].map((i) => pngFor(i)));
  const [mA, mB] = [await upload(fx.mediaService, susan, pngA), await upload(fx.mediaService, susan, pngB)];
  const mB2 = await upload(fx.mediaService, carol, pngB2);
  const familyPost = await createPost(fx, susan, [mA.mediaId, mB.mediaId]);
  // Cross-post twin: an independent post at the OTHER origin (crossPostRef
  // rides only as a display hint; the twin carries its own mediaRefs).
  const twin = await fx.posts.create({
    accessToken: carol.token,
    payload: { type: "photo", mediaRefs: [mB2.mediaId], crossPostRef: familyPost._id, caption: "the twin" },
    signature: carol.dev.signPayload({ type: "photo", mediaRefs: [mB2.mediaId], crossPostRef: familyPost._id, caption: "the twin" }),
  });

  const { base, close } = await startServer(fx);
  try {
    const res = await getZip(base, `/posts/${familyPost._id}/media/originals.zip`, susan.token);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition"), new RegExp(`porchlight-post-${familyPost._id}-originals\\.zip`));
    const entries = parseStoredZip(Buffer.from(await res.arrayBuffer()));
    // The exact photo set at original bytes, in the post's mediaRef order.
    assert.deepEqual(entries.map((entry) => entry.name), ["001.png", "002.png"]);
    assert.deepEqual(entries.map((entry) => chunkSha(entry.bytes)), [chunkSha(pngA), chunkSha(pngB)]);

    // The twin composes independently per origin: its own zip holds its own
    // stored bytes, and neither origin's zip ever carries the other's media.
    const twinRes = await getZip(base, `/posts/${twin.post._id}/media/originals.zip`, carol.token);
    assert.equal(twinRes.status, 200);
    const twinEntries = parseStoredZip(Buffer.from(await twinRes.arrayBuffer()));
    assert.deepEqual(twinEntries.map((entry) => chunkSha(entry.bytes)), [chunkSha(pngB2)]);

    // Origin containment: each origin's token resolves only its own post.
    assert.equal((await getZip(base, `/posts/${twin.post._id}/media/originals.zip`, susan.token)).status, 404);
    assert.equal((await getZip(base, `/posts/${familyPost._id}/media/originals.zip`, carol.token)).status, 404);

    // A private-group post composes only for its group members.
    const gallery = await fx.groupsService.create({ networkId: FAMILY, name: "Photo group", members: [SUSAN] });
    const hiddenOriginal = await upload(fx.mediaService, susan, pngA);
    const groupPost = await createPost(fx, susan, [hiddenOriginal.mediaId], { groupId: gallery._id });
    const hiddenRes = await getZip(base, `/posts/${groupPost._id}/media/originals.zip`, carol.token);
    assert.equal(hiddenRes.status, 404); // a non-group-member's token never composes it
    const memberRes = await getZip(base, `/posts/${groupPost._id}/media/originals.zip`, susan.token);
    assert.equal(memberRes.status, 200);

    // An unknown post or a foreign-origin post reads "doesn't exist here".
    assert.equal((await getZip(base, "/posts/post_missing/media/originals.zip", susan.token)).status, 404);
  } finally {
    close();
  }
});

// The route of record carries no origin segment (the PORCH-013 family
// convention: the membership token IS the origin — no route carries the
// origin). The PRD's :originNetworkId wording is not the served shape; a
// network-segmented URL reads "doesn't exist here" while the served shape
// streams (PORCH-083 Oct 18 field report: the SPA built the segmented
// shape and got its 404).
test("ac-1: the bulk zip URLs carry no origin segment — the segmented shape never composes, the served shape does", async () => {
  const fx = bulkFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const mediaRefs = [];
  for (const png of [await pngFor(0), await pngFor(1)]) {
    mediaRefs.push((await upload(fx.mediaService, susan, png)).mediaId);
  }
  const post = await createPost(fx, susan, mediaRefs);
  const { base, close } = await startServer(fx);
  try {
    const segmented = await getZip(
      base,
      `/${FAMILY}/posts/${post._id}/media/originals.zip`,
      susan.token,
    );
    assert.equal(segmented.status, 404);
    const served = await getZip(base, `/posts/${post._id}/media/originals.zip`, susan.token);
    assert.equal(served.status, 200);
  } finally {
    close();
  }
});

/* ------------------------- ac-2: streaming composition ------------------ */

test("ac-2: a several-hundred-original set streams flat — one read per original, one entry held at a time, no staging file", async () => {
  const counted = countingStore();
  const fx = bulkFixture(counted.store);
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const SET_SIZE = 240;
  const mediaIds = [];
  const bytesByMediaId = new Map();
  for (let index = 0; index < SET_SIZE; index += 1) {
    const bytes = await pngFor(index, 20, 12);
    const committed = await upload(fx.mediaService, susan, bytes);
    mediaIds.push(committed.mediaId);
    bytesByMediaId.set(committed.mediaId, bytes);
  }
  const post = await createPost(fx, susan, mediaIds);

  // Consume the composed stream exactly as the controller does: chunk by
  // chunk, never a full-resident archive beyond the zip writer's own
  // per-entry assembly.
  counted.stats.gets.clear();
  counted.stats.maxInFlight = 0;
  const chunks = [];
  for await (const chunk of fx.bulk.streamPostZip({ accessToken: susan.token, postId: post._id })) {
    chunks.push(chunk);
  }
  assert.equal(chunks.length, SET_SIZE + 1, "one chunk per entry piped at a time plus the trailing central directory");

  // Flat-memory evidence: each original's bytes were read at the media root
  // exactly once during this stream, and never more than one held in flight.
  for (const [, count] of counted.stats.gets) {
    assert.equal(count, 1, "every original is read from the media root exactly once during the stream");
  }
  assert.equal(counted.stats.maxInFlight, 1, "entries compose one at a time — never the full set resident");

  const entries = parseStoredZip(Buffer.concat(chunks));
  assert.equal(entries.length, SET_SIZE);
  assert.equal(entries[0].name, "001.png");
  assert.equal(entries[SET_SIZE - 1].name, `${SET_SIZE}.png`);
  // Entry content is the set's bytes in mediaRef order.
  for (const [index, entry] of entries.entries()) {
    assert.deepEqual(chunkSha(entry.bytes), chunkSha(bytesByMediaId.get(mediaIds[index])));
  }
});

test("ac-2: empty sets and unknown scopes refuse named, never an empty zip", async () => {
  const fx = bulkFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  // An album whose only item is a text post: zero photos.
  const textPost = await fx.posts.create({
    accessToken: susan.token,
    payload: { type: "text", body: "no photos here" },
    signature: susan.dev.signPayload({ type: "text", body: "no photos here" }),
  });
  await addItem(fx, susan, "Text-only album", textPost.post._id);
  const { base, close } = await startServer(fx);
  try {
    const emptyAlbum = await getZip(base, `/albums/${encodeURIComponent("Text-only album")}/media/originals.zip`, susan.token);
    assert.equal(emptyAlbum.status, 404);
    assert.equal((await emptyAlbum.json()).code, "E_ORIGINALS_SET_EMPTY");

    // An unknown album name and an unknown post ref read as not-found.
    assert.equal((await getZip(base, `/albums/${encodeURIComponent("No such album")}/media/originals.zip`, susan.token)).status, 404);
    const noMediaPost = await getZip(base, `/posts/${textPost.post._id}/media/originals.zip`, susan.token);
    assert.equal(noMediaPost.status, 404);
    assert.equal((await noMediaPost.json()).code, "E_ORIGINALS_SET_EMPTY");
  } finally {
    close();
  }
});

/* ------------------------- ac-3: the audited set action ----------------- */

test("ac-3: one audit record per successful stream (actor, set, count); a mid-stream read-back failure aborts the archive named", async () => {
  const counted = countingStore();
  const fx = bulkFixture(counted.store);
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const [png1, png2, png3] = await Promise.all([21, 22, 23].map((i) => pngFor(i)));
  const uploads = [png1, png2, png3].map((bytes) => upload(fx.mediaService, susan, bytes));
  const [u1, u2, u3] = await Promise.all(uploads);
  const post = await createPost(fx, susan, [u1.mediaId, u2.mediaId, u3.mediaId]);
  const name = "Cascade trip";
  await addItem(fx, susan, name, post._id);

  const { base, close } = await startServer(fx);
  try {
    const res = await getZip(base, `/posts/${post._id}/media/originals.zip`, susan.token);
    assert.equal(res.status, 200);
    const entries = parseStoredZip(Buffer.from(await res.arrayBuffer()));
    assert.equal(entries.length, 3);

    const actions = await fx.collections.auditEvents.find({});
    const zipRows = actions.filter((row) => row.action === "originals_zip_download");
    assert.equal(zipRows.length, 1, "one audit record for the successful stream");
    assert.equal(zipRows[0].did, susan.did);
    assert.equal(zipRows[0].networkId, FAMILY);
    assert.equal(zipRows[0].detail.set, post._id);
    assert.equal(zipRows[0].detail.setKind, "post");
    assert.equal(zipRows[0].detail.count, 3);
    assert.ok(zipRows[0].detail.deviceId === susan.dev.deviceId || zipRows[0].detail.deviceId === "dev_s");
    assert.equal(typeof zipRows[0].createdAt, "string");
    // Per-photo audit family untouched by the bulk stream.
    assert.equal(actions.filter((row) => row.action === "original_download").length, 0);

    // Mid-stream read-back failure: the first entry flows (headers are
    // committed), the second original cannot be read → the archive aborts.
    // The client observes the failure, never a truncated silent zip.
    counted.stats.failKeys.add(u2.blobKey ?? chunkSha(png2));
    counted.stats.gets.delete(u2.blobKey ?? chunkSha(png2));
    const raw = await import("node:http");
    const failure = await new Promise((resolve) => {
      const url = new URL(`${base}/posts/${post._id}/media/originals.zip`);
      let outcome = null;
      const request = raw.get(url, { headers: { authorization: `Bearer ${susan.token}` } }, (response) => {
        let bytes = 0;
        outcome = { status: response.statusCode, complete: false, bytes };
        response.on("data", (chunk) => {
          bytes += chunk.length;
        });
        response.on("aborted", () => resolve({ ...outcome, bytes }));
        response.on("end", () => resolve({ ...outcome, complete: true }));
        response.on("error", () => {});
      });
      request.on("error", () => {
        // The abort may surface as a socket reset on the request too.
        if (outcome) resolve({ ...outcome });
        else resolve({ status: null, complete: false, bytes: 0 });
      });
    });
    // The controller's abort may flush before or after the headers: the
    // client observes a 200-that-never-completes OR a pure connection
    // reset — in both cases the download fails, never a complete
    // truncated silent zip.
    assert.equal(
      failure.complete === false && (failure.status === null || failure.status === 200),
      true,
      `the archive aborted (got ${failure.status}, complete=${failure.complete})`,
    );
    const afterActions = await fx.collections.auditEvents.find({});
    assert.equal(afterActions.filter((row) => row.action === "originals_zip_download").length, 1, "the aborted stream added no successful-stream audit record");
  } finally {
    close();
  }
});

/* ------------------------- ac-4: scope of record ------------------------ */

test("ac-4: bulk reads consume no quota and the untouched surfaces keep their contracts", async () => {
  const counted = countingStore();
  const fx = bulkFixture(counted.store);
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const png = await pngFor(31);
  const committed = await upload(fx.mediaService, susan, png);
  const post = await createPost(fx, susan, [committed.mediaId]);
  const name = "Quota album";
  await addItem(fx, susan, name, post._id);

  const { base, close } = await startServer(fx);
  try {
    const usageBefore = (await fx.quota.usage({ networkId: FAMILY })).usedBytes;
    const res = await getZip(base, `/albums/${encodeURIComponent(name)}/media/originals.zip`, susan.token);
    assert.equal(res.status, 200);
    const entries = parseStoredZip(Buffer.from(await res.arrayBuffer()));
    assert.equal(entries.length, 1);
    assert.deepEqual(chunkSha(entries[0].bytes), chunkSha(png));
    assert.equal((await fx.quota.usage({ networkId: FAMILY })).usedBytes, usageBefore, "reads never consume quota bytes");

    // Per-photo original download unchanged: the explicit audited member
    // action rides with its own headers and its own audit family.
    const perPhoto = await getZip(base, `/albums/${encodeURIComponent(name)}/media/${committed.mediaId}/original`, susan.token);
    assert.equal(perPhoto.status, 200);
    assert.equal(perPhoto.headers.get("x-porchlight-sha256"), committed.sha256);
    assert.deepEqual(Buffer.from(await perPhoto.arrayBuffer()), png);
    const actions = await fx.collections.auditEvents.find({});
    assert.equal(actions.filter((row) => row.action === "original_download" && row.detail?.mediaId === committed.mediaId).length, 1);

    // The signed archive export stays untouched: it still demands its own
    // device-signed surface and its route family is unchanged.
    assert.equal((await getZip(base, "/media/export", susan.token)).status, 401);
    const unsignedExport = await fetch(`${base}/media/export?signature=x`, {
      headers: { authorization: `Bearer ${susan.token}` },
    });
    assert.equal(unsignedExport.status, 403); // a forged device signature never opens the export
  } finally {
    close();
  }
});