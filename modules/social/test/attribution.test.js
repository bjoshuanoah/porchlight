import { test } from "node:test";
import assert from "node:assert/strict";
import { device, fixture } from "./helpers/content.fixture.js";
import { FeedService } from "../src/services/feed.service.js";
import { assembleSocialModule } from "../src/assemble.js";

const SUSAN = "did:porchlight:susan";
const JUNE = "did:porchlight:june";
const STRANGER = "did:porchlight:stranger";
const FAMILY = "net_family";
const OTHER = "net_other";

/**
 * PORCH-034: authored-content attribution resolves the author's
 * family-facing name at READ time against the ORIGIN network's active
 * membership — on the feed (base, group, ranked, search), post detail,
 * reply threads, and album items — for every member's perspective,
 * including self-attribution. Nothing is frozen on the documents, votes
 * and reactions surfaces stay untouched, and a DID that holds no active
 * membership at the origin renders nameless.
 */

/** Mutable presentation plane: names change without reshipping content (ac-3). */
const names = {
  [SUSAN]: "Susan Hale",
  [JUNE]: "June River",
};
const nameResolver = async (dids) => dids.map((did) => ({ did, displayName: names[did] ?? null }));

async function attributedFixture() {
  const fx = fixture({ memberNames: nameResolver });
  const susanDev = device("dev_s");
  const juneDev = device("dev_j");
  const susanToken = (await fx.admit({ networkId: FAMILY, did: SUSAN, device: susanDev })).accessToken;
  const juneToken = (await fx.admit({ networkId: FAMILY, did: JUNE, device: juneDev })).accessToken;
  return { ...fx, susanDev, juneDev, susanToken, juneToken };
}

async function mkPost(fx, token, dev, payload) {
  return (await fx.posts.create({ accessToken: token, payload, signature: dev.signPayload(payload) })).post;
}

function feedOver(fx) {
  return new FeedService({
    posts: fx.collections.posts,
    derivedData: fx.collections.derivedData,
    groups: fx.collections.groups,
    membership: fx.membership,
    ranking: { rank: (rows) => rows.map((post) => ({ post })) },
  });
}

test("ac-1: feed, post detail, and reply threads carry the author's real name", async () => {
  const fx = await attributedFixture();
  const { feed } = { feed: feedOver(fx) };
  const post = await mkPost(fx, fx.juneToken, fx.juneDev, { type: "text", body: "picnic sunday" });

  const timeline = (await feed.timeline({ accessToken: fx.susanToken })).posts;
  assert.equal(timeline.find((row) => row._id === post._id).authorName, "June River");

  const detail = (await fx.posts.get({ accessToken: fx.susanToken, postId: post._id })).post;
  assert.equal(detail.authorName, "June River");

  const commentPayload = { postId: post._id, body: "we'll bring the drinks" };
  const comment = (await fx.interactions.comment({
    accessToken: fx.susanToken,
    payload: commentPayload,
    signature: fx.susanDev.signPayload(commentPayload),
  })).comment;
  assert.equal(comment.authorName, "Susan Hale");

  const thread = (await fx.interactions.commentThread({ accessToken: fx.juneToken, postId: post._id })).comments;
  assert.equal(thread.find((row) => row._id === comment._id).authorName, "Susan Hale");
});

test("ac-1: the timeline carries no counter, ratio, or vote-privacy leak beyond the name", async () => {
  const fx = await attributedFixture();
  const feed = feedOver(fx);
  const post = await mkPost(fx, fx.juneToken, fx.juneDev, { type: "text", body: "hello" });
  const row = (await feed.timeline({ accessToken: fx.susanToken })).posts.find((item) => item._id === post._id);
  assert.equal(row.authorName, "June River");
  for (const key of ["interactionCounters", "deviceSignature", "upVolume", "voteRatio"]) {
    assert.equal(key in row, false);
  }
});

