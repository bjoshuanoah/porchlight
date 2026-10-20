import { test } from "node:test";
import assert from "node:assert/strict";
import { device, fixture } from "./helpers/content.fixture.js";
import { RankingService } from "../src/services/ranking.service.js";
import { FeedService } from "../src/services/feed.service.js";

// PORCH-103 — Vote display, server half (vote-display ruling, Brian,
// Oct 19, 2026): served post payloads carry exactly two vote-derived values
// — the post's up-vote count (`upCount`) and the viewer's OWN effective
// vote (`myVote`) — and every other vote quantity (down-counts, ratios,
// per-member vote records, who-else-voted) stays off every read surface,
// event, and catch-up. Ranking is untouched: the formula keeps consuming
// the stored recount aggregates.

const SUSAN = "did:porchlight:susan";
const JUNE = "did:porchlight:june";
const MEG = "did:porchlight:meg";
const ANN = "did:porchlight:ann";
const PAT = "did:porchlight:pat";
const KIM = "did:porchlight:kim";
const FAMILY = "net_family";

/** A fresh fixture with five admitted members and their devices. */
async function votedFixture() {
  const fx = fixture({ networkIds: [FAMILY] });
  const devs = {
    [SUSAN]: device("dev_s"),
    [JUNE]: device("dev_j"),
    [MEG]: device("dev_m"),
    [ANN]: device("dev_a"),
    [PAT]: device("dev_p"),
    [KIM]: device("dev_k"),
  };
  const tokens = {};
  for (const did of Object.keys(devs)) {
    tokens[did] = (await fx.admit({ networkId: FAMILY, did, device: devs[did] })).accessToken;
  }
  return { fx, devs, tokens };
}

/** The feed service assembled exactly as the module wire does: votes rides. */
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


test("ac-1: upCount rides the card/detail payloads and no other vote aggregate does", async () => {
  const { fx, devs, tokens } = await votedFixture();
  const feed = feedOver(fx);
  const post = await mkPost(fx, tokens[SUSAN], devs[SUSAN], { type: "text", body: "two ups and a down", caption: "two ups and a down" });

  // Three signed votes through the real write path: two ups, one down.
  // PORCH-113: Susan's self-vote (the creation write, up) rides the post
  // already — the two member ups make upCount 3.
  for (const [did, value] of [[JUNE, "up"], [MEG, "up"], [ANN, "down"]]) {
    const payload = { postId: post._id, value };
    await fx.interactions.vote({ accessToken: tokens[did], payload, signature: devs[did].signPayload(payload) });
  }

  // Card reads (as KIM, who holds no vote): the timeline, the ranked
  // section, search, and the base list all carry exactly upCount = 3 and
  // no vote for a viewer who holds none.
  const surfaces = {
    timeline: (await feed.timeline({ accessToken: tokens[KIM] })).posts,
    ranked: (await feed.ranked({ accessToken: tokens[KIM] })).posts,
    search: (await feed.search({ accessToken: tokens[KIM], query: "two ups" })).posts,
    list: (await fx.posts.list({ accessToken: tokens[KIM] })).posts,
  };
  for (const [surface, posts] of Object.entries(surfaces)) {
    const row = posts.find((entry) => entry._id === post._id);
    assert.ok(row, `${surface} serves the post`);
    assert.equal(row.upCount, 3, `${surface} carries the up-vote count`);
    assert.equal(row.myVote, null, `${surface} carries no vote for a viewer who holds none`);
    for (const forbidden of ["interactionCounters", "downVolume", "voteVolume", "voteRatio", "voteCount", "downCount", "downvotes", "votes", "voteRecords", "deviceSignature"]) {
      assert.equal(forbidden in row, false, `${surface} carries no ${forbidden} (no other vote aggregate)`);
    }
  }

  // The detail read carries the same single quantity.
  const detail = (await fx.posts.get({ accessToken: tokens[MEG], postId: post._id })).post;
  assert.equal(detail.upCount, 3);
  for (const forbidden of ["interactionCounters", "downVolume", "voteVolume", "voteRatio", "downCount", "votes"]) {
    assert.equal(forbidden in detail, false);
  }

  // No other vote aggregate is anywhere in the serialized payloads.
  const wire = JSON.stringify([...Object.values(surfaces).flat(), detail]);
  assert.equal(wire.includes('"voteRatio"'), false);
  assert.equal(wire.includes('"downVolume"'), false);
});

