import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { device, fixture, canonicalJson } from "./helpers/content.fixture.js";
import { assembleSocialModule } from "../src/assemble.js";
import { renditionBytes, MESSAGES } from "../src/services/media.service.js";
import { sha256Hex } from "../src/services/media.store.js";

const SUSAN = "did:porchlight:susan";
const JUNE = "did:porchlight:june";
const FAMILY = "net_family";
const OTHER = "net_other";

const CHUNK_SIZE = 16;

/**
 * Media fixture: the assembled social module (real wiring: membership
 * perimeter + quota + media pipeline) on a memory store, with a small
 * chunk size and an injectable disk probe. Returns the module's services
 * plus admission helpers that return real membership tokens.
 */
function mediaFixture({ diskProbe = async () => ({ totalBytes: 1_000_000, freeBytes: 900_000 }) } = {}) {
  const fx = fixture();
  // Owner-root rule (PORCH-015): the hub-owner identity founded this
  // network, so Susan's admission resolves the owner role — the console
  // surfaces below need a genuine owner token.
  fx.collections.networks.updateOne({ _id: FAMILY }, { $set: { ownerDid: SUSAN } });
  const mod = assembleSocialModule(fx.store, {
    verifyMemberIdToken: (token) => (token ? { did: token } : null),
    media: { chunkSize: CHUNK_SIZE, diskProbe },
  });
  const dev = device("dev_s");
  const juneDev = device("dev_j");
  const otherDev = device("dev_o");
  return {
    ...fx,
    mod,
    media: mod.mediaService,
    blobs: mod.mediaService.blobs,
    collections: Object.assign(fx.collections, {
      media_uploads: fx.store.collection("media_uploads"),
      media_assets: fx.store.collection("media_assets"),
    }),
    dev,
    juneDev,
    otherDev,
  };
}

/** Admit a member and return everything the upload flows need. */
async function admitted(fx, { networkId, did, device: memberDevice }) {
  const { accessToken } = await fx.admit({ networkId, did, device: memberDevice });
  return { networkId, did, token: accessToken, dev: memberDevice };
}

const chunkSha = (chunk) => createHash("sha256").update(chunk).digest("hex");

/** Drive a full upload: begin (device-signed) → chunks → complete (device-signed). */
async function upload(media, member, bytes, { beginOverrides = {}, commitOverrides = {} } = {}) {
  const declare = { scope: "media-upload", size: bytes.length, contentType: "image/jpeg", ...beginOverrides.payload };
  const begin = await media.beginUpload({
    accessToken: member.token,
    payload: beginOverrides.payload ?? { scope: "media-upload", size: bytes.length, contentType: "image/jpeg" },
    signature: member.dev.signPayload(declare),
  });
  const chunkCount = Math.ceil(bytes.length / begin.chunkSize);
  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = bytes.subarray(index * begin.chunkSize, (index + 1) * begin.chunkSize);
    await media.putChunk({
      accessToken: member.token,
      uploadId: begin.uploadId,
      index,
      bytes: chunk,
      chunkSha: beginOverrides.chunkShaByIndex?.[index] ?? chunkSha(chunk),
    });
  }
  const commitPayload = {
    scope: "media-commit",
    uploadId: begin.uploadId,
    sha256: beginOverrides.commitSha ?? sha256Hex(bytes),
    size: beginOverrides.commitSize ?? bytes.length,
    ...commitOverrides.payload,
  };
  const committed = await media.completeUpload({
    accessToken: member.token,
    uploadId: begin.uploadId,
    payload: { sha256: commitPayload.sha256, size: commitPayload.size },
    signature: member.dev.signPayload(commitPayload),
  });
  return { ...committed, uploadId: begin.uploadId };
}

/* ---- ac-1: originals immutable, resumable upload ----------------------- */

