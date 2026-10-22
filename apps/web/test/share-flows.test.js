// Share flows (PORCH-105, Brian Oct 19 2026): share into the app (the share
// target opens compose), mobile originals move by share, and the
// download-all platform matrix. The pure decisions pin as module contracts;
// the worker staging pins as an executed simulation of the real sw.js source
// (the pwa-install pattern); the surfaces pin as source contracts plus
// rendered DOM sweeps.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile, rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { build } from "esbuild";
import React from "react";
import { renderToString } from "react-dom/server";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const src = async (file) => await readFile(join(webRoot, file), "utf8");

const manifest = await src("public/manifest.webmanifest");
const workerSource = await src("public/sw.js");
const shellSource = await src("src/main.jsx");
const socialSource = await src("src/social.jsx");
const viewerSource = await src("src/photo-viewer.jsx");
const actionsSource = await src("src/member-actions.js");

import {
  classifyStagedShare, requestStagedShare, clearStagedShare, SHARE_TARGET_PATH,
} from "../src/share-target.js";
import {
  ANDROID_SHEET_SET_LIMIT, shareDeviceClass, overlayOriginalAction,
  endCardPlan, shareOriginal, shareFileSet,
} from "../src/share-matrix.js";

const png = { name: "trip.png", type: "image/png" };
const jpg = { name: "camp.jpg", type: "image/jpeg" };
const mp4 = { name: "day.mp4", type: "video/mp4" };
const m4a = { name: "song.m4a", type: "audio/x-m4a" };
const pdf = { name: "list.pdf", type: "application/pdf" };

/* ---- ac-1: share into the app ------------------------------------------ */

test("ac-1: the manifest declares the share target as a launch surface", () => {
  const parsed = JSON.parse(manifest);
  assert.equal(parsed.share_target.action, SHARE_TARGET_PATH);
  assert.equal(parsed.share_target.method, "POST");
  assert.equal(parsed.share_target.enctype, "multipart/form-data");
  assert.deepEqual(parsed.share_target.params.files.map((entry) => entry.name), ["media"]);
  assert.ok(["image/*", "video/*", "audio/*"].every((mime) =>
    parsed.share_target.params.files[0].accept.includes(mime)));
  assert.ok(parsed.share_target.params.title, "title rides the form");
  assert.ok(parsed.share_target.params.text, "text rides the form");
  assert.ok(parsed.share_target.params.url, "url rides the form");
});

test("ac-1: the app's staged-share consumption stays behind identity and the normal boot path", () => {
  assert.match(shellSource, /if \(!mediaTransport \|\| !identity\) return undefined;/,
    "no staged share is consumed without an identity open (auth gates every surface)");
  assert.match(shellSource, /const staged = classifyStagedShare\(payload\);/);
  assert.match(shellSource, /clearStagedShare\(workerRegistration\(\)\)/,
    "compose takes the payload and the staging clears behind it");
  assert.match(shellSource, /staged=\{composeStaging\}/, "the shell hands the staging to the compose dialog");
  assert.match(shellSource, /setComposeStaging\(null\);/,
    "closing compose discards the staging state (the member's content is their own to discard)");
});

/* ---- ac-4: type staging ------------------------------------------------- */

test("ac-4: an image set opens photo compose with every shared photo staged and the shared text in the caption", () => {
  const staged = classifyStagedShare({ text: "From the park", files: [png, jpg] });
  assert.equal(staged.type, "photo");
  assert.deepEqual(staged.files, [png, jpg]);
  assert.equal(staged.caption, "From the park");
  assert.equal(staged.notice, null);
});

test("ac-4: a video share opens video compose; an audio share opens audio compose", () => {
  const video = classifyStagedShare({ files: [mp4] });
  assert.equal(video.type, "video");
  assert.deepEqual(video.files, [mp4]);
  const audio = classifyStagedShare({ files: [m4a] });
  assert.equal(audio.type, "audio");
  assert.deepEqual(audio.files, [m4a]);
});

test("ac-4: a text share opens text compose with the shared text in the area", () => {
  assert.equal(classifyStagedShare({ text: "Look at this", url: "https://example.com/x" }).body, "Look at this");
  // A bare URL (no text) or a lone title stages as text too.
  assert.equal(classifyStagedShare({ url: "https://example.com/x" }).body, "https://example.com/x");
  assert.equal(classifyStagedShare({ title: "Trip" }).body, "Trip");
});

