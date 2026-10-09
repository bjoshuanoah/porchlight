import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { device, fixture } from "./helpers/content.fixture.js";
import { assembleSocialModule } from "../src/assemble.js";
import { sha256Hex } from "../src/services/media.store.js";

const SUSAN = "did:porchlight:susan";
const JUNE = "did:porchlight:june";
const CAROL = "did:porchlight:carol";
const FAMILY = "net_family";
const OTHER = "net_other";

const CHUNK_SIZE = 16;

/**
 * Album fixture: the assembled social module (real wiring: membership
 * perimeter + posts + media pipeline + albums) on a memory store, with a
 * small chunk size and a stub disk probe. Members are admitted with real
 * device keys so album writes carry genuine Ed25519 signatures.
 */
function albumFixture() {
  const fx = fixture();
  fx.collections.networks.updateOne({ _id: FAMILY }, { $set: { ownerDid: SUSAN } });
  const mod = assembleSocialModule(fx.store, {
    verifyMemberIdToken: (token) => (token ? { did: token } : null),
    media: { chunkSize: CHUNK_SIZE, diskProbe: async () => ({ totalBytes: 1_000_000, freeBytes: 900_000 }) },
  });
  return {
    ...fx,
    mod,
    collections: Object.assign(fx.collections, {
      media_uploads: fx.store.collection("media_uploads"),
      media_assets: fx.store.collection("media_assets"),
    }),
    albums: mod.albumService,
    feed: mod.feedService,
    posts: mod.postService,
    mediaService: mod.mediaService,
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
  const declare = { scope: "media-upload", size: bytes.length, contentType: "image/jpeg" };
  const begin = await media.beginUpload({
    accessToken: member.token,
    payload: declare,
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
      chunkSha: chunkSha(chunk),
    });
  }
  const commitPayload = { scope: "media-commit", uploadId: begin.uploadId, sha256: sha256Hex(bytes), size: bytes.length };
  return media.completeUpload({
    accessToken: member.token,
    uploadId: begin.uploadId,
    payload: { sha256: commitPayload.sha256, size: commitPayload.size },
    signature: member.dev.signPayload(commitPayload),
  });
}

/* ------------------------- ac-1: memberships + cascade ------------------- */

test("ac-1: album memberships write as derived-artifact-class records keyed to originals", async () => {
  const fx = albumFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const created = await fx.posts.create({
    accessToken: susan.token,
    payload: { type: "photo", mediaRefs: ["med_orig_a"], caption: "Lakeside morning" },
    signature: susan.dev.signPayload({ type: "photo", mediaRefs: ["med_orig_a"], caption: "Lakeside morning" }),
  });

  const added = await fx.albums.addItem({
    accessToken: susan.token,
    name: " Summer 2026 ",
    postId: created.post._id,
    signature: susan.dev.signPayload({
      kind: "album.add",
      networkId: FAMILY,
      postId: created.post._id,
      album: "Summer 2026",
    }),
  });

  // The membership row is a derived-artifact-class record keyed to the
  // original post id (deletion-cascade bound), album name stored verbatim.
  const row = await fx.collections.derivedData.findOne({ _id: added.membershipId });
  assert.equal(row.class, "album_membership");
  assert.equal(row.postId, created.post._id); // keyed to the original
  assert.equal(row.networkId, FAMILY); // exactly one origin
  assert.equal(row.value, "Summer 2026");
  assert.equal(typeof row.createdAt, "string");
  assert.equal(added.created, true);

  // Idempotent re-add: no duplicate membership rows ever appear.
  const again = await fx.albums.addItem({
    accessToken: susan.token,
    name: "Summer 2026",
    postId: created.post._id,
    signature: susan.dev.signPayload({
      kind: "album.add",
      networkId: FAMILY,
      postId: created.post._id,
      album: "Summer 2026",
    }),
  });
  assert.equal(again.created, false);
  assert.equal((await fx.collections.derivedData.find({ postId: created.post._id, class: "album_membership" })).length, 1);

  // Un-signed and wrong-network writes never resolve.
  await assert.rejects(
    () => fx.albums.addItem({ accessToken: susan.token, name: "Summer 2026", postId: created.post._id }),
    (error) => error.code === "E_SIGNATURE_REQUIRED",
  );
  await assert.rejects(
    () =>
      fx.albums.addItem({
        accessToken: susan.token,
        name: "Summer 2026",
        postId: "post_missing",
        signature: susan.dev.signPayload({ kind: "album.add", networkId: FAMILY, postId: "post_missing", album: "Summer 2026" }),
      }),
    (error) => error.code === "E_POST_NOT_FOUND",
  );
  await assert.rejects(
    () => fx.albums.addItem({ accessToken: susan.token, name: "  ", postId: created.post._id, signature: susan.dev.signPayload({}) }),
    (error) => error.code === "E_ALBUM_NAME_REQUIRED",
  );
});