test("ac-1: originals stored once, immutable, at full original quality", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const bytes = Buffer.from("JPEGORIGINALBYTES:the-full-quality-family-photo-record", "utf8");
  const committed = await upload(fx.media, susan, bytes);

  // Commit declaration echoes the original's full bytes and sha256 — the
  // browser uploaded raw chunks and never transcoded or pre-scaled.
  assert.equal(committed.bytes, bytes.length);
  assert.equal(committed.sha256, sha256Hex(bytes));
  assert.ok(committed.mediaId.startsWith("med_"));

  // The stored original is the exact uploaded bytes.
  const stored = await fx.collections.media_assets.findOne({ _id: committed.mediaId });
  assert.equal(stored.kind, "original");
  assert.equal(stored.immutable, true);
  assert.deepEqual(await fx.blobs.get(stored.blobKey), bytes);

  // Stored once, settled once: the committed upload cannot be re-committed.
  await assert.rejects(
    () =>
      fx.media.completeUpload({
        accessToken: susan.token,
        uploadId: committed.uploadId,
        payload: { sha256: committed.sha256, size: bytes.length },
        signature: susan.dev.signPayload({
          scope: "media-commit",
          uploadId: committed.uploadId,
          sha256: committed.sha256,
          size: bytes.length,
        }),
      }),
    (error) => error.code === "E_UPLOAD_CLOSED",
  );
});

test("ac-1: resumable chunked upload — status read, idempotent chunks, resume to commit", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const bytes = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef", "utf8");
  const begin = await fx.media.beginUpload({
    accessToken: susan.token,
    payload: { scope: "media-upload", size: bytes.length, contentType: "image/jpeg" },
    signature: susan.dev.signPayload({ scope: "media-upload", size: bytes.length, contentType: "image/jpeg" }),
  });
  const chunkCount = Math.ceil(bytes.length / begin.chunkSize);
  assert.equal(begin.chunkSize, CHUNK_SIZE);
  assert.equal(begin.chunkCount, chunkCount);
  const chunkOf = (index) => bytes.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);

  // Two chunks, then the connection drops.
  for (let index = 0; index < 2; index += 1) {
    await fx.media.putChunk({
      accessToken: susan.token,
      uploadId: begin.uploadId,
      index,
      bytes: chunkOf(index),
      chunkSha: chunkSha(chunkOf(index)),
    });
  }

  // The browser resumes, reads state, and re-PUTs the last partial chunk
  // idempotently — a repeat write replaces that blob, no corruption.
  const again = await fx.media.putChunk({
    accessToken: susan.token,
    uploadId: begin.uploadId,
    index: 1,
    bytes: chunkOf(1),
    chunkSha: chunkSha(chunkOf(1)),
  });
  assert.equal(again.received, 2);

  const status = await fx.media.uploadStatus({ accessToken: susan.token, uploadId: begin.uploadId });
  assert.deepEqual(status.receivedChunks, [0, 1]);
  assert.equal(status.state, "open");

  // Commit with chunks missing is refused — resume is the only path.
  await assert.rejects(
    () =>
      fx.media.completeUpload({
        accessToken: susan.token,
        uploadId: begin.uploadId,
        payload: { sha256: sha256Hex(bytes), size: bytes.length },
        signature: susan.dev.signPayload({
          scope: "media-commit",
          uploadId: begin.uploadId,
          sha256: sha256Hex(bytes),
          size: bytes.length,
        }),
      }),
    (error) => error.code === "E_UPLOAD_INCOMPLETE",
  );

  for (let index = 2; index < chunkCount; index += 1) {
    await fx.media.putChunk({
      accessToken: susan.token,
      uploadId: begin.uploadId,
      index,
      bytes: chunkOf(index),
      chunkSha: chunkSha(chunkOf(index)),
    });
  }
  const committed = await fx.media.completeUpload({
    accessToken: susan.token,
    uploadId: begin.uploadId,
    payload: { sha256: sha256Hex(bytes), size: bytes.length },
    signature: susan.dev.signPayload({
      scope: "media-commit",
      uploadId: begin.uploadId,
      sha256: sha256Hex(bytes),
      size: bytes.length,
    }),
  });
  assert.equal(committed.sha256, sha256Hex(bytes));
});

