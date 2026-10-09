import { test } from "node:test";
import assert from "node:assert/strict";
import { device, fixture } from "./helpers/content.fixture.js";
import { RankingService, normalizeRankingConfig, rankedScore } from "../src/services/ranking.service.js";
import { FeedService } from "../src/services/feed.service.js";

const SUSAN = "did:porchlight:susan";
const JUNE = "did:porchlight:june";
const MEG = "did:porchlight:meg";
const FAMILY = "net_family";
const OTHER = "net_other";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function feedFixture() {
  const fx = fixture({ networkIds: [FAMILY, OTHER] });
  const dev = device("dev_s");
  const juneDev = device("dev_j");
  const megDev = device("dev_m");
  return { ...fx, dev, juneDev, megDev };
}

async function admitAll(fx, network = FAMILY) {
  const susan = (await fx.admit({ networkId: network, did: SUSAN, device: fx.dev })).accessToken;
  const june = (await fx.admit({ networkId: network, did: JUNE, device: fx.juneDev })).accessToken;
  const meg = (await fx.admit({ networkId: network, did: MEG, device: fx.megDev })).accessToken;
  return { susan, june, meg };
}

async function mkPost(fx, token, dev, payload) {
  return (await fx.posts.create({ accessToken: token, payload, signature: dev.signPayload(payload) })).post;
}

/** Feed service over the fixture's collections with the real ranking module. */
function withFeed(fx, rankingOverrides = {}) {
  const ranking = new RankingService(rankingOverrides);
  const feed = new FeedService({
    posts: fx.collections.posts,
    derivedData: fx.collections.derivedData,
    groups: fx.collections.groups,
    membership: fx.membership,
    ranking,
  });
  return { ranking, feed };
}

function feedOver(fx, ranking) {
  return new FeedService({
    posts: fx.collections.posts,
    derivedData: fx.collections.derivedData,
    groups: fx.collections.groups,
    membership: fx.membership,
    ranking,
  });
}

test("ac-1: base timeline is newest-first and latest activity bumps order posts", async () => {
  const fx = feedFixture();
  const { susan, june } = await admitAll(fx);
  const { feed } = withFeed(fx);

  const first = await mkPost(fx, susan, fx.dev, { type: "text", body: "older post" });
  const second = await mkPost(fx, june, fx.juneDev, { type: "text", body: "newer post" });
  // Two creates can land in the same millisecond; backdate the older post
  // so the reverse-chron asserts below are deterministic.
  await fx.collections.posts.updateOne({ _id: first._id }, { $set: { createdAt: new Date(Date.now() - 10_000).toISOString() } });

  let timeline = (await feed.timeline({ accessToken: susan })).posts;
  assert.deepEqual(timeline.map((post) => post._id), [second._id, first._id]);
  // Views carry no rank inputs and no signatures (vote privacy contract).
  assert.equal("interactionCounters" in timeline[0], false);
  assert.equal("deviceSignature" in timeline[0], false);

  // An interaction is the post's latest activity: commenting on the older
  // post moves it to the top of the reverse-chron base timeline. (A brief
  // pause keeps the bump strictly later than both creation timestamps.)
  await new Promise((resolve) => setTimeout(resolve, 5));
  const commentPayload = { postId: first._id, body: "bump" };
  await fx.interactions.comment({ accessToken: june, payload: commentPayload, signature: fx.juneDev.signPayload(commentPayload) });

  timeline = (await feed.timeline({ accessToken: susan })).posts;
  assert.deepEqual(timeline.map((post) => post._id), [first._id, second._id]);
  const stored = await fx.collections.posts.findOne({ _id: first._id });
  assert.ok(new Date(stored.lastActivityAt).getTime() >= new Date(stored.createdAt).getTime());

  // Origin containment: the timeline reads ONLY the token's origin network.
  const otherToken = (await fx.admit({ networkId: OTHER, did: SUSAN, device: fx.dev })).accessToken;
  const otherPost = await mkPost(fx, otherToken, fx.dev, { type: "text", body: "other origin" });
  const otherTimeline = (await feed.timeline({ accessToken: otherToken })).posts;
  assert.deepEqual(otherTimeline.map((post) => post._id), [otherPost._id]);
  // ...and the family timeline never mixes origins.
  assert.equal((await feed.timeline({ accessToken: susan })).posts.some((post) => post._id === otherPost._id), false);
});

