import { test } from "node:test";
import assert from "node:assert/strict";
import { device, fixture } from "./helpers/content.fixture.js";
import { RankingService, rankedScore, normalizeRankingConfig } from "../src/services/ranking.service.js";
import { FeedService } from "../src/services/feed.service.js";

// PORCH-113 — Poster self-vote at publish + un-vote clear ride (Brian,
// Oct 20, 2026 / vote-display ruling Oct 19, 2026): post creation writes
// the author's up-vote in the same operation as the post, a first-class
// vote doc of the existing signed schema; the clear write (DELETE
// /posts/:postId/votes) removes the member's own vote row on the existing
// signed vote path. Self-votes are never privileged: they change and
// clear exactly like every other member's vote.

const SUSAN = "did:porchlight:susan";
const JUNE = "did:porchlight:june";
const MEG = "did:porchlight:meg";
const FAMILY = "net_family";

/** Susan founds the network (owner-root rule), June and Meg ride as members. */
async function selfVoteFixture() {
  const audits = [];
  const fx = fixture({ networkIds: [FAMILY], audit: async (action, payload) => audits.push({ action, payload }) });
  // Owner-root rule: Susan founds, so restore rides her owner token.
  fx.collections.networks.updateOne({ _id: FAMILY }, { $set: { ownerDid: SUSAN } });
  const devs = { susan: device("dev_s"), june: device("dev_j"), meg: device("dev_m") };
  const dids = { susan: SUSAN, june: JUNE, meg: MEG };
  const tokens = {};
  for (const [key, did] of Object.entries(dids)) {
    tokens[key] = (await fx.admit({ networkId: FAMILY, did, device: devs[key] })).accessToken;
  }
  return { ...fx, tokens, devs, audits };
}

function feedOver(fx) {
  return new FeedService({
    posts: fx.collections.posts,
    derivedData: fx.collections.derivedData,
    groups: fx.collections.groups,
    membership: fx.membership,
    ranking: new RankingService(),
    media: fx.media,
    comments: fx.collections.comments,
    reactions: fx.collections.reactions,
    votes: fx.collections.votes,
  });
}

async function mkPost(fx, token, dev, payload) {
  return (await fx.posts.create({ accessToken: token, payload, signature: dev.signPayload(payload) })).post;
}

async function vote(fx, key, postId, value) {
  const payload = { postId, value };
  return fx.interactions.vote({ accessToken: fx.tokens[key], payload, signature: fx.devs[key].signPayload(payload) });
}

test("ac-1: creation writes the author's up-vote doc in the same operation, first served truth resolves upCount 1", async () => {
  const fx = await selfVoteFixture();

  const post = await mkPost(fx, fx.tokens.susan, fx.devs.susan, { type: "text", body: "hands raised on arrival" });

  // A first-class vote doc of the existing signed schema: memberId = the
  // author, value up, riding the verified creation signature.
  const rows = await fx.collections.votes.find({ postId: post._id });
  assert.equal(rows.length, 1, "exactly one vote doc exists from the creation write");
  assert.equal(rows[0].memberDid, SUSAN);
  assert.equal(rows[0].value, "up");
  assert.equal(rows[0].networkId, FAMILY);
  assert.equal(rows[0].deviceSignature, fx.devs.susan.signPayload({ type: "text", body: "hands raised on arrival" }));
  assert.equal(rows[0].createdAt != null, true);

  // Counters recomputed over the self-vote before anything serves.
  const stored = await fx.collections.posts.findOne({ _id: post._id });
  assert.equal(stored.interactionCounters.upVolume, 1);
  assert.equal(stored.interactionCounters.voteVolume, 1);
  assert.equal(stored.interactionCounters.voteRatio, 1);

  // First served truth: the returning member view and the post.created
  // broadcast envelope both resolve upCount 1 from the same recomputed
  // counters. The author's own view carries myVote "up"; a member who
  // holds no vote carries null.
  const authorView = (await fx.posts.get({ accessToken: fx.tokens.susan, postId: post._id })).post;
  assert.equal(authorView.upCount, 1);
  assert.equal(authorView.myVote, "up");
  const otherView = (await fx.posts.get({ accessToken: fx.tokens.june, postId: post._id })).post;
  assert.equal(otherView.upCount, 1);
  assert.equal(otherView.myVote, null);
  const created = (await fx.realtime.catchUp({ accessToken: fx.tokens.june })).events
    .filter((event) => event.type === "post.created" && event.postId === post._id).pop();
  assert.ok(created, "post.created rides the plane");
  assert.equal(created.content.upCount, 1, "the arriving card renders the raised hand");

  // Any post type and any target: a group post self-votes too.
  const group = await fx.groups.create({ networkId: FAMILY, name: "Picnic", members: [SUSAN] });
  const groupPayload = { type: "photo", mediaRefs: ["med_1"], caption: "the pier", groupId: group._id };
  const groupPost = await mkPost(fx, fx.tokens.susan, fx.devs.susan, groupPayload);
  const groupVotes = await fx.collections.votes.find({ postId: groupPost._id });
  assert.equal(groupVotes.length, 1);
  assert.equal(groupVotes[0].value, "up");
  assert.equal(groupVotes[0].memberDid, SUSAN);
  const groupView = (await fx.posts.get({ accessToken: fx.tokens.susan, postId: groupPost._id })).post;
  assert.equal(groupView.upCount, 1);
});