test("ac-2: attribution is symmetric, including self-attribution on one's own post", async () => {
  const fx = await attributedFixture();
  const feed = feedOver(fx);
  const post = await mkPost(fx, fx.juneToken, fx.juneDev, { type: "text", body: "from june" });

  for (const viewerToken of [fx.susanToken, fx.juneToken]) {
    const row = (await feed.timeline({ accessToken: viewerToken })).posts.find((item) => item._id === post._id);
    assert.equal(row.authorName, "June River");
    const detail = (await fx.posts.get({ accessToken: viewerToken, postId: post._id })).post;
    assert.equal(detail.authorName, "June River");
  }
  // Self-attribution: June's own authored post names June, not a placeholder.
  const ownRow = (await feed.timeline({ accessToken: fx.juneToken })).posts.find((item) => item._id === post._id);
  assert.equal(ownRow.authorName, "June River");
  const ownDetail = (await fx.posts.get({ accessToken: fx.juneToken, postId: post._id })).post;
  assert.equal(ownDetail.authorName, "June River");
});

test("ac-3: attribution resolves at read time — a name change shows on the next read, nothing frozen on the document", async () => {
  const fx = await attributedFixture();
  const feed = feedOver(fx);
  const post = await mkPost(fx, fx.juneToken, fx.juneDev, { type: "text", body: "same post, new name" });

  const before = (await feed.timeline({ accessToken: fx.susanToken })).posts.find((row) => row._id === post._id);
  assert.equal(before.authorName, "June River");

  names[JUNE] = "June Appleby";
  const after = (await feed.timeline({ accessToken: fx.susanToken })).posts.find((row) => row._id === post._id);
  assert.equal(after.authorName, "June Appleby");

  const stored = await fx.collections.posts.findOne({ _id: post._id });
  assert.equal("authorName" in stored, false);
  names[JUNE] = "June River"; // restore the presentation plane for later tests
});

test("ac-4: names resolve against the origin network's membership only", async () => {
  const fx = fixture({ memberNames: nameResolver });
  const susanDev = device("dev_s");
  const juneDev = device("dev_j");
  const familyToken = (await fx.admit({ networkId: FAMILY, did: SUSAN, device: susanDev })).accessToken;
  const otherToken = (await fx.admit({ networkId: OTHER, did: JUNE, device: juneDev })).accessToken;
  const otherPost = await mkPost(fx, otherToken, juneDev, { type: "text", body: "posted at the other network" });

  // Susan's token scopes exactly one origin; the other network's author
  // is unresolvable there — nameless fallback, never a cross-origin name.
  const timeline = (await feedOver(fx).timeline({ accessToken: familyToken })).posts;
  assert.equal(timeline.find((row) => row._id === otherPost._id), undefined);

  const roster = await fx.membership.attributionNames({
    networkId: FAMILY,
    dids: [SUSAN, JUNE, STRANGER],
  });
  // JUNE holds no FAMILY membership: no name crosses the origin boundary.
  assert.deepEqual(roster, new Map([[SUSAN, "Susan Hale"]]));

  const otherRoster = await fx.membership.attributionNames({ networkId: OTHER, dids: [JUNE] });
  assert.deepEqual(otherRoster, new Map([[JUNE, "June River"]]));
});