test("ac-1: group timeline is the origin-filtered groupId query with no rank weight", async () => {
  const fx = feedFixture();
  const { susan, june } = await admitAll(fx);
  const { feed } = withFeed(fx);

  const group = await fx.groups.create({ networkId: FAMILY, name: "Picnic", members: [SUSAN, JUNE] });
  const main = await mkPost(fx, susan, fx.dev, { type: "text", body: "main post" });
  const picnic = await mkPost(fx, june, fx.juneDev, { type: "text", body: "picnic post", groupId: group._id });

  const groupView = await feed.groupTimeline({ accessToken: susan, groupId: group._id });
  assert.equal(groupView.group.name, "Picnic");
  assert.deepEqual(groupView.posts.map((post) => post._id), [picnic._id]);

  // Group posts also render in the main timeline (groups ruling Oct 8 2026).
  const base = (await feed.timeline({ accessToken: susan })).posts;
  assert.ok(base.some((post) => post._id === picnic._id));
  assert.ok(base.some((post) => post._id === main._id));

  await assert.rejects(
    () => feed.groupTimeline({ accessToken: susan, groupId: "grp_unknown" }),
    (error) => error.code === "E_GROUP_UNKNOWN",
  );
  // No cross-origin group reads: a group of another network is unknown here.
  await fx.admit({ networkId: OTHER, did: SUSAN, device: fx.dev });
  const otherGroup = await fx.groups.create({ networkId: OTHER, name: "Other", members: [SUSAN] });
  await assert.rejects(
    () => feed.groupTimeline({ accessToken: susan, groupId: otherGroup._id }),
    (error) => error.code === "E_GROUP_UNKNOWN",
  );
});

test("ac-2: the published formula scores volume, ratio, and age decay from config", async () => {
  const config = normalizeRankingConfig();
  const reference = "2026-10-08T00:00:00.000Z";
  const now = new Date(reference);

  const hot = {
    _id: "post_hot",
    createdAt: new Date(now.getTime() - 2 * HOUR).toISOString(),
    interactionCounters: { upVolume: 8, downVolume: 2, voteVolume: 10, voteRatio: 0.8, commentCount: 2, reactionCount: 1 },
  };
  // volume = 10*1 + 2*2 + 1*1 = 15; ratioFactor = 1 + 0.5*(0.8 - 0.5) = 1.15;
  // ageFactor = 2^(-2/48). Verified against the independent computation.
  const expected = 15 * 1.15 * Math.pow(2, -2 / 48);
  const score = rankedScore(hot, config, now);
  assert.ok(Math.abs(score - expected) < 1e-9);

  // Below the volume floor the ratio stays neutral (one vote cannot dominate).
  const oneVote = {
    _id: "post_one",
    createdAt: reference,
    interactionCounters: { upVolume: 1, downVolume: 0, voteVolume: 1, voteRatio: 1, commentCount: 0, reactionCount: 0 },
  };
  assert.equal(rankedScore(oneVote, config, now), Math.pow(2, 0));

  // Aged posts decay; age uses latest activity, falling back to createdAt.
  const decayed = {
    _id: "post_old",
    createdAt: new Date(now.getTime() - 4 * DAY).toISOString(),
    interactionCounters: { upVolume: 0, downVolume: 0, voteVolume: 0, voteRatio: 0, commentCount: 2, reactionCount: 0 },
  };
  assert.ok(Math.abs(rankedScore(decayed, config, now) - 4 * Math.pow(2, -96 / 48)) < 1e-9);
  const samePost = { ...decayed, lastActivityAt: reference };
  assert.equal(rankedScore(samePost, config, now), 4);
});

