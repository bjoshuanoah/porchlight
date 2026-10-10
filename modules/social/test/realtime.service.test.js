import { test } from "node:test";
import assert from "node:assert/strict";
import { RealtimeService, createMemoryEventPlane } from "../src/services/realtime.service.js";
import { fixture, device } from "./helpers/content.fixture.js";

function realtimeFixture() {
  // The content fixture already mirrors the module assembly: the realtime
  // service rides a memory event plane with the revocation hook wired.
  return fixture();
}

/** A live channel collecting delivered envelopes (the transport's handle). */
function channel(networkId) {
  const delivered = [];
  return {
    delivered,
    networkId,
    emit: (envelope) => delivered.push(envelope),
  };
}

test("realtime: per-origin isolation — an origin's events reach only that origin's channels (ac-1)", async () => {
  const fx = realtimeFixture();
  const memberA = await fx.admit({ networkId: "net_family", did: "did_a", device: device("dev_a") });
  const memberB = await fx.admit({ networkId: "net_other", did: "did_b", device: device("dev_b") });

  const chA = channel("net_family");
  const chB = channel("net_other");
  await fx.realtime.subscribe({ token: memberA.accessToken, networkId: chA.networkId, channel: { id: "chA", emit: chA.emit, close: () => {} } });
  await fx.realtime.subscribe({ token: memberB.accessToken, networkId: chB.networkId, channel: { id: "chB", emit: chB.emit, close: () => {} } });

  // An event on network A: only A's room receives it — no envelope, partial
  // or otherwise, crosses to B's channel (isolation e2e hook).
  await fx.realtime.published({
    networkId: "net_family",
    type: "post.created",
    postId: "post_1",
    content: { _id: "post_1", originNetworkId: "net_family", body: "Hello family" },
  });

  assert.equal(chA.delivered.length, 1);
  assert.equal(chA.delivered[0].networkId, "net_family");
  assert.equal(chA.delivered[0].type, "post.created");
  assert.equal(chB.delivered.length, 0);
});

test("realtime: payload privacy — envelopes carry content only, vote writes emit nothing (ac-2)", async () => {
  const fx = realtimeFixture();
  const ownerDevice = device("dev_owner");
  const owner = await fx.admit({ networkId: "net_family", did: "did_owner", device: ownerDevice });
  const memberDevice = device("dev_member");
  const member = await fx.admit({ networkId: "net_family", did: "did_member", device: memberDevice });

  const seen = [];
  await fx.realtime.subscribe({
    token: member.accessToken,
    networkId: "net_family",
    channel: { id: "ch_member", emit: (envelope) => seen.push(envelope), close: () => {} },
  });

  // A real signed write through the post service: the arriving post.created
  // payload must be the member view (content only — no rank inputs).
  const postPayload = { type: "text", body: "Vote-privacy audit post" };
  await fx.posts.create({ accessToken: owner.accessToken, payload: postPayload, signature: ownerDevice.signPayload(postPayload) });

  // The member's private vote: votes modulate prominence internally only —
  // no event exists for them in the closed vocabulary.
  const postRow = (await fx.posts.list({ accessToken: member.accessToken })).posts[0];
  const votePayload = { postId: postRow._id, value: "up" };
  const voteResult = await fx.interactions.vote({
    accessToken: member.accessToken,
    payload: votePayload,
    signature: memberDevice.signPayload(votePayload),
  });
  assert.ok(voteResult.vote.effective);

  // A reaction write DOES deliver — the as-authored emoji view only.
  const reactPayload = { postId: postRow._id, emoji: "❤️" };
  await fx.interactions.react({ accessToken: member.accessToken, payload: reactPayload, signature: memberDevice.signPayload(reactPayload) });

  // Exactly two deliveries: post.created + reaction.applied (the vote
  // emitted nothing).
  assert.deepEqual(
    seen.map((envelope) => envelope.type),
    ["post.created", "reaction.applied"],
  );

  // Payload audit across every delivered envelope: content only, no
  // counters, no vote records, no aggregate fields, no actor signatures.
  const forbidden = ["interactionCounters", "votes", "deviceSignature", "score", "rank", "volume", "ratio", "voteCount", "upvotes", "downvotes", "reactionCount", "commentCount"];
  for (const envelope of seen) {
    for (const field of forbidden) {
      if (typeof envelope.content === "object" || envelope.content === null) {
        assert.ok(!Object.hasOwn(envelope.content ?? {}, field), `forbidden field ${field} on payload ${JSON.stringify(envelope)}`);
      }
      assert.ok(!Object.hasOwn(envelope, field), `forbidden field ${field} on envelope ${JSON.stringify(envelope)}`);
    }
    assert.ok(["post.created", "reply.created", "reaction.applied", "media.attached"].includes(envelope.type));
  }
  // The post.created payload is the member post view (vote-privacy shape).
  const delivered = seen[0].content;
  assert.ok("body" in delivered);
  assert.ok("interactionCounters" in postRow === false);
});