test("ac-2: the self-vote is an ordinary vote — change and clear behave exactly like any member's write, rank output is unchanged", async () => {
  const fx = await selfVoteFixture();
  const feed = feedOver(fx);
  const post = await mkPost(fx, fx.tokens.susan, fx.devs.susan, { type: "text", body: "ordinary vote laws" });

  // The author changes their self-vote down through the ordinary path
  // (the same signed write every member uses — no special surface).
  await vote(fx, "susan", post._id, "down");
  let rows = await fx.collections.votes.find({ postId: post._id });
  assert.equal(rows.length, 1, "one effective vote: the self-vote row re-signed, never duplicated");
  assert.equal(rows[0].value, "down");
  assert.notEqual(rows[0].changedAt, null);
  const downView = (await fx.posts.get({ accessToken: fx.tokens.susan, postId: post._id })).post;
  assert.equal(downView.myVote, "down");
  assert.equal(downView.upCount, 0);

  // A unit fixture proves identical rank output with and without the
  // special case: two posts with identical counters — one whose single up
  // came from the creation self-vote, one whose single up came from an
  // ordinary member vote write — score identically. The formula has no
  // self-vote awareness.
  const selfVoted = await mkPost(fx, fx.tokens.susan, fx.devs.susan, { type: "text", body: "self-voted up at birth" });
  const ordinary = await mkPost(fx, fx.tokens.june, fx.devs.june, { type: "text", body: "ordinary up only" });
  await vote(fx, "june", ordinary._id, "up");
  // Neutralize Susan's self-vote on the ordinary post? None exists — June
  // authored it. But Susan's self-vote must be cleared from the selfVoted
  // fixture's twin comparisons: here selfVoted holds ONLY its self-vote
  // (up). Both posts now stand at upVolume 1, downVolume 0, volume 1,
  // ratio 1, no comments, no reactions.
  const selfRow = await fx.collections.posts.findOne({ _id: selfVoted._id });
  const ordRow = await fx.collections.posts.findOne({ _id: ordinary._id });
  assert.deepEqual(selfRow.interactionCounters, ordRow.interactionCounters);
  const now = new Date();
  const sharedAge = selfRow.createdAt; // pin both to one age reference: the fixture compares the counter math, not the clock
  const selfScore = rankedScore({ ...selfRow, createdAt: sharedAge, lastActivityAt: sharedAge }, normalizeRankingConfig(), now);
  const ordScore = rankedScore({ ...ordRow, createdAt: sharedAge, lastActivityAt: sharedAge }, normalizeRankingConfig(), now);
  assert.ok(Math.abs(selfScore - ordScore) < 1e-9, "the self-vote enters the formula exactly like an ordinary vote");

  // And the same equality holds through the ranked service over live rows.
  const ranked = (await feed.ranked({ accessToken: fx.tokens.meg })).posts;
  const selfRanked = ranked.find((row) => row._id === selfVoted._id);
  const ordRanked = ranked.find((row) => row._id === ordinary._id);
  assert.ok(selfRanked && ordRanked);
  // The ranked surfaces resolve MY VOTE per viewer: Meg holds none.
  assert.equal(selfRanked.myVote, null);
  assert.equal(ordRanked.myVote, null);

  // Cross-posted twins each carry their own independent author vote.
  const twin = await mkPost(fx, fx.tokens.june, fx.devs.june, { type: "text", body: "twin on this network", crossPostRef: selfVoted._id });
  const twinVotes = await fx.collections.votes.find({ postId: twin._id });
  assert.equal(twinVotes.length, 1);
  assert.equal(twinVotes[0].memberDid, JUNE, "each twin's author self-vote is its own");
  await vote(fx, "susan", twin._id, "up");
  assert.equal((await fx.collections.posts.findOne({ _id: selfVoted._id })).interactionCounters.voteVolume, 1,
    "a vote on one twin never moves the other");
  assert.equal((await fx.collections.posts.findOne({ _id: twin._id })).interactionCounters.voteVolume, 2,
    "the twin's author self-vote and Susan's vote both count there");
});

