// PORCH-143 — Mixed photo/video posts: ordered mediaRefs end to end.
// Pins the mixed build contract (Brian, Nov 25, 2026; PRD
// 6b073a52549901c58e055cc8 / TS 6b073a52549901c58e055cc7): one Post
// document per mixed draft with the ordered mediaRefs list (position =
// array order), per-reference kind riding the ingest stamps, type=mixed as
// a READ projection only, per-reference admission through the existing
// pipeline, and ordered kind+geometry+durationMs on the served payloads and
// event envelopes — never bytes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { device, fixture } from "./helpers/content.fixture.js";
import { assembleSocialModule } from "../src/assemble.js";
import { sha256Hex } from "../src/services/media.store.js";
import { sampleImageBytes, sampleVideoBytes } from "./media.service.test.js";

const SUSAN = "did:porchlight:susan";
const FAMILY = "net_family";

/**
 * Media fixture: the assembled social module (real wiring: perimeter +
 * quota + media pipeline + realtime plane) on a memory store, large chunk
 * size so small fixtures commit in one chunk. Returns the module's
 * services plus an upload helper.
 */
async function mixedFixture({ networkId = FAMILY } = {}) {
  const fx = fixture();
  fx.collections.networks.updateOne({ _id: networkId }, { $set: { ownerDid: SUSAN } });
  const mod = assembleSocialModule(fx.store, {
    verifyMemberIdToken: (token) => (token ? { did: token } : null),
    media: { chunkSize: 1024 * 1024 },
    realtime: { plane: fx.realtimePlane },
  });
  const dev = device("dev_m");
  const { accessToken } = await fx.admit({ networkId, did: SUSAN, device: dev });
  return { ...fx, mod, dev, token: accessToken, media: mod.mediaService };
}

/** Drive a full upload (begin → chunk → complete); returns the committed id. */
async function upload(media, token, dev, bytes, contentType, overrides = {}) {
  const declare = {
    scope: "media-upload",
    size: bytes.length,
    contentType,
    ...(overrides.declare ?? {}),
  };
  const begin = await media.beginUpload({ accessToken: token, payload: declare, signature: dev.signPayload(declare) });
  const count = Math.ceil(bytes.length / begin.chunkSize);
  for (let index = 0; index < count; index += 1) {
    const chunk = bytes.subarray(index * begin.chunkSize, (index + 1) * begin.chunkSize);
    await media.putChunk({ accessToken: token, uploadId: begin.uploadId, index, bytes: chunk, chunkSha: sha256Hex(chunk) });
  }
  const committed = await media.completeUpload({
    accessToken: token,
    uploadId: begin.uploadId,
    payload: { sha256: overrides.commitSha ?? sha256Hex(bytes), size: bytes.length },
    signature: dev.signPayload({
      scope: "media-commit",
      uploadId: begin.uploadId,
      sha256: overrides.commitSha ?? sha256Hex(bytes),
      size: bytes.length,
    }),
  });
  return committed.mediaId;
}

/** The signed create write as the composer sends it. */
async function createPost(fx, payload) {
  return fx.mod.postService.create({ accessToken: fx.token, payload, signature: fx.dev.signPayload(payload) });
}

/** No media bytes ever ride a payload: no binary values anywhere in the view. */
function assertNoBytesOnPayload(value, path = "payload") {
  if (value instanceof Buffer || value instanceof Uint8Array) {
    assert.fail(`media bytes reached ${path}`);
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) assertNoBytesOnPayload(v, `${path}.${k}`);
  }
}

/* ---- ac-1: mixed-create e2e --------------------------------------------- */