test("realtime: reconnect catch-up — deltas replay from the cursor inside the window, stale beyond it (ac-3)", async () => {
  const fx = realtimeFixture();
  const memberDevice = device("dev_m");
  const member = await fx.admit({ networkId: "net_family", did: "did_m", device: memberDevice });
  await fx.realtime.subscribe({ token: member.accessToken, networkId: "net_family", channel: { id: "ch_live", emit: () => {}, close: () => {} } });

  const first = await fx.realtime.published({ networkId: "net_family", type: "post.created", postId: "p1", content: { body: "first" } });
  const baseline = first.seq;
  const baselineRead = await fx.realtime.catchUp({ accessToken: member.accessToken, since: null });
  assert.equal(baselineRead.stale, false);

  // The device goes offline (channel removed); events still land in the window.
  fx.realtime.unsubscribe("ch_live");
  await fx.realtime.published({ networkId: "net_family", type: "reply.created", postId: "p1", content: { body: "while-away-1" } });
  await fx.realtime.published({ networkId: "net_family", type: "post.created", postId: "p2", content: { body: "while-away-2" } });

  // Reconnect catch-up from the baseline cursor: EXACTLY the two missed
  // deltas replay without a manual refresh; the cursor advances.
  const replay = await fx.realtime.catchUp({ accessToken: member.accessToken, since: baseline });
  assert.equal(replay.stale, false);
  assert.deepEqual(replay.events.map((row) => row.content.body), ["while-away-1", "while-away-2"]);
  assert.notEqual(replay.cursor, baseline);

  // Beyond the window: a plane whose retention consumed the cursor's
  // neighborhood resolves the gap stale → the client falls back to REST.
  const thin = createMemoryEventPlane({ maxEntries: 1 });
  const realtimeThin = new RealtimeService({ membership: fx.membership, plane: thin });
  await thin.append("net_family", { type: "post.created", networkId: "net_family", postId: "p3", content: {}, createdAt: new Date().toISOString() });
  await thin.append("net_family", { type: "reply.created", networkId: "net_family", postId: "p1", content: {}, createdAt: new Date().toISOString() });
  const thinRead = await realtimeThin.catchUp({ accessToken: member.accessToken, since: baseline });
  assert.equal(thinRead.stale, true);
  assert.deepEqual(thinRead.events, []);
});

test("realtime: membership enforcement — cross-origin subscribe refused, missing token refused, revocation kills the channel (ac-4)", async () => {
  const fx = realtimeFixture();
  const memberA = await fx.admit({ networkId: "net_family", did: "did_a", device: device("dev_a") });
  const memberB = await fx.admit({ networkId: "net_other", did: "did_b", device: device("dev_b") });

  // B's live membership token is for the OTHER origin: subscribing to A's
  // room refuses server-side at subscribe time.
  await assert.rejects(
    () =>
      fx.realtime.subscribe({ token: memberB.accessToken, networkId: "net_family", channel: { id: "ch_bad", emit: () => {}, close: () => {} } }),
    (error) => error.code === "E_NOT_PERMITTED",
  );
  await assert.rejects(
    () => fx.realtime.subscribe({ token: null, networkId: "net_family", channel: { id: "ch_none", emit: () => {}, close: () => {} } }),
    (error) => error.code === "E_MUST_SIGN_IN",
  );

  // A legit channel, then the revocation: subscriptions close at the
  // revocation write, not at the member's next request.
  let closed = false;
  await fx.realtime.subscribe({ token: memberA.accessToken, networkId: "net_family", channel: { id: "ch_revoked", emit: () => {}, close: () => (closed = true) } });
  assert.equal(fx.realtime.channelsFor("net_family").length, 1);
  await fx.membership.revokeMember({ networkId: "net_family", did: "did_a" });
  assert.equal(closed, true);
  assert.equal(fx.realtime.channelsFor("net_family").length, 0);
});

test("realtime: catch-up requires the token and refuses non-members (ac-4 tail)", async () => {
  const fx = realtimeFixture();
  await fx.admit({ networkId: "net_family", did: "did_a", device: device("dev_a") });
  await assert.rejects(() => fx.realtime.catchUp({ accessToken: null }), (error) => error.code === "E_MUST_SIGN_IN");
  await assert.rejects(() => fx.realtime.catchUp({ accessToken: "not-a-token" }), (error) => error.code === "E_NOT_PERMITTED");
});

test("realtime: the event vocabulary is closed — unknown types never publish", async () => {
  const fx = realtimeFixture();
  await assert.rejects(
    () => fx.realtime.published({ networkId: "net_family", type: "badge", content: null }),
    /closed|Unknown event type/,
  );
  await assert.rejects(
    () => fx.realtime.published({ networkId: "net_family", type: "post.created", postId: "p1", content: { interactionCounters: {} } }),
    /payload-privacy/,
  );
});

test("realtime: a cursor older than the replay window resolves stale even when entries are retained (24h contract)", async () => {
  const fx = realtimeFixture();
  const member = await fx.admit({ networkId: "net_family", did: "did_m", device: device("dev_m") });
  const tiny = new RealtimeService({ membership: fx.membership, plane: fx.realtimePlane, replayHours: 0.0001 });
  await tiny.published({ networkId: "net_family", type: "post.created", postId: "p0", content: { body: "x" } });
  // A 1-hour-old cursor inside a 0.0001-hour window: retained or not, the
  // delta is beyond the promised window → REST fallback.
  const oldSeq = `${Date.now() - 60 * 60 * 1000}-0`;
  const read = await tiny.catchUp({ accessToken: member.accessToken, since: oldSeq });
  assert.equal(read.stale, true);
  assert.deepEqual(read.events, []);
  // The retained window (no cursor) still replays fresh.
  await tiny.published({ networkId: "net_family", type: "post.created", postId: "p1", content: { body: "x" } });
  const fresh = await tiny.catchUp({ accessToken: member.accessToken, since: null });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.events.length, 2);
});