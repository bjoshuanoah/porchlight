import { test } from "node:test";
import assert from "node:assert/strict";
import { device, fixture } from "./helpers/content.fixture.js";

const SUSAN = "did:porchlight:susan";
const JUNE = "did:porchlight:june";
const FAMILY = "net_family";
const OTHER = "net_other";

function textPayload(overrides = {}) {
  return { type: "text", body: "picnic at noon", ...overrides };
}

/** Susan on the family network only. */
async function susanFixture() {
  const fx = fixture();
  const dev = device("dev_s");
  const { accessToken } = await fx.admit({ networkId: FAMILY, did: SUSAN, device: dev });
  return { ...fx, dev, accessToken };
}

/** Susan on BOTH networks (dual membership) + June on the family network. */
async function dualFixture() {
  const fx = fixture();
  const dev = device("dev_s");
  const juneDev = device("dev_j");
  const familyToken = (await fx.admit({ networkId: FAMILY, did: SUSAN, device: dev })).accessToken;
  const otherToken = (await fx.admit({ networkId: OTHER, did: SUSAN, device: dev })).accessToken;
  const juneToken = (await fx.admit({ networkId: FAMILY, did: JUNE, device: juneDev })).accessToken;
  return { ...fx, dev, juneDev, familyToken, otherToken, juneToken };
}

test("ac-1: text, photo, video, audio posts store one origin with signed authorship", async () => {
  const { posts, collections, dev, accessToken } = await susanFixture();

  const payload = textPayload();
  const text = (await posts.create({ accessToken, payload, signature: dev.signPayload(payload) })).post;
  assert.equal(text.type, "text");
  assert.equal(text.originNetworkId, FAMILY);
  assert.equal(text.authorId, SUSAN);
  assert.equal(text.visibility, "members-only");

  const photoPayload = { type: "photo", mediaRefs: ["med_1"], caption: "the pier" };
  const photo = (await posts.create({ accessToken, payload: photoPayload, signature: dev.signPayload(photoPayload) })).post;
  const videoPayload = { type: "video", mediaRefs: ["med_2"] };
  const video = (await posts.create({ accessToken, payload: videoPayload, signature: dev.signPayload(videoPayload) })).post;
  const audioPayload = { type: "audio", mediaRefs: ["med_3"] };
  const audio = (await posts.create({ accessToken, payload: audioPayload, signature: dev.signPayload(audioPayload) })).post;
  assert.deepEqual([photo.type, video.type, audio.type], ["photo", "video", "audio"]);

  // Exactly one origin; the verified device signature rides the document.
  const storedText = await collections.posts.findOne({ _id: text._id });
  assert.equal(storedText.originNetworkId, FAMILY);
  assert.equal(storedText.deviceSignature, dev.signPayload(payload));
  assert.deepEqual(storedText.interactionCounters, {
    upVolume: 0, downVolume: 0, voteVolume: 0, voteRatio: 0, commentCount: 0, reactionCount: 0,
  });
  // Nothing is stored on any other network.
  assert.deepEqual(await collections.posts.find({ originNetworkId: OTHER }), []);
});

test("ac-1: write shapes fail plainly — unknown type, empty text, media-less photo", async () => {
  const { posts, dev, accessToken } = await susanFixture();

  await assert.rejects(
    () => posts.create({ accessToken, payload: { type: "story", body: "x" }, signature: dev.signPayload({ type: "story", body: "x" }) }),
    (error) => error.code === "E_TYPE_REQUIRED",
  );
  await assert.rejects(
    () => posts.create({ accessToken, payload: { type: "text", body: "   " }, signature: dev.signPayload({ type: "text", body: "   " }) }),
    (error) => error.code === "E_BODY_REQUIRED",
  );
  const photoPayload = { type: "photo", mediaRefs: [] };
  await assert.rejects(
    () => posts.create({ accessToken, payload: photoPayload, signature: dev.signPayload(photoPayload) }),
    (error) => error.code === "E_MEDIA_REQUIRED",
  );
});

test("ac-1: a write claiming a foreign origin never resolves", async () => {
  const { posts, dev, accessToken } = await susanFixture();
  await assert.rejects(
    () =>
      posts.create({
        accessToken,
        payload: { type: "text", body: "hi", networkId: OTHER },
        signature: dev.signPayload({ type: "text", body: "hi", networkId: OTHER }),
      }),
    (error) => error.code === "E_NOT_PERMITTED",
  );
});