test("PORCH-143 ac-1: one photo, one video, and text create one Post — ordered refs, per-reference kind, geometry, durationMs; no bytes on any payload", async () => {
  const fx = await mixedFixture();
  const photo = await upload(fx.media, fx.token, fx.dev, await sampleImageBytes({ seed: 3 }), "image/jpeg");
  const video = await upload(fx.media, fx.token, fx.dev, await sampleVideoBytes({ seconds: 1 }), "video/mp4");

  // Attachment order is exactly what was staged: photo first, video second.
  const payload = { type: "photo", mediaRefs: [photo, video], caption: "the lake day" };
  const { post } = await createPost(fx, payload);

  const stored = await fx.collections.posts.findOne({ _id: post._id });
  // The document carries no media bytes, no geometry, and no kind — the
  // ordered id list only; the kind is the read projection of the stamps.
  assert.deepEqual(stored.mediaRefs, [photo, video]);
  assert.equal(stored.type, "photo"); // stored type unchanged; mixed is a projection

  // The served detail payload carries the projected type and, per
  // reference, kind + geometry stamps + durationMs — in attachment order.
  const detail = (await fx.mod.feedService.timeline({ accessToken: fx.token })).posts
    .find((view) => view._id === post._id);
  assert.equal(detail.type, "mixed");
  const meta = detail.mediaMeta;
  assert.equal(meta[video].kind, "video");
  assert.ok(meta[video].durationMs > 0, "the video stamp carries durationMs");
  assert.ok(meta[video].aspect > 0 && Number.isFinite(meta[video].aspect), "the video stamp carries the computed aspect");
  assert.equal(meta[photo].kind, "photo");
  assert.equal(meta[photo].durationMs, null, "a photo stamp carries no duration");
  assert.deepEqual(meta[photo].renditions.map((r) => r.kind).sort(), ["album", "detail", "feed-thumb"], "the photo ladder rides the ref");
  assert.deepEqual(meta[video].renditions.map((r) => r.kind).sort(), ["playable"], "the playable rendition rides the video ref; the poster rides poster");
  assert.ok(meta[video].poster, "the poster frame rides the video ref");
  // Bytes never ride the payload (network sweep over the whole view).
  assertNoBytesOnPayload(detail);

  // The post.created envelope carries the same ordered per-reference shape
  // (content only, never bytes) — PORCH-081 client parity.
  const events = (await fx.realtimePlane.readSince(FAMILY, null)).events;
  const created = events.find((event) => event.type === "post.created" && event.postId === post._id);
  assert.ok(created, "post.created emitted");
  assert.equal(created.content.type, "mixed");
  assert.equal(created.content.mediaMeta[video].kind, "video");
  assert.equal(created.content.mediaMeta[video].durationMs, meta[video].durationMs);
  assert.equal(created.content.mediaRefs[0], photo);
  assert.equal(created.content.mediaRefs[1], video);
  assertNoBytesOnPayload(created.content);

  // The post.updated envelope (a silent caption edit) carries the same
  // ordered mixed shape — every event consumer sees the one list model.
  const editPayload = { kind: "post-edit", postId: post._id, networkId: FAMILY, caption: "the lake day, two" };
  await fx.mod.postService.editPost({ accessToken: fx.token, postId: post._id, payload: { caption: "the lake day, two" }, signature: fx.dev.signPayload(editPayload) });
  const eventsNow = (await fx.realtimePlane.readSince(FAMILY, null)).events;
  const updated = eventsNow.find((event) => event.type === "post.updated" && event.postId === post._id);
  assert.ok(updated, "post.updated emitted");
  assert.equal(updated.content.type, "mixed");
  assert.equal(updated.content.mediaMeta[video].kind, "video");
  assert.ok(updated.content.mediaMeta[video].durationMs > 0);
  assertNoBytesOnPayload(updated.content);
});

/* ---- ac-2: atomicity ----------------------------------------------------- */

test("PORCH-143 ac-2: a create attempted with an unverified/failed upload refs nothing", async () => {
  const fx = await mixedFixture();
  const photo = await upload(fx.media, fx.token, fx.dev, await sampleImageBytes({ seed: 5 }), "image/jpeg");

  // A reference whose upload never committed: the create refuses whole —
  // no document, and no half-state any read surface could serve.
  const payload = { type: "photo", mediaRefs: [photo, "med_never_committed"], caption: "half staged" };
  await assert.rejects(
    () => createPost(fx, payload),
    (error) => {
      assert.equal(error.code, "E_MEDIA_UNCOMMITTED");
      assert.equal(
        error.message,
        "Nothing was created: one of the attached files never finished uploading. Re-attach the missing file and try again.",
      );
      return true;
    },
  );
  assert.equal((await fx.collections.posts.find({ networkId: FAMILY })).filter((row) => row.caption === "half staged").length, 0);
  const events = (await fx.realtimePlane.readSince(FAMILY, null)).events;
  assert.equal(events.filter((event) => event.type === "post.created").length, 0, "no post.created for a refused create");

  // A foreign-origin reference (committed on another network in the same
  // assembly) refuses with the same class — the write is origin-contained
  // per reference.
  const otherDev = device("dev_o");
  const { accessToken: otherToken } = await fx.admit({ networkId: "net_other", did: SUSAN, device: otherDev });
  const foreign = await upload(fx.media, otherToken, otherDev, await sampleImageBytes({ seed: 9 }), "image/jpeg");
  await assert.rejects(
    () => createPost(fx, { type: "photo", mediaRefs: [photo, foreign], caption: "foreign ref" }),
    (error) => error.code === "E_MEDIA_UNCOMMITTED",
  );
  // The committed origin ref still works alone: the mixed path rides the
  // ordinary photo/video path.
  const { post } = await createPost(fx, { type: "photo", mediaRefs: [photo], caption: "single ref ok" });
  assert.ok(post._id.startsWith("post_"));
});

