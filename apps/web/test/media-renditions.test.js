// Media delivery (PORCH-044): the responsive rendition ladder, the
// content-addressed browser-cache contract, and the service-worker
// rendition transport. The pure ladder helpers are pinned as a contract
// module; the worker and the wiring are pinned as source contracts (same
// style as the photo-first pins).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  renditionSrcset,
  timelineImageSizes,
  detailImageSizes,
  playableVideoUrl,
  posterUrl,
  rungKindForViewport,
} from "../src/media-rung.js";
import { photoFirst } from "../src/photo-first.js";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const src = async (file) => await readFile(join(webRoot, file), "utf8");

const ORIGIN = "https://hub.family";
const imageMeta = {
  mediaId: "med_1",
  contentType: "image/jpeg",
  width: 4032,
  height: 3024,
  poster: null,
  renditions: [
    { kind: "detail", sha256: "cc".repeat(32), width: 1600, height: 1200, bytes: 100 },
    { kind: "feed-thumb", sha256: "aa".repeat(32), width: 640, height: 480, bytes: 40 },
    { kind: "album", sha256: "bb".repeat(32), width: 1080, height: 810, bytes: 70 },
  ],
};
const videoMeta = {
  mediaId: "med_2",
  contentType: "video/mp4",
  width: 1920,
  height: 1080,
  poster: { kind: "poster", sha256: "dd".repeat(32), width: 640, height: 360, bytes: 12 },
  renditions: [{ kind: "playable", sha256: "ee".repeat(32), width: 1280, height: 720, bytes: 900 }],
};

test("PORCH-044 ac-2: the ladder builds an ascending srcset from the hydrated meta", () => {
  const srcset = renditionSrcset(imageMeta, ORIGIN);
  const parts = srcset.split(", ");
  assert.deepEqual(parts.map((part) => part.split(" ").pop()), ["640w", "1080w", "1600w"]);
  assert.ok(parts[0].startsWith(`${ORIGIN}/api/social/media/med_1/renditions/feed-thumb?v=${"aa".repeat(32)}`));
  // Content-addressed: no query version, no URL reuse of the original.
  for (const part of parts) assert.ok(/\?v=[0-9a-f]{64} /.test(`${part} `));
});

test("PORCH-044 ac-2: sizes match the photo-first treatments", () => {
  // Timeline: full-bleed mobile (breakout), the desktop card interior past
  // the card padding.
  const sizes = timelineImageSizes();
  assert.ok(sizes.startsWith(`(max-width: ${photoFirst.mobileBelow - 1}px) 100vw`));
  assert.ok(sizes.endsWith(`calc(min(780px, 100vw - 40px) + ${2 * photoFirst.postPad}px)`));
  // Detail: capped by the 720px height cap and the media's own aspect.
  // 720 × (4032/3024) = 960 — wider renders clamp at the detail width cap.
  assert.equal(
    detailImageSizes(imageMeta),
    `(max-width: ${photoFirst.mobileBelow - 1}px) 100vw, 820px`,
  );
});

test("PORCH-044 ac-2: detail sizes follow the payload aspect", () => {
  const portrait = { ...imageMeta, width: 3024, height: 4032 };
  // 720 × (3024/4032) = 540 → the widest useful detail render.
  assert.ok(detailImageSizes(portrait).endsWith("540px"));
});

test("PORCH-044 ac-4: video meta exposes the playable rendition + poster, images none", () => {
  assert.ok(playableVideoUrl(videoMeta, ORIGIN).endsWith(`/renditions/playable?v=${"ee".repeat(32)}`));
  assert.ok(posterUrl(videoMeta, ORIGIN).endsWith(`/renditions/poster?v=${"dd".repeat(32)}`));
  assert.equal(playableVideoUrl(imageMeta, ORIGIN), null);
  assert.equal(posterUrl(imageMeta, ORIGIN), null);
});

test("PORCH-044 ac-2: the blob-loader fallback picks the nearest fitting rung", () => {
  // 320 CSS px @ 2 DPR over a 4032-wide original → 640 rung fits first.
  assert.equal(rungKindForViewport(imageMeta, 320, 2), "feed-thumb");
  assert.equal(rungKindForViewport(imageMeta, 460, 2), "album");
  assert.equal(rungKindForViewport(imageMeta, 640, 2), "detail");
  // A never-upscale cap: nothing renders wider than the original.
  assert.equal(rungKindForViewport({ ...imageMeta, width: 512, height: 384 }, 400, 4), "feed-thumb");
  // Video posts ride the playable rendition in fallback mode.
  assert.equal(rungKindForViewport(videoMeta, 390, 3), "playable");
});