test("ac-1: server-side integrity — corrupt chunk, sha mismatch, size mismatch refused", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const bytes = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
  const begin = await fx.media.beginUpload({
    accessToken: susan.token,
    payload: { scope: "media-upload", size: bytes.length, contentType: "image/jpeg" },
    signature: susan.dev.signPayload({ scope: "media-upload", size: bytes.length, contentType: "image/jpeg" }),
  });

  // Corrupt transport chunk: declared hash disagrees with the received bytes.
  await assert.rejects(
    () =>
      fx.media.putChunk({
        accessToken: susan.token,
        uploadId: begin.uploadId,
        index: 0,
        bytes: bytes.subarray(0, CHUNK_SIZE),
        chunkSha: "0".repeat(64),
      }),
    (error) => error.code === "E_CHUNK_CORRUPT",
  );

  await fx.media.putChunk({
    accessToken: susan.token,
    uploadId: begin.uploadId,
    index: 0,
    bytes: bytes.subarray(0, CHUNK_SIZE),
    chunkSha: chunkSha(bytes.subarray(0, CHUNK_SIZE)),
  });
  await fx.media.putChunk({
    accessToken: susan.token,
    uploadId: begin.uploadId,
    index: 1,
    bytes: bytes.subarray(CHUNK_SIZE),
    chunkSha: chunkSha(bytes.subarray(CHUNK_SIZE)),
  });

  const commitFor = (sha, size) =>
    fx.media.completeUpload({
      accessToken: susan.token,
      uploadId: begin.uploadId,
      payload: { sha256: sha, size },
      signature: susan.dev.signPayload({ scope: "media-commit", uploadId: begin.uploadId, sha256: sha, size }),
    });
  await assert.rejects(() => commitFor("a".repeat(64), bytes.length), (error) => error.code === "E_COMMIT_SHA_MISMATCH");
  await assert.rejects(
    () => commitFor(sha256Hex(bytes), bytes.length + 1),
    (error) => error.code === "E_COMMIT_SIZE_MISMATCH",
  );
});

test("ac-1: scheduled garbage collection aborts idle incomplete uploads, frees chunk blobs", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const bytes = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
  const begin = await fx.media.beginUpload({
    accessToken: susan.token,
    payload: { scope: "media-upload", size: bytes.length, contentType: "image/jpeg" },
    signature: susan.dev.signPayload({ scope: "media-upload", size: bytes.length, contentType: "image/jpeg" }),
  });
  await fx.media.putChunk({
    accessToken: susan.token,
    uploadId: begin.uploadId,
    index: 0,
    bytes: bytes.subarray(0, CHUNK_SIZE),
    chunkSha: chunkSha(bytes.subarray(0, CHUNK_SIZE)),
  });

  const at = new Date();
  // Inside the TTL the upload survives.
  assert.deepEqual(
    await fx.media.gcIncompleteUploads({ now: () => at }),
    { abortedUploads: 0, chunkBlobsDeleted: 0, at: at.toISOString() },
  );
  // Past the TTL the upload aborts and its chunk blobs are collected.
  const later = new Date(at.getTime() + 25 * 60 * 60 * 1000);
  const result = await fx.media.gcIncompleteUploads({ now: () => later });
  assert.equal(result.abortedUploads, 1);
  assert.equal(result.chunkBlobsDeleted, 1);
  assert.equal(await fx.blobs.get(`${begin.uploadId}/0`), null);
  const record = await fx.collections.media_uploads.findOne({ _id: begin.uploadId });
  assert.equal(record.state, "aborted");
  // Idempotent: a second pass collects nothing.
  assert.equal((await fx.media.gcIncompleteUploads({ now: () => later })).abortedUploads, 0);
});

/* ---- ac-2: hub-generated renditions ------------------------------------ */