test("ac-1: every write is actor-signed — tampered payloads do not verify", async () => {
  const { posts, dev, accessToken } = await susanFixture();
  const payload = textPayload();
  const signature = dev.signPayload(payload);
  const ok = await posts.create({ accessToken, payload, signature });
  assert.ok(ok.post._id);

  await assert.rejects(
    () => posts.create({ accessToken, payload: textPayload({ body: "tampered" }), signature }),
    (error) => error.code === "E_SIGNATURE_INVALID",
  );
  await assert.rejects(
    () => posts.create({ accessToken, payload, signature: null }),
    (error) => error.code === "E_SIGNATURE_REQUIRED",
  );
  await assert.rejects(
    () => posts.create({ accessToken, payload }),
    (error) => error.code === "E_SIGNATURE_REQUIRED",
  );
});

test("ac-1: a group post verifies the group lives on the origin and holds the author", async () => {
  const { posts, groups, collections, dev, familyToken } = await dualFixture();
  const group = await groups.create({ networkId: FAMILY, name: "Picnic Crew", members: [SUSAN] });

  const payload = textPayload({ groupId: group._id });
  const created = await posts.create({ accessToken: familyToken, payload, signature: dev.signPayload(payload) });
  assert.equal(created.post.groupId, group._id);
  const stored = await collections.posts.findOne({ _id: created.post._id });
  assert.equal(stored.groupId, group._id);
  void collections;
});

test("ac-1: group containment rejects foreign groups and non-members", async () => {
  const { posts, groups, dev, familyToken } = await dualFixture();

  const foreignGroup = await groups.create({ networkId: OTHER, name: "Other Crew", members: [SUSAN] });
  await assert.rejects(
    () =>
      posts.create({
        accessToken: familyToken,
        payload: textPayload({ groupId: foreignGroup._id }),
        signature: dev.signPayload(textPayload({ groupId: foreignGroup._id })),
      }),
    (error) => error.code === "E_GROUP_UNKNOWN",
  );

  const closedGroup = await groups.create({ networkId: FAMILY, name: "Closed", members: [JUNE] });
  await assert.rejects(
    () =>
      posts.create({
        accessToken: familyToken,
        payload: textPayload({ groupId: closedGroup._id }),
        signature: dev.signPayload(textPayload({ groupId: closedGroup._id })),
      }),
    (error) => error.code === "E_GROUP_NOT_MEMBER",
  );
});

test("ac-2: cross-post creates an independent post — display hint is the only link", async () => {
  const { posts, collections, dev, familyToken, otherToken } = await dualFixture();

  const photoPayload = { type: "photo", mediaRefs: ["med_src"], caption: "sunset" };
  const source = (await posts.create({ accessToken: familyToken, payload: photoPayload, signature: dev.signPayload(photoPayload) })).post;

  // Cross-post to the second network under ITS token: an independent write
  // with its own media ingest (own mediaRefs), no dedupe machinery.
  const crossPayload = { type: "photo", mediaRefs: ["med_own_ingest"], caption: "sunset", crossPostRef: source._id };
  const cross = (await posts.create({ accessToken: otherToken, payload: crossPayload, signature: dev.signPayload(crossPayload) })).post;

  assert.notEqual(cross._id, source._id);
  assert.equal(cross.originNetworkId, OTHER);
  assert.equal(cross.authorId, SUSAN);
  assert.deepEqual(cross.mediaRefs, ["med_own_ingest"]); // separate ingest refs
  assert.deepEqual(cross.displayHint, { crossPostOf: source._id });
  assert.equal(source.displayHint, null); // the source document is untouched

  // Two independent stored documents.
  const storedSource = await collections.posts.findOne({ _id: source._id });
  const storedCross = await collections.posts.findOne({ _id: cross._id });
  assert.equal(storedSource.originNetworkId, FAMILY);
  assert.equal(storedCross.originNetworkId, OTHER);
  assert.deepEqual(storedSource.interactionCounters.voteVolume, 0);
  assert.deepEqual(storedCross.interactionCounters.voteVolume, 0);

  // The family timeline never shows the cross-post.
  const familyList = await posts.list({ accessToken: familyToken });
  assert.deepEqual(familyList.posts.map((post) => post._id), [source._id]);
});

