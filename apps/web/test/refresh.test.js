// Update detection and refresh flow (PORCH-125, Brian, Oct 22, 2026): the
// in-session banner (verbatim copy, never interrupts, exactly one instance,
// no timer-driven apply), the banner-tap apply (one reload, no re-banner),
// the cold-open auto-apply (before first paint, no banner), and the worker
// boundaries (no /api/** from a cache, no non-2xx cached, one registration,
// old shell caches cleaned on activate). Pure logic and the worker's
// executable behavior run in-process; the shell document carries its
// contract as a source pin (the established pin style).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import vm from "node:vm";
import {
  APPLY_UPDATE_MESSAGE,
  COLD_OPEN_RELOAD_FLAG,
  UPDATE_BANNER_COPY,
  applyPendingUpdate,
  buildStamp,
  coldOpenRefresh,
  startUpdateWatch,
  swShellVersion,
} from "../src/refresh.js";

const webRoot = join(dirname(fileURLToPath(new URL(import.meta.url))), "..");
const src = (file) => readFile(join(webRoot, file), "utf8");

// ——— Pure logic ———

test("PORCH-125 ac-1: the banner copy of record is verbatim and never a variant", async () => {
  assert.equal(UPDATE_BANNER_COPY, "New version available. Click here to refresh.");
  // The verbatim string of record renders through the shell's banner.
  const main = await src("src/main.jsx");
  assert.match(main, /\{UPDATE_BANNER_COPY\}/);
});

test("PORCH-125 ac-1: exactly one banner instance, fixed top, no displacement, holds with no timeout", async () => {
  const main = await src("src/main.jsx");
  // Single render condition app-wide.
  const instances = main.match(/updatePending && <UpdateBanner/g) ?? [];
  assert.equal(instances.length, 1);
  // Fixed at the top of the page; no layout-affecting (content-displacing) box.
  assert.match(main, /position: "fixed", top: 0, left: 0, right: 0/);
  // Informational affordance: no error-state chrome (the earned-error
  // class is not this surface).
  assert.doesNotMatch(main, /<Alert[\s\S]{0,400}\{UPDATE_BANNER_COPY\}/);
  // The state clears ONLY on the tap: the sole setUpdatePending(false) is
  // the tap's clear, before the apply.
  const clears = main.match(/setUpdatePending\(false\)/g) ?? [];
  assert.equal(clears.length, 1);
  assert.match(main, /const applyUpdateNow = \(\) => \{\s*\n\s*setUpdatePending\(false\);/);
});

test("PORCH-125 ac-1: detection fires on the waiting-worker signal, exactly once; the timer path is detection-only", () => {
  let pending = 0;
  const updates = [];
  const listeners = new Map();
  const registration = {
    _waiting: null,
    installing: null,
    get waiting() { return this._waiting; },
    set waiting(value) { this._waiting = value; },
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(handler);
    },
    removeEventListener(name, handler) {
      const list = listeners.get(name) ?? [];
      const at = list.indexOf(handler);
      if (at >= 0) list.splice(at, 1);
    },
    update: () => { updates.push(1); return Promise.resolve(); },
  };
  const emit = (name, event) => { for (const handler of listeners.get(name) ?? []) handler(event); };
  const stop = startUpdateWatch(registration, () => { pending += 1; }, { intervalMs: 0 });
  assert.equal(pending, 0);
  // updatefound → the installing worker reaches "installed" → the waiting
  // slot is set → exactly one report.
  registration.installing = { state: "installing", addEventListener: () => {} };
  emit("updatefound", {});
  registration.installing.state = "installed";
  registration.waiting = registration.installing;
  emit("updatefound", {});
  assert.equal(pending, 1);
  // A repeated signal never yields a second banner instance.
  emit("updatefound", {});
  emit("updatefound", {});
  assert.equal(pending, 1, "one detection, one banner — never a second instance");
  stop();
});