test("ac-2: the hub generates the rendition set on the server, idempotently, inside the budget", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const bytes = Buffer.concat([Buffer.from("JPEG.".repeat(512), "utf8"), Buffer.from("X".repeat(1024), "utf8")]);
  const committed = await upload(fx.media, susan, bytes);

  // Feed thumb, detail, album — all generated at ingest, all on the hub
  // (the upload API accepted no scaled-down device bytes).
  assert.deepEqual(
    [...committed.renditions].sort(),
    ["album", "detail", "feed-thumb"],
  );
  const renditions = await fx.collections.media_assets.find({ networkId: FAMILY, originalId: committed.mediaId, kind: "rendition" });
  assert.deepEqual(
    renditions.map((row) => row.renditionKind).sort(),
    ["album", "detail", "feed-thumb"],
  );

  // Idempotent per media item: another pass generates nothing new.
  assert.deepEqual(await fx.media.generateRenditions(committed.mediaId), []);

  // The set's overhead lands inside the ≤2–4x budget.
  const overhead = renditions.reduce((total, row) => total + row.bytes, 0);
  assert.ok(overhead <= committed.bytes * 4, `renditions ${overhead} exceed 4x of ${committed.bytes}`);
  assert.ok(overhead <= committed.bytes * 2, `renditions ${overhead} exceed the tuned 2x target of ${committed.bytes}`);

  // Renditions count against the same quota ceiling (artifact ledger).
  const rows = await fx.collections.artifacts.find({ networkId: FAMILY });
  assert.equal(rows.filter((row) => row.kind === "rendition").length, 3);
  assert.ok(rows.reduce((total, row) => total + row.bytes, 0) > committed.bytes);
});

test("ac-2: renditions are deterministic hub-side derivatives of the original", () => {
  const bytes = Buffer.from("DETERMINISTIC-ORIGINAL-CONTENT".repeat(64), "utf8");
  const thumb = renditionBytes(bytes, "feed-thumb", 0.15);
  assert.deepEqual(thumb, renditionBytes(bytes, "feed-thumb", 0.15));
  const linebreak = thumb.indexOf("\n");
  const header = JSON.parse(thumb.subarray(0, linebreak).toString("utf8"));
  assert.equal(header.format, "porchlight-rendition/1");
  assert.equal(header.renditionKind, "feed-thumb");
  assert.equal(header.sourceSha256, sha256Hex(bytes));
});

/* ---- ac-3: rendition-default serving, explicit originals, export ------- */

test("ac-3: serving defaults to renditions; original retrieval is the explicit audited action", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const june = await admitted(fx, { networkId: FAMILY, did: JUNE, device: fx.juneDev });
  const bytes = Buffer.from("THE FULL QUALITY ARCHIVAL RECORD", "utf8");
  const committed = await upload(fx.media, susan, bytes);

  // Default serve path: the rendition, by kind.
  const thumb = await fx.media.serveRendition({ accessToken: june.token, mediaId: committed.mediaId, renditionKind: "feed-thumb" });
  assert.equal(thumb.renditionKind, "feed-thumb");
  const originalAsset = await fx.collections.media_assets.findOne({ _id: committed.mediaId });
  assert.notEqual(thumb.sha256, originalAsset.sha256);

  // Explicit original retrieval is a separate surface — and audited.
  const original = await fx.media.serveOriginal({ accessToken: june.token, mediaId: committed.mediaId });
  assert.equal(original.sha256, originalAsset.sha256);
  assert.deepEqual(original.bytes, bytes);
  const actions = await fx.audit.events.find({ networkId: FAMILY });
  assert.equal(actions.filter((row) => row.action === "original_download").length, 1);

  // Origin containment: the same DID on another network sees nothing.
  const otherSusan = await admitted(fx, { networkId: OTHER, did: SUSAN, device: fx.otherDev });
  await assert.rejects(
    () => fx.media.serveOriginal({ accessToken: otherSusan.token, mediaId: committed.mediaId }),
    (error) => error.code === "E_MEDIA_NOT_FOUND",
  );
  await assert.rejects(
    () => fx.media.serveRendition({ accessToken: undefined, mediaId: committed.mediaId, renditionKind: "feed-thumb" }),
    (error) => error.code === "E_MUST_SIGN_IN",
  );
});