test("ac-2: rank order is deterministic, capped to the window, and owned by the ranking module", async () => {
  const fx = feedFixture();
  const { susan } = await admitAll(fx);
  const { feed } = withFeed(fx);
  const now = Date.now();

  const hot = {
    _id: "post_hot",
    originNetworkId: FAMILY,
    authorId: SUSAN,
    type: "text",
    createdAt: new Date(now - 2 * HOUR).toISOString(),
    interactionCounters: { upVolume: 8, downVolume: 2, voteVolume: 10, voteRatio: 0.8, commentCount: 2, reactionCount: 1 },
  };
  const stale = {
    _id: "post_stale",
    originNetworkId: FAMILY,
    authorId: SUSAN,
    type: "text",
    createdAt: new Date(now - 31 * DAY).toISOString(),
    interactionCounters: { upVolume: 90, downVolume: 0, voteVolume: 90, voteRatio: 1, commentCount: 50, reactionCount: 40 },
  };
  const fresh = {
    _id: "post_fresh",
    originNetworkId: FAMILY,
    authorId: SUSAN,
    type: "text",
    createdAt: new Date(now - 1 * HOUR).toISOString(),
    interactionCounters: { upVolume: 0, downVolume: 0, voteVolume: 0, voteRatio: 0, commentCount: 1, reactionCount: 0 },
  };
  await fx.collections.posts.insertOne(hot);
  await fx.collections.posts.insertOne(stale);
  await fx.collections.posts.insertOne(fresh);

  // The ranking module is the sole writer of ranked order (AI-exclusion by
  // isolation): the feed service adopts its order verbatim. Prove it with a
  // ranking stub emitting an arbitrary, unnatural order.
  const feedWithStub = feedOver(fx, {
    rank: (posts) => ["post_fresh", "post_stale", "post_hot"].map((id) => ({ post: posts.find((p) => p._id === id), score: 0 })),
  });
  const forced = (await feedWithStub.ranked({ accessToken: susan })).posts;
  assert.deepEqual(
    forced.map((post) => post._id),
    ["post_fresh", "post_stale", "post_hot"],
    "ranked output is exactly the ranking module's order (stub honored verbatim)",
  );

  // With the real ranking module the order is deterministic across reads
  // and capped to the window: the 31-day-old post ages out despite its
  // huge score.
  const ranked = (await feed.ranked({ accessToken: susan })).posts;
  assert.deepEqual(
    ranked.map((post) => post._id),
    ["post_hot", "post_fresh"],
    "recompute is capped to the 30-day window",
  );
  const rankedAgain = (await feed.ranked({ accessToken: susan })).posts;
  assert.deepEqual(rankedAgain.map((post) => post._id), ranked.map((post) => post._id), "same inputs, same order (deterministic)");

  // The base timeline never re-sorts by rank: newest-first by latest
  // activity, aged-out post included.
  const timeline = (await feed.timeline({ accessToken: susan })).posts;
  assert.deepEqual(timeline.map((post) => post._id), ["post_fresh", "post_hot", "post_stale"]);
});

test("ac-2: parameters are owner-readable named configuration values", async () => {
  const service = new RankingService();
  const described = service.describe();
  assert.equal(typeof described.formula, "string");
  assert.deepEqual(Object.keys(described.parameters).sort(), ["ageDecay", "ratio", "weights", "window"]);
  assert.deepEqual(Object.keys(described.parameters.weights).sort(), ["comment", "reaction", "vote"]);
  assert.equal(described.parameters.window.days, 30);
  assert.equal(described.parameters.ageDecay.halfLifeHours, 48);
  assert.equal(described.parameters.ratio.volumeFloor, 2);

  assert.throws(() => normalizeRankingConfig({ weights: { ml: 3 } }));
  assert.throws(() => normalizeRankingConfig({ window: { days: -1 } }));
});

test("ac-3: vote records and aggregates never reach a client", async () => {
  const fx = feedFixture();
  const { susan, june, meg } = await admitAll(fx);
  const { feed } = withFeed(fx);

  const post = await mkPost(fx, susan, fx.dev, { type: "text", body: "vote me", caption: "captioned" });
  const votes = [
    [susan, fx.dev, "up"],
    [june, fx.juneDev, "up"],
    [meg, fx.megDev, "down"],
  ];
  for (const [token, dev, value] of votes) {
    const payload = { postId: post._id, value };
    await fx.interactions.vote({ accessToken: token, payload, signature: dev.signPayload(payload) });
  }
  assert.equal((await fx.collections.votes.find({ postId: post._id })).length, 3, "votes are stored for ranking only");

  // Every read surface returns member views only: no counters, no ratios,
  // no per-member vote records — prominence order is all a client sees.
  const surfaces = [
    ...(await feed.ranked({ accessToken: susan })).posts,
    ...(await feed.timeline({ accessToken: susan })).posts,
    ...(await fx.posts.list({ accessToken: susan })).posts,
    (await fx.posts.get({ accessToken: susan, postId: post._id })).post,
  ];
  for (const view of surfaces) {
    assert.equal("interactionCounters" in view, false);
    assert.equal("voteVolume" in view, false);
    assert.equal("voteRatio" in view, false);
    assert.equal("deviceSignature" in view, false);
    assert.equal("votes" in view, false);
  }

  // No vote-read surface exists on the interaction service: votes flow to
  // the formula through the stored counters only.
  assert.equal(typeof fx.interactions.votesFor, "undefined");
  assert.equal(typeof fx.interactions.voteCounts, "undefined");
  assert.equal(typeof fx.interactions.voteRatios, "undefined");
});