test("ac-4: a mixed share stages what can be staged and names what was left out", () => {
  const mixed = classifyStagedShare({ files: [png, mp4, m4a, pdf] });
  assert.equal(mixed.type, "photo");
  assert.deepEqual(mixed.files, [png]);
  for (const name of ["day.mp4", "song.m4a", "list.pdf"]) assert.match(mixed.notice, new RegExp(name));
});

test("ac-4: an unsupported share stages nothing and renders plain copy naming it", () => {
  const unsupported = classifyStagedShare({ files: [pdf] });
  assert.deepEqual(unsupported.files, []);
  assert.match(unsupported.notice, /photos, videos, and audio/);
  assert.match(unsupported.notice, /list\.pdf/);
  // Extra videos beyond the one video compose carries ride the same copy.
  const extra = classifyStagedShare({ files: [mp4, { name: "more.mp4", type: "video/mp4" }] });
  assert.deepEqual(extra.files, [mp4]);
  assert.match(extra.notice, /more\.mp4/);
});

/* ---- ac-2: mobile originals move by share ------------------------------- */

test("ac-2: touch surfaces share, desktop keeps the Oct 15 download — engine-fact classification", () => {
  assert.equal(shareDeviceClass({ userAgent: "WebKit iPhone", touchCapable: true }), "ios");
  assert.equal(shareDeviceClass({ userAgent: "Chrome Mobile", touchCapable: true }), "android");
  assert.equal(shareDeviceClass({ userAgent: "WebKit Mac", touchCapable: true }),
    "ios", "iPadOS presenting as Mac stays iOS-class through the touch pair");
  assert.equal(shareDeviceClass({ userAgent: "Chrome", touchCapable: false }), "desktop");
  assert.equal(overlayOriginalAction({ touchCapable: true }), "share");
  assert.equal(overlayOriginalAction({ touchCapable: false }), "download");
});

let surfacesPackage = null;

/** The real MediaOverlay, bundled once for the DOM sweeps. */
async function MediaOverlayComponent() {
  if (!surfacesPackage) {
    const outDir = join(here, ".tmp105");
    await mkdir(outDir, { recursive: true });
    await build({
      stdin: { contents: 'export { MediaOverlay } from "./src/photo-viewer.jsx";', resolveDir: webRoot, loader: "jsx", sourcefile: "entry.jsx" },
      bundle: true, format: "esm", jsx: "automatic", platform: "neutral",
      external: ["react", "react-dom", "@mui/*", "@emotion/*", "@noble/*", "socket.io-client", "unicode-emoji-json", "react-transition-group", "hoist-non-react-statics"],
      outfile: join(outDir, "surfaces.built.mjs"), logLevel: "silent",
    });
    surfacesPackage = await import(join(outDir, "surfaces.built.mjs"));
    after(async () => { await rm(outDir, { recursive: true, force: true }); });
  }
  return surfacesPackage.MediaOverlay;
}

test("ac-2: no mobile per-media download control remains — the overlay renders Share on touch, Original on desktop", async () => {
  const MediaOverlay = await MediaOverlayComponent();
  const mobile = renderToString(React.createElement(MediaOverlay, {
    shown: true, shareAction: { busy: false, run: () => {} }, onDownload: () => {},
  }));
  assert.match(mobile, /> Share/);
  assert.doesNotMatch(mobile, />↓ Original</);
  const desktop = renderToString(React.createElement(MediaOverlay, {
    shown: true, shareAction: null, onDownload: () => {},
  }));
  assert.match(desktop, />↓ Original</);
  assert.doesNotMatch(desktop, /> Share</);
});