test("ac-2: cross-post interactions stay contained — voting on one copy leaves the other", async () => {
  const { posts, interactions, collections, dev, familyToken, otherToken } = await dualFixture();
  const photoPayload = { type: "photo", mediaRefs: ["med_src"] };
  const source = (await posts.create({ accessToken: familyToken, payload: photoPayload, signature: dev.signPayload(photoPayload) })).post;
  const crossPayload = { type: "photo", mediaRefs: ["med_own"], crossPostRef: source._id };
  const cross = (await posts.create({ accessToken: otherToken, payload: crossPayload, signature: dev.signPayload(crossPayload) })).post;

  const crossVote = { postId: cross._id, value: "up" };
  await interactions.vote({ accessToken: otherToken, payload: crossVote, signature: dev.signPayload(crossVote) });

  assert.equal((await collections.posts.findOne({ _id: cross._id })).interactionCounters.voteVolume, 1);
  assert.equal((await collections.posts.findOne({ _id: source._id })).interactionCounters.voteVolume, 0);
});

test("ac-5: post deletion cascades transactionally — interactions, derived rows, artifacts all go", async () => {
  const { posts, interactions, quota, collections, dev, familyToken, juneToken, juneDev } = await dualFixture();
  const payload = { type: "photo", mediaRefs: ["med_a"], caption: "trip" };
  const post = (await posts.create({ accessToken: familyToken, payload, signature: dev.signPayload(payload) })).post;

  // Derived artifacts ledger rows + derived-data container rows keyed to the
  // original (rendition, tag, album memberships).
  await quota.recordArtifact({ networkId: FAMILY, kind: "original", bytes: 100, sourceId: post._id });
  await quota.recordArtifact({ networkId: FAMILY, kind: "rendition", bytes: 40, sourceId: "med_a" });
  await collections.derivedData.insertOne({ _id: "ddt_1", networkId: FAMILY, postId: post._id, class: "tag", createdAt: new Date().toISOString() });
  await collections.derivedData.insertOne({ _id: "ddt_2", networkId: FAMILY, postId: post._id, class: "album_membership", createdAt: new Date().toISOString() });

  // Interactions from another member on the post.
  const commentPayload = { postId: post._id, body: "beautiful" };
  await interactions.comment({ accessToken: juneToken, payload: commentPayload, signature: juneDev.signPayload(commentPayload) });
  const heart = { postId: post._id, emoji: "❤️" };
  await interactions.react({ accessToken: juneToken, payload: heart, signature: juneDev.signPayload(heart) });
  const juneVote = { postId: post._id, value: "down" };
  await interactions.vote({ accessToken: juneToken, payload: juneVote, signature: juneDev.signPayload(juneVote) });
  assert.equal((await collections.comments.find({ postId: post._id })).length, 1);

  const signature = dev.signPayload({ kind: "delete", postId: post._id, networkId: FAMILY });
  const result = await posts.deletePost({ accessToken: familyToken, postId: post._id, signature });
  assert.equal(result.deleted, true);
  // post + comment + reaction + vote + 2 derived rows + 2 artifact rows.
  assert.equal(result.cascadeRows, 8);

  assert.equal(await collections.posts.findOne({ _id: post._id }), null);
  assert.equal((await collections.comments.find({ postId: post._id })).length, 0);
  assert.equal((await collections.reactions.find({ postId: post._id })).length, 0);
  assert.equal((await collections.votes.find({ postId: post._id })).length, 0);
  assert.equal((await collections.derivedData.find({ postId: post._id })).length, 0);
  assert.equal((await collections.artifacts.find({ networkId: FAMILY })).length, 0);
});

test("ac-5: only the author deletes — another member's signed deletion fails", async () => {
  const { posts, dev, familyToken, juneToken } = await dualFixture();
  const payload = textPayload();
  const post = (await posts.create({ accessToken: familyToken, payload, signature: dev.signPayload(payload) })).post;

  await assert.rejects(
    () => posts.deletePost({ accessToken: juneToken, postId: post._id, signature: "whatever" }),
    (error) => error.code === "E_NOT_PERMITTED",
  );
  void dev;
});