test("ac-1: a member's deletion cascade removes their album memberships, never other members' albums", async () => {
  const fx = albumFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const june = await admitted(fx, { networkId: FAMILY, did: JUNE, device: fx.juneDev });
  const susanPost = await fx.posts.create({
    accessToken: susan.token,
    payload: { type: "photo", mediaRefs: ["med_orig_a"], caption: "Susan's photo" },
    signature: susan.dev.signPayload({ type: "photo", mediaRefs: ["med_orig_a"], caption: "Susan's photo" }),
  });
  const junePost = await fx.posts.create({
    accessToken: june.token,
    payload: { type: "photo", mediaRefs: ["med_orig_b"], caption: "June's photo" },
    signature: june.dev.signPayload({ type: "photo", mediaRefs: ["med_orig_b"], caption: "June's photo" }),
  });
  const add = (member, post) =>
    fx.albums.addItem({
      accessToken: member.token,
      name: "Summer 2026",
      postId: post.post._id,
      signature: member.dev.signPayload({
        kind: "album.add",
        networkId: FAMILY,
        postId: post.post._id,
        album: "Summer 2026",
      }),
    });
  const susanRow = await add(susan, susanPost);
  const juneRow = await add(june, junePost);

  // Susan deletes her post: the cascade removes HER album membership in the
  // same transactional write — but June's membership on the shared album
  // name is untouched, so June's album survives.
  await fx.posts.deletePost({ accessToken: susan.token, postId: susanPost.post._id, signature: susan.dev.signPayload({ kind: "delete", postId: susanPost.post._id, networkId: FAMILY }) });
  assert.equal(await fx.collections.derivedData.findOne({ _id: susanRow.membershipId }), null);
  const juneSurviving = await fx.collections.derivedData.findOne({ _id: juneRow.membershipId });
  assert.ok(juneSurviving, "another member's album membership must survive the cascade");
  assert.equal(juneSurviving.value, "Summer 2026");

  const listing = await fx.albums.list({ accessToken: june.token });
  assert.deepEqual(listing.albums.map((entry) => entry.name), ["Summer 2026"]);
  assert.equal(listing.albums[0].itemCount, 1);

  // Member content sweep: June sweeps ALL her content — her remaining album
  // membership dies with it; the album then has no rows left at this origin.
  await fx.posts.memberContentSweep({ accessToken: june.token, signature: june.dev.signPayload({ kind: "delete", scope: "member", networkId: FAMILY }) });
  assert.equal(await fx.collections.derivedData.findOne({ _id: juneRow.membershipId }), null);
  const emptied = await fx.albums.list({ accessToken: june.token });
  assert.deepEqual(emptied.albums, []);
});

test("ac-1: whole-album delete cascades only its own membership rows, transactionally", async () => {
  const fx = albumFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const post = await fx.posts.create({
    accessToken: susan.token,
    payload: { type: "photo", mediaRefs: ["med_orig_a"], caption: "Original stays" },
    signature: susan.dev.signPayload({ type: "photo", mediaRefs: ["med_orig_a"], caption: "Original stays" }),
  });
  const peopleTag = {
    _id: "dd_tag_1",
    networkId: FAMILY,
    postId: post.post._id,
    class: "tag",
    value: "Aunt June",
    createdAt: new Date().toISOString(),
  };
  await fx.collections.derivedData.insertOne(peopleTag);
  const album = "Beach Days";
  await fx.albums.addItem({
    accessToken: susan.token,
    name: album,
    postId: post.post._id,
    signature: susan.dev.signPayload({ kind: "album.add", networkId: FAMILY, postId: post.post._id, album }),
  });

  await assert.rejects(
    () => fx.albums.deleteAlbum({ accessToken: susan.token, name: album }),
    (error) => error.code === "E_SIGNATURE_REQUIRED",
  );
  const deleted = await fx.albums.deleteAlbum({
    accessToken: susan.token,
    name: album,
    signature: susan.dev.signPayload({ kind: "album.delete", networkId: FAMILY, album }),
  });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.itemsRemoved, 1);

  // The original post and its OTHER derived rows (the people tag) and the
  // media refs are untouched: memberships are derived artifacts only.
  const survivingPost = await fx.posts.get({ accessToken: susan.token, postId: post.post._id });
  assert.equal(survivingPost.post._id, post.post._id);
  assert.equal((await fx.collections.derivedData.findOne({ _id: peopleTag._id }))?.value, "Aunt June");
  assert.equal(await fx.collections.derivedData.findOne({ value: album, class: "album_membership" }), null);
  await assert.rejects(
    () => fx.albums.deleteAlbum({
      accessToken: susan.token,
      name: album,
      signature: susan.dev.signPayload({ kind: "album.delete", networkId: FAMILY, album }),
    }),
    (error) => error.code === "E_ALBUM_NOT_FOUND",
  );
});