test("ac-2: the share control hands the full-resolution original to the sheet; refusal falls back to the plain download", async () => {
  const shared = [];
  const downloads = [];
  const original = new Blob(["original"], { type: "image/jpeg" });
  const smallPayload = (payload) => payload?.files?.[0]?.size > 0;
  const share = (payload) => { shared.push(payload.files.map((f) => f.name)); return Promise.resolve(); };

  let result = await shareOriginal(original, "med_1.jpg", { share, canShare: smallPayload });
  assert.deepEqual(shared, [["med_1.jpg"]], "the original's bytes hand to the sheet under its real name");
  assert.equal(result.mode, "shared");
  assert.equal(downloads.length, 0);

  // Platform-refused size (canShare says no): the plain download behavior
  // answers — never an error path family. The download stub proves the
  // fallback ran, not the share and not an error copy.
  const refused = await shareOriginal(original, "med_1.jpg", {
    share, canShare: () => false,
    download: async (blob, name) => { downloads.push(name); },
  });
  assert.equal(refused.mode, "downloaded");
  assert.deepEqual(downloads, ["med_1.jpg"], "the refusal runs the download behavior, not an error copy");

  // Member dismissed the sheet: quiet exit, never an error, never the download.
  const abort = Object.assign(new Error(), { name: "AbortError" });
  result = await shareOriginal(original, "med_1.jpg", { share: () => Promise.reject(abort), canShare: () => true });
  assert.equal(result.mode, "shared");
  assert.equal(result.dismissed, true);
  assert.equal(downloads.length, 1, "a dismissal never runs the download fallback");
});

/* ---- ac-3: download-all platform matrix --------------------------------- */

test("ac-3: the end-card bulk decision rides the platform matrix", () => {
  // Desktop keeps the zip download exactly as ruled Oct 15.
  assert.deepEqual(
    { ...endCardPlan({ deviceClass: "desktop", photos: 30, shareCapable: true }) },
    { kind: "zip-download", verb: "Fetching your originals…", label: "Download all originals" },
  );
  // iOS: the set zip hands to the native sheet (the sheet is always the path).
  assert.deepEqual(
    { ...endCardPlan({ deviceClass: "ios", photos: 30, shareCapable: true }) },
    { kind: "share-zip", verb: "Sharing your originals…", label: "Share all originals" },
  );
  // Android: up to the limit the set shares as individual files…
  assert.deepEqual(
    { ...endCardPlan({ deviceClass: "android", photos: ANDROID_SHEET_SET_LIMIT, shareCapable: true }) },
    { kind: "share-files", verb: "Sharing your originals…", label: "Share all originals" },
  );
  // …beyond the limit the bulk zip route is the carrier.
  assert.deepEqual(
    { ...endCardPlan({ deviceClass: "android", photos: ANDROID_SHEET_SET_LIMIT + 1, shareCapable: true }) },
    { kind: "share-zip", verb: "Sharing your originals…", label: "Share all originals" },
  );
  // No share capability on the device: the plain download behavior.
  assert.equal(endCardPlan({ deviceClass: "android", photos: 3, shareCapable: false }).kind, "zip-download");
});

test("ac-3: the set share hands every full-resolution photo as one share; a refused set reports refusal", async () => {
  const shared = [];
  const share = (payload) => { shared.push(payload.files.length); return Promise.resolve(); };
  const blobs = ["a", "b"].map((letter) => new Blob([letter], { type: "image/jpeg" }));
  const result = await shareFileSet(blobs, { names: ["a.jpg", "b.jpg"], env: { share, canShare: () => true } });
  assert.equal(result.mode, "shared");
  assert.equal(result.files.length, 2, "the set, not a zip, rides the sheet as its individual files");
  assert.deepEqual(shared, [2]);
  assert.equal((await shareFileSet(blobs, { env: { share, canShare: () => false } })).mode, "refused",
    "a platform-refused (size/count) set reports refusal for the caller's bulk fallback");
  assert.deepEqual(
    (await shareFileSet(blobs, { env: { share: undefined, canShare: () => true } })).mode, "refused");
});

test("ac-3 (and the whole matrix): only the shipped archive route is the zip carrier — no second zip machinery", () => {
  // The URL of record lives ONLY in the member-actions carrier the existing
  // end card already used (PORCH-083's contract), untouched.
  assert.match(actionsSource, /\/api\/social\/posts\/\$\{encodeURIComponent\(postId\)\}\/media\/originals\.zip/);
  assert.doesNotMatch(shellSource, /originals\.zip/, "the shell invents no zip path of its own");
  assert.match(shellSource, /bulkPostOriginals\(connection, post\)/,
    "the matrix still fetches through the shipped archive route");
  assert.match(shellSource, /shareDeviceClass\(\)/, "the matrix classifies per device at action time");
});

/* ---- ac-5: boundary and auth on the launch path ------------------------- */