test("ac-2: the viewer's own vote rides their payload and their flip lands in the next read", async () => {
  const { fx, devs, tokens } = await votedFixture();
  const feed = feedOver(fx);
  const post = await mkPost(fx, tokens[SUSAN], devs[SUSAN], { type: "text", body: "flip me" });

  // June holds no vote: myVote is explicitly null, never undefined-shaped
  // absence. The post's upCount already resolves Susan's creation
  // self-vote (PORCH-113).
  const before = (await fx.posts.get({ accessToken: tokens[JUNE], postId: post._id })).post;
  assert.equal(before.myVote, null);
  assert.equal(before.upCount, 1);

  // Susan re-states her self-vote through the ordinary write: identical
  // semantics to any member (one effective vote), upCount stays 1.
  await fx.interactions.vote({
    accessToken: tokens[SUSAN],
    payload: { postId: post._id, value: "up" },
    signature: devs[SUSAN].signPayload({ postId: post._id, value: "up" }),
  });
  const susanRow = (await fx.posts.get({ accessToken: tokens[SUSAN], postId: post._id })).post;
  assert.equal(susanRow.myVote, "up");
  assert.equal(susanRow.upCount, 1);
  // June's payload carries exactly June's (still no vote).
  const juneRow = (await fx.posts.get({ accessToken: tokens[JUNE], postId: post._id })).post;
  assert.equal(juneRow.myVote, null);
  assert.equal(juneRow.upCount, 1);

  // June votes up too: upCount = 2 with both self-states intact.
  await fx.interactions.vote({
    accessToken: tokens[JUNE],
    payload: { postId: post._id, value: "up" },
    signature: devs[JUNE].signPayload({ postId: post._id, value: "up" }),
  });

  // Susan flips up → down: the write lands and the next payload resolves
  // her self-state as "down" while the up-count drops to 1 — the two ruled
  // values move together, exactly as the ruling reads.
  await fx.interactions.vote({
    accessToken: tokens[SUSAN],
    payload: { postId: post._id, value: "down" },
    signature: devs[SUSAN].signPayload({ postId: post._id, value: "down" }),
  });
  const flipped = (await fx.posts.get({ accessToken: tokens[SUSAN], postId: post._id })).post;
  assert.equal(flipped.myVote, "down");
  assert.equal(flipped.upCount, 1);
  const juneAfter = (await fx.posts.get({ accessToken: tokens[JUNE], postId: post._id })).post;
  assert.equal(juneAfter.myVote, "up");
  assert.equal(juneAfter.upCount, 1, "only Susan flipped — June's up vote still counts");

  // The same two values ride the card reads (timeline row).
  const timelineRow = (await feed.timeline({ accessToken: tokens[SUSAN] })).posts.find((row) => row._id === post._id);
  assert.equal(timelineRow.myVote, "down");
  assert.equal(timelineRow.upCount, 1);
});

test("ac-3: no down-vote count, ratio, or another member's vote record on any surface", async () => {
  const { fx, devs, tokens } = await votedFixture();
  const feed = feedOver(fx);
  const post = await mkPost(fx, tokens[SUSAN], devs[SUSAN], { type: "text", body: "five downs and two ups" });

  // Five up-voters, then flip every one of them down: the post holds
  // exactly five down-votes and two live ups afterwards (JUNE and MEG stay
  // up from the next test's shape — here: no ups at all).
  for (const did of [JUNE, MEG, ANN, PAT, KIM]) {
    await fx.interactions.vote({
      accessToken: tokens[did],
      payload: { postId: post._id, value: "down" },
      signature: devs[did].signPayload({ postId: post._id, value: "down" }),
    });
  }

  // PORCH-113: Susan's creation self-vote (up) is her effective vote. The
  // five member downs stay off her payload: she reads upCount 1 (her own
  // up) and her own vote state — no count, no ratio, no record of the
  // five down-votes.
  const card = (await feed.timeline({ accessToken: tokens[SUSAN] })).posts.find((row) => row._id === post._id);
  const detail = (await fx.posts.get({ accessToken: tokens[SUSAN], postId: post._id })).post;
  for (const view of [card, detail]) {
    assert.equal(view.upCount, 1);
    assert.equal(view.myVote, "up");
    const fields = Object.keys(view);
    assert.equal(
      fields.filter((field) => /^(down|ratio|score|volume|whoVoted|voters)/i.test(field)).length,
      0,
      `no down-bearing or aggregate field: ${fields.join(", ")}`,
    );
  }
  // No representation of the five down-votes exists anywhere on the payload's
  // substance. The clock strings (createdAt and its derivatives) are stripped
  // before the sweep: an ISO timestamp whose minute or second starts with 5
  // ("…T13:50:22Z") carries ":5" with the wall clock, not with vote data —
  // the raw blob check was time-of-day flaky (caught running off CI, Oct 19).
  const withoutClock = JSON.stringify(card)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, "");
  assert.equal(withoutClock.includes(":5"), false, "no representation of the five down-votes exists");

  // Susan DOES vote down: her own payload may carry exactly her own state.
  await fx.interactions.vote({
    accessToken: tokens[SUSAN],
    payload: { postId: post._id, value: "down" },
    signature: devs[SUSAN].signPayload({ postId: post._id, value: "down" }),
  });
  const susanRow = (await fx.posts.get({ accessToken: tokens[SUSAN], postId: post._id })).post;
  assert.equal(susanRow.myVote, "down");
  assert.equal(susanRow.upCount, 0);

  // MEG's payload carries exactly MEG's state — never Susan's.
  const megRow = (await fx.posts.get({ accessToken: tokens[MEG], postId: post._id })).post;
  assert.equal(megRow.myVote, "down");
  // And ANN, who flipped nothing else, sees only her own value as well.
  const juneRow = (await fx.posts.get({ accessToken: tokens[JUNE], postId: post._id })).post;
  assert.equal(juneRow.myVote, "down");
});