/* ------------------------- ac-2: plain-text search ----------------------- */

test("ac-2: plain-text search resolves album names, captions, and manual people tags with origin containment", async () => {
  const fx = albumFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const carol = await admitted(fx, { networkId: OTHER, did: CAROL, device: fx.otherDev });
  const beachPost = await fx.posts.create({
    accessToken: susan.token,
    payload: { type: "photo", mediaRefs: ["med_beach"], caption: "Beach picnic at sunset" },
    signature: susan.dev.signPayload({ type: "photo", mediaRefs: ["med_beach"], caption: "Beach picnic at sunset" }),
  });
  const lakePost = await fx.posts.create({
    accessToken: susan.token,
    payload: { type: "photo", mediaRefs: ["med_lake"], caption: "Lakeside morning" },
    signature: susan.dev.signPayload({ type: "photo", mediaRefs: ["med_lake"], caption: "Lakeside morning" }),
  });
  // Album membership rows come from the albums surface (PORCH-013).
  await fx.albums.addItem({
    accessToken: susan.token,
    name: "Summer 2026 Album",
    postId: lakePost.post._id,
    signature: susan.dev.signPayload({ kind: "album.add", networkId: FAMILY, postId: lakePost.post._id, album: "Summer 2026 Album" }),
  });
  // Manual people tags are the same derived-artifact class, member-authored
  // value; the tag write surface is not part of this task, so the row is
  // placed exactly as the derived-data container defines it.
  await fx.collections.derivedData.insertOne({
    _id: "dd_tag_2",
    networkId: FAMILY,
    postId: beachPost.post._id,
    class: "tag",
    value: "Aunt June",
    createdAt: new Date().toISOString(),
  });

  const search = (token, query) => fx.feed.search({ accessToken: token, query });
  // Album name resolves its keyed post.
  assert.deepEqual((await search(susan.token, "Summer 2026")).posts.map((p) => p._id), [lakePost.post._id]);
  // Caption text resolves its post.
  assert.deepEqual((await search(susan.token, "beach picnic")).posts.map((p) => p._id), [beachPost.post._id]);
  // Manual people tag resolves its keyed post.
  assert.deepEqual((await search(susan.token, "aunt")).posts.map((p) => p._id), [beachPost.post._id]);

  // Origin containment: a foreign-origin member token never sees the
  // family's captions, album names, or tags.
  const foreignCaption = await search(carol.token, "beach");
  assert.deepEqual(foreignCaption.posts, []);
  const foreignAlbum = await search(carol.token, "Summer 2026");
  assert.deepEqual(foreignAlbum.posts, []);
  const foreignTag = await search(carol.token, "Aunt June");
  assert.deepEqual(foreignTag.posts, []);

  // No ranking model intervenes: search ordering is the base timeline's
  // reverse-chron-by-latest-activity order (the published formula touches
  // only the ranked surface, which search never reads).
  const timeline = await fx.posts.list({ accessToken: susan.token });
  assert.deepEqual((await search(susan.token, "e")).posts.map((p) => p._id), timeline.posts.map((p) => p._id));
});

/* ------------------------- ac-3: album serving + quota ------------------- */