test("ac-5: the share-target launch path never touches /api/** and never the rendition cache (executed worker)", async () => {
  const { listener, staging, renditionState } = await shareWorkerContext();
  const responded = [];
  const files = [new File([new Blob(["bytes"], { type: "image/png" })], "trip.png", { type: "image/png" })];
  const form = {
    get: (field) => ({ title: "", text: "Watch this", url: "https://example.com/x" })[field],
    getAll: (field) => field === "media" ? files : [],
  };
  listener("fetch")({
    request: { method: "POST", url: "https://hub.family/share", formData: async () => form },
    respondWith: (p) => responded.push(p),
  });
  const launch = await responded[0];
  assert.equal(launch.status, 303);
  assert.match(launch.headers.get("location"), /^https:\/\/hub\.family\/\?$/,
    "the launch redirects into the app at the start URL");
  assert.equal(staging.size, 2, "the manifest entry and the staged file entered the dedicated staging store");
  for (const key of staging.keys()) {
    assert.ok(key.startsWith("https://hub.family/share/"), `staging keys stay inside the share staging path: ${key}`);
    assert.doesNotMatch(key, /\/api\//, "no /api/** URL is ever written to a cache");
  }
  assert.equal(renditionState.size(), 0, "the rendition cache never receives staging entries");
});

test("ac-5: the executed worker never intercepts live /api/** and never caches it (the boundary stands)", async () => {
  const { listener, renditionState, staging } = await shareWorkerContext();
  const refused = [];
  listener("fetch")({
    request: { method: "GET", url: "https://hub.family/api/social/feed" },
    respondWith: () => refused.push(true),
  });
  assert.equal(refused.length, 0, "live /api data is never intercepted");
  assert.equal(renditionState.size() + staging.size, 0);
  // A POST to an undisturbed surface passes through untouched as well.
  const postResponded = [];
  listener("fetch")({
    request: { method: "POST", url: "https://hub.family/api/social/posts" },
    respondWith: (p) => postResponded.push(p),
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(postResponded.length, 0, "non-share POST requests are never intercepted");
});

test("ac-5: the activation sweep keeps the staging store; a stale rendition cache is swept", async () => {
  const { deletedNames, runActivate } = await shareWorkerContext();
  await runActivate();
  assert.match(JSON.stringify(deletedNames), /other-stale-v1/, "a stale cache is swept");
  assert.ok(!deletedNames.includes("porchlight-share-staging"), "staging survives the sweep");
});

test("ac-5: staged-share retrieval rides the message channel only, then clears behind compose", async () => {
  const { listener, staging } = await shareWorkerContext();
  const files = [new File([new Blob(["bytes"], { type: "image/png" })], "trip.png", { type: "image/png" })];
  listener("fetch")({
    request: { method: "POST", url: "https://hub.family/share", formData: async () => ({
      get: (field) => (field === "text" ? "Watch this" : ""),
      getAll: (field) => field === "media" ? files : [],
    }) },
    respondWith: (p) => p,
  });

  const posted = [];
  let resolver;
  const wait = new Promise((resolve) => { resolver = resolve; });
  listener("message")({
    data: { type: "share-staged-request" },
    source: { postMessage: (payload) => { posted.push(payload); resolver(); } },
    waitUntil: (p) => void p,
  });
  await wait;
  assert.equal(posted[0]?.type, "share-staged");
  assert.equal(posted[0]?.payload?.text, "Watch this");
  const stagedRow = posted[0]?.payload?.files?.[0];
  assert.equal(stagedRow?.name, "trip.png");
  assert.equal(stagedRow?.type, "image/png");
  assert.ok(stagedRow?.blob instanceof Blob, "the staged original bytes ride the payload");

  let clearReply;
  const clearFlights = [];
  listener("message")({
    data: { type: "share-staged-clear" },
    source: { postMessage: (payload) => { clearReply = payload; } },
    waitUntil: (p) => clearFlights.push(p),
  });
  await Promise.all(clearFlights);
  assert.equal(clearReply?.type, "share-staged-cleared");
  assert.equal(staging.size, 0, "the staging store empties once compose has taken the staged share");
});

test("ac-5: the app's request/clear helpers ride the bounded channel and degrade to null", async () => {
  // No worker, no controller: graceful absence — a plain launch, not an error.
  assert.equal(await requestStagedShare(null), null);
  // A worker that answers nothing within the bound resolves null too.
  assert.equal(await requestStagedShare({ postMessage: () => {} }, { timeoutMs: 20 }), null);
  // A worker replies on the transferred port; the payload resolves.
  const payload = { title: "", text: "Hello", url: "", files: [] };
  const receiving = {
    postMessage: (_message, transfer) => {
      const port = transfer?.[0];
      if (port?.postMessage) port.postMessage({ type: "share-staged", payload });
    },
  };
  assert.deepEqual(await requestStagedShare(receiving, { timeoutMs: 500 }), payload,
    "the transferred port delivers the staged payload");
  // Clear posts its type to the controller.
  const cleared = [];
  await clearStagedShare({ postMessage: (message) => { cleared.push(message.type); } });
  assert.deepEqual(cleared, ["share-staged-clear"]);
});

test("ac-5: source shape — renditions-first boundary untouched, the POST branch scoped to /share", () => {
  assert.match(workerSource, /request\.method === "POST" && new URL\(request\.url\)\.pathname === SHARE_TARGET_PATH/,
    "the POST branch is scoped to the share target's path, never /api/**");
  assert.match(workerSource, /if \(request\.method !== "GET"\) return;/,
    "every other non-GET still passes through untouched");
  // PORCH-125 amendment: the rendition filter is the branch of record — it
  // still gates BEFORE the /api boundary check inside the one fetch
  // listener (the boundary follows the branch); renditions first, order
  // carried, the interception set extended only by the /api-free shell
  // branches below it.
  assert.match(workerSource, /if \(url\.pathname\.includes\("\/renditions\/"\)\) \{\n?\s*event\.respondWith\(/,
    "the rendition filter keeps running before any /api boundary check");
  const renditionGate = workerSource.indexOf('if (url.pathname.includes("/renditions/")) {');
  const shellGate = workerSource.indexOf('if (url.pathname.startsWith("/api/")) return;');
  assert.ok(renditionGate >= 0 && shellGate > renditionGate, "the /api shell boundary follows the rendition branch");
});

test("ac-2: source — every per-media download control is mobile-conditional on both media surfaces", () => {
  // The card/detail overlay: share on touch, the ruled download on desktop.
  assert.match(socialSource, /const shareOriginalHere = overlayOriginalAction\(\) === 'share';/);
  assert.match(socialSource, /shareAction=\{shareOriginalHere \?/);
  // The full-screen viewer's chrome control carries the same law.
  assert.match(viewerSource, /const shareActive = overlayOriginalAction\(\) === 'share';/);
  assert.match(viewerSource, /const run = shareActive \? shareFromViewer : downloadOriginal;/);
  assert.match(viewerSource, /shareOriginal\(blob, mediaFileName\(activeId, blob\)\)/,
    "the original's bytes hand to the sheet under the media's real name");
});

/* ---- worker simulation harness ------------------------------------------ */

async function shareWorkerContext() {
  const staging = new Map();
  const rendition = new Map();
  const deletedNames = [];
  const keyOf = (entry) => (typeof entry === "string" ? entry
    : entry instanceof Request ? entry.url : String(entry?.url ?? entry));
  const makeCache = (store) => ({
    match: async (request) => store.get(keyOf(request)),
    put: async (request, response) => store.set(keyOf(request), response),
    keys: async () => [...store.keys()],
    delete: async (request) => store.delete(keyOf(request)),
  });
  const stageCache = makeCache(staging);
  const renditionCache = makeCache(rendition);
  const listeners = new Map();
  const sandbox = {
    self: {
      addEventListener: (type, fn) => listeners.set(type, fn),
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      open: async (name) => (name === "porchlight-share-staging" ? stageCache : renditionCache),
      keys: async () => ["porchlight-renditions-v1", "porchlight-share-staging", "other-stale-v1"],
      delete: async (name) => { deletedNames.push(name); return true; },
    },
    fetch: async () => new Response("x", { status: 200 }),
    Request: class extends Request {
      constructor(input, init) {
        super(typeof input === "string" && input.startsWith("/") ? `https://hub.family${input}` : input, init);
      }
    },
    Headers, URL, Response, Blob, File,
    setTimeout, clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(workerSource, sandbox);
  let drained = [];
  const drainedPush = (promise) => drained.push(promise);
  return {
    listener: (type) => listeners.get(type),
    staging,
    renditionState: { size: () => rendition.size, keys: () => [...rendition.keys()] },
    deletedNames,
    runActivate: async () => {
      drained = [];
      listeners.get("activate")({ waitUntil: drainedPush });
      await Promise.all(drained);
    },
  };
}