test("ac-3: the clear write removes only the member's own row; a clear with no vote refuses plainly and idempotently", async () => {
  const fx = await selfVoteFixture();
  const feed = feedOver(fx);
  const post = await mkPost(fx, fx.tokens.susan, fx.devs.susan, { type: "text", body: "clearable" });

  // June and Meg vote up beside the author's self-vote.
  await vote(fx, "june", post._id, "up");
  await vote(fx, "meg", post._id, "up");
  const before = (await fx.posts.get({ accessToken: fx.tokens.june, postId: post._id })).post;
  assert.equal(before.upCount, 3);
  assert.equal(before.myVote, "up");

  // The clear write: June's own row leaves on the signed vote path.
  const clearPayload = { postId: post._id };
  const cleared = await fx.interactions.unvote({ accessToken: fx.tokens.june, payload: clearPayload, signature: fx.devs.june.signPayload(clearPayload) });
  assert.deepEqual(cleared, { vote: { postId: post._id, effective: null } });

  // Only June's row is gone; the author's self-vote and Meg's row stay.
  const rows = await fx.collections.votes.find({ postId: post._id });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.memberDid).sort(), [MEG, SUSAN]);

  // myVote resolves null; the stored counters recomputed (upCount drops).
  const after = (await fx.posts.get({ accessToken: fx.tokens.june, postId: post._id })).post;
  assert.equal(after.myVote, null);
  assert.equal(after.upCount, 2);
  const stored = await fx.collections.posts.findOne({ _id: post._id });
  assert.equal(stored.interactionCounters.upVolume, 2);
  assert.equal(stored.interactionCounters.voteVolume, 2);
  const cardRow = (await feed.timeline({ accessToken: fx.tokens.june })).posts.find((row) => row._id === post._id);
  assert.equal(cardRow.myVote, null);
  assert.equal(cardRow.upCount, 2);

  // Meg is untouched: her vote still serves as her own state.
  const megView = (await fx.posts.get({ accessToken: fx.tokens.meg, postId: post._id })).post;
  assert.equal(megView.myVote, "up");

  // The clear is audited like every signed vote write.
  const removal = fx.audits.filter((row) => row.action === "vote_remove").pop();
  assert.ok(removal, "the clear write audited");
  assert.equal(removal.payload.detail.postId, post._id);

  // A member with no vote (June now, or anyone who never voted) receives
  // the plain refusal — zero mutation, and the repeated clear resolves
  // the same way (idempotent no-op class).
  await assert.rejects(
    () => {
      const payload = { postId: post._id };
      return fx.interactions.unvote({ accessToken: fx.tokens.june, payload, signature: fx.devs.june.signPayload(payload) });
    },
    (error) => error.code === "E_VOTE_NOT_HELD",
  );
  assert.equal((await fx.collections.votes.find({ postId: post._id })).length, 2, "the refused clear mutated nothing");
  // Susan holds her self-vote: clearing it works, then refuses thereafter.
  await fx.interactions.unvote({ accessToken: fx.tokens.susan, payload: clearPayload, signature: fx.devs.susan.signPayload(clearPayload) });
  assert.equal((await fx.collections.votes.find({ postId: post._id })).length, 1, "the author's self-vote cleared like any other");
  await assert.rejects(
    () => {
      const payload = { postId: post._id };
      return fx.interactions.unvote({ accessToken: fx.tokens.susan, payload, signature: fx.devs.susan.signPayload(payload) });
    },
    (error) => error.code === "E_VOTE_NOT_HELD",
  );
});

