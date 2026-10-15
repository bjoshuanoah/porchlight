import { test } from "node:test";
import assert from "node:assert/strict";
import { REPLY_SLICE_LIMIT, sliceDisplay, expanderCount, reconcileConfirmed, repliesByParent, ruledOrder, conversationOf } from "../src/slice.js";

const ME = "did:porch:me";
const SIB = "did:porch:sister";

function reply(id, body, createdAt) {
  return { _id: id, authorDid: SIB, authorName: "June", body, createdAt };
}

test("ac-2: a 52-root conversation shows the top four of the ruled sort with 48 more", () => {
  const server = Array.from({ length: 52 }, (_, index) => reply(`r${index}`, `comment ${index}`, `2026-10-14T10:${String(index).padStart(2, "0")}:00Z`));
  const view = sliceDisplay({ replySlice: server.slice(-4), replyTotal: 52 });
  assert.equal(view.total, 52);
  assert.deepEqual(view.replies.map((row) => row.body), ["comment 51", "comment 50", "comment 49", "comment 48"]);
  assert.equal(expanderCount(view.total), 48);
  assert.equal(expanderCount(4), 0);
  assert.equal(expanderCount(0), 0);
});

test("a new root enters the ruled window immediately as its head and moves the oldest into the count", () => {
  const server = Array.from({ length: 4 }, (_, index) => reply(`r${index}`, `comment ${index}`, `2026-10-14T10:0${index}:00Z`));
  const mine = { _id: "local:mine", authorDid: ME, authorName: "You", body: "mine", createdAt: "2026-10-14T10:09:00Z" };
  const view = sliceDisplay({ replySlice: server, replyTotal: 4 }, { pending: [mine] });
  assert.equal(view.total, 5);
  assert.deepEqual(view.replies.map((row) => row.body), ["mine", "comment 3", "comment 2", "comment 1"]);
  assert.equal(expanderCount(view.total), 1);
});

test("ac-1: threaded roots render ahead of childless roots; the rest renders newest-first", () => {
  const roots = [
    reply("A", "oldest", "2026-10-14T10:00:00Z"),
    reply("B", "second", "2026-10-14T10:01:00Z"),
    reply("C", "threaded", "2026-10-14T10:02:00Z"),
  ];
  roots[2].responseCount = 12;
  assert.deepEqual(ruledOrder(roots).map((row) => row._id), ["C", "B", "A"]);
  // Multiple threaded roots stay newest-first among themselves.
  const two = [reply("x", "older thread", "2026-10-14T09:00:00Z"), reply("y", "newer thread", "2026-10-14T09:30:00Z")];
  two[0].responseCount = 1;
  two[1].responseCount = 3;
  assert.deepEqual(ruledOrder(two).map((row) => row._id), ["y", "x"]);
});

test("ac-1: the card slice renders the top four of the ruled order, a threaded root first", () => {
  const roots = Array.from({ length: 5 }, (_, index) => reply(`r${index}`, `comment ${index}`, `2026-10-14T10:0${index}:00Z`));
  // "comment 1" carries the tree; the ruled sort renders it ahead of the
  // newer childless roots, and the window still holds the top four, so the
  // oldest childless root ("comment 0") falls into the expander count.
  roots[1].responseCount = 12;
  const view = sliceDisplay({ replySlice: roots, replyTotal: 5 });
  assert.deepEqual(view.replies.map((row) => row.body), ["comment 1", "comment 4", "comment 3", "comment 2"]);
  assert.equal(expanderCount(view.total), 1);
});

test("a failed optimistic root rolls back from the visible window and quantity", () => {
  const server = Array.from({ length: 4 }, (_, index) => reply(`r${index}`, `comment ${index}`, `2026-10-14T10:0${index}:00Z`));
  const after = sliceDisplay({ replySlice: server, replyTotal: 4 }, { pending: [], confirmed: [] });
  assert.equal(after.total, 4);
  assert.equal(after.replies[0].body, "comment 3");
  assert.equal(after.replies.some((row) => row._id.startsWith("local:")), false);
  assert.deepEqual(reconcileConfirmed([], 0), []);
});

test("ac-2: an acknowledged reply renders until the next read counts it, then retires — never twice", () => {
  const confirmed = (basis) => [{ reply: { _id: "r5", authorDid: ME, authorName: "You", body: "reply 5", createdAt: "2026-10-14T10:05:00Z" }, basis }];
  // A read sampled after the confirm already holds the reply: total passed
  // basis+1, so the local copy retires and the view counts it once.
  assert.deepEqual(reconcileConfirmed(confirmed(5), 6), []);
  // A raced (older) read does not yet hold it: the local row stays visible.
  assert.deepEqual(reconcileConfirmed(confirmed(5), 5), confirmed(5));

  const server = Array.from({ length: 6 }, (_, index) => reply(`r${index}`, `reply ${index}`, `2026-10-14T10:0${index}:00Z`));
  const retired = sliceDisplay({ replySlice: server.slice(-4), replyTotal: 6 }, { confirmed: confirmed(5) });
  assert.equal(retired.total, 6, "the acknowledged root is counted by the server read");
  assert.deepEqual(retired.replies.map((row) => row.body), ["reply 5", "reply 4", "reply 3", "reply 2"]);

  // A raced read (total unaware of the write): the local copy bridges the
  // gap — renders in the window and carries the count until reconciliation.
  const older = Array.from({ length: 5 }, (_, index) => reply(`r${index}`, `reply ${index}`, `2026-10-14T10:0${index}:00Z`));
  const bridged = sliceDisplay({ replySlice: older.slice(-5), replyTotal: 5 }, { confirmed: confirmed(5) });
  assert.deepEqual(bridged.replies.map((row) => row.body), ["reply 5", "reply 4", "reply 3", "reply 2"]);
  assert.equal(bridged.total, 6);
});

test("undecorated and malformed rows render no unauthorized text or count", () => {
  assert.deepEqual(sliceDisplay({}).replies, []);
  assert.equal(sliceDisplay({}).total, 0);
  assert.deepEqual(conversationOf({}).replies, []);
  const view = sliceDisplay({ replySlice: [reply("ok", "fine", "2026-10-14T10:00:00Z"), { body: "no id" }], replyTotal: 3 });
  assert.deepEqual(view.replies.map((row) => row.body), ["fine"]);
  assert.equal(expanderCount(REPLY_SLICE_LIMIT + 3), 3);
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