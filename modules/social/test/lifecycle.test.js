import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { device, fixture } from "./helpers/content.fixture.js";
import { sha256Hex } from "../src/services/media.store.js";

const SUSAN = "did:porchlight:susan"; // founder-owner of the family network
const JUNE = "did:porchlight:june"; // plain member
const MEG = "did:porchlight:meg"; // plain member
const FAMILY = "net_family";
const OTHER = "net_other";

const DAY = 24 * 60 * 60 * 1000;

/** A small deterministic decodable photo (the family-archive shape). */
const sampleImageBytes = async ({ width = 320, height = 200, seed = 3 } = {}) => {
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * channels;
      raw[at] = 128 + 100 * Math.sin(x * seed * 0.013);
      raw[at + 1] = 128 + 100 * Math.cos(y * seed * 0.004);
      raw[at + 2] = 128 + 100 * Math.sin((x + y) * 0.01);
    }
  }
  return sharp(raw, { raw: { width, height, channels } }).jpeg({ quality: 80 }).toBuffer();
};

/**
 * Lifecycle fixture (PORCH-093): Susan first (the founder-root admits the
 * owner role), then June and Meg as plain members — the delete-authority
 * ladder in one room: author, network owner, plain member, plus group
 * managers created on demand.
 */
async function lifecycleFixture() {
  const fx = fixture();
  // Owner-root rule (PORCH-015): the hub-owner identity founded this
  // network — Susan's admission resolves the owner role.
  fx.collections.networks.updateOne({ _id: FAMILY }, { $set: { ownerDid: SUSAN } });
  const devS = device("dev_s");
  const juneDev = device("dev_j");
  const megDev = device("dev_m");
  const susan = await fx.admit({ networkId: FAMILY, did: SUSAN, device: devS });
  assert.equal(susan.membership.role, "owner", "the founder-root admits the owner role");
  const june = await fx.admit({ networkId: FAMILY, did: JUNE, device: juneDev });
  const meg = await fx.admit({ networkId: FAMILY, did: MEG, device: megDev });
  return {
    ...fx,
    tokens: { susan: susan.accessToken, june: june.accessToken, meg: meg.accessToken },
    devs: { susan: devS, june: juneDev, meg: megDev },
  };
}

/** Create a post as one of the admitted members. */
async function createPost(fx, key, payload) {
  return (await fx.posts.create({ accessToken: fx.tokens[key], payload, signature: fx.devs[key].signPayload(payload) })).post;
}

/** Write a comment (root or nested reply) as one of the members. */
async function writeComment(fx, key, payload) {
  return (await fx.interactions.comment({ accessToken: fx.tokens[key], payload, signature: fx.devs[key].signPayload(payload) })).comment;
}

/** Drive a real photo upload through the media pipeline; returns the committed original id. */
async function uploadPhoto(fx, key, bytes) {
  const { media } = fx;
  const declare = { scope: "media-upload", size: bytes.length, contentType: "image/jpeg" };
  const begin = await media.beginUpload({
    accessToken: fx.tokens[key],
    payload: declare,
    signature: fx.devs[key].signPayload(declare),
  });
  await media.putChunk({
    accessToken: fx.tokens[key],
    uploadId: begin.uploadId,
    index: 0,
    bytes,
    chunkSha: begin.overrides?.chunkShaByIndex?.[0] ?? sha256Hex(bytes),
  });
  const committed = await media.completeUpload({
    accessToken: fx.tokens[key],
    uploadId: begin.uploadId,
    payload: { sha256: sha256Hex(bytes), size: bytes.length },
    signature: fx.devs[key].signPayload({ scope: "media-commit", uploadId: begin.uploadId, sha256: sha256Hex(bytes), size: bytes.length }),
  });
  return committed.mediaId;
}

/** Delete a post as one of the members (the signed delete payload). */
async function deletePostAs(fx, key, postId) {
  return fx.posts.deletePost({
    accessToken: fx.tokens[key],
    postId,
    signature: fx.devs[key].signPayload({ kind: "delete", postId, networkId: FAMILY }),
  });
}

/** Tombstone row by id (or null). */
const tombstoneOf = async (fx, id) => fx.collections.tombstones.findOne({ _id: id });

const planeEvents = async (fx) => (await fx.realtimePlane.readSince(FAMILY, null)).events;

/* ---- ac-1: delete authority and cascade ---------------------------------- */

