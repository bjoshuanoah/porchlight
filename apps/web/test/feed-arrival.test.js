import { test } from "node:test";
import assert from "node:assert/strict";
import { arrivalPollMs } from "../src/live.js";
import { createScrollMemory } from "../src/scroll.js";
import { pickFeedAnchor, anchorCompensation, compensationScroll } from "../src/scroll.js";
import { visibleFeedPosts, postKey } from "../src/feed-filter.js";

test("ac-1: the poll cadence is a background degrade, never poll-on-scroll", () => {
  assert.equal(typeof arrivalPollMs, "number");
  assert.ok(arrivalPollMs > 5_000, "arrivals ride a cadence independent of scrolling");
});

test("ac-1: the reading anchor is the topmost card still reaching the viewport", () => {
  const nodes = [
    { getAttribute: () => "hub:p1", getBoundingClientRect: () => ({ top: -400, bottom: 50 }) },
    { getAttribute: () => "hub:p2", getBoundingClientRect: () => ({ top: 66, bottom: 620 }) },
  ];
  assert.deepEqual(pickFeedAnchor(nodes, 0), { key: "hub:p1", top: -400 });
  // Nothing reaches the viewport: no anchor, no compensation.
  const gone = [{ getAttribute: () => "hub:p1", getBoundingClientRect: () => ({ top: -900, bottom: -100 }) }];
  assert.equal(pickFeedAnchor(gone, 0), null);
  assert.equal(anchorCompensation(null, { key: "hub:p1", top: 0 }), 0);
});

test("ac-1/scroll-jack: an arrival above the reading anchor is compensated exactly once", () => {
  // A card arrives above the anchor: the anchor sinks 108px in the viewport;
  // the scroll adjustment must push the window down by the same amount.
  const before = { key: "hub:p2", top: 512 };
  const after = { key: "hub:p2", top: 620 };
  assert.equal(anchorCompensation(before, after), -108);
  assert.equal(compensationScroll(before, after), 108);
  // Content removed above (deletion cascade): the anchor rose; scroll back.
  assert.equal(compensationScroll({ key: "hub:p2", top: 512 }, { key: "hub:p2", top: 390 }), -122);
  // An in-place reflection (same anchor, same position) compensates nothing.
  assert.equal(compensationScroll({ key: "hub:p2", top: 512 }, { key: "hub:p2", top: 512 }), 0);
  // A replaced anchor is not a displacement: never compensate on a guess.
  assert.equal(compensationScroll({ key: "hub:p2", top: 512 }, { key: "hub:p9", top: 512 }), 0);
});

test("ac-3: leaving the timeline notes the reading place; returning recalls it", () => {
  const memory = createScrollMemory();
  memory.note("/timeline", 1840);
  assert.equal(memory.recall("/timeline"), 1840);
  assert.equal(memory.recall("/posts/p1"), null);
  memory.note("/groups", 220);
  assert.equal(memory.recall("/groups"), 220);
  // Offsets never go negative and fractional pixels floor to a whole offset.
  memory.note("/timeline", -3);
  assert.equal(memory.recall("/timeline"), 1840, "an invalid offset never erases the recorded place");
});

test("ac-3: a newer note replaces a stale one; forget clears", () => {
  const memory = createScrollMemory();
  memory.note("/timeline", 100);
  memory.note("/timeline", 340);
  assert.equal(memory.recall("/timeline"), 340);
  memory.forget("/timeline");
  assert.equal(memory.recall("/timeline"), null);
});

const data = {
  network: { _id: "net_family", name: "Family" },
  server: { url: "https://hub" },
  connections: [{ url: "https://hub", networkId: "net_family", token: "t" }],
};

test("ac-4: the arrival filter drops hidden posts from the feed, live or cached", () => {
  const arrived = [
    { _id: "p1", origin: "https://hub", originNetworkId: "net_family" },
    { _id: "p2", origin: "https://hub", originNetworkId: "net_family" },
  ];
  const hidden = new Set([postKey(arrived[1])]);
  const visible = visibleFeedPosts(arrived, data, hidden);
  assert.deepEqual(visible.map((post) => post._id), ["p1"]);
});

test("ac-4: the arrival filter drops foreign-network posts from the feed, live or cached", () => {
  const arrived = [
    { _id: "ok", origin: "https://hub", originNetworkId: "net_family" },
    { _id: "foreign", origin: "https://elsewhere", originNetworkId: "net_other" },
  ];
  const visible = visibleFeedPosts(arrived, data, new Set());
  assert.deepEqual(visible.map((post) => post._id), ["ok"]);
});

test("ac-4: an origin a member belongs to through another connection stays visible", () => {
  const multi = {
    network: { _id: "net_family" },
    connections: [
      { url: "https://hub", networkId: "net_family" },
      { url: "https://cabin", networkId: "net_cabin", token: "t" },
    ],
  };
  const arrived = [{ _id: "cabin-post", origin: "https://cabin", originNetworkId: "net_cabin" }];
  assert.deepEqual(visibleFeedPosts(arrived, multi, new Set()).map((post) => post._id), ["cabin-post"]);
});