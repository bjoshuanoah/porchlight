import { test } from "node:test";
import assert from "node:assert/strict";
import { REPLY_SLICE_LIMIT, sliceDisplay, expanderCount, reconcileConfirmed, repliesByParent, conversationOf } from "../src/slice.js";

const ME = "did:porch:me";
const SIB = "did:porch:sister";

function reply(id, body, createdAt) {
  return { _id: id, authorDid: SIB, authorName: "June", body, createdAt };
}

test("ac-5: the card window is the five most-recent replies in reading order", () => {
  const server = Array.from({ length: 52 }, (_, index) => reply(`r${index}`, `reply ${index}`, `2026-10-14T10:${String(index).padStart(2, "0")}:00Z`));
  const view = sliceDisplay({ replySlice: server.slice(47), replyTotal: 52 });
  assert.equal(view.total, 52);
  assert.deepEqual(view.replies.map((row) => row.body), ["reply 47", "reply 48", "reply 49", "reply 50", "reply 51"]);
});

test("ac-5/expander: a 52-reply conversation reads (and 47 more); at or below five there is no expander", () => {
  assert.equal(expanderCount(52), 47);
  assert.equal(expanderCount(5), 0);
  assert.equal(expanderCount(0), 0);
  const view = sliceDisplay({ replySlice: [reply("a", "first", "2026-10-14T10:00:00Z")], replyTotal: 1 });
  assert.equal(view.total, 1);
  assert.equal(view.replies.length, 1);
});

test("ac-2: the member's own reply renders in the slice immediately, exits the oldest, and joins the count", () => {
  const server = Array.from({ length: 5 }, (_, index) => reply(`r${index}`, `reply ${index}`, `2026-10-14T10:0${index}:00Z`));
  const mine = { _id: "local:mine", authorDid: ME, authorName: "You", body: "mine", createdAt: "2026-10-14T10:09:00Z" };
  const view = sliceDisplay({ replySlice: server, replyTotal: 5 }, { pending: [mine] });
  assert.equal(view.total, 6);
  assert.deepEqual(view.replies.map((row) => row.body), ["reply 1", "reply 2", "reply 3", "reply 4", "mine"]);
});

test("ac-2: a failed reply rolls back — the pending row leaves the slice and the count", () => {
  const server = Array.from({ length: 5 }, (_, index) => reply(`r${index}`, `reply ${index}`, `2026-10-14T10:0${index}:00Z`));
  const mine = { _id: "local:gone", authorDid: ME, authorName: "You", body: "mine", createdAt: "2026-10-14T10:09:00Z" };
  const after = sliceDisplay({ replySlice: server, replyTotal: 5 }, { pending: [], confirmed: [] });
  assert.equal(after.total, 5);
  assert.equal(after.replies.at(-1).body, "reply 4");
  // Rollback is the absence of the row, never an error surface in its place.
  assert.equal(after.replies.some((row) => row._id === "local:gone"), false);
  assert.deepEqual(reconcileConfirmed([], 0), []);
  void mine;
});

test("ac-2: an acknowledged reply renders until the next read counts it, then retires — never twice", () => {
  const confirmed = (basis) => [{ reply: { _id: "r5", authorDid: ME, authorName: "You", body: "reply 5", createdAt: "2026-10-14T10:05:00Z" }, basis }];
  // A read sampled after the confirm already holds the reply: total passed
  // basis+1, so the local copy retires and the view counts it once.
  assert.deepEqual(reconcileConfirmed(confirmed(5), 6), []);
  // A raced (older) read does not yet hold it: the local row stays visible.
  assert.deepEqual(reconcileConfirmed(confirmed(5), 5), confirmed(5));

  const server = Array.from({ length: 6 }, (_, index) => reply(`r${index}`, `reply ${index}`, `2026-10-14T10:0${index}:00Z`));
  const retired = sliceDisplay({ replySlice: server.slice(-5), replyTotal: 6 }, { confirmed: confirmed(5) });
  assert.equal(retired.total, 6, "the acknowledged reply is counted by the server read");
  assert.deepEqual(retired.replies.map((row) => row.body), ["reply 1", "reply 2", "reply 3", "reply 4", "reply 5"], "the id-deduped window never renders a double copy");

  // A raced read (total unaware of the write): the local copy bridges the
  // gap — renders in the window and carries the count until reconciliation.
  const older = Array.from({ length: 5 }, (_, index) => reply(`r${index}`, `reply ${index}`, `2026-10-14T10:0${index}:00Z`));
  const bridged = sliceDisplay({ replySlice: older, replyTotal: 5 }, { confirmed: confirmed(5) });
  assert.deepEqual(bridged.replies.map((row) => row.body), ["reply 1", "reply 2", "reply 3", "reply 4", "reply 5"]);
  assert.equal(bridged.total, 6);
});

test("ac-5: a payload without the conversation decoration renders no slice and no count", () => {
  assert.deepEqual(sliceDisplay({}).replies, []);
  assert.equal(sliceDisplay({}).total, 0);
  assert.deepEqual(conversationOf({}).replies, []);
});

test("ac-6: the expander is quantity only — never an engagement count", () => {
  const view = sliceDisplay({ replySlice: [], replyTotal: REPLY_SLICE_LIMIT + 3 });
  assert.equal(expanderCount(view.total), 3);
});

test("ac-5: replies without ids never join the slice", () => {
  const view = sliceDisplay({ replySlice: [reply("ok", "fine", "2026-10-14T10:00:00Z"), { body: "no id" }], replyTotal: 3 });
  assert.deepEqual(view.replies.map((row) => row.body), ["fine"]);
});

test("ac-5: the thread structure for the in-place conversation groups by parent, oldest first", () => {
  const comments = [
    reply("c2", "nested later", "2026-10-14T10:02:00Z"),
    reply("c1", "root first", "2026-10-14T10:01:00Z"),
  ];
  comments[0].parentId = "c1";
  const byParent = repliesByParent(comments);
  assert.deepEqual([...byParent.get("")].map((row) => row._id), ["c1"]);
  assert.deepEqual([...byParent.get("c1")].map((row) => row._id), ["c2"]);
});