test("ac-1: the author's delete tombstones and cascades in one operation — every surface drops it", async () => {
  const fx = await lifecycleFixture();
  const mediaId = await uploadPhoto(fx, "june", await sampleImageBytes());
  const post = await createPost(fx, "june", { type: "photo", mediaRefs: [mediaId], caption: "the pier" });
  const root = await writeComment(fx, "meg", { postId: post._id, body: "beautiful" });
  const reply = await writeComment(fx, "susan", { postId: post._id, body: "@June the sunset!", parentId: root._id });
  const heart = { postId: post._id, emoji: "❤️" };
  await fx.interactions.react({ accessToken: fx.tokens.meg, payload: heart, signature: fx.devs.meg.signPayload(heart) });
  const up = { postId: post._id, value: "up" };
  await fx.interactions.vote({ accessToken: fx.tokens.meg, payload: up, signature: fx.devs.meg.signPayload(up) });

  const result = await deletePostAs(fx, "june", post._id);
  assert.equal(result.deleted, true);
  const tombstone = await tombstoneOf(fx, result.tombstoneId);
  assert.equal(tombstone.subjectType, "post");
  assert.equal(tombstone.subjectId, post._id);
  assert.equal(tombstone.deletedBy, JUNE);
  assert.equal(tombstone.deletedByRole, "author");
  assert.equal(tombstone.originNetworkId, FAMILY);
  assert.deepEqual(tombstone.mediaOrigins, [mediaId]);
  // The window of record: purgeAt sits 30 days out; nothing purged yet.
  assert.ok(Math.abs(new Date(tombstone.purgeAt).getTime() - (new Date(tombstone.deletedAt).getTime() + 30 * DAY)) < 5_000);
  assert.equal(tombstone.purgedAt, null);
  // The cascade children are captured exactly — no tombstones of their own.
  assert.deepEqual(tombstone.cascade.comments.map((row) => row._id).sort(), [root._id, reply._id].sort());
  assert.equal(tombstone.cascade.subject._id, post._id);
  assert.equal((await fx.collections.tombstones.find({ subjectType: "comment" })).length, 0);

  // Every read surface drops it in the same operation: base timeline,
  // detail read, conversation read, notification back-references.
  assert.deepEqual((await fx.posts.list({ accessToken: fx.tokens.meg })).posts, []);
  await assert.rejects(() => fx.posts.get({ accessToken: fx.tokens.june, postId: post._id }), (error) => error.code === "E_POST_NOT_FOUND");
  // The conversation read refuses a tombstoned post exactly as a
  // cross-origin one — reads never serve tombstoned content.
  await assert.rejects(
    () => fx.interactions.commentThread({ accessToken: fx.tokens.meg, postId: post._id }),
    (error) => error.code === "E_POST_NOT_FOUND",
  );
  assert.equal((await fx.collections.notifications.find({ postId: post._id })).length, 0);
  assert.equal(await fx.collections.posts.findOne({ _id: post._id }), null);
  assert.equal((await fx.collections.comments.find({ postId: post._id })).length, 0);
  assert.equal((await fx.collections.reactions.find({ postId: post._id })).length, 0);
  assert.equal((await fx.collections.votes.find({ postId: post._id })).length, 0);
  // The tree-scoped removal event rode the plane (content-only ids).
  const removals = (await planeEvents(fx)).filter((row) => row.type === "post.deleted" && row.postId === post._id);
  assert.equal(removals.length, 1);
  assert.deepEqual(removals[0].content.cascadeIds.sort(), [root._id, reply._id].sort());
});

test("ac-1: the network owner deletes any post in networks they own; a plain member never does", async () => {
  const fx = await lifecycleFixture();
  const junesPost = await createPost(fx, "june", { type: "text", body: "june's note" });

  // The owner deletes June's post despite not authoring it.
  const ownerResult = await deletePostAs(fx, "susan", junesPost._id);
  assert.equal(ownerResult.deleted, true);
  const tombstone = await tombstoneOf(fx, ownerResult.tombstoneId);
  assert.equal(tombstone.deletedBy, SUSAN);
  assert.equal(tombstone.deletedByRole, "owner");

  // A plain member's attempt on ANOTHER member's post is refused plainly
  // with zero mutation.
  const megTarget = await createPost(fx, "june", { type: "text", body: "meg cannot take this" });
  await assert.rejects(
    () => deletePostAs(fx, "meg", megTarget._id),
    (error) => error.code === "E_NOT_PERMITTED",
  );
  assert.notEqual(await fx.collections.posts.findOne({ _id: megTarget._id }), null);
  assert.deepEqual(await fx.collections.tombstones.find({ subjectId: megTarget._id }), []);
});