test("ac-3: signed archive export streams the authored history with per-item signatures", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const bytes = Buffer.from("family-photo-archival-record", "utf8");
  const committed = await upload(fx.media, susan, bytes);
  const payload = { type: "photo", mediaRefs: [committed.mediaId], caption: "the pier" };
  await fx.mod.postService.create({ accessToken: susan.token, payload, signature: susan.dev.signPayload(payload) });

  const chunks = [];
  for await (const chunk of fx.mod.exportService.streamMemberExport({
    accessToken: susan.token,
    signature: susan.dev.signPayload({ scope: "export", networkId: FAMILY }),
  })) {
    chunks.push(chunk);
  }
  const archive = Buffer.concat(chunks);

  // ZIP structure: stored local entries, EOCD trailer.
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);

  const manifest = JSON.parse(parseZipEntry(archive, "manifest.json").toString("utf8"));
  assert.equal(manifest.format, "porchlight-export/1");
  assert.equal(manifest.exportedBy, SUSAN);
  assert.equal(manifest.networkId, FAMILY);
  assert.ok(manifest.requestSignature.length > 0);

  // Per-item signatures: the post item carries the authoring device signature.
  const storedPost = (await fx.collections.posts.find({ originNetworkId: FAMILY })).find((row) => row.mediaRefs?.includes(committed.mediaId));
  const postItem = manifest.items.find((item) => item.kind === "post");
  assert.equal(postItem.signature, storedPost.deviceSignature);
  assert.equal(postItem.sha256, sha256Hex(Buffer.from(canonicalJson(storedPost), "utf8")));
  const mediaOriginal = manifest.items.find((item) => item.kind === "media-original");
  assert.equal(mediaOriginal.sha256, sha256Hex(bytes));

  // The manifest checksum is present; the post archive entry carries the post.
  assert.equal(manifest.manifestChecksum.length, 64);
  assert.deepEqual(JSON.parse(parseZipEntry(archive, `posts/${storedPost._id}.json`).toString("utf8")).mediaRefs, [committed.mediaId]);
  assert.deepEqual(parseZipEntry(archive, `media/${committed.mediaId}`), bytes);
});

test("ac-3: export is signature-gated and origin-contained", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });

  // Unsigned export request is refused.
  await assert.rejects(
    () => fx.mod.exportService.streamMemberExport({ accessToken: susan.token, signature: null }).next(),
    (error) => error.code === "E_SIGNATURE_REQUIRED",
  );
  // A garbage membership token resolves nothing.
  const stranger = device("dev_x");
  await assert.rejects(
    async () => {
      for await (const chunk of fx.mod.exportService.streamMemberExport({
        accessToken: "not-a-token",
        signature: stranger.signPayload({ scope: "export", networkId: FAMILY }),
      })) {
        void chunk;
      }
    },
    (error) => error.code === "E_NOT_PERMITTED",
  );
});

/* ---- ac-4: quota admission, disk guard, retention sweep ----------------- */

test("ac-4: quota admission rejects over-ceiling uploads with clear client messaging", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  // Owner sets a 1 MiB ceiling; a 2 MiB declared upload is refused plainly.
  await fx.collections.networks.updateOne(
    { _id: FAMILY },
    { $set: { quota: { storageCeilingMb: 1, retentionDays: null } } },
  );
  const huge = { scope: "media-upload", size: 2 * 1024 * 1024, contentType: "image/jpeg" };
  await assert.rejects(
    () => fx.media.beginUpload({ accessToken: susan.token, payload: huge, signature: susan.dev.signPayload(huge) }),
    (error) => {
      assert.equal(error.code, "E_STORAGE_QUOTA_EXCEEDED");
      assert.equal(
        error.message,
        "This network is full: the owner has set a storage limit and it has been reached. Free up space or ask the owner to raise the limit.",
      );
      return true;
    },
  );
  // Nothing was admitted: no ledger rows, no upload sessions.
  assert.equal((await fx.collections.artifacts.find({ networkId: FAMILY })).length, 0);
});