test("ac-3: albums serve renditions by default; original retrieval is the explicit audited member action under shared quota accounting", async () => {
  const fx = albumFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const carol = await admitted(fx, { networkId: OTHER, did: CAROL, device: fx.otherDev });
  const original = Buffer.from("JPEGORIGINALBYTES:the-full-quality-family-album-photo-archive", "utf8");
  const committed = await upload(fx.mediaService, susan, original);

  const post = await fx.posts.create({
    accessToken: susan.token,
    payload: { type: "photo", mediaRefs: [committed.mediaId], caption: "Album shot" },
    signature: susan.dev.signPayload({ type: "photo", mediaRefs: [committed.mediaId], caption: "Album shot" }),
  });
  const album = "Lake Album";
  await fx.albums.addItem({
    accessToken: susan.token,
    name: album,
    postId: post.post._id,
    signature: susan.dev.signPayload({ kind: "album.add", networkId: FAMILY, postId: post.post._id, album }),
  });

  // Quota accounting BEFORE the album writes: originals + renditions only.
  // Rendition ledger rows are keyed by their rendition asset id.
  const renditionAssets = await fx.collections.media_assets.find({ networkId: FAMILY, kind: "rendition", originalId: committed.mediaId });
  const renditionIds = new Set(renditionAssets.map((row) => row._id));
  const usageBefore = (await fx.quota.usage({ networkId: FAMILY })).usedBytes;
  const ledgerBefore = await fx.collections.artifacts.find({ networkId: FAMILY });
  assert.equal(
    usageBefore,
    committed.bytes +
      ledgerBefore.filter((row) => row.kind === "rendition" && renditionIds.has(row.sourceId)).reduce((n, row) => n + row.bytes, 0),
    "renditions must be ledgered against the same ceiling as the original",
  );

  const listing = await fx.albums.listMedia({ accessToken: susan.token, name: album });
  assert.equal(listing.media.length, 1);
  const entry = listing.media[0];
  assert.equal(entry.mediaId, committed.mediaId);
  // The default serve target is the hub-generated "album" rendition; the
  // original is never the default.
  assert.equal(entry.defaultRendition, "album");
  assert.ok(entry.renditionKinds.includes("album"));

  // Zero-byte derived records: album membership writes move NO bytes
  // against the ceiling — renditions and originals already carry it.
  const usageAfterMembership = (await fx.quota.usage({ networkId: FAMILY })).usedBytes;
  assert.equal(usageAfterMembership, usageBefore);

  // Route level: the album-serving path serves the rendition bytes by
  // default (with the pipeline's integrity header), origin-contained.
  const { default: express } = await import("express");
  const app = express();
  app.use("/api/social", fx.api);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/social`;
  try {
    const expectedAlbumBytes = await fx.mediaService.serveRendition({ accessToken: susan.token, mediaId: committed.mediaId, renditionKind: "album" });
    const renditionRes = await fetch(`${base}/albums/${encodeURIComponent(album)}/media/${committed.mediaId}/renditions/album`, {
      headers: { authorization: `Bearer ${susan.token}` },
    });
    assert.equal(renditionRes.status, 200);
    assert.equal(renditionRes.headers.get("x-porchlight-sha256"), expectedAlbumBytes.sha256);
    assert.deepEqual(Buffer.from(await renditionRes.arrayBuffer()), expectedAlbumBytes.bytes);

    // Album containment: media that is not an album item does not exist on
    // the album surface, even within the same origin network.
    const otherMedia = await upload(fx.mediaService, susan, Buffer.from("UNRELATED-ORIGINAL-BYTES-not-in-the-album", "utf8"));
    const outsideRes = await fetch(`${base}/albums/${encodeURIComponent(album)}/media/${otherMedia.mediaId}/renditions/album`, {
      headers: { authorization: `Bearer ${susan.token}` },
    });
    assert.equal(outsideRes.status, 404);
    assert.equal((await outsideRes.json()).code, "E_MEDIA_NOT_FOUND");

    // Original-quality retrieval is the EXPLICIT member action: a separate
    // route, audited, never the default listing.
    const originalRes = await fetch(`${base}/albums/${encodeURIComponent(album)}/media/${committed.mediaId}/original`, {
      headers: { authorization: `Bearer ${susan.token}` },
    });
    assert.equal(originalRes.status, 200);
    assert.equal(originalRes.headers.get("x-porchlight-sha256"), committed.sha256);
    assert.deepEqual(Buffer.from(await originalRes.arrayBuffer()), original);
    const actions = await fx.collections.auditEvents.find({});
    assert.equal(actions.filter((row) => row.action === "original_download").length, 1);

    // Origin containment on serving: a foreign-origin member gets 404/403,
    // never the bytes of another network's album media.
    const foreignRes = await fetch(`${base}/albums/${encodeURIComponent(album)}/media/${committed.mediaId}/renditions/album`, {
      headers: { authorization: `Bearer ${carol.token}` },
    });
    assert.equal(foreignRes.status, 404);
    const foreignOriginal = await fetch(`${base}/albums/${encodeURIComponent(album)}/media/${committed.mediaId}/original`, {
      headers: { authorization: `Bearer ${carol.token}` },
    });
    assert.notEqual(foreignOriginal.status, 200);

    // Unsigned album-list reads stay inside the perimeter.
    const anonymous = await fetch(`${base}/albums`, {});
    assert.equal(anonymous.status, 401); // E_MUST_SIGN_IN, perimeter-first
  } finally {
    server.close();
  }
});