test("ac-1: a managing member removes a group-origin post with the tombstone attribution — never a comment, never outside their groups", async () => {
  const fx = await lifecycleFixture();
  await fx.groups.create({ networkId: FAMILY, name: "Picnic Crew", createdBy: MEG, members: [MEG, JUNE] });
  const groupId = (await fx.collections.groups.findOne({ name: "Picnic Crew" }))._id;
  const groupPost = await createPost(fx, "june", { type: "text", body: "bring a blanket", groupId });
  const comment = await writeComment(fx, "june", { postId: groupPost._id, body: "I'm bringing it" });

  // The managing member's removal rides the same tombstone pattern.
  const removed = await fx.posts.removePost({
    accessToken: fx.tokens.meg,
    postId: groupPost._id,
    signature: fx.devs.meg.signPayload({ kind: "group_post_remove", postId: groupPost._id, groupId, networkId: FAMILY }),
  });
  assert.equal(removed.removed, true);
  const tombstone = await tombstoneOf(fx, removed.tombstoneId);
  assert.equal(tombstone.deletedBy, MEG);
  assert.equal(tombstone.deletedByRole, "group-manager", "the managing member's attribution lands on the tombstone");
  assert.equal(await fx.collections.posts.findOne({ _id: groupPost._id }), null);
  assert.equal(await fx.collections.comments.findOne({ _id: comment._id }), null);

  // A group member who is NOT the managing member is refused like anyone.
  await fx.groups.create({ networkId: FAMILY, name: "Second Crew", createdBy: MEG, members: [MEG, JUNE] });
  const secondGroupId = (await fx.collections.groups.findOne({ name: "Second Crew" }))._id;
  const secondPost = await createPost(fx, "meg", { type: "text", body: "second crew post", groupId: secondGroupId });
  await assert.rejects(
    () =>
      fx.posts.removePost({
        accessToken: fx.tokens.june,
        postId: secondPost._id,
        signature: fx.devs.june.signPayload({ kind: "group_post_remove", postId: secondPost._id, groupId: secondGroupId, networkId: FAMILY }),
      }),
    (error) => error.code === "E_GROUP_NOT_CREATOR",
  );
  await assert.rejects(
    () =>
      fx.posts.removePost({
        accessToken: fx.tokens.june,
        postId: groupPost._id,
        signature: fx.devs.june.signPayload({ kind: "group_post_remove", postId: groupPost._id, groupId, networkId: FAMILY }),
      }),
    (error) => error.code === "E_POST_NOT_FOUND",
  );
  // A non-group post is unreachable through the moderation route.
  const plainPost = await createPost(fx, "meg", { type: "text", body: "no group" });
  await assert.rejects(
    () =>
      fx.posts.removePost({
        accessToken: fx.tokens.meg,
        postId: plainPost._id,
        signature: fx.devs.meg.signPayload({ kind: "group_post_remove", postId: plainPost._id, groupId: "grp_none", networkId: FAMILY }),
      }),
    (error) => error.code === "E_GROUP_POST_ONLY",
  );

  // The managing member's authority NEVER reaches comments — their attempt
  // on a comment is refused like any other member's, zero mutation.
  const otherPost = await createPost(fx, "june", { type: "text", body: "june's other note" });
  const otherComment = await writeComment(fx, "june", { postId: otherPost._id, body: "june's comment" });
  await assert.rejects(
    () =>
      fx.interactions.deleteComment({
        accessToken: fx.tokens.meg,
        postId: otherPost._id,
        commentId: otherComment._id,
        signature: fx.devs.meg.signPayload({ kind: "comment-delete", postId: otherPost._id, commentId: otherComment._id, networkId: FAMILY }),
      }),
    (error) => error.code === "E_COMMENT_DELETE_NOT_PERMITTED",
  );
  assert.notEqual(await fx.collections.comments.findOne({ _id: otherComment._id }), null);
  assert.deepEqual(await fx.collections.tombstones.find({ subjectId: otherComment._id }), []);
});

test("ac-1: a comment delete cascades its reply tree in one operation — owner included, others refused", async () => {
  const fx = await lifecycleFixture();
  const post = await createPost(fx, "june", { type: "text", body: "the thread post" });
  const root = await writeComment(fx, "meg", { postId: post._id, body: "root" });
  const reply1 = await writeComment(fx, "june", { postId: post._id, body: "reply", parentId: root._id });
  const reply2 = await writeComment(fx, "susan", { postId: post._id, body: "nested reply", parentId: reply1._id });
  // A sibling root survives the delete of the first.
  const sibling = await writeComment(fx, "june", { postId: post._id, body: "sibling root" });

  // The author deletes their own root.
  const result = await fx.interactions.deleteComment({
    accessToken: fx.tokens.meg,
    postId: post._id,
    commentId: root._id,
    signature: fx.devs.meg.signPayload({ kind: "comment-delete", postId: post._id, commentId: root._id, networkId: FAMILY }),
  });
  assert.equal(result.deleted, true);
  assert.equal(result.cascadedReplies, 2);
  const tombstone = await tombstoneOf(fx, result.tombstoneId);
  assert.equal(tombstone.subjectType, "comment");
  assert.equal(tombstone.deletedByRole, "author");
  assert.deepEqual(tombstone.cascade.comments.map((row) => row._id).sort(), [reply1._id, reply2._id].sort());
  for (const id of [root._id, reply1._id, reply2._id]) {
    assert.equal(await fx.collections.comments.findOne({ _id: id }), null);
  }
  assert.notEqual(await fx.collections.comments.findOne({ _id: sibling._id }), null, "the sibling root is untouched");
  // The thread read serves the surviving root only, counts recomputed.
  const thread = (await fx.interactions.commentThread({ accessToken: fx.tokens.susan, postId: post._id })).comments;
  assert.deepEqual(thread.map((row) => row._id), [sibling._id]);
  // The tree-scoped removal event carries the root and its children.
  const removal = (await planeEvents(fx)).filter((row) => row.type === "comment.deleted" && row.postId === post._id).pop();
  assert.equal(removal.content.rootId, root._id);
  assert.deepEqual(removal.content.cascadeIds.sort(), [reply1._id, reply2._id].sort());

  // The network owner may delete any comment; a plain member may not.
  const ownerRoot = await writeComment(fx, "june", { postId: post._id, body: "owner-deletes" });
  const ownerResult = await fx.interactions.deleteComment({
    accessToken: fx.tokens.susan,
    postId: post._id,
    commentId: ownerRoot._id,
    signature: fx.devs.susan.signPayload({ kind: "comment-delete", postId: post._id, commentId: ownerRoot._id, networkId: FAMILY }),
  });
  assert.equal((await tombstoneOf(fx, ownerResult.tombstoneId)).deletedByRole, "owner");
  const strangers = await writeComment(fx, "june", { postId: post._id, body: "stranger deletes?" });
  await assert.rejects(
    () =>
      fx.interactions.deleteComment({
        accessToken: fx.tokens.meg,
        postId: post._id,
        commentId: strangers._id,
        signature: fx.devs.meg.signPayload({ kind: "comment-delete", postId: post._id, commentId: strangers._id, networkId: FAMILY }),
      }),
    (error) => error.code === "E_COMMENT_DELETE_NOT_PERMITTED",
  );
  assert.notEqual(await fx.collections.comments.findOne({ _id: strangers._id }), null);
});