test("ac-4: hidden lists are client-local — the server stores no hidden state", async () => {
  const fx = feedFixture();
  const { susan } = await admitAll(fx);

  // The feed path opens only posts, derived_data, and groups (plus the
  // membership perimeter): no hidden-list collection is ever touched.
  // `groups` is the PORCH-030 group-chip decoration read — a group's name
  // decorates member views; it stores no hidden-list state.
  const opened = [];
  const recording = (name, coll) => ({
    findOne: (...a) => (opened.push(name), coll.findOne(...a)),
    find: (...a) => (opened.push(name), coll.find(...a)),
  });
  const recordingMembership = {
    verifyAccessToken: (token) => {
      opened.push("membership");
      return fx.membership.verifyAccessToken(token);
    },
  };
  const spyFeed = new FeedService({
    posts: recording("posts", fx.collections.posts),
    derivedData: recording("derived_data", fx.collections.derivedData),
    groups: recording("groups", fx.collections.groups),
    membership: recordingMembership,
    ranking: new RankingService(),
  });

  const post = await mkPost(fx, susan, fx.dev, { type: "text", body: "hideable" });
  const second = await mkPost(fx, susan, fx.dev, { type: "text", body: "another" });
  opened.length = 0;
  await spyFeed.timeline({ accessToken: susan });
  await spyFeed.ranked({ accessToken: susan });
  await spyFeed.search({ accessToken: susan, query: "hideable" });
  assert.deepEqual([...new Set(opened)].sort(), ["derived_data", "groups", "membership", "posts"], "no hidden-list storage is ever opened by feed reads");
  assert.equal(typeof spyFeed.storeHidden === "function", false, "no hidden-write surface exists on the feed service");

  // The client-side application: hidden ids drop from BOTH surfaces at
  // render; the server keeps serving them untouched to everyone else.
  const hidden = new Set([post._id]);
  const base = (await spyFeed.timeline({ accessToken: susan })).posts;
  const ranked = (await spyFeed.ranked({ accessToken: susan })).posts;
  assert.deepEqual(FeedService.applyHidden(base, hidden).map((p) => p._id), [second._id]);
  assert.deepEqual(FeedService.applyHidden(ranked, hidden).map((p) => p._id), [second._id]);
  assert.equal((await spyFeed.timeline({ accessToken: susan })).posts.length, 2);
});

test("ac-5: plain-text search spans captions, people tags, and album names within the origin", async () => {
  const fx = feedFixture();
  const { susan, june } = await admitAll(fx);
  const { feed } = withFeed(fx);

  const captioned = await mkPost(fx, susan, fx.dev, { type: "photo", mediaRefs: ["med_1"], caption: "Picnic at the Lake" });
  const tagged = await mkPost(fx, june, fx.juneDev, { type: "photo", mediaRefs: ["med_2"], caption: "sunday" });
  const albumPost = await mkPost(fx, susan, fx.dev, { type: "photo", mediaRefs: ["med_3"], caption: "unrelated" });
  await fx.collections.derivedData.insertOne({
    _id: "ddt_tag_1", networkId: FAMILY, postId: tagged._id, class: "tag", value: "Aunt June", createdAt: new Date().toISOString(),
  });
  await fx.collections.derivedData.insertOne({
    _id: "ddt_album_1", networkId: FAMILY, postId: albumPost._id, class: "album_membership", value: "Summer 2026 Album", createdAt: new Date().toISOString(),
  });
  // Origin-scoped: a caption outside the token's network never matches.
  const otherToken = (await fx.admit({ networkId: OTHER, did: SUSAN, device: fx.dev })).accessToken;
  const otherPost = await mkPost(fx, otherToken, fx.dev, { type: "photo", mediaRefs: ["med_9"], caption: "other-origin picnic" });

  const byCaption = await feed.search({ accessToken: susan, query: "picnic at the" });
  assert.deepEqual(byCaption.posts.map((post) => post._id), [captioned._id]);

  const byTag = await feed.search({ accessToken: susan, query: "june" });
  assert.deepEqual(byTag.posts.map((post) => post._id), [tagged._id]);

  const byAlbum = await feed.search({ accessToken: susan, query: "summer" });
  assert.deepEqual(byAlbum.posts.map((post) => post._id), [albumPost._id]);

  const foreign = await feed.search({ accessToken: otherToken, query: "picnic" });
  assert.deepEqual(foreign.posts.map((post) => post._id), [otherPost._id], "search is scoped to the token's origin network");

  await assert.rejects(
    () => feed.search({ accessToken: susan, query: "   " }),
    (error) => error.code === "E_SEARCH_QUERY_REQUIRED",
  );
});