test("PORCH-044 ac-3: the rendition worker cache-firsts content-addressed URLs only", async () => {
  const worker = await src("public/sw.js");
  // The worker intercepts rendition requests only — originals bypass (no
  // pre-cached archive bytes) and only authenticated, content-addressed
  // responses enter the store.
  assert.match(worker, /pathname\.includes\("\/renditions\/"\)/);
  assert.match(worker, /searchParams\.has\("v"\)/);
  assert.match(worker, /"media-auth"/);
  assert.match(worker, /porchlight-renditions-v1/);
  assert.doesNotMatch(worker, /\/original/);
  // Boot race: a rendition request that starts before the token relay
  // reaches the worker waits for the relay (bounded) instead of fetching
  // unauthenticated — a 401 to an <img> is a permanent media failure (the
  // element never retries).
  assert.match(worker, /const token = await tokenFor\(url\.origin\)/);
  assert.match(worker, /tokenWaiters/);
  assert.match(worker, /timeoutMs = 3000/);
  // A PRESENT-but-rejected token (boot-window credential churn) parks the
  // request and retries with each renewed-token publication until one
  // answers or the park budget expires; a genuinely unauthenticated request
  // surfaces its 401 immediately.
  assert.match(worker, /response\.status === 401 && token/);
  assert.match(worker, /while \(response\.status === 401 && Date\.now\(\) < deadline\)/);
  assert.match(worker, /PARK_BUDGET_MS = 8000/);
  assert.match(worker, /authedRequest\(request, tokensByOrigin\[url\.origin\]\)/);
  // PORCH-050: the authed re-issue never re-uses the intercepted no-cors
  // request — the request-no-cors headers guard is not required to carry
  // non-safelisted names and Authorization is not safelisted (Safari drops
  // the value), which can re-issue rendition fetches UNAUTHENTICATED on
  // that engine (the reported desktop album-401 root). The worker rebuilds
  // the request same-origin in cors mode, where the header carries and no
  // preflight applies.
  assert.doesNotMatch(worker, /new Request\(request, \{ headers \}\)/);
  assert.match(worker, /mode: "cors"/);
  assert.match(worker, /headers\.set\("authorization"/);
  // The boot-time sync can publish the SAME token the park just failed on;
  // only a changed token set wakes parked requests — otherwise the park
  // retries the identical stale-token request and 401s again.
  assert.match(worker, /tokensByOrigin\[origin\] !== incoming\[origin\]/);
  assert.match(worker, /if \(changed\)/);
  // An empty relay (the boot-time sync can publish none) must not resolve a
  // waiting rendition request; only a credential-bearing publication wakes.
  assert.match(worker, /Object\.values\(incoming\)\.some\(\(token\) => Boolean\(token\)\)/);
  // The registration relay posts only a synced token set — an empty default
  // relay would resolve the wait unauthenticated and 401 first-load media.
  const transport = await src("src/media-transport.js");
  assert.match(transport, /if \(pendingTokens !== null\)/);
  assert.doesNotMatch(transport, /pendingTokens \?\? \{\}/);
});

test("PORCH-044 ac-3: originals resolve with no-store from the client action", async () => {
  const main = await src("src/main.jsx");
  // The getMedia original path stays the explicit archive action; rendition
  // requests carry the content address for the immutable cache.
  assert.match(main, /kind === "original"\s*\?\s*`media\/\$\{encodeURIComponent\(mediaId\)\}\/original`/);
  assert.match(main, /\?v=\$\{encodeURIComponent\(version\)\}/);
  assert.match(main, /registerMediaTransport/);
  assert.match(main, /syncMediaTransport/);
});

test("PORCH-044 ac-1/ac-2: member surfaces render the ladder, originals stay explicit", async () => {
  const social = await src("src/social.jsx");
  // Direct images carry the ladder + sizes; the video element renders its
  // poster and playable rendition; the explicit original remains "Get original".
  assert.match(social, /srcSet=\{renditionSrcset\(meta, origin\)/);
  assert.match(social, /sizes=\{detail \? detailImageSizes\(meta\) : timelineImageSizes\(\)\}/);
  assert.match(social, /component="video" src=\{videoPlayable\} poster=\{videoPoster\}/);
  assert.match(social, />Get original<\/Button>/);
  // No surface fetches original bytes for rendering anymore — the original
  // rides only the explicit download action and the pre-PORCH-044 legacy
  // payload fallback.
  assert.ok(!/getMedia\(id, 'original', origin\);\s*\n\s*\}\)\.then\(async \(blob\) => [\s\S]*component="img"/.test(social));
  // The fallback loader answers cadence-driven repeats from the
  // identity-cache (media-blob.js): a cache hit re-serves the SAME object
  // URL and returns before any network read or revoke — the page-visible
  // reload churn (Brian's report) cannot come back through this path.
  assert.match(social, /readMediaBlob\(identity\)/);
  assert.match(social, /putMediaBlob\(identity, \{ url, blob, shape \}\)/);
  // Object URLs are owned by the cache: the effect cleanup revokes nothing.
  assert.doesNotMatch(social, /revokeObjectURL\(url\);\s*\n?\s*if \(posterUrlObj\) URL\.revokeObjectURL\(posterUrlObj\)/);
});

test("PORCH-044: the fallback blob cache owns fallback URLs by content identity", async () => {
  const cache = await import("../src/media-blob.js");
  const key = cache.mediaBlobKey({ origin: "https://hub", mediaId: "m", kind: "detail", version: null });
  assert.equal(cache.readMediaBlob(key), null, "an unloaded identity misses");

  const first = cache.putMediaBlob(key, { url: "blob:one", blob: Buffer.alloc(4) });
  assert.equal(cache.readMediaBlob(key).url, first.url, "the repeat request re-serves the same URL without refetch");
  const replaced = cache.putMediaBlob(key, {
    url: "blob:two",
    blob: Buffer.alloc(4),
    shape: { width: 1600, height: 1067 },
  });
  assert.equal(replaced.url, "blob:two");
  assert.equal(cache.readMediaBlob(key).blob, replaced.blob);
  cache.clearMediaBlobs();
});