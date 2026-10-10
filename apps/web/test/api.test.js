import test from "node:test";
import assert from "node:assert/strict";
import { loadFeeds, request, setUnauthorizedHandler } from "../src/api.js";

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
  assert.deepEqual(result.failures, [{ origin: "https://unreachable.example", message: "Hub unreachable", status: null, code: null }]);
});

test("a 401 that survives recovery is carried as a dead session, not a network failure (PORCH-050 ac-4)", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  setUnauthorizedHandler(async () => null); // recovery has nothing to offer
  globalThis.fetch = async (url) => {
    if (url.toString().includes("home")) return { ok: true, json: async () => ({ posts: [{ _id: "here", createdAt: "2026-01-01" }] }) };
    return { ok: false, status: 401, json: async () => ({ error: "Your session has ended.", code: "E_SESSION_REQUIRED" }) };
  };
  const result = await loadFeeds([{ url: "https://home.example", token: "home" }, { url: "https://dead.example", token: "dead" }]);
  assert.equal(result.posts.length, 1);
  assert.deepEqual(result.failures, [{
    origin: "https://dead.example",
    message: "Your session has ended.",
    status: 401,
    code: "E_SESSION_REQUIRED",
  }]);
});

test("a 401 retries once through the recovery handler and succeeds (PORCH-028)", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  setUnauthorizedHandler(null);
  const bearers = [];
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bearers.push(init.headers.authorization);
    bodies.push(init.body);
    if (init.headers.authorization === "Bearer dead") {
      return { ok: false, status: 401, json: async () => ({ error: "active session required", code: "E_SESSION_REQUIRED" }) };
    }
    return { ok: true, json: async () => ({ posts: [] }) };
  };
  const replacement = { url: "https://hub.example", token: "fresh", identityToken: "id-fresh" };
  setUnauthorizedHandler(({ connection, error }) => {
    assert.equal(connection.token, "dead");
    assert.equal(error.code, "E_SESSION_REQUIRED");
    return replacement;
  });
  t.after(() => setUnauthorizedHandler(null));
  const result = await request({ url: "https://hub.example", token: "dead" }, "social/timeline");
  assert.deepEqual(result, { posts: [] });
  assert.deepEqual(bearers, ["Bearer dead", "Bearer fresh"]);
  // A 401 never processed the request, so the signed body is retried intact.
  assert.equal(bodies[0], bodies[1]);
});

test("recovery handler is consulted once; a retry 401 surfaces the original error", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    if (init.headers.authorization === "Bearer dead") {
      return { ok: false, status: 401, json: async () => ({ error: "required", code: "E_SESSION_REQUIRED" }) };
    }
    return { ok: false, status: 403, json: async () => ({ error: "forbidden", code: "E_FORBIDDEN" }) };
  };
  let consulted = 0;
  setUnauthorizedHandler(() => {
    consulted += 1;
    return { url: "https://hub.example", token: "less-dead" };
  });
  t.after(() => setUnauthorizedHandler(null));
  await assert.rejects(
    request({ url: "https://hub.example", token: "dead" }, "social/timeline"),
    (error) => error.status === 403 && error.code === "E_FORBIDDEN",
  );
  assert.equal(consulted, 1, "the retry attempt must not re-enter recovery");
});

test("401 without a replacement falls through with the original error", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: "active session required", code: "E_SESSION_REQUIRED" }) });
  setUnauthorizedHandler(() => null);
  t.after(() => setUnauthorizedHandler(null));
  await assert.rejects(
    request({ url: "https://hub.example", token: "dead" }, "identity/devices"),
    (error) => error.status === 401 && error.code === "E_SESSION_REQUIRED",
  );
});
