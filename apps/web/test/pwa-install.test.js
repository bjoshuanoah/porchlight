// Install as an App (PORCH-051): the manifest installability contract, the
// single-worker boundary contract, and the Android/iOS home-screen flow
// decision logic. The pure module is exercised directly; the wiring, the
// worker, and the document carry their contracts as source pins (the same
// style as the photo-first and rendition pins).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import vm from "node:vm";
import {
  INSTALL_SUPPRESSION_MS,
  installSuppressed,
  isStandaloneLaunch,
  surfaceInstallKind,
  webkitClass,
  consumeInstallPrompt,
} from "../src/install.js";

const webRoot = join(dirname(fileURLToPath(new URL(import.meta.url))), "..");
const src = async (file) => await readFile(join(webRoot, file), "utf8");

// ac-1: the manifest is the app's identity — name/short_name, the timeline
// root start_url, standalone display, and the porch-warm splash tokens; the
// icon array carries 192/512 with maskable variants and iOS reads the
// apple-touch link tag in the document.
test("PORCH-051 ac-1: the manifest carries the app identity and porch-warm splash tokens", async () => {
  const manifest = JSON.parse(await src("public/manifest.webmanifest"));
  assert.equal(manifest.name, "Porchlight");
  assert.equal(manifest.short_name, "Porchlight");
  assert.equal(manifest.start_url, "/?");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.orientation, "portrait-primary");
  // Splash uses background_color — the light-mode page token, never white
  // and never the navy ink; theme_color matches the SPA theme-color meta.
  assert.equal(manifest.background_color, "#F7F5F0");
  assert.equal(manifest.theme_color, "#F7F5F0");
  const byKey = new Set(manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose}`));
  assert.ok(byKey.has("192x192:any"));
  assert.ok(byKey.has("512x512:any"));
  assert.ok(byKey.has("192x192:maskable"));
  assert.ok(byKey.has("512x512:maskable"));
});

test("PORCH-051 ac-1: the document links the manifest, the apple-touch icon, and the cover viewport", async () => {
  const html = await src("index.html");
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest" \/>/);
  assert.match(html, /<link rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon\.png" \/>/);
  // The Photo-First viewport lock carries viewport-fit=cover so the shell
  // can consume env(safe-area-inset-*) in standalone launch (ac-5).
  assert.match(html, /content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"/);
  assert.match(html, /<meta name="theme-color" content="#F7F5F0" \/>/);
});

// ac-2: exactly one service worker registration exists in the app — the
// PORCH-044 rendition worker — and the install machinery rides it instead
// of registering a second worker.
test("PORCH-051 ac-2: exactly one service worker registration exists in the app", async () => {
  const srcDir = join(webRoot, "src");
  let registers = 0;
  const holders = [];
  for (const name of await readdir(srcDir)) {
    if (!/\.(?:js|jsx)$/.test(name)) continue;
    const text = await readFile(join(srcDir, name), "utf8");
    const found = text.match(/serviceWorker\.register\(/g);
    if (found) {
      registers += found.length;
      holders.push(`src/${name}`);
    }
  }
  assert.equal(registers, 1);
  assert.deepEqual(holders, ["src/media-transport.js"]);
  const transport = await src("src/media-transport.js");
  assert.match(transport, /navigator\.serviceWorker\.register\("\/sw\.js", \{ scope: "\/" \}\)/);
});

test("PORCH-051 ac-2: the worker never intercepts or caches /api/** and never caches non-2xx", async () => {
  const worker = await src("public/sw.js");
  // The boundary guard: /api paths return before any respondWith, so the
  // media-auth surface and live data are never intercepted or cache-served.
  assert.match(worker, /if \(url\.pathname === "\/api" \|\| url\.pathname\.startsWith\("\/api\/"\)\) return;/);
  // Non-rendition paths (which includes everything the shell and the hub
  // API serve) never enter respondWith.
  assert.match(worker, /if \(!url\.pathname\.includes\("\/renditions\/"\)\) return;/);
  // Only response.ok enters the store — a 401/5xx rendition response can
  // never poison the cache.
  assert.match(worker, /if \(response\.ok && url\.searchParams\.has\("v"\) && token\)/);
  assert.match(worker, /await cache\.put\(request, response\.clone\(\)\)/);
});

// ac-3: the Android flow — a captured beforeinstallprompt is stored and
// fired once; the accepted and dismissed outcomes are handled apart.
test("PORCH-051 ac-3: the deferred prompt fires exactly once and reports its outcome", async () => {
  let fired = 0;
  const prompt = { prompt: () => { fired += 1; }, userChoice: Promise.resolve({ outcome: "accepted" }) };
  const first = await consumeInstallPrompt(prompt);
  assert.equal(first?.outcome, "accepted");
  assert.equal(fired, 1);
  // A consumed prompt is never re-fired: the repeat call resolves null and
  // leaves the event untouched (Chrome throws on re-prompt).
  assert.equal(await consumeInstallPrompt(prompt), null);
  assert.equal(fired, 1);
  assert.equal((await consumeInstallPrompt(null)) ?? null, null);
});

// The suppression window: a dismissal hides the surfaces for two weeks,
// client-side, per origin; an expired window lets them return.
test("PORCH-051 ac-3/ac-4: a dismissal suppresses the surfaces through the window, never past it", () => {
  const now = 1_000_000_000_000;
  assert.equal(installSuppressed(0, now), false);
  assert.equal(installSuppressed(null, now), false);
  assert.equal(installSuppressed(now - INSTALL_SUPPRESSION_MS + 1, now), true);
  assert.equal(installSuppressed(now - INSTALL_SUPPRESSION_MS, now), false);
  // A future timestamp (clock skew toward a later wall clock) stays
  // suppressed until it is reached — it is never a re-show trigger.
  assert.equal(installSuppressed(now + 5000, now), true);
});

// The classification: capability checks only (iPadOS presents as desktop
// Mac, so device UA strings are never the signal).
test("PORCH-051 ac-3/ac-4: the surface classification rides capabilities, never device strings", () => {
  assert.equal(surfaceInstallKind({ standalone: true, canPrompt: true, touchCapable: true, webkit: true }), null);
  assert.equal(surfaceInstallKind({ standalone: false, canPrompt: true, touchCapable: true, webkit: false }), "android");
  assert.equal(surfaceInstallKind({ standalone: false, canPrompt: false, touchCapable: true, webkit: true }), "ios");
  assert.equal(surfaceInstallKind({ standalone: false, canPrompt: false, touchCapable: false, webkit: true }), null);
  assert.equal(surfaceInstallKind({ standalone: false, canPrompt: false, touchCapable: true, webkit: false }), null);
});

test("PORCH-051 ac-3/ac-4: the WebKit class excludes Chromium forks and Firefox by engine", () => {
  // iPadOS in desktop presentation: touch-capable WebKit under a Mac UA.
  assert.equal(webkitClass("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"), true);
  assert.equal(webkitClass("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1"), true);
  assert.equal(webkitClass("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36"), false);
  assert.equal(webkitClass("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0"), false);
  assert.equal(webkitClass("Mozilla/5.0 (Android 14; Mobile; rv:126.0) Gecko/126.0 Firefox/126.0"), false);
  assert.equal(webkitClass(undefined), false);
});

// Standalone never nags: the appinstalled event / display-mode check is the
// sticky installed state.
test("PORCH-051 ac-3/ac-4: the installed state is sticky from either standalone signal", () => {
  assert.equal(isStandaloneLaunch({ navigatorStandalone: true, standaloneQuery: false }), true);
  assert.equal(isStandaloneLaunch({ navigatorStandalone: 0, standaloneQuery: true }), true);
  assert.equal(isStandaloneLaunch({ navigatorStandalone: undefined, standaloneQuery: false }), false);
});

// ac-3: the app wires the capture, the custom CTA, and the suppression
// window; the default banner is prevented and the stored prompt is fired
// from the CTA.
test("PORCH-051 ac-3: main.jsx captures the prompt, renders the CTA, and writes the per-origin dismissal", async () => {
  const main = await src("src/main.jsx");
  assert.match(main, /onPrompt = \(event\) => \{ event\.preventDefault\(\); setInstallPrompt\(event\); \}/);
  assert.match(main, /window\.addEventListener\("beforeinstallprompt", onPrompt\)/);
  assert.match(main, /consumeInstallPrompt\(installPrompt\)/);
  assert.match(main, /readLocal\(stored, origin, "install-dismissed-at", 0\)/);
  assert.match(main, /writeLocal\(stored, origin, "install-dismissed-at",\s*dismissedAt\)/);
  assert.match(main, /<InstallCta kind=\{installHidden \? null : installKind\} onInstall=\{installNow\} onDismiss=\{dismissInstall\} \/>/);
  // The installed surface is never asked again — appinstalled retires the
  // surfaces and sets the sticky standalone state.
  assert.match(main, /onInstalled = \(\) => \{ setInstallPrompt\(null\); setStandaloneLaunch\(true\); \}/);
});

// ac-4: the iOS guided card carries the Share-then-Add-to-Home-Screen
// instruction and rides the same dismissal; the card never renders in
// standalone (the classification returns null there).
test("PORCH-051 ac-4: the iOS guidance card instructs Share then Add to Home Screen", async () => {
  const install = await src("src/install.jsx");
  assert.match(install, /Add to Home Screen/);
  assert.match(install, /IosShareOutlined/);
  assert.match(install, /aria-label="Share"/);
  assert.match(install, /if \(!kind\) return null;/);
});

// ac-5: the shell consumes the safe-area insets in the header and the
// bottom tab bar so the geometry survives the home indicator.
test("PORCH-051 ac-5: the shell consumes safe-area insets and the cover viewport in the document", async () => {
  const main = await src("src/main.jsx");
  assert.match(main, /pt: "env\(safe-area-inset-top\)"/);
  assert.match(main, /pb: "env\(safe-area-inset-bottom\)"/);
  const html = await src("index.html");
  assert.match(html, /viewport-fit=cover/);
});

// Executed worker simulation (ac-2): the real sw.js source runs in an
// isolated context with a stubbed caches/fetch, and its fetch handler is
// exercised directly — not a regex pin. Proves: /api/** is never
// intercepted (no respondWith), and a non-2xx response is fetched through
// but never cached.
test("PORCH-051 ac-2 (executed): /api/** is never intercepted and non-2xx is never cached", async () => {
  const source = await src("public/sw.js");
  const listeners = {};
  const puts = [];
  const cacheStub = {
    match: async () => undefined,
    put: async (request, _response) => { puts.push(String(request.url)); },
  };
  const responsesByUrl = new Map([
    ["https://hub.family/api/social/feed", { status: 200, body: "secret feed" }],
    ["https://hub.family/renditions/feed-thumb?v=" + "ee".repeat(32), { status: 500, body: "explode" }],
  ]);
  const sandbox = {
    self: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      open: async () => cacheStub,
      keys: async () => [],
      delete: async () => true,
    },
    fetch: async (request) => new Response(responsesByUrl.get(String(request.url))?.body ?? "x", { status: responsesByUrl.get(String(request.url))?.status ?? 200 }),
    Request, Headers, URL, Response,
    setTimeout, clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const fetchHandler = listeners["fetch"];
  assert.ok(fetchHandler, "sw.js registers a fetch handler");

  const relay = listeners["message"];
  assert.ok(relay, "sw.js registers the token relay");
  relay({ data: { type: "media-auth", tokensByOrigin: { "https://hub.family": "tok" } } });

  // 1. /api/**: the handler must return without respondWith — the
  // media-auth surface and live data are never intercepted or cache-served.
  const apiEvent = { request: new Request("https://hub.family/api/social/feed"), respondWith: () => { throw new Error("/api request was intercepted"); } };
  fetchHandler(apiEvent);
  assert.equal(puts.length, 0);

  // 2. a non-2xx rendition response streams through to the media element
  // and never enters the store.
  const responded = [];
  const mediaEvent = {
    request: new Request("https://hub.family/renditions/feed-thumb?v=" + "ee".repeat(32)),
    respondWith: (p) => responded.push(p),
  };
  fetchHandler(mediaEvent);
  assert.equal(responded.length, 1, "rendition requests are intercepted");
  const response = await responded[0];
  assert.equal(response.status, 500);
  assert.equal(puts.length, 0, "the non-2xx response entered no cache");
});