test("ac-3: event envelopes and catch-up carry upCount only — no myVote, no down data", async () => {
  const { fx, devs, tokens } = await votedFixture();
  const post = await mkPost(fx, tokens[SUSAN], devs[SUSAN], { type: "text", body: "live card" });

  // Susan casts an up vote: the write recomputes the counter but emits NO
  // vote event (the closed vocabulary has no vote type).
  const eventsBefore = (await fx.realtime.catchUp({ accessToken: tokens[JUNE] })).events;
  await fx.interactions.vote({
    accessToken: tokens[SUSAN],
    payload: { postId: post._id, value: "up" },
    signature: devs[SUSAN].signPayload({ postId: post._id, value: "up" }),
  });
  const eventsAfter = (await fx.realtime.catchUp({ accessToken: tokens[JUNE] })).events;
  const caught = eventsAfter.filter(
    (event) => event.type === "reply.created" || event.type === "reaction.applied",
  );
  assert.equal(eventsAfter.length - eventsBefore.length, 0, "no vote event exists in the vocabulary");
  assert.ok(eventsBefore.length > 0 || caught.length === 0);

  // The post.created envelope replays with the ruled public quantity on
  // its payload (upCount live at composition — the creation self-vote
  // already counts, PORCH-113) — and no per-member vote field, no
  // down-count, no ratio anywhere in the envelope.
  const created = eventsAfter.find((event) => event.type === "post.created" && event.postId === post._id);
  assert.ok(created, "post.created replays through catch-up");
  assert.equal(created.content.upCount, 1, "the envelope carries the up-count as it stood at publication");
  for (const forbidden of ["myVote", "downVolume", "voteVolume", "voteRatio", "votes", "downCount", "deviceSignature"]) {
    assert.equal(forbidden in created.content, false, `no ${forbidden} on the event payload`);
  }

  // The same guard composes post.updated envelopes: an edit publishes the
  // decorated view with upCount, never the viewer's vote.
  await fx.posts.editPost({
    accessToken: tokens[SUSAN],
    postId: post._id,
    payload: { body: "live card, edited" },
    signature: devs[SUSAN].signPayload({ kind: "post-edit", postId: post._id, networkId: FAMILY, body: "live card, edited" }),
  });
  const replayed = (await fx.realtime.catchUp({ accessToken: tokens[MEG], since: created.seq })).events;
  const updated = replayed.find((event) => event.type === "post.updated");
  assert.ok(updated, "post.updated rides catch-up");
  assert.equal(updated.content.upCount, 1, "the edit envelope carries the live up-count");
  for (const forbidden of ["myVote", "downVolume", "voteVolume", "voteRatio", "votes", "downCount"]) {
    assert.equal(forbidden in updated.content, false);
  }
});

test("ac-4: ranking behavior is unchanged — the formula still consumes the stored aggregates only", async () => {
  const { fx, devs, tokens } = await votedFixture();
  const feed = feedOver(fx);
  const post = await mkPost(fx, tokens[SUSAN], devs[SUSAN], { type: "text", body: "rank source" });

  // Two member ups on top of the self-vote put voteVolume at 3 with ratio
  // 1: rankedScore = (3*1) * (1 + 0.5*(1 - 0.5)) * ageFactor = 3.75 *
  // ageFactor — exactly the published formula over the stored counters,
  // with no contribution from the serving fields and no special weight
  // for the self-vote (it enters volume and ratio as an ordinary vote,
  // PORCH-113).
  for (const did of [JUNE, MEG]) {
    await fx.interactions.vote({
      accessToken: tokens[did],
      payload: { postId: post._id, value: "up" },
      signature: devs[did].signPayload({ postId: post._id, value: "up" }),
    });
  }
  const { rankedScore, normalizeRankingConfig } = await import("../src/services/ranking.service.js");
  const stored = await fx.collections.posts.findOne({ _id: post._id });
  assert.equal(stored.interactionCounters.upVolume, 3);
  assert.equal(stored.interactionCounters.voteVolume, 3);
  const ageHours = (Date.now() - new Date(stored.lastActivityAt ?? stored.createdAt).getTime()) / 3_600_000;
  const expected = 3 * (1 + 0.5 * (1 - 0.5)) * Math.pow(2, -ageHours / 48);
  const score = rankedScore(stored, normalizeRankingConfig(), new Date());
  assert.ok(Math.abs(score - expected) < 1e-6, `(${score}) is exactly the published formula over the stored counters`);

  // The serving change adds no ranking input: the ranked order comes back
  // from the ranking module over the same post documents (upCount and
  // myVote attach at decoration, after rank() has consumed its inputs).
  const views = (await feed.ranked({ accessToken: tokens[JUNE] })).posts;
  const row = views.find((entry) => entry._id === post._id);
  assert.equal(row.upCount, 3);
  assert.equal(row.myVote, "up");
});