/* ---- ac-2: deleted media — renditions purge, original holds -------------- */

test("ac-2: renditions purge at delete; the original holds the window and never resolves on any media surface", async () => {
  const fx = await lifecycleFixture();
  const juneDev = fx.devs.june;
  void juneDev;
  const mediaId = await uploadPhoto(fx, "june", await sampleImageBytes());
  const post = await createPost(fx, "june", { type: "photo", mediaRefs: [mediaId], caption: "trip" });

  const renditionRows = await fx.store.collection("media_assets").find({});
  const renditions = renditionRows.filter((row) => row.originalId === mediaId && row.kind === "rendition");
  assert.ok(renditions.length > 0, "the hub generated the rendition set at ingest");
  const served = await fx.media.serveRendition({ accessToken: fx.tokens.meg, mediaId, renditionKind: "feed-thumb" });
  assert.equal(served.mediaId, mediaId);
  const originalAsset = await fx.store.collection("media_assets").findOne({ _id: mediaId });
  const originalBlob = await fx.media.blobs.get(originalAsset.blobKey);
  assert.notEqual(originalBlob, null);

  await deletePostAs(fx, "june", post._id);

  // Renditions: asset rows AND their bytes gone at delete time.
  const afterRenditions = (await fx.store.collection("media_assets").find({})).filter((row) => row.originalId === mediaId && row.kind === "rendition");
  assert.deepEqual(afterRenditions, []);
  for (const row of renditions) {
    assert.equal(await fx.media.blobs.get(row.blobKey), null, "the rendition bytes left the store at delete");
  }
  // The original: asset row, bytes, and ledger row hold the window.
  assert.notEqual(await fx.store.collection("media_assets").findOne({ _id: mediaId }), null);
  assert.notEqual(await fx.media.blobs.get(originalAsset.blobKey), null);
  assert.equal((await fx.collections.artifacts.find({ networkId: FAMILY })).some((row) => row.sourceId === mediaId), true);

  // Every media-resolution route refuses the deleted post's media.
  await assert.rejects(
    () => fx.media.serveRendition({ accessToken: fx.tokens.meg, mediaId, renditionKind: "feed-thumb" }),
    (error) => error.code === "E_MEDIA_NOT_FOUND",
  );
  await assert.rejects(
    () => fx.media.serveOriginal({ accessToken: fx.tokens.meg, mediaId }),
    (error) => error.code === "E_MEDIA_NOT_FOUND",
  );
  await assert.rejects(
    () => fx.media.describe({ accessToken: fx.tokens.meg, mediaId }),
    (error) => error.code === "E_MEDIA_NOT_FOUND",
  );
});

/* ---- ac-3: restore window, restore, one-time hard purge ------------------ */