test("PORCH-125 ac-1: the periodic check keeps detection alive and never applies, never reloads", async () => {
  const updates = [];
  const listeners = new Map();
  const registration = {
    _waiting: null,
    get waiting() { return this._waiting; },
    addEventListener: (name, handler) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(handler);
    },
    removeEventListener: () => {},
    update: () => { updates.push(1); return Promise.resolve(); },
  };
  let pending = 0;
  const stop = startUpdateWatch(registration, () => { pending += 1; }, { intervalMs: 5, isVisible: () => true });
  await new Promise((resolve) => setTimeout(resolve, 30));
  stop();
  assert.ok(updates.length >= 1, "the bounded periodic check rides registration.update");
  assert.equal(pending, 0, "a check that finds nothing reports nothing");
  // The invisible window checks nothing and never applies (detection only).
  const idle = [];
  const hidden = startUpdateWatch(
    { ...registration, update: () => { idle.push(1); return Promise.resolve(); } },
    () => { pending += 1; },
    { intervalMs: 5, isVisible: () => false },
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  hidden();
  assert.equal(idle.length, 0, "an invisible window never checks");
  // The module's watch carries no apply, message, or reload machinery.
  const refreshModule = await src("src/refresh.js");
  const watch = refreshModule.slice(refreshModule.indexOf("export function startUpdateWatch"));
  assert.doesNotMatch(watch, /reload|APPLY_UPDATE_MESSAGE|postMessage|skipWaiting/);
  assert.equal(pending, 0);
});

test("PORCH-125 ac-1: the worker never auto-activates — the install handler waits and skipWaiting lives only on the apply message", async () => {
  const worker = await src("public/sw.js");
  assert.equal((worker.match(/skipWaiting\(\)/g) ?? []).length, 1, "exactly one skipWaiting caller");
  assert.match(worker, /event\.data\?\.type === "porchlight-apply-update"/);
  const install = worker.slice(worker.indexOf('self.addEventListener("install"'), worker.indexOf('self.addEventListener("activate"'));
  assert.doesNotMatch(install, /skipWaiting/, "the install handler carries no automatic activation");
});

test("PORCH-125 ac-2: the tap applies the waiting worker and reloads exactly once", async () => {
  const posted = [];
  const reloads = [];
  const controlListeners = [];
  const serviceWorker = {
    controller: null,
    addEventListener: (name, handler) => { if (name === "controllerchange") controlListeners.push(handler); },
    removeEventListener: () => {},
  };
  const registration = {
    waiting: { postMessage: (message) => { posted.push(message); } },
  };
  const settleDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // The claim never lands here (settle bound); the reload still fires once
  // so the member always lands in the fresh shell.
  const applied = await applyPendingUpdate({
    registration,
    serviceWorker,
    reload: () => { reloads.push(1); },
    settleMs: 20,
    delay: settleDelay,
  });
  assert.equal(applied, true);
  assert.deepEqual(posted, [{ type: APPLY_UPDATE_MESSAGE }]);
  assert.equal(reloads.length, 1, "exactly one reload per tap");
  // The claiming path: the controllerchange resolves the settle, one reload.
  const claimed = await applyPendingUpdate({
    registration: { waiting: { postMessage: (message) => { posted.push(message); } } },
    serviceWorker: {
      controller: null,
      addEventListener: (name, handler) => { setTimeout(() => handler({}), 5); },
      removeEventListener: () => {},
    },
    reload: () => { reloads.push(1); },
    settleMs: 200,
    delay: settleDelay,
  });
  assert.equal(claimed, true);
  assert.equal(reloads.length, 2);
  // No waiting worker: no apply, no reload, no re-banner state.
  const idle = await applyPendingUpdate({ registration: { waiting: null }, reload: () => { reloads.push(1); } });
  assert.equal(idle, false);
  assert.equal(reloads.length, 2);
  // The tap handler wires the one registration, the reload, and the clear.
  const main = await src("src/main.jsx");
  assert.match(main, /registration: workerRegistration\(\),\s*\n\s*serviceWorker: navigator\.serviceWorker,\s*\n\s*reload: \(\) => window\.location\.reload\(\),/);
});

