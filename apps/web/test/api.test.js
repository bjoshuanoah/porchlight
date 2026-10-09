import test from "node:test";
import assert from "node:assert/strict";
import { loadFeeds } from "../src/api.js";

test("merged member timeline orders by latest activity and retains each origin's published prominence order", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const family = "https://family.example";
  const cousins = "https://cousins.example";
  const responses = new Map([
    [`${family}/api/social/timeline`, { posts: [{ _id: "a", createdAt: "2026-01-01", lastActivityAt: "2026-01-04" }] }],
    [`${family}/api/social/ranked`, { posts: [{ _id: "a" }, { _id: "b" }] }],
    [`${cousins}/api/social/timeline`, { posts: [{ _id: "c", createdAt: "2026-01-03" }] }],
    [`${cousins}/api/social/ranked`, { posts: [{ _id: "c" }] }],
  ]);
  globalThis.fetch = async (url, init) => {
    assert.match(init.headers.authorization, /^Bearer (family|cousins)$/);
    const body = responses.get(url.toString());
    if (!body) throw new Error("Unexpected origin");
    return { ok: true, json: async () => body };
  };
  const result = await loadFeeds([{ url: family, token: "family", name: "Family" }, { url: cousins, token: "cousins", name: "Cousins" }]);
  assert.deepEqual(result.posts.map((post) => [post._id, post.origin]), [["a", family], ["c", cousins]]);
  assert.deepEqual(result.ranked.map((post) => post._id), ["a", "b", "c"]);
  assert.deepEqual(result.failures, []);
});

test("one unreachable origin remains visible as a failure while healthy origin still loads", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => {
    if (url.toString().includes("unreachable")) throw new TypeError("Hub unreachable");
    return { ok: true, json: async () => ({ posts: [{ _id: "here", createdAt: "2026-01-01" }] }) };
  };
  const result = await loadFeeds([{ url: "https://home.example", token: "home" }, { url: "https://unreachable.example", token: "away" }]);
  assert.equal(result.posts[0].origin, "https://home.example");
  assert.deepEqual(result.failures, [{ origin: "https://unreachable.example", message: "Hub unreachable" }]);
});