test("ac-4: renditions and derived artifacts count against the same ceiling", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  await fx.collections.networks.updateOne(
    { _id: FAMILY },
    { $set: { quota: { storageCeilingMb: 1, retentionDays: null } } },
  );
  const bytes = Buffer.from("filler".repeat(1024), "utf8"); // 6 KB original
  const committed = await upload(fx.media, susan, bytes);
  // Ledger rows: original + 3 renditions; used bytes exceed the original's.
  const rows = await fx.collections.artifacts.find({ networkId: FAMILY });
  assert.equal(rows.length, 4);
  const used = rows.reduce((total, row) => total + row.bytes, 0);
  assert.ok(used > committed.bytes, "renditions must count against the quota");
  const usage = await fx.mod.quotaService.usage({ networkId: FAMILY });
  assert.equal(usage.usedBytes, used);
});

test("ac-4: disk guard — soft threshold warns, hard stop halts new uploads, reads continue", async () => {
  let freeBytes = 200_000; // 80% used — under both thresholds
  const fx = mediaFixture({ diskProbe: async () => ({ totalBytes: 1_000_000, freeBytes }) });
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });

  // Below soft: clean status, no warning.
  let status = await fx.media.diskStatus();
  assert.equal(status.usedRatio, 0.8);
  assert.equal(status.warning, false);
  assert.equal(status.uploadsHalted, false);

  const bytes = Buffer.from("read-continues-at-every-threshold", "utf8");
  const committed = await upload(fx.media, susan, bytes);

  // Soft band (90%–95% used): the owner console sees the warning; the
  // same pass still admits new uploads.
  freeBytes = 80_000; // 92% used
  status = await fx.media.diskStatus();
  assert.equal(status.warning, true);
  assert.equal(status.uploadsHalted, false);
  const softBand = await fx.media.beginUpload({
    accessToken: susan.token,
    payload: { scope: "media-upload", size: 8, contentType: "image/jpeg" },
    signature: susan.dev.signPayload({ scope: "media-upload", size: 8, contentType: "image/jpeg" }),
  });
  assert.ok(softBand.uploadId.startsWith("upl_"));

  // Hard stop (95%+ used): NEW uploads are rejected plain-language; the
  // committed media above STAYS readable at both thresholds.
  freeBytes = 40_000; // 96% used
  const hard = { scope: "media-upload", size: 8, contentType: "image/jpeg" };
  await assert.rejects(
    () => fx.media.beginUpload({ accessToken: susan.token, payload: hard, signature: susan.dev.signPayload(hard) }),
    (error) => {
      assert.equal(error.code, "E_DISK_HARD_STOP");
      assert.equal(error.message, MESSAGES.E_DISK_HARD_STOP);
      return true;
    },
  );
  status = await fx.media.diskStatus();
  assert.equal(status.uploadsHalted, true);
  const detail = await fx.media.serveRendition({ accessToken: susan.token, mediaId: committed.mediaId, renditionKind: "detail" });
  assert.equal(detail.renditionKind, "detail");
  const original = await fx.media.serveOriginal({ accessToken: susan.token, mediaId: committed.mediaId });
  assert.deepEqual(original.bytes, bytes);
});

test("ac-4: retention sweep — expired artifacts cascade media rows and blob bytes", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  // Owner set: 1-day retention window.
  await fx.collections.networks.updateOne(
    { _id: FAMILY },
    { $set: { quota: { storageCeilingMb: 1, retentionDays: 1 } } },
  );
  const bytes = Buffer.from("retention-cascade-record", "utf8");
  const committed = await upload(fx.media, susan, bytes);
  const assets = await fx.collections.media_assets.find({ networkId: FAMILY });
  assert.equal(assets.length, 4); // original + 3 renditions

  // Past the window: ledger rows, media rows (original + rendition
  // cascade), and blob bytes all leave in the same pass.
  const later = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const result = await fx.media.sweep({ networkId: FAMILY, now: () => later });
  assert.ok(result.swept >= 4, `expected the original and its renditions swept, got ${result.swept}`);
  assert.ok(result.assetRowsRemoved >= 1);
  const originalAsset = assets.find((row) => row._id === committed.mediaId);
  assert.equal(await fx.blobs.get(originalAsset.blobKey), null);
  assert.equal((await fx.collections.media_assets.find({ networkId: FAMILY })).length, 0);
  const usage = await fx.mod.quotaService.usage({ networkId: FAMILY });
  assert.ok(usage.usedBytes < committed.bytes * 5);
});