test("ac-3: one restore re-materializes the subject, its cascade children, and its renditions", async () => {
  const fx = await lifecycleFixture();
  const mediaId = await uploadPhoto(fx, "june", await sampleImageBytes());
  const post = await createPost(fx, "june", { type: "photo", mediaRefs: [mediaId], caption: "the album" });
  const comment = await writeComment(fx, "meg", { postId: post._id, body: "great shot" });
  const party = { postId: post._id, emoji: "🎉" };
  await fx.interactions.react({ accessToken: fx.tokens.meg, payload: party, signature: fx.devs.meg.signPayload(party) });

  const deleted = await deletePostAs(fx, "june", post._id);
  assert.equal((await fx.store.collection("media_assets").find({})).filter((row) => row.originalId === mediaId && row.kind === "rendition").length, 0);

  // A member restore never passes (owner-only, owner-console-only).
  await assert.rejects(
    () => fx.lifecycle.restore({ accessToken: fx.tokens.june, tombstoneId: deleted.tombstoneId }),
    (error) => error.code === "E_RESTORE_NOT_PERMITTED",
  );
  assert.equal(await fx.collections.posts.findOne({ _id: post._id }), null, "a refused restore mutates nothing");

  // The owner's restore re-materializes everything the cascade captured.
  const restored = await fx.lifecycle.restore({ accessToken: fx.tokens.susan, tombstoneId: deleted.tombstoneId });
  assert.equal(restored.restored, true);
  assert.equal(restored.subjectType, "post");
  assert.equal(restored.subjectId, post._id);
  // The subject is back, byte-identical to the delete-time capture.
  const backPost = await fx.collections.posts.findOne({ _id: post._id });
  assert.equal(backPost.caption, "the album");
  // The cascade children are back: comments, reactions (the interactions
  // captured at delete time — the restore never fabricates state).
  assert.notEqual(await fx.collections.comments.findOne({ _id: comment._id }), null);
  assert.equal((await fx.collections.reactions.find({ postId: post._id })).length, 1);
  // The tombstone left scope.
  assert.equal(await tombstoneOf(fx, deleted.tombstoneId), null);
  // Renditions regenerated on demand; serving works again.
  assert.ok(restored.renditionsRegenerated > 0);
  const renditions = (await fx.store.collection("media_assets").find({})).filter((row) => row.originalId === mediaId && row.kind === "rendition");
  assert.ok(renditions.length > 0);
  await fx.media.serveRendition({ accessToken: fx.tokens.meg, mediaId, renditionKind: "feed-thumb" });
  // The reads serve it again.
  assert.deepEqual((await fx.posts.list({ accessToken: fx.tokens.meg })).posts.map((row) => row._id), [post._id]);
  // A restored post re-enters the live rooms through post.updated — the
  // shipped vocabulary, no restore-revealing field.
  const updated = (await planeEvents(fx)).filter((row) => row.type === "post.updated" && row.postId === post._id).pop();
  assert.equal(updated.content._id, post._id);
  assert.equal(updated.content.mediaRefs[0], mediaId);
});

test("ac-3: the day-30 reaper purges once — originals destroyed, the tombstone audit-remains, restore refuses loudly", async () => {
  const fx = await lifecycleFixture();
  const mediaId = await uploadPhoto(fx, "june", await sampleImageBytes());
  const post = await createPost(fx, "june", { type: "photo", mediaRefs: [mediaId], caption: "old trip" });
  await writeComment(fx, "meg", { postId: post._id, body: "memory" });
  const deleted = await deletePostAs(fx, "june", post._id);
  const originalAsset = await fx.store.collection("media_assets").findOne({ _id: mediaId });

  // Nothing purges before the window closes.
  const early = await fx.lifecycle.sweep({ now: () => new Date() });
  assert.equal(early.purged, 0);
  assert.notEqual(await fx.store.collection("media_assets").findOne({ _id: mediaId }), null);

  // Day 30 passes: shift the tombstone's purgeAt into the past (the sweep
  // itself takes the injectable clock; the state of record is purgeAt).
  const past = new Date(Date.now() - DAY).toISOString();
  await fx.collections.tombstones.updateOne({ _id: deleted.tombstoneId }, { $set: { purgeAt: past } });

  const swept = await fx.lifecycle.sweep({ now: () => new Date() });
  assert.equal(swept.purged, 1);
  // Hard purge destroyed the original AND its ledger row, once.
  assert.equal(await fx.store.collection("media_assets").findOne({ _id: mediaId }), null);
  assert.equal(await fx.media.blobs.get(originalAsset.blobKey), null);
  assert.equal((await fx.collections.artifacts.find({ networkId: FAMILY })).some((row) => row.sourceId === mediaId), false);
  // The tombstone remains for audit with purgedAt set — one-time semantics.
  const tombstone = await tombstoneOf(fx, deleted.tombstoneId);
  assert.notEqual(tombstone, null);
  assert.notEqual(tombstone.purgedAt, null);

  // Restore refuses loudly after the purge.
  await assert.rejects(
    () => fx.lifecycle.restore({ accessToken: fx.tokens.susan, tombstoneId: deleted.tombstoneId }),
    (error) => error.code === "E_TOMBSTONE_PURGED",
  );
  // Retries never double-destroy.
  const again = await fx.lifecycle.sweep({ now: () => new Date() });
  assert.equal(again.purged, 0);
  // A second tombstone due at the same moment purges independently.
  const otherPost = await createPost(fx, "june", { type: "text", body: "second purge" });
  const otherDeleted = await deletePostAs(fx, "june", otherPost._id);
  await fx.collections.tombstones.updateOne({ _id: otherDeleted.tombstoneId }, { $set: { purgeAt: past } });
  const concurrent = await Promise.all([
    fx.lifecycle.sweep({ now: () => new Date() }),
    fx.lifecycle.sweep({ now: () => new Date() }),
  ]);
  assert.equal(concurrent.reduce((n, r) => n + r.purged, 0), 1, "concurrent sweeps claim each tombstone exactly once");
  assert.equal(await tombstoneOf(fx, otherDeleted.tombstoneId) != null, true);
});