test("ac-4: revoked membership loses attribution; reactions and votes render exactly as before", async () => {
  const fx = await attributedFixture();
  const feed = feedOver(fx);
  const post = await mkPost(fx, fx.juneToken, fx.juneDev, { type: "text", body: "before revocation" });

  const reactionPayload = { postId: post._id, emoji: "🌻" };
  const reaction = (await fx.interactions.react({
    accessToken: fx.susanToken,
    payload: reactionPayload,
    signature: fx.susanDev.signPayload(reactionPayload),
  })).reaction;
  assert.deepEqual(Object.keys(reaction).sort(), ["_id", "createdAt", "emoji", "memberDid"]);
  const reactions = (await fx.interactions.reactionsFor({ accessToken: fx.susanToken, postId: post._id })).reactions;
  assert.deepEqual(reactions.map((row) => ({ emoji: row.emoji, createdAt: row.createdAt })), [
    { emoji: "🌻", createdAt: reaction.createdAt },
  ]);
  const replyPayload = { postId: post._id, body: "counting us in" };
  const reply = (await fx.interactions.comment({
    accessToken: fx.susanToken,
    payload: replyPayload,
    signature: fx.susanDev.signPayload(replyPayload),
  })).comment;
  const votePayload = { postId: post._id, value: "up" };
  const vote = (await fx.interactions.vote({
    accessToken: fx.susanToken,
    payload: votePayload,
    signature: fx.susanDev.signPayload(votePayload),
  })).vote;
  assert.deepEqual(vote, { postId: post._id, effective: "up" });

  const revoked = await fx.membership.revokeMember({ networkId: FAMILY, did: JUNE });
  assert.equal(revoked.revoked, true);

  const after = (await feed.timeline({ accessToken: fx.susanToken })).posts.find((row) => row._id === post._id);
  assert.equal(after.authorName, null);

  // Reactions stay as-given and votes stay undiscoverable after the revocation.
  const reactionsAfter = (await fx.interactions.reactionsFor({ accessToken: fx.susanToken, postId: post._id })).reactions;
  assert.deepEqual(reactionsAfter, [{ _id: reactions[0]._id, memberDid: SUSAN, emoji: "🌻", createdAt: reaction.createdAt }]);
  const threadAfter = (await fx.interactions.commentThread({ accessToken: fx.susanToken, postId: post._id })).comments;
  assert.deepEqual(
    threadAfter.map((row) => ({ id: row._id, authorName: row.authorName })),
    [{ id: reply._id, authorName: "Susan Hale" }],
  );
});

test("attribution rides every decorated view: search, ranked, albums, and the base content list", async () => {
  const fx = await attributedFixture();
  const feed = feedOver(fx);
  const post = await mkPost(fx, fx.juneToken, fx.juneDev, { type: "text", body: "lake day", caption: "the lake" });

  const searched = (await feed.search({ accessToken: fx.susanToken, query: "lake" })).posts;
  assert.equal(searched.find((row) => row._id === post._id).authorName, "June River");
  const ranked = (await feed.ranked({ accessToken: fx.susanToken })).posts;
  assert.equal(ranked.find((row) => row._id === post._id).authorName, "June River");
  const listed = (await fx.posts.list({ accessToken: fx.susanToken })).posts;
  assert.equal(listed.find((row) => row._id === post._id).authorName, "June River");

  const mod = assembleSocialModule(fx.store, {
    verifyMemberIdToken: (token) => (token ? { did: token } : null),
    memberNames: nameResolver,
    media: { diskProbe: async () => ({ totalBytes: 1_000_000, freeBytes: 900_000 }) },
  });
  const albumPayload = { kind: "album.add", networkId: FAMILY, postId: post._id, album: "Lake" };
  await mod.albumService.addItem({ accessToken: fx.susanToken, name: "Lake", postId: post._id, signature: fx.susanDev.signPayload(albumPayload) });
  const album = (await mod.albumService.get({ accessToken: fx.susanToken, name: "Lake" })).posts;
  assert.equal(album.find((row) => row._id === post._id).authorName, "June River");
});

test("an assembly without the identity name resolver still serves views with nameless attribution", async () => {
  const fx = fixture();
  const dev = device("dev_s");
  const token = (await fx.admit({ networkId: FAMILY, did: SUSAN, device: dev })).accessToken;
  const feed = feedOver(fx);
  const post = await mkPost(fx, token, dev, { type: "text", body: "unnamed hub" });
  const row = (await feed.timeline({ accessToken: token })).posts.find((item) => item._id === post._id);
  assert.equal(row.authorName, null);
});