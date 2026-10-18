// PORCH-082 — Photo Viewer: fading overlay controls, the full-screen
// zoomable paged viewer, and the branded download-all end-card. Pins the
// build contract (TS §10, Porchlight UI, Brian Oct 15, 2026): the per-image
// "download original and share" row is retired everywhere, the overlay
// carries exactly original download + expand with a disabled hit area while
// faded, zoom/pan/paging math is bounded, the original fetch fires only on
// zoom past rendition resolution, the position indicator holds the ruled
// 3–5s window and counts the end-card slot, and the end-card rides the
// bulk-original archive route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  POSITION_HOLD_MS, DEFAULT_ZOOM, MAX_ZOOM,
  panBounds, clampPan, anchoredPan, zoomTo, pinchTo, wheelZoom,
  needsOriginal, viewerTotalCount,
} from '../src/photo-viewer.js';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const social = readFileSync(here('../src/social.jsx'), 'utf8');
const viewer = readFileSync(here('../src/photo-viewer.jsx'), 'utf8');
const main = readFileSync(here('../src/main.jsx'), 'utf8');
const actions = readFileSync(here('../src/member-actions.js'), 'utf8');

// ac-1 — retirement sweep: no per-image download text control outside the
// overlay renders anywhere (DOM-sweep equivalent: repo source scan).
test('PORCH-082 ac-1: the per-image download and share text link retires on every media surface', () => {
  // The Get original / Share row is gone from the one code path every
  // media surface renders through (post detail media, timeline card media,
  // carousel slides, reply media all route through MediaItem).
  assert.doesNotMatch(social, />Get original<\/Button>/);
  assert.doesNotMatch(social, />Share<\/Button>/);
  assert.doesNotMatch(social, /aria-label="Media actions"/);
  // The share sheet machinery of the retired row (clipboard fallback, file
  // naming for share) leaves with it.
  assert.doesNotMatch(social, /navigator\.canShare/);
  assert.doesNotMatch(social, /shareMedia/);
  // The overlay control renders per media element: the top-right chip with
  // exactly two actions — "↓ Original" and the expand icon (accessible name
  // "View full screen"); share is absent from it (it rides the ··· menus).
  assert.match(viewer, /function MediaOverlay/);
  assert.match(viewer, />↓ Original<\/Button>/);
  assert.match(viewer, /aria-label="View full screen"/);
  assert.doesNotMatch(viewer, /aria-label="Share"|>Share</);
  // MediaItem renders the overlay for photo and video frames.
  assert.match(social, /<MediaOverlay shown=\{overlayShown\}/);
  // Carousel and the single-media stack both wire the overlay expand.
  assert.match(social, /index=\{index\} onExpand=\{onExpand\}/);
  assert.match(social, /index=\{index\} onExpand=\{onExpand\}/);
});

test('PORCH-082 ac-1: the overlay fades with the chrome and its hit area disables while faded', () => {
  // Reveal is tap (touch) / hover (pointer): the outer media Box carries
  // the hover pair, photos toggle on tap, video reveals with the panel tap.
  assert.match(social, /onMouseEnter=\{\(\) => setOverlayShown\(true\)\}/);
  assert.match(social, /onMouseLeave=\{\(\) => setOverlayShown\(false\)\}/);
  assert.match(social, /if \(tapTogglesOverlay\) setOverlayShown\(\(shown\) => !shown\)/);
  assert.match(social, /setPanelOpen\(true\);\s*\n\s*setOverlayShown\(true\);/);
  // The overlay's own taps never re-toggle the frame (stopPropagation).
  assert.match(viewer, /onClick=\{\(event\) => event\.stopPropagation\(\)\}\s*\n?\s*onTouchStart/);
  // While faded: opacity 0 AND pointer-events none (swipes pass through);
  // the fade rides the established 140–220ms band (build value 180ms).
  assert.match(viewer, /opacity: shown \? 1 : 0, pointerEvents: shown \? 'auto' : 'none'/);
  assert.match(viewer, /FADE_MS/);
  // Per-slide state: each MediaItem instance owns its shown state.
  assert.match(social, /const \[overlayShown, setOverlayShown\] = useState\(false\);/);
});