/* ---- ac-4: edit authority and scope -------------------------------------- */

test("ac-4: the author edits text and caption; ownership never confers edit authority; media changes are refused with the delete-and-repost direction", async () => {
  const fx = await lifecycleFixture();
  const textPost = await createPost(fx, "june", { type: "text", body: "dinner at six" });
  const photoPost = await createPost(fx, "june", { type: "photo", mediaRefs: [await uploadPhoto(fx, "june", await sampleImageBytes())], caption: "the pier" });

  // The author edits their own post's text.
  const bodyPayload = { body: "dinner at seven" };
  const edited = await fx.posts.editPost({
    accessToken: fx.tokens.june,
    postId: textPost._id,
    payload: bodyPayload,
    signature: fx.devs.june.signPayload({ kind: "post-edit", postId: textPost._id, networkId: FAMILY, body: bodyPayload.body }),
  });
  assert.equal(edited.post.body, "dinner at seven");

  // …and their caption.
  const captionPayload = { caption: "the south pier" };
  const captioned = await fx.posts.editPost({
    accessToken: fx.tokens.june,
    postId: photoPost._id,
    payload: captionPayload,
    signature: fx.devs.june.signPayload({ kind: "post-edit", postId: photoPost._id, networkId: FAMILY, caption: captionPayload.caption }),
  });
  assert.equal(captioned.post.caption, "the south pier");

  // Any other member — the network owner included — is refused loudly.
  for (const key of ["susan", "meg"]) {
    await assert.rejects(
      () =>
        fx.posts.editPost({
          accessToken: fx.tokens[key],
          postId: textPost._id,
          payload: { body: "not mine" },
          signature: fx.devs[key].signPayload({ kind: "post-edit", postId: textPost._id, networkId: FAMILY, body: "not mine" }),
        }),
      (error) => error.code === "E_EDIT_NOT_AUTHOR",
    );
  }
  assert.equal((await fx.collections.posts.findOne({ _id: textPost._id })).body, "dinner at seven", "refused edits write nothing");
  // The refusal names the one-directional law.
  try {
    await fx.posts.editPost({
      accessToken: fx.tokens.susan,
      postId: textPost._id,
      payload: { body: "x" },
      signature: fx.devs.susan.signPayload({ kind: "post-edit", postId: textPost._id, networkId: FAMILY, body: "x" }),
    });
    assert.fail("the owner's edit should have been refused");
  } catch (error) {
    assert.match(error.message, /ownership never confers edit authority/);
  }

  // Media is never edited: the mediaRef change is refused with the
  // delete-and-repost direction.
  const mediaAttempt = { mediaRefs: ["med_other"], caption: "swapped" };
  await assert.rejects(
    () =>
      fx.posts.editPost({
        accessToken: fx.tokens.june,
        postId: photoPost._id,
        payload: mediaAttempt,
        signature: fx.devs.june.signPayload({ kind: "post-edit", postId: photoPost._id, networkId: FAMILY, caption: "swapped" }),
      }),
    (error) => {
      assert.equal(error.code, "E_EDIT_MEDIA_IMMUTABLE");
      assert.match(error.message, /deleting this post and posting it again/);
      return true;
    },
  );
  const storedPhoto = await fx.collections.posts.findOne({ _id: photoPost._id });
  assert.equal(storedPhoto.caption, "the south pier", "the media-ref refusal wrote nothing");
  // A type change refuses beside it.
  await assert.rejects(
    () =>
      fx.posts.editPost({
        accessToken: fx.tokens.june,
        postId: textPost._id,
        payload: { type: "photo", body: "x" },
        signature: fx.devs.june.signPayload({ kind: "post-edit", postId: textPost._id, networkId: FAMILY, body: "x" }),
      }),
    (error) => error.code === "E_EDIT_TYPE_IMMUTABLE",
  );
  // Every edit write is actor-signed.
  await assert.rejects(
    () => fx.posts.editPost({ accessToken: fx.tokens.june, postId: textPost._id, payload: { body: "unsigned" }, signature: null }),
    (error) => error.code === "E_SIGNATURE_REQUIRED",
  );

  // The same gates at comment scale: the author edits text; the owner's
  // edit is refused (ownership never confers edit authority).
  const comment = await writeComment(fx, "june", { postId: textPost._id, body: "see you there" });
  const commentEdit = { body: "see you at seven" };
  const editedComment = await fx.interactions.editComment({
    accessToken: fx.tokens.june,
    postId: textPost._id,
    commentId: comment._id,
    payload: commentEdit,
    signature: fx.devs.june.signPayload({ kind: "comment-edit", postId: textPost._id, commentId: comment._id, body: commentEdit.body, networkId: FAMILY }),
  });
  assert.equal(editedComment.comment.body, "see you at seven");
  await assert.rejects(
    () =>
      fx.interactions.editComment({
        accessToken: fx.tokens.susan,
        postId: textPost._id,
        commentId: comment._id,
        payload: { body: "owner edit" },
        signature: fx.devs.susan.signPayload({ kind: "comment-edit", postId: textPost._id, commentId: comment._id, body: "owner edit", networkId: FAMILY }),
      }),
    (error) => error.code === "E_COMMENT_EDIT_NOT_AUTHOR",
  );
  assert.equal((await fx.collections.comments.findOne({ _id: comment._id })).body, "see you at seven");
});