test("PORCH-125 ac-2: the apply message is the worker's only skipWaiting entry", async () => {
  const workerScript = await src("public/sw.js");
  const sandbox = createWorkerSandbox({ fetchImpl: async () => { throw new Error("no fetch expected"); } });
  vm.runInContext(workerScript, sandbox.context);
  const messageHandlers = sandbox.handlers.message;
  assert.equal(messageHandlers.length, 1);
  const event = { data: { type: APPLY_UPDATE_MESSAGE }, waitUntil(promise) { this.waited = promise; } };
  messageHandlers[0](event);
  await event.waited;
  assert.equal(sandbox.skipWaitingCalls.length, 1, "one apply message, one activation");
});

test("PORCH-125 ac-3: markers parse and compare; a dev/placeholder stamp never reads as newer or older", async () => {
  assert.deepEqual(swShellVersion('const SHELL_VERSION = "1700000000001";'), { stamp: "1700000000001", build: 1700000000001 });
  assert.deepEqual(swShellVersion('const SHELL_VERSION = "__PORCHLIGHT_SHELL_VERSION__";'), { stamp: "__PORCHLIGHT_SHELL_VERSION__", build: null });
  assert.deepEqual(swShellVersion("garbage"), { stamp: null, build: null });
  assert.equal(buildStamp("1200"), 1200);
  assert.equal(buildStamp("not-a-number"), null);
  assert.equal(buildStamp(undefined), null);
});

test("PORCH-125 ac-3: the cold open applies a waiting worker (no reload, no banner on this path)", async () => {
  const posted = [];
  const reloads = [];
  const registration = {
    update: () => {
      // The worker side of the apply: the postMessage reaches the waiting
      // worker, it skipWaits, claims, and the registration's waiting
      // slot clears (the activation that leaves nothing to banner about).
      registration.waiting = { postMessage: (message) => { posted.push(message); registration.waiting = null; } };
      return Promise.resolve();
    },
    waiting: null,
  };
  const own = 1700000000000;
  const cold = await coldOpenRefresh({
    registration,
    ownBuild: String(own),
    readHubScript: async () => `const SHELL_VERSION = "${own}";`,
    sessionStorageLike: { getItem: () => null, setItem: () => {} },
    reload: () => { reloads.push(1); },
    settleMs: 5,
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  assert.deepEqual(posted, [{ type: APPLY_UPDATE_MESSAGE }], "the waiting worker was applied at boot");
  assert.deepEqual(reloads, [], "the cold-open path never reloads");
  assert.deepEqual(cold, { pending: false }, "no update banner renders on the cold-open apply path");
});

test("PORCH-125 ac-3: a stale shell under a newer hub auto-applies exactly once per session", async () => {
  const reloads = [];
  const stored = new Map();
  // A stale shell implies the worker script is newer too (one build stamps
  // both): the check hands the newer worker to the waiting slot.
  const registration = {
    update: () => {
      registration.waiting = { postMessage: () => { registration.waiting = null; } };
      return Promise.resolve();
    },
    waiting: null,
  };
  const cold = await coldOpenRefresh({
    registration,
    ownBuild: "1700000000000",
    readHubScript: async () => 'const SHELL_VERSION = "1700000099999";',
    sessionStorageLike: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => { stored.set(key, value); },
    },
    reload: () => { reloads.push(1); },
    settleMs: 20,
    stillBooting: () => true,
  });
  assert.deepEqual(reloads, [1], "one automatic reload at the cold open");
  assert.equal(cold.reloaded, true);
  assert.equal(cold.pending, false);
  assert.equal(stored.get(COLD_OPEN_RELOAD_FLAG), "1700000000000");
  // The loop guard: the same session's next cold open (still stale) never
  // auto-reloads again — the banner renders instead, never silently stale.
  const second = await coldOpenRefresh({
    registration,
    ownBuild: "1700000000000",
    readHubScript: async () => 'const SHELL_VERSION = "1700000099999";',
    sessionStorageLike: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => { stored.set(key, value); },
    },
    reload: () => { reloads.push(1); },
    settleMs: 20,
    stillBooting: () => true,
  });
  assert.deepEqual(reloads, [1]);
  assert.deepEqual(second, { pending: true });
  // The boot hold passed (an active member) — no reload underneath.
  const third = await coldOpenRefresh({
    registration,
    ownBuild: "1700000000000",
    readHubScript: async () => 'const SHELL_VERSION = "1700000099999";',
    sessionStorageLike: { getItem: () => null, setItem: () => {} },
    reload: () => { reloads.push(1); },
    settleMs: 20,
    stillBooting: () => false,
  });
  assert.deepEqual(reloads, [1]);
  assert.deepEqual(third, { pending: true });
  // A downgrade or an equal stamp is not a pending update.
  const downgrade = await coldOpenRefresh({
    registration,
    ownBuild: "1700000000000",
    readHubScript: async () => 'const SHELL_VERSION = "1600000000000";',
    sessionStorageLike: { getItem: () => null, setItem: () => {} },
    reload: () => { reloads.push(1); },
    settleMs: 20,
    stillBooting: () => true,
  });
  assert.deepEqual(reloads, [1]);
  assert.deepEqual(downgrade, { pending: false });
});