/* ---- ac-3: quota classes on the mixed path -------------------------------- */

test("PORCH-143 ac-3: a mixed item over the owner storage ceiling is refused at that item's upload admission; no per-post attachment ceiling exists to invent", async () => {
  const fx = await mixedFixture();
  // Owner sets a 1 MiB storage ceiling (the live quantity-only limit —
  // confirmed-then-written: no per-item byte cap and no per-post
  // attachment ceiling exist in ingest; recorded on the task trail with
  // source. The refusal class a mixed draft meets is the storage ceiling,
  // exactly as a photos-only draft does).
  await fx.collections.networks.updateOne(
    { _id: FAMILY },
    { $set: { quota: { storageCeilingMb: 1, retentionDays: null } } },
  );
  const huge = { scope: "media-upload", size: 2 * 1024 * 1024, contentType: "image/jpeg" };
  await assert.rejects(
    () => fx.media.beginUpload({ accessToken: fx.token, payload: huge, signature: fx.dev.signPayload(huge) }),
    (error) => error.code === "E_STORAGE_QUOTA_EXCEEDED",
  );
  // The over-ceiling item's admission wrote nothing: the draft stages the
  // items that admit, and the refused item refs nothing (ac-2's class).
  const photo = await upload(fx.media, fx.token, fx.dev, await sampleImageBytes({ seed: 23 }), "image/jpeg");
  const video = await upload(fx.media, fx.token, fx.dev, await sampleVideoBytes({ seconds: 1 }), "video/mp4");
  // Mixed commit at attachment count: no per-post ceiling refuses a mixed
  // draft — the same classes (storage quota, disk guard) count the bytes,
  // never the item count.
  const { post } = await createPost(fx, { type: "photo", mediaRefs: [photo, video], caption: "under the byte ceiling" });
  assert.equal((await fx.collections.posts.findOne({ _id: post._id })).type, "photo");
  const view = (await fx.mod.feedService.timeline({ accessToken: fx.token })).posts.find((row) => row._id === post._id);
  assert.equal(view.type, "mixed");
});

/* ---- ac-5: legacy resolution --------------------------------------------- */

test("PORCH-143 ac-5: posts created before the change resolve through the same projection — single shapes unchanged, no data rewrite", async () => {
  const fx = await mixedFixture();
  const photo = await upload(fx.media, fx.token, fx.dev, await sampleImageBytes({ seed: 31 }), "image/jpeg");
  const video = await upload(fx.media, fx.token, fx.dev, await sampleVideoBytes({ seconds: 1 }), "video/mp4");
  const photoPost = await createPost(fx, { type: "photo", mediaRefs: [photo], caption: "before" });
  const videoPost = await createPost(fx, { type: "video", mediaRefs: [video], caption: "before too" });

  const timeline = (await fx.mod.feedService.timeline({ accessToken: fx.token })).posts;
  const photoView = timeline.find((row) => row._id === photoPost.post._id);
  const videoView = timeline.find((row) => row._id === videoPost.post._id);
  assert.equal(photoView.type, "photo", "a single-kind photo post keeps type photo");
  assert.equal(videoView.type, "video", "a single video keeps type video");
  assert.equal(videoView.mediaMeta[video].kind, "video");
  assert.ok(videoView.mediaMeta[video].durationMs > 0);
  assert.equal(photoView.mediaMeta[photo].kind, "photo");

  // No data rewrite: the legacy documents' stored type and ref list are
  // untouched by the projection (the reads never mutate).
  const storedPhoto = await fx.collections.posts.findOne({ _id: photoPost.post._id });
  const storedVideo = await fx.collections.posts.findOne({ _id: videoPost.post._id });
  assert.equal(storedPhoto.type, "photo");
  assert.deepEqual(storedPhoto.mediaRefs, [photo]);
  assert.equal(storedVideo.type, "video");
  assert.deepEqual(storedVideo.mediaRefs, [video]);
});