/* ---- ac-5: no edited marker anywhere ------------------------------------- */

test("ac-5: edits are silent — the served document is byte-indistinguishable from the same content authored once", async () => {
  const fx = await lifecycleFixture();
  const post = await createPost(fx, "june", { type: "text", body: "first draft" });
  const before = await fx.collections.posts.findOne({ _id: post._id });
  const createdEvents = (await planeEvents(fx)).filter((row) => row.type === "post.created" && row.postId === post._id);

  await fx.posts.editPost({
    accessToken: fx.tokens.june,
    postId: post._id,
    payload: { body: "second draft" },
    signature: fx.devs.june.signPayload({ kind: "post-edit", postId: post._id, networkId: FAMILY, body: "second draft" }),
  });

  const after = await fx.collections.posts.findOne({ _id: post._id });
  // The stored document carries exactly the same fields — no edit-time
  // marker, annotation, revision pointer, or version-history field was
  // added; the enforced-by-omission contract.
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  assert.deepEqual(Object.keys(after).filter((key) => !["body", "lastActivityAt", "interactionCounters"].includes(key)).sort(), Object.keys(before).filter((key) => !["body", "lastActivityAt", "interactionCounters"].includes(key)).sort());
  assert.equal(after.editedAt, undefined);
  assert.equal(after.edited, undefined);
  assert.equal(after.revisions, undefined);

  // The post.updated envelope's content carries exactly the same shape
  // (field names) the post.created envelope carried — nothing in the event
  // vocabulary reveals an edit occurred.
  const updated = (await planeEvents(fx)).filter((row) => row.type === "post.updated" && row.postId === post._id).pop();
  assert.deepEqual(Object.keys(updated.content).sort(), Object.keys(createdEvents[0].content).sort());

  // Comment scale: same omission, same event shape as reply.created.
  const comment = await writeComment(fx, "meg", { postId: post._id, body: "comment v1" });
  const commentBefore = await fx.collections.comments.findOne({ _id: comment._id });
  const replyCreated = (await planeEvents(fx)).filter((row) => row.type === "reply.created" && row.content._id === comment._id).pop();
  await fx.interactions.editComment({
    accessToken: fx.tokens.meg,
    postId: post._id,
    commentId: comment._id,
    payload: { body: "comment v2" },
    signature: fx.devs.meg.signPayload({ kind: "comment-edit", postId: post._id, commentId: comment._id, body: "comment v2", networkId: FAMILY }),
  });
  const commentAfter = await fx.collections.comments.findOne({ _id: comment._id });
  assert.deepEqual(Object.keys(commentAfter).sort(), Object.keys(commentBefore).sort());
  const commentUpdated = (await planeEvents(fx)).filter((row) => row.type === "comment.updated" && row.content._id === comment._id).pop();
  assert.deepEqual(Object.keys(commentUpdated.content).sort(), Object.keys(replyCreated.content).sort());
});

/* ---- ac-6: live edit rendering, ordering, catch-up ----------------------- */

test("ac-6: lifecycle events ride the shipped transport in order, idempotent, and the removal replays in catch-up", async () => {
  const fx = await lifecycleFixture();
  const post = await createPost(fx, "june", { type: "text", body: "live wire" });
  const comment = await writeComment(fx, "meg", { postId: post._id, body: "on the wire" });

  await fx.posts.editPost({
    accessToken: fx.tokens.june,
    postId: post._id,
    payload: { body: "live wire, edited" },
    signature: fx.devs.june.signPayload({ kind: "post-edit", postId: post._id, networkId: FAMILY, body: "live wire, edited" }),
  });
  await fx.interactions.deleteComment({
    accessToken: fx.tokens.meg,
    postId: post._id,
    commentId: comment._id,
    signature: fx.devs.meg.signPayload({ kind: "comment-delete", postId: post._id, commentId: comment._id, networkId: FAMILY }),
  });
  await deletePostAs(fx, "june", post._id);

  // Ordered per origin: created → updated → comment.deleted → deleted, one
  // per write, monotonic seqs.
  const events = await planeEvents(fx);
  const seqs = events.map((row) => row.seq.split("-").map(Number));
  for (let i = 1; i < seqs.length; i += 1) {
    const [prevAt, prevN] = seqs[i - 1];
    const [at, n] = seqs[i];
    assert.ok(at > prevAt || (at === prevAt && n > prevN), "the seq stays monotonic per origin");
  }
  const names = events.filter((row) => row.postId === post._id).map((row) => row.type);
  assert.deepEqual(names, ["post.created", "reply.created", "post.updated", "comment.deleted", "post.deleted"]);
  // Content-only envelopes (the payload-privacy law holds on transport).
  for (const row of events) {
    assert.equal(row.content?.interactionCounters, undefined);
    assert.equal(row.content?.voteCount, undefined);
    assert.equal(row.content?.deviceSignature, undefined);
    assert.equal(row.content?.updated || row.content?.edited || row.content?.version, undefined, "no edit-revealing field rides any envelope");
  }

  // Catch-up: the removal is exactly how a returning device learns the
  // post and its subtree are gone — the tombstoned subject's other events
  // (created, updated) never replay, the removal does.
  const delta = await fx.realtime.catchUp({ accessToken: fx.tokens.meg, since: null });
  const forPost = delta.events.filter((row) => row.postId === post._id);
  assert.deepEqual(forPost.map((row) => row.type), ["comment.deleted", "post.deleted"]);
});

