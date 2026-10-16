// Live consumption (PORCH-081): the socket feed is the live path — merges
// in place, no cadence anywhere, closed vocabulary, cursor catch-up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEvent, EVENT_TYPES, readEventCursor, saveEventCursor, catchUpSince } from "../src/live.js";

const here = dirname(fileURLToPath(import.meta.url));

test("ac-1: the fixed-interval refresh cycle is deleted from the client path", async () => {
  const live = await readFile(join(here, "..", "src", "live.js"), "utf8");
  const realtime = await readFile(join(here, "..", "src", "realtime.js"), "utf8");
  // No periodic cadence anywhere: no interval timer, no poll constant.
  for (const [name, source] of [["live.js", live], ["realtime.js", realtime]]) {
    assert.ok(!/setInterval|arrivalPollMs/.test(source), `${name} carries no interval cadence`);
  }
  assert.ok(!/setTimeout|setInterval/.test(live), "live.js carries no timers at all — arrivals are event-driven");
  // The transport's ONLY timer is the one-shot, guard-guarded re-open
  // after a POLICY close (hub-restart recovery); it never re-fires and
  // never rides a cadence.
  const timers = [...realtime.matchAll(/setTimeout\(/g)].length;
  assert.equal(timers, 1);
  assert.ok(/io server disconnect/.test(realtime), "the single timer is the policy-close re-open");
});

test("ac-5: the event vocabulary is closed and logged on unknown types, never guessed at", () => {
  // The lifecycle amendment (PORCH-094, Oct 16, 2026): the server-half
  // write contract publishes post.updated, post.deleted, comment.updated,
  // and comment.deleted on this same plane — the client consumes them on
  // the closed vocabulary it already carries.
  assert.deepEqual([...EVENT_TYPES].sort(), [
    "comment.deleted", "comment.updated", "media.attached", "post.created",
    "post.deleted", "post.updated", "reaction.applied", "reply.created",
  ].sort());
  const warns = [];
  const posts = [{ _id: "p1", originNetworkId: "net_family" }];
  const unchanged = applyEvent(posts, { type: "vote.counted", networkId: "net_family", postId: "p1", content: {} }, { log: { warn: (line) => warns.push(line) } });
  assert.equal(unchanged, posts, "an unknown envelope re-renders nothing");
  assert.equal(warns.length, 1, "the arrival was logged, not guessed at");
});

const existing = (id, extra = {}) => ({
  _id: id, originNetworkId: "net_family", authorId: "did_cara", authorName: "Cara",
  type: "text", body: `body ${id}`, createdAt: "2026-10-15T10:00:00Z", ...extra,
});
const envelope = (type, { postId, content, seq = "1000-1", networkId = "net_family", groupId = null } = {}) => ({
  type, networkId, postId: postId ?? null, groupId, content, createdAt: "2026-10-15T11:00:00Z", seq,
});
const context = { origin: "https://hub", network: "Hub" };

test("ac-2: a live post prepends in the river in place — copy-on-write, no full rebuild", () => {
  const river = [existing("p1")];
  const arrived = applyEvent(river, envelope("post.created", { postId: "p2", content: existing("p2", { body: "new post", authorName: "Dev" }) }), context);
  assert.notEqual(arrived, river, "the river array is a new copy (copy-on-write)");
  assert.equal(river.length, 1, "the source river row is untouched");
  assert.deepEqual(arrived.map((post) => post._id), ["p2", "p1"]);
  assert.equal(arrived[0].origin, "https://hub");
  assert.equal(arrived[0].network, "Hub");
  assert.equal(arrived[0].authorName, "Dev", "the envelope rides attribution (PORCH-034), no follow-up read");
});

test("ac-2: a post arrival is idempotent — a deduped replay re-renders nothing", () => {
  const river = [existing("p1"), existing("p2")];
  assert.equal(applyEvent(river, envelope("post.created", { postId: "p2", content: existing("p2") }), context), river);
  assert.equal(applyEvent(river, envelope("post.created", { content: null, postId: null }), context), river);
});

test("ac-2: a root reply enters the card slice; past the window the oldest root exits into the count", () => {
  const river = [existing("p1", {
    replyTotal: 4,
    replySlice: [
      { _id: "r1", body: "r1", createdAt: "2026-10-15T10:01:00Z", responseCount: 0 },
      { _id: "r2", body: "r2", createdAt: "2026-10-15T10:02:00Z", responseCount: 0 },
      { _id: "r3", body: "r3", createdAt: "2026-10-15T10:03:00Z", responseCount: 0 },
      { _id: "r4", body: "r4", createdAt: "2026-10-15T10:04:00Z", responseCount: 0 },
    ],
  })];
  const first = applyEvent(river, envelope("reply.created", { postId: "p1", content: { _id: "r9", parentId: null, body: "newest", createdAt: "2026-10-15T12:00:00Z" } }), context);
  assert.notEqual(first, river);
  assert.deepEqual(first[0].replySlice.map((reply) => reply._id), ["r9", "r4", "r3", "r2"], "the arriving root is the window's head under the ruled newest-first order");
  assert.equal(first[0].replyTotal, 5, "the root total counts the arrival");
  // The expander count (conversation quantity, not engagement) grows with it.
  const second = applyEvent(first, envelope("reply.created", { postId: "p1", content: { _id: "r10", parentId: null, body: "newest 2", createdAt: "2026-10-15T12:01:00Z" } }), context);
  assert.deepEqual(second[0].replySlice.map((reply) => reply._id), ["r10", "r9", "r4", "r3"]);
  assert.equal(second[0].replyTotal, 6);
});

test("ac-2: a nested arrival bumps the parent root's response count in place", () => {
  const river = [existing("p1", { replyTotal: 2, replySlice: [
    { _id: "r1", parentId: null, responseCount: 0, createdAt: "2026-10-15T10:01:00Z" },
  ] })];
  const merged = applyEvent(river, envelope("reply.created", { postId: "p1", content: { _id: "r5", parentId: "r1", body: "response", createdAt: "2026-10-15T12:00:00Z" } }), context);
  assert.deepEqual(merged[0].replySlice, [{ _id: "r1", parentId: null, responseCount: 1, createdAt: "2026-10-15T10:01:00Z" }]);
  assert.equal(merged[0].replyTotal, 2, "a response rides its parent's count, not the root total");
  // Idempotent replay.
  assert.equal(applyEvent(merged, envelope("reply.created", { postId: "p1", content: { _id: "r5", parentId: "r1", createdAt: "2026-10-15T12:00:00Z" } }), context), merged);
});

test("ac-2: a reply to a post absent from the river changes nothing", () => {
  const river = [existing("p_other")];
  assert.equal(applyEvent(river, envelope("reply.created", { postId: "p1", content: { _id: "r9", parentId: null, createdAt: "2026-10-15T12:00:00Z" } }), context), river);
});

test("ac-2: a reaction renders as given — the row appends, no count is derived", () => {
  const river = [existing("p1", { reactionRows: [{ _id: "rct_a", emoji: "🎉", memberDid: "did_cara" }] })];
  const merged = applyEvent(river, envelope("reaction.applied", { postId: "p1", content: { _id: "rct_b", emoji: "🪴", memberDid: "did_sam", createdAt: "2026-10-15T12:00:00Z" } }), context);
  assert.equal(merged[0].reactionRows.length, 2);
  assert.deepEqual(merged[0].reactionRows.map((row) => row.emoji), ["🎉", "🪴"]);
  assert.equal(merged[0].reactionCount, undefined, "no count-bearing field is derived anywhere");
  // Same arrival again (the member's own optimistic row or a replay) is a no-op.
  assert.equal(applyEvent(merged, envelope("reaction.applied", { postId: "p1", content: { _id: "rct_b", emoji: "🪴", memberDid: "did_sam" } }), context), merged);
  // The same emoji from a different member is a different row (rows stay
  // per-member, reactions ruling); the rendering surface dedupes emoji values.
  const more = applyEvent(merged, envelope("reaction.applied", { postId: "p1", content: { _id: "rct_c", emoji: "🪴", memberDid: "did_sue" } }), context);
  assert.equal(more[0].reactionRows.length, 3);
  assert.equal(applyEvent(more, envelope("reaction.applied", { postId: "p1", content: { _id: "rct_c", emoji: "🪴", memberDid: "did_sue" } }), context), more);
});

test("ac-2: media.attached is an acknowledged no-op for the river", () => {
  const river = [existing("p1")];
  assert.equal(applyEvent(river, envelope("media.attached", { content: { mediaId: "m1", kind: "original" } }), context), river);
});

test("ac-4: the reconnect delta rides the catch-up endpoint with the stored cursor", async () => {
  const calls = [];
  const events = [envelope("post.created", { postId: "p9", content: existing("p9") })];
  const result = await catchUpSince(async (connection, path) => {
    assert.equal(connection.token, "t");
    calls.push(path);
    return { events, stale: false, cursor: "1200-4", replayHours: 24 };
  }, { url: "https://hub", token: "t" }, "1000-1");
  assert.deepEqual(calls, ["social/events?since=1000-1"]);
  assert.equal(result.stale, false);
  assert.equal(result.cursor, "1200-4");
  assert.equal(result.events.length, 1);
  const without = await catchUpSince(async (connection, path) => { calls.push(path); return {}; }, { url: "https://hub", token: "t" }, null);
  assert.deepEqual(calls, ["social/events?since=1000-1", "social/events"]);
  assert.deepEqual(without.events, []);
  assert.equal(without.cursor, null);
});

test("ac-4: the per-origin catch-up cursor stores browser-locally", () => {
  const storage = {
    map: new Map(),
    getItem(key) { return this.map.get(key) ?? null; },
    setItem(key, value) { this.map.set(key, value); },
  };
  assert.equal(readEventCursor(storage, "https://hub"), null);
  saveEventCursor(storage, "https://hub", "1200-4");
  assert.equal(readEventCursor(storage, "https://hub"), "1200-4");
  assert.equal(readEventCursor(storage, "https://cabin"), null, "the cursor is per origin, one per hub");
  saveEventCursor(storage, "https://hub", null);
  assert.equal(readEventCursor(storage, "https://hub"), "1200-4", "a null cursor never erases the stored one");
});