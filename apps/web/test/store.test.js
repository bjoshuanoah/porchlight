import test from "node:test";
import assert from "node:assert/strict";
import { cachedTimeline, hiddenPosts, hidePost, unhidePost, saveTimeline, readConnections, saveConnections } from "../src/store.js";

function storage() {
  const entries = new Map();
  return { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
}

test("hidden items stay isolated by hub origin and survive re-opening the app", () => {
  const local = storage();
  hidePost(local, "https://family.example", "https://family.example:post-1");
  assert.equal(hiddenPosts(local, "https://family.example").has("https://family.example:post-1"), true);
  assert.equal(hiddenPosts(local, "https://cousins.example").size, 0);
});

test("showing a hidden item again removes exactly that item and nothing else", () => {
  const local = storage();
  hidePost(local, "https://family.example", "https://family.example:post-1");
  hidePost(local, "https://family.example", "https://family.example:post-2");
  const shown = unhidePost(local, "https://family.example", "https://family.example:post-1");
  assert.equal(shown.has("https://family.example:post-1"), false);
  assert.equal(shown.has("https://family.example:post-2"), true);
  assert.equal(hiddenPosts(local, "https://family.example").size, 1);
  assert.equal(hiddenPosts(local, "https://cousins.example").size, 0);
});

test("saved timeline expires and never leaks to another origin", () => {
  const local = storage();
  saveTimeline(local, "https://family.example", [{ _id: "post-1" }], 1000);
  assert.deepEqual(cachedTimeline(local, "https://family.example", 1999, 1000), [{ _id: "post-1" }]);
  assert.deepEqual(cachedTimeline(local, "https://family.example", 2000, 1000), []);
  assert.deepEqual(cachedTimeline(local, "https://cousins.example", 1500, 1000), []);
});

test("connections remain scoped to the hosting hub", () => {
  const local = storage();
  saveConnections(local, "https://family.example", [{ url: "https://family.example", token: "member" }]);
  assert.equal(readConnections(local, "https://family.example")[0].token, "member");
  assert.deepEqual(readConnections(local, "https://cousins.example"), []);
});