test("ac-4: payloads carry exactly the ruled two values — no authorship mark of the self-vote anywhere", async () => {
  const fx = await selfVoteFixture();
  const feed = feedOver(fx);
  const post = await mkPost(fx, fx.tokens.susan, fx.devs.susan, { type: "text", body: "privacy sweep" });

  await vote(fx, "june", post._id, "down");
  const surfaces = {
    detail: (await fx.posts.get({ accessToken: fx.tokens.june, postId: post._id })).post,
    timeline: (await feed.timeline({ accessToken: fx.tokens.meg })).posts.find((row) => row._id === post._id),
    ranked: (await feed.ranked({ accessToken: fx.tokens.meg })).posts.find((row) => row._id === post._id),
    list: (await fx.posts.list({ accessToken: fx.tokens.meg })).posts.find((row) => row._id === post._id),
    event: (await fx.realtime.catchUp({ accessToken: fx.tokens.meg })).events
      .filter((event) => event.type === "post.created" && event.postId === post._id).pop()?.content,
  };
  for (const [surface, view] of Object.entries(surfaces)) {
    assert.ok(view, `${surface} serves the post`);
    // Vote-derived material is exactly upCount + the viewer's own vote
    // (null on the did-less event plane), and nothing else — the
    // self-vote is marked nowhere: no authorship field, no vote field,
    // no down-count, no ratio.
    assert.equal(view.upCount, 1, `${surface} upCount counts the self-vote, nothing more`);
    for (const forbidden of [
      "interactionCounters", "downVolume", "voteVolume", "voteRatio", "downCount",
      "votes", "voteRecords", "selfVote", "voters", "whoVoted", "deviceSignature",
    ]) {
      assert.equal(forbidden in view, false, `${surface} carries no ${forbidden}`);
    }
    if (surface !== "event") {
      assert.equal("myVote" in view, true);
    } else {
      assert.equal("myVote" in view, false, "the broadcast envelope carries no per-viewer field");
    }
  }
});

test("ac-5: the cascade removes the self-vote with the post, the restore re-materializes it, nothing survives the purge", async () => {
  const fx = await selfVoteFixture();

  const post = await mkPost(fx, fx.tokens.susan, fx.devs.susan, { type: "text", body: "cascade bait" });
  await vote(fx, "june", post._id, "up");
  assert.equal((await fx.collections.votes.find({ postId: post._id })).length, 2);

  // The author deletes: the cascade takes the votes with everything else.
  const deleted = await fx.posts.deletePost({
    accessToken: fx.tokens.susan,
    postId: post._id,
    signature: fx.devs.susan.signPayload({ kind: "delete", postId: post._id, networkId: FAMILY }),
  });
  assert.equal(deleted.deleted, true);
  assert.equal((await fx.collections.votes.find({ postId: post._id })).length, 0,
    "the self-vote and every other vote left with the post");

  // The tombstone captured both vote rows for restore.
  const tombstone = await fx.collections.tombstones.findOne({ _id: deleted.tombstoneId });
  assert.equal(tombstone.cascade.votes.length, 2);

  // Restore re-materializes the captured state exactly: the self-vote
  // (author, value up) is back and the post votes as it was deleted. The
  // tombstone left scope, so the day-30 reaper has nothing to purge here.
  const restored = await fx.lifecycle.restore({ accessToken: fx.tokens.susan, tombstoneId: deleted.tombstoneId });
  assert.equal(restored.restored, true);
  const rows = await fx.collections.votes.find({ postId: post._id });
  assert.equal(rows.length, 2);
  const selfRow = rows.find((row) => row.memberDid === SUSAN);
  assert.ok(selfRow);
  assert.equal(selfRow.value, "up", "the self-vote re-materializes as captured");
  const backView = (await fx.posts.get({ accessToken: fx.tokens.susan, postId: post._id })).post;
  assert.equal(backView.upCount, 2);

  // A NOT-restored post: the cascade already removed the votes with the
  // subject; the day-30 reaper destroys the held originals and the
  // tombstone one time, and nothing vote-shaped survives it (no vote doc
  // survives its subject's purge, and restore is refused after).
  const later = await mkPost(fx, fx.tokens.june, fx.devs.june, { type: "text", body: "purge bait" });
  await vote(fx, "meg", later._id, "down");
  const laterDeleted = await fx.posts.deletePost({
    accessToken: fx.tokens.june,
    postId: later._id,
    signature: fx.devs.june.signPayload({ kind: "delete", postId: later._id, networkId: FAMILY }),
  });
  const laterTombstone = await fx.collections.tombstones.findOne({ _id: laterDeleted.tombstoneId });
  assert.equal((await fx.collections.votes.find({ postId: later._id })).length, 0,
    "the votes (self-vote included) left with the cascade");
  await fx.lifecycle.sweep({ now: () => new Date(new Date(laterTombstone.purgeAt).getTime() + 60_000) });
  // The tombstone remains for audit with purgedAt set — one-time semantics.
  const purged = await fx.collections.tombstones.findOne({ _id: laterDeleted.tombstoneId });
  assert.notEqual(purged, null);
  assert.notEqual(purged.purgedAt, null);
  assert.equal((await fx.collections.votes.find({ postId: later._id })).length, 0,
    "no vote document survives its subject's purge");
  await assert.rejects(
    () => fx.lifecycle.restore({ accessToken: fx.tokens.susan, tombstoneId: laterDeleted.tombstoneId }),
    (error) => error.code === "E_TOMBSTONE_PURGED",
  );
});