// ac-2 — zoom, pan, paging.
test('PORCH-082 ac-2: zoom anchors at the gesture point with pan bounded to the media surface', () => {
  const fit = { width: 800, height: 600 };
  const vp = { width: 400, height: 300 };
  // Fit stage: nothing pans, nothing zooms.
  assert.deepEqual(zoomTo({ scale: 1, x: 0, y: 0 }, 1, 0, 0, vp.width, vp.height, fit.width, fit.height), { scale: 1, x: 0, y: 0 });
  // Double-tap zoom to 2x anchored at the tap point keeps the tapped
  // content point under the gesture.
  const at = zoomTo({ scale: 1, x: 0, y: 0 }, DEFAULT_ZOOM, 100, 50, vp.width, vp.height, fit.width, fit.height);
  assert.equal(at.scale, DEFAULT_ZOOM);
  const unit = anchoredPan({ scale: 1, x: 0, y: 0 }, DEFAULT_ZOOM, 100, 50);
  assert.equal(unit.x, -100);
  // Pan bounds (2x of a contain-fit image in a half-scale viewport):
  // the scale-2 media overflows half its scaled size on both axes.
  const bounds = panBounds(2, vp.width, vp.height, fit.width, fit.height);
  assert.deepEqual(bounds, { x: 600, y: 450 });
  const clamped = clampPan(9999, -9999, bounds);
  assert.deepEqual(clamped, { x: bounds.x, y: -bounds.y });
  // Pinch multiplies from the start distance ratio; the anchor is midpoint.
  const pinched = pinchTo(at, 100, 150, 0, 0, vp.width, vp.height, fit.width, fit.height);
  assert.ok(pinched.scale > at.scale);
  // Wheel zoom is multiplicative and clamped to the max.
  const wheeled = wheelZoom({ scale: MAX_ZOOM - 0.01, x: 0, y: 0 }, -500, 0, 0, vp.width, vp.height, fit.width, fit.height);
  assert.equal(wheeled.scale, MAX_ZOOM);
  // Degenerate fits never zoom.
  assert.deepEqual(wheelZoom({ scale: 1, x: 0, y: 0 }, -500, 0, 0, vp.width, vp.height, 0, 0), { scale: 1, x: 0, y: 0 });
});

test('PORCH-082 ac-2: the viewer rides gesture listeners and the zoom-suspended page lock', () => {
  // Native (non-passive) listeners so zoom gestures can preventDefault.
  assert.match(viewer, /addEventListener\('wheel', onWheel, \{ passive: false \}\)/);
  assert.match(viewer, /addEventListener\('touchmove', onTouchMove, \{ passive: false \}\)/);
  // Native scroll-snap paging: the track is the PORCH-045 mechanics of record.
  assert.match(viewer, /scrollSnapType: 'x mandatory'/);
  assert.match(viewer, /scrollSnapStop: 'always'/);
  assert.match(viewer, /carouselIndex\(track\.scrollLeft, track\.clientWidth, total\)/);
  // While zoomed, paging suspends: the track stops scrolling and swipes pan.
  assert.match(viewer, /track\.style\.overflowX = zoom\.scale > 1 \? 'hidden' : 'auto'/);
  assert.match(viewer, /panRef\.current = \{ x: touch\.clientX, y: touch\.clientY \}/);
  // Double-tap toggles fit ↔ the default zoom, anchored at the gesture point.
  assert.match(viewer, /prev\.scale > 1 \? 1 : DEFAULT_ZOOM/);
  // Renditions render at fit; originals fetch only for the zoomed view.
  assert.match(viewer, /needsOriginal\(activeMeta, zoom\.scale, viewport\.width, window\.devicePixelRatio \|\| 1\)/);
  assert.match(viewer, /originals\.current\.get\(activeId\)/);
});

test('PORCH-082 ac-2: the original fetch decision — none at fit, one past rendition resolution', () => {
  const meta = {
    mediaId: 'm1', width: 6000, height: 4000,
    renditions: [{ kind: 'feed-thumb', width: 480, sha256: 'a' }, { kind: 'mid', width: 1080, sha256: 'b' }, { kind: 'large', width: 2560, sha256: 'c' }],
  };
  assert.equal(needsOriginal(meta, 1, 390, 2), false, 'fit browsing never fetches');
  assert.equal(needsOriginal(meta, 2, 390, 2), false, '2x of 1560 device pixels is still inside the ladder');
  assert.equal(needsOriginal(meta, 4, 390, 2), true, '6240 needed pixels pass the 2560 ladder top');
  assert.equal(needsOriginal(null, 4, 390, 2), false, 'legacy payloads render the explicit original already');
  assert.equal(needsOriginal({ mediaId: 'm1', width: 2000, height: 1000, renditions: [{ kind: 'large', width: 4000, sha256: 'c' }] }, 4, 390, 2), false,
    'no wider original to serve: the ladder already tops the stored width');
});