/* ---- HTTP transport: the browser-facing API surface --------------------- */

test("ac-1/ac-3: the media API surface serves the full browser flow end to end", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/social", fx.mod.api);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/social`;

  try {
    const bytes = Buffer.from("BROWSER-UPLOAD-RESUMABLE-BYTES-FULL-QUALITY", "utf8");
    // POST /media/uploads — device-signed begin.
    const declare = { scope: "media-upload", size: bytes.length, contentType: "image/jpeg" };
    const beginResponse = await fetch(`${base}/media/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${susan.token}` },
      body: JSON.stringify({ payload: declare, signature: susan.dev.signPayload(declare) }),
    });
    assert.equal(beginResponse.status, 200);
    const begin = await beginResponse.json();

    // PUT chunks — raw bytes + per-chunk sha256 header.
    for (let index = 0; index < begin.chunkCount; index += 1) {
      const chunk = bytes.subarray(index * begin.chunkSize, (index + 1) * begin.chunkSize);
      const response = await fetch(`${base}/media/uploads/${begin.uploadId}/chunks/${index}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${susan.token}`, "x-chunk-sha256": chunkSha(chunk) },
        body: chunk,
      });
      assert.equal(response.status, 200);
    }

    // POST complete — device-signed commit.
    const commit = { scope: "media-commit", uploadId: begin.uploadId, sha256: sha256Hex(bytes), size: bytes.length };
    const completeResponse = await fetch(`${base}/media/uploads/${begin.uploadId}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${susan.token}` },
      body: JSON.stringify({ payload: { sha256: commit.sha256, size: commit.size }, signature: susan.dev.signPayload(commit) }),
    });
    assert.equal(completeResponse.status, 200);
    const committed = await completeResponse.json();
    assert.equal(committed.sha256, sha256Hex(bytes));

    // GET rendition — the default serve path returns rendition bytes.
    const renditionResponse = await fetch(`${base}/media/${committed.mediaId}/renditions/album`, {
      headers: { authorization: `Bearer ${susan.token}` },
    });
    assert.equal(renditionResponse.status, 200);
    assert.ok((await renditionResponse.arrayBuffer()).byteLength > 0);

    // GET original — the explicit archive action returns exact bytes.
    const originalResponse = await fetch(`${base}/media/${committed.mediaId}/original`, {
      headers: { authorization: `Bearer ${susan.token}` },
    });
    assert.equal(originalResponse.status, 200);
    assert.equal(originalResponse.headers.get("x-porchlight-sha256"), sha256Hex(bytes));
    assert.deepEqual(Buffer.from(await originalResponse.arrayBuffer()), bytes);

    // Disk-guard status rides the console surface — owner-only now
    // (PORCH-015): the founding owner's token passes, members' do not.
    const diskResponse = await fetch(`${base}/console/disk`, {
      headers: { authorization: `Bearer ${susan.token}` },
    });
    assert.equal(diskResponse.status, 200);
    const disk = await diskResponse.json();
    assert.equal(disk.available, true);
    assert.equal(disk.softThreshold.toFixed(2), "0.90");
    assert.equal(disk.hardThreshold.toFixed(2), "0.95");
  } finally {
    server.close();
  }
});

/* ---- helpers ------------------------------------------------------------- */

/** Parse one stored ZIP entry out of the streamed archive bytes. */
function parseZipEntry(archive, path) {
  let offset = 0;
  while (offset + 30 <= archive.length) {
    if (archive.readUInt32LE(offset) !== 0x04034b50) break;
    const nameLength = archive.readUInt16LE(offset + 26);
    const size = archive.readUInt32LE(offset + 18);
    const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const data = archive.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size);
    if (name === path) return data;
    offset += 30 + nameLength + size;
  }
  throw new Error(`zip entry not found: ${path}`);
}