test("ac-5: a mid-flight cascade failure rolls every removal back", async () => {
  const { posts, interactions, collections, dev, familyToken, juneToken, juneDev } = await dualFixture();
  const payload = textPayload();
  const post = (await posts.create({ accessToken: familyToken, payload, signature: dev.signPayload(payload) })).post;
  const commentPayload = { postId: post._id, body: "sweet" };
  await interactions.comment({ accessToken: juneToken, payload: commentPayload, signature: juneDev.signPayload(commentPayload) });
  const party = { postId: post._id, emoji: "🎉" };
  await interactions.react({ accessToken: juneToken, payload: party, signature: juneDev.signPayload(party) });

  // The comments collection fails its first deleteOne mid-cascade (after
  // the post itself was already removed).
  const rawComments = collections.comments;
  let calls = 0;
  const flaky = {
    ...rawComments,
    async deleteOne(filter) {
      calls += 1;
      if (calls === 1) throw new Error("simulated mid-flight failure");
      return rawComments.deleteOne(filter);
    },
  };
  posts.comments = flaky; // service field swap, same store surface

  const signature = dev.signPayload({ kind: "delete", postId: post._id, networkId: FAMILY });
  await assert.rejects(() => posts.deletePost({ accessToken: familyToken, postId: post._id, signature }));

  // The cascade rolled back: the post and both interactions are intact.
  assert.notEqual(await collections.posts.findOne({ _id: post._id }), null);
  assert.equal((await collections.comments.find({ postId: post._id })).length, 1);
  assert.equal((await collections.reactions.find({ postId: post._id })).length, 1);
});

test("ac-5: member-level deletion sweeps all authored originals at the origin", async () => {
  const { posts, interactions, collections, dev, juneDev, familyToken, juneToken } = await dualFixture();

  const minePayload = textPayload({ body: "first" });
  const mine = (await posts.create({ accessToken: familyToken, payload: minePayload, signature: dev.signPayload(minePayload) })).post;
  const junePayload = { type: "text", body: "june post" };
  const junePostObj = (await posts.create({ accessToken: juneToken, payload: junePayload, signature: juneDev.signPayload(junePayload) })).post;

  // Susan interacts with June's post: a comment and a vote, both to be swept.
  const onJune = { postId: junePostObj._id, body: "love it" };
  const susanComment = (await interactions.comment({ accessToken: familyToken, payload: onJune, signature: dev.signPayload(onJune) })).comment;
  const susanVote = { postId: junePostObj._id, value: "up" };
  await interactions.vote({ accessToken: familyToken, payload: susanVote, signature: dev.signPayload(susanVote) });
  assert.equal((await collections.votes.find({ postId: junePostObj._id })).length, 1);

  const signature = dev.signPayload({ kind: "delete", scope: "member", networkId: FAMILY });
  const swept = await posts.memberContentSweep({ accessToken: familyToken, signature });
  assert.equal(swept.sweptPosts, 1);

  assert.equal(await collections.posts.findOne({ _id: mine._id }), null);
  assert.equal((await collections.comments.find({ authorDid: SUSAN, networkId: FAMILY })).length, 0);
  assert.equal((await collections.votes.find({ memberDid: SUSAN, networkId: FAMILY })).length, 0);
  assert.equal(await collections.comments.findOne({ _id: susanComment._id }), null);

  // June's post survives and its rank inputs forget Susan's swept vote.
  const surviving = await collections.posts.findOne({ _id: junePostObj._id });
  assert.notEqual(surviving, null);
  assert.deepEqual(surviving.interactionCounters, {
    upVolume: 0, downVolume: 0, voteVolume: 0, voteRatio: 0, commentCount: 0, reactionCount: 0,
  });
});

test("ac-5: the member sweep is origin-contained — the other network's posts survive", async () => {
  const { posts, collections, dev, familyToken, otherToken } = await dualFixture();
  const crossPayload = { type: "text", body: "on the other network" };
  const otherPost = (await posts.create({ accessToken: otherToken, payload: crossPayload, signature: dev.signPayload(crossPayload) })).post;

  const signature = dev.signPayload({ kind: "delete", scope: "member", networkId: FAMILY });
  await posts.memberContentSweep({ accessToken: familyToken, signature });

  // The sweep runs at the origin of the signing token only.
  assert.notEqual(await collections.posts.findOne({ _id: otherPost._id }), null);
});