// ac-3 — the position indicator.
test('PORCH-082 ac-3: the indicator holds within the ruled 3–5s band, fades, and returns', () => {
  assert.ok(POSITION_HOLD_MS >= 3000 && POSITION_HOLD_MS <= 5000);
  assert.equal(POSITION_HOLD_MS, 4000);
  // Rendition on open, page change, chrome reveal; pointer-events none
  // while faded; instant on reduced motion.
  assert.match(viewer, /setTimeout\(\(\) => setChromeUp\(false\), POSITION_HOLD_MS\)/);
  assert.match(viewer, /pointerEvents: 'none', \.\.\.fade\(\)/);
  assert.match(viewer, /revealChrome\(\);[\s\S]{0,120}return \(\) => \{ if \(chromeTimer\.current\) clearTimeout/);
  assert.match(viewer, /prefers-reduced-motion: reduce/);
  // The indicator counts the end-card slot: N total = photos + 1.
  assert.equal(viewerTotalCount(0), 1);
  assert.equal(viewerTotalCount(1), 2);
  assert.equal(viewerTotalCount(12), 13);
  assert.match(viewer, /viewerTotalCount\(photos\.length\)/);
});

// ac-4 — the end-card.
test('PORCH-082 ac-4: the end-card is the last slide of the paged surface and books the bulk zip', () => {
  // In the paged surface: the end-card renders as a track slide (never a popup).
  assert.match(viewer, /photos\.length > 0 && <EndCardSlide count=\{photos\.length\}/);
  assert.match(viewer, /function EndCardSlide/);
  // Branded composition: thumbnail-stack icon, heading, quantity line, the
  // strong amber button (48px class, ≥44 target).
  assert.match(viewer, /PhotoLibraryOutlined/);
  assert.match(viewer, /Download all originals/);
  assert.match(viewer, /full-resolution image/);
  assert.match(viewer, /height: 48/);
  assert.match(viewer, /bgcolor: viewerTokens\.amber/);
  // In-flight state is plain language (no counts); failure names its state
  // and the same button retries.
  assert.match(viewer, /Fetching your originals…/);
  assert.match(viewer, /setError\(failure\?\.message \|\| 'That did not work\. Please try again\.'\)/);
  // The set zip rides the bulk-original archive route (PORCH-083's
  // contract), composed at the post's own origin network.
  assert.match(viewer, /actions\?\.bulkOriginals/);
  assert.match(main, /bulkOriginals: async \(post\)/);
  assert.match(main, /bulkPostOriginals\(connectionForPost\(post\), post\)/);
  // The wire shape is the served route of record: /api/social with no
  // network segment (the membership token IS the origin — PORCH-013
  // convention). A network-segmented URL 404s on every hub (PORCH-083 Oct
  // 18 field report).
  assert.match(actions,
    /\/api\/social\/posts\/\$\{encodeURIComponent\(postId\)\}\/media\/originals\.zip/);
  assert.doesNotMatch(actions, /\/posts\/\$\{encodeURIComponent\(member\.networkId\)\}/);
  // Back-swipe never blocks browsing: the card is an ordinary slide.
  assert.match(viewer, /viewerTotalCount/);
});

// ac-5 — composition with the existing law.
test('PORCH-082 ac-5: history, Escape, geometry stamps, warm dark, and containment', () => {
  // The viewer pushes one history entry so back exits it; Escape closes
  // through the same path.
  assert.match(viewer, /window\.history\.pushState\(\{ porchlightPhotoViewer: true \}, ''\)/);
  assert.match(viewer, /addEventListener\('popstate', onPop\)/);
  assert.match(viewer, /event\.key === 'Escape'/);
  // Geometry stamps reserve every full-screen frame before bytes arrive.
  assert.match(viewer, /fitDimensions\(activeMeta\.width, activeMeta\.height, viewport\.width, viewport\.height\)/);
  assert.match(viewer, /stampedAspect\(meta\)/);
  // Dark composition: warm dark tokens, never cold gray; the overlay's
  // glass treatment rides the same token family.
  assert.match(viewer, /bgcolor: viewerTokens\.page/);
  assert.match(viewer, /backdropFilter: viewerTokens\.backdropBlur/);
  // Containment and the render-time filter carry: the viewer's set is the
  // post's own surface-rendered mediaRefs — nothing resolves media the
  // surface never rendered.
  assert.match(social, /<PhotoViewer post=\{post\} ids=\{ids\} actions=\{actions\} startIndex=\{viewerIndex\} onClose=/);
});