test("PORCH-125 ac-3: the cold open waits, bounded, for the installing worker to reach the waiting slot before applying", async () => {
  const posted = [];
  const reloads = [];
  const registration = { waiting: null, installing: null };
  const own = 1700000000000;
  // The update check resolves BEFORE the install lands in the waiting slot
  // (the real-browser race): install finishes one tick later.
  registration.update = () => {
    registration.installing = {
      state: "installing",
      addEventListener: (name, handler) => {
        if (name !== "statechange") return;
        setTimeout(() => {
          registration.installing.state = "installed";
          registration.waiting = { postMessage: (message) => { posted.push(message); registration.waiting = null; } };
          handler();
        }, 30);
      },
    };
    return Promise.resolve();
  };
  const cold = await coldOpenRefresh({
    registration,
    ownBuild: String(own),
    readHubScript: async () => `const SHELL_VERSION = "${own}";`,
    sessionStorageLike: { getItem: () => null, setItem: () => {} },
    reload: () => { reloads.push(1); },
    settleMs: 2000,
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  assert.deepEqual(posted, [{ type: APPLY_UPDATE_MESSAGE }], "the late-arriving waiting worker still applies at boot");
  assert.deepEqual(reloads, []);
  assert.deepEqual(cold, { pending: false });
});

test("PORCH-125 ac-3: the cold open applies the browser's own late-arriving waiting worker too", async () => {
  const posted = [];
  const reloads = [];
  const listeners = new Map();
  const registration = {
    waiting: null,
    installing: null,
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(handler);
    },
    removeEventListener(name, handler) {
      const list = listeners.get(name) ?? [];
      const at = list.indexOf(handler);
      if (at >= 0) list.splice(at, 1);
    },
    update: () => Promise.resolve(),
  };
  const emit = (name, event) => { for (const handler of listeners.get(name) ?? []) handler(event); };
  const own = 1700000000000;
  const cold = await coldOpenRefresh({
    registration,
    ownBuild: String(own),
    readHubScript: async () => `const SHELL_VERSION = "${own}";`,
    sessionStorageLike: { getItem: () => null, setItem: () => {} },
    reload: () => { reloads.push(1); },
    settleMs: 200,
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  // The check surfaced nothing (the browser's soft update runs later): the
  // bounded hold resolved quietly — no banner, no reload.
  assert.deepEqual(cold, { pending: false });
  assert.deepEqual(reloads, []);
  assert.deepEqual(posted, []);
  // LATE ARRIVAL (the hold already passed): the watch's own detection —
  // and a later cold open's apply — covers it; this open renders nothing.
  registration.installing = { state: "installing", addEventListener: () => {} };
  emit("updatefound", {});
  registration.waiting = { postMessage: (message) => { posted.push(message); registration.waiting = null; } };
  const second = await coldOpenRefresh({
    registration,
    ownBuild: String(own),
    readHubScript: async () => `const SHELL_VERSION = "${own}";`,
    sessionStorageLike: { getItem: () => null, setItem: () => {} },
    reload: () => { reloads.push(1); },
    settleMs: 200,
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  assert.deepEqual(posted, [{ type: APPLY_UPDATE_MESSAGE }], "the arrived waiting worker applies at the next cold open");
  assert.deepEqual(reloads, []);
  assert.deepEqual(second, { pending: false }, "no banner on the applied cold-open path");
});

test("PORCH-125 ac-3: the cold open never blocks the boot on a failed or unreachable check", async () => {
  const registration = { update: () => Promise.reject(new Error("unreachable")), waiting: null };
  const cold = await coldOpenRefresh({
    registration,
    ownBuild: "1700000000000",
    readHubScript: async () => { throw new Error("offline"); },
    sessionStorageLike: { getItem: () => null, setItem: () => {} },
    reload: () => { throw new Error("never reloaded"); },
    updateBudgetMs: 5,
    settleMs: 5,
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  assert.deepEqual(cold, { pending: false });
});

test("PORCH-125 ac-2/ac-3: the apply settles when the worker empties the waiting slot late; a never-landing apply renders the banner instead", async () => {
  // The late engine: the worker processes the apply two ticks after the post.
  const posted = [];
  const registration = { waiting: null, update: () => Promise.resolve() };
  const own = 1700000000000;
  const slowApply = await applyPendingUpdate({
    registration: {
      get waiting() { 
        if (registration._cleared) return null;
        return { postMessage: () => { posted.push(1); setTimeout(() => { registration._cleared = true; }, 250); } };
      },
    },
    settleMs: 2000,
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  assert.equal(slowApply, true, "the late-but-landed apply settles as applied");
  assert.deepEqual(posted, [1], "one apply postMessage");
  // The never-landing engine: the slot holds forever — the caller reads
  // the live slot and renders the banner (never a silent un-applied open).
  const waitingStub = { postMessage: () => {} };
  const stuck = await applyPendingUpdate({
    registration: {
      get waiting() {
        return waitingStub;
      },
    },
    settleMs: 300,
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  assert.equal(stuck, false, "no reload, no claimed settle — the cold-open flow re-reads the slot for the banner");
  // A cold open with a slot that never clears reports the pending banner.
  const cold = await coldOpenRefresh({
    registration: {
      get waiting() { return waitingStub; },
      update: () => Promise.resolve(),
    },
    ownBuild: String(own),
    readHubScript: async () => `const SHELL_VERSION = "${own}";`,
    sessionStorageLike: { getItem: () => null, setItem: () => {} },
    reload: () => {},
    settleMs: 200,
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  assert.deepEqual(cold, { pending: true }, "an un-applied pending update renders the member-facing banner, never silent");
});

test("PORCH-125: the refresh flow registers nothing — the one registration stays in media-transport", async () => {
  const refreshModule = await src("src/refresh.js");
  assert.doesNotMatch(refreshModule, /serviceWorker\.register\(/);
  const mediaTransport = await src("src/media-transport.js");
  assert.match(mediaTransport, /navigator\.serviceWorker\.register\("\/sw\.js", \{ scope: "\/" \}\)/);
});

// ——— Worker behavior (the worker file runs in-process) ———

/** The minimal worker environment: fake self, CacheStorage, fetch, Request shim. */
function createWorkerSandbox({ fetchImpl }) {
  const handlers = {};
  const skipWaitingCalls = [];
  const claims = [];
  const stores = new Map();
  const deletedCaches = [];
  const keyOf = (request) => `${request.method} ${request.url}`;
  const cacheStorage = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async match(request) {
          const hit = store.get(keyOf(request));
          return hit ? hit.clone() : undefined;
        },
        async put(request, response) { store.set(keyOf(request), response.clone()); },
        async keys() { return [...store.keys()]; },
        async delete(request) { return store.delete(keyOf(request)); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { deletedCaches.push(name); return stores.delete(name); },
  };
  const fakeSelf = {
    addEventListener: (name, handler) => {
      if (!handlers[name]) handlers[name] = [];
      handlers[name].push(handler);
    },
    skipWaiting: async () => { skipWaitingCalls.push(1); },
    clients: { claim: async () => { claims.push(1); }, matchAll: async () => [], openWindow: async () => {} },
    registration: { showNotification: async () => {} },
  };
  // Node's Request rejects relative URLs; the worker resolves them against
  // the origin. The shim preserves that resolution for the sandbox.
  const RelativeRequest = class extends Request {
    constructor(input, init) {
      super(typeof input === "string" && input.startsWith("/") ? new URL(input, "https://hub.test").href : input, init);
    }
  };
  const context = vm.createContext({
    self: fakeSelf,
    caches: cacheStorage,
    fetch: fetchImpl,
    Request: RelativeRequest,
    Response,
    Headers,
    URL,
    Set,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Promise,
  });
  return { context, handlers, skipWaitingCalls, claims, stores, deletedCaches };
}

function fetchEventFor(sandbox, request) {
  const event = { request, waitUntil() {}, respondWith(promise) { event.responded = promise; } };
  for (const handler of sandbox.handlers.fetch) handler(event);
  return event;
}

const HUB_ASSETS = "https://hub.test/assets/main-abc123.js";
const HUB_API = "https://hub.test/api/social/posts";
const HUB_RENDITION = "https://hub.test/api/social/networks/n1/posts/p1/renditions/cover?v=aa11";
const HUB_NAV = "https://hub.test/?";

test("PORCH-125 ac-4: hashed shell assets answer cache-first; a non-2xx asset response is served but never cached", async () => {
  const workerScript = await src("public/sw.js");
  let assetFetches = 0;
  const sandbox = createWorkerSandbox({
    fetchImpl: async () => { assetFetches += 1; return new Response("asset body", { status: 200, headers: { "content-type": "text/javascript" } }); },
  });
  vm.runInContext(workerScript, sandbox.context);
  const first = fetchEventFor(sandbox, new Request(HUB_ASSETS));
  assert.ok(first.responded, "the hashed-asset branch intercepts");
  const firstResponse = await first.responded;
  assert.equal(firstResponse.status, 200);
  assert.equal(assetFetches, 1);
  const shell = sandbox.stores.get("porchlight-shell-dev");
  assert.equal(shell.size, 1, "the ok response entered the versioned shell cache");
  const second = fetchEventFor(sandbox, new Request(HUB_ASSETS));
  await second.responded;
  assert.equal(assetFetches, 1, "the repeat asset resolves from the cache without a network round trip");
  // Non-2xx: served to the event, never stored.
  const failing = createWorkerSandbox({ fetchImpl: async () => new Response("explode", { status: 500 }) });
  vm.runInContext(workerScript, failing.context);
  const event = fetchEventFor(failing, new Request(HUB_ASSETS));
  const response = await event.responded;
  assert.equal(response.status, 500);
  assert.equal((failing.stores.get("porchlight-shell-dev") ?? { size: 0 }).size, 0, "non-2xx never enters a cache");
});

test("PORCH-125 ac-4: /api/** other than the rendition serve paths is never intercepted and never fulfilled from a cache", async () => {
  const workerScript = await src("public/sw.js");
  const sandbox = createWorkerSandbox({
    fetchImpl: async (request) => {
      // A rendition serve request legitimately fetches network-side
      // (authed); any other fetch means a plain /api request slipped
      // through the boundary.
      if (new URL(request.url).pathname.includes("/renditions/")) return new Response("bytes", { status: 200 });
      throw new Error("the worker must never fetch a plain /api request");
    },
  });
  vm.runInContext(workerScript, sandbox.context);
  const event = fetchEventFor(sandbox, new Request(HUB_API));
  assert.equal(event.responded, undefined, "the plain /api request leaves the worker untouched");
  // The rendition serve paths remain intercepted (the standing PORCH-052
  // repair): Authorization rides the worker, and an ok rendition is cached.
  sandbox.handlers.message[0]({ data: { type: "media-auth", tokensByOrigin: { "https://hub.test": "member-token" } } });
  const renditionEvent = fetchEventFor(sandbox, new Request(HUB_RENDITION));
  assert.ok(renditionEvent.responded, "the rendition path stays intercepted");
  const response = await renditionEvent.responded;
  assert.equal(response.status, 200);
  const renditionStore = sandbox.stores.get("porchlight-renditions-v1");
  assert.equal(renditionStore.size, 1, "the ok rendition entered the version-agnostic rendition store");
});

test("PORCH-125 ac-4: a non-2xx rendition response is never cached", async () => {
  const workerScript = await src("public/sw.js");
  const sandbox = createWorkerSandbox({
    fetchImpl: async () => new Response("", { status: 401 }),
  });
  vm.runInContext(workerScript, sandbox.context);
  const renditionEvent = fetchEventFor(sandbox, new Request(HUB_RENDITION));
  await renditionEvent.responded;
  const store = sandbox.stores.get("porchlight-renditions-v1");
  assert.equal(store ? store.size : 0, 0);
});

test("PORCH-125 ac-3/ac-4: navigations are network-first online and fall back to the cached shell offline; only ok responses are cached", async () => {
  const workerScript = await src("public/sw.js");
  // Offline: the cached shell carries the open.
  const offline = createWorkerSandbox({ fetchImpl: async () => { throw new Error("offline"); } });
  vm.runInContext(workerScript, offline.context);
  offline.stores.set("porchlight-shell-dev", new Map());
  offline.stores.get("porchlight-shell-dev").set(`GET ${HUB_NAV}`, new Response("<html>cached shell</html>", { status: 200 }));
  const event = fetchEventFor(offline, { method: "GET", mode: "navigate", url: HUB_NAV, headers: new Headers() });
  assert.ok(event.responded, "the navigate branch intercepts");
  const response = await event.responded;
  assert.equal(await response.text(), "<html>cached shell</html>");
  // Online: the fresh document serves and enters the shell cache.
  const online = createWorkerSandbox({
    fetchImpl: async (request) => new Response(`<html>${request.url}</html>`, { status: 200 }),
  });
  vm.runInContext(workerScript, online.context);
  const fresh = fetchEventFor(online, { method: "GET", mode: "navigate", url: HUB_NAV, headers: new Headers() });
  const freshResponse = await fresh.responded;
  assert.ok((await freshResponse.text()).includes("hub.test"));
  assert.equal(online.stores.get("porchlight-shell-dev").size, 1);
  // Non-2xx navigation: served, never cached.
  const missing = createWorkerSandbox({ fetchImpl: async () => new Response("nope", { status: 404 }) });
  vm.runInContext(workerScript, missing.context);
  const miss = fetchEventFor(missing, { method: "GET", mode: "navigate", url: "https://hub.test/some/missing/route", headers: new Headers() });
  const missResponse = await miss.responded;
  assert.equal(missResponse.status, 404);
  assert.equal(missing.stores.get("porchlight-shell-dev") ? missing.stores.get("porchlight-shell-dev").size : 0, 0);
});

test("PORCH-125 ac-4: old shell caches are cleaned on activate; rendition, staging, and the current shell carry", async () => {
  const sandbox = createWorkerSandbox({ fetchImpl: async () => { throw new Error("unused"); } });
  vm.runInContext(await src("public/sw.js"), sandbox.context);
  sandbox.stores.set("porchlight-renditions-v1", new Map());
  sandbox.stores.set("porchlight-share-staging", new Map());
  sandbox.stores.set("porchlight-shell-dev", new Map());
  sandbox.stores.set("porchlight-shell-999", new Map());
  sandbox.stores.set("porchlight-v2-cruft", new Map());
  const event = { waitUntil(promise) { this.promise = promise; } };
  sandbox.handlers.activate[0](event);
  await event.promise;
  assert.deepEqual(sandbox.deletedCaches, ["porchlight-shell-999", "porchlight-v2-cruft"]);
  assert.deepEqual([...sandbox.stores.keys()].sort(), ["porchlight-renditions-v1", "porchlight-share-staging", "porchlight-shell-dev"]);
  assert.equal(sandbox.claims.length, 1, "the claimed control serves the fresh cache");
});