/* ---- ac-7: atomicity, containment, purge safety -------------------------- */

test("ac-7: a mid-flight cascade failure rolls the tombstone back with every row — no half-deleted state is reachable", async () => {
  const fx = await lifecycleFixture();
  const post = await createPost(fx, "june", { type: "text", body: "rollback case" });
  await writeComment(fx, "meg", { postId: post._id, body: "comment one" });

  const rawComments = fx.collections.comments;
  let calls = 0;
  const flaky = {
    ...rawComments,
    async deleteOne(filter) {
      calls += 1;
      if (calls === 1) throw new Error("simulated mid-flight failure");
      return rawComments.deleteOne(filter);
    },
  };
  fx.posts.comments = flaky;

  await assert.rejects(() => deletePostAs(fx, "june", post._id));
  // No half-deleted read state and no tombstone of a failed cascade: the
  // compensating write removed the tombstone, the rollback re-installed
  // every already-removed row.
  assert.notEqual(await rawComments.findOne({ postId: post._id }), null);
  assert.deepEqual(await fx.collections.tombstones.find({ subjectId: post._id }), []);
  assert.notEqual(await fx.collections.posts.findOne({ _id: post._id }), null, "the cascade rolled the post document back");
});

test("ac-7: containment — authority and restore resolve within the origin only, and a comment restore with a deleted post refuses", async () => {
  const fx = await lifecycleFixture();
  // A comment tombstone whose post dies afterwards: the restore refuses
  // rather than resurrecting an unreachable child.
  const post = await createPost(fx, "june", { type: "text", body: "orphan case" });
  const comment = await writeComment(fx, "june", { postId: post._id, body: "orphaned comment" });
  const commentDeleted = await fx.interactions.deleteComment({
    accessToken: fx.tokens.june,
    postId: post._id,
    commentId: comment._id,
    signature: fx.devs.june.signPayload({ kind: "comment-delete", postId: post._id, commentId: comment._id, networkId: FAMILY }),
  });
  const postDeleted = await deletePostAs(fx, "june", post._id);
  await assert.rejects(
    () => fx.lifecycle.restore({ accessToken: fx.tokens.susan, tombstoneId: commentDeleted.tombstoneId }),
    (error) => error.code === "E_TOMBSTONE_ORPHANED",
  );
  // The post tombstone restores standalone (its own cascade is whole).
  const restoredPost = await fx.lifecycle.restore({ accessToken: fx.tokens.susan, tombstoneId: postDeleted.tombstoneId });
  assert.equal(restoredPost.subjectId, post._id);

  // Cross-origin restore refusal: a tombstone of the OTHER network is
  // unaddressable with the family token — the read simply doesn't exist here.
  const foreign = {
    _id: "tmb_foreigner",
    subjectType: "post",
    subjectId: "post_foreign",
    originNetworkId: OTHER,
    deletedBy: JUNE,
    deletedByRole: "author",
    deletedAt: new Date().toISOString(),
    purgeAt: new Date(Date.now() + DAY).toISOString(),
    purgedAt: null,
    mediaOrigins: [],
    heldBlobKeys: [],
    cascade: { subject: { _id: "post_foreign" } },
  };
  await fx.collections.tombstones.insertOne(foreign);
  await assert.rejects(
    () => fx.lifecycle.restore({ accessToken: fx.tokens.susan, tombstoneId: "tmb_foreigner" }),
    (error) => error.code === "E_TOMBSTONE_NOT_FOUND",
  );
  // Cross-origin delete refusal: the owner's authority resolves on the
  // origin network only — a post that isn't of their origin "doesn't exist".
  await assert.rejects(
    () =>
      fx.posts.deletePost({
        accessToken: fx.tokens.susan,
        postId: "post_foreign",
        signature: fx.devs.susan.signPayload({ kind: "delete", postId: "post_foreign", networkId: OTHER }),
      }),
    (error) => error.code === "E_POST_NOT_FOUND",
  );
});