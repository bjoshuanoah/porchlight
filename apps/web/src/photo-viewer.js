// Photo Viewer (PORCH-082) pure build helpers — Brian, Oct 15, 2026 pair
// (PRD 6ad1242a89855af1a3cb464b / build contract TS §10 on Porchlight UI).
// Zoom math, the original-fetch decision, and the ruled timers live here so
// the SPA renders from them and the tests pin the contract. The JSX half
// (overlay control, full-screen viewer) is photo-viewer.jsx.
import { darkTokens, tokenAlpha } from "./theme.js";

// Position indicator hold. The contract rules a 3–5s band; the build value
// [Assumed: 4s] sits mid-band pending Brian's mock-up read (mock-ups were
// attached to PORCH-082 but their presigned media URL fails S3 InvalidToken
// at fetch time, so the build value stands).
export const POSITION_HOLD_MS = 4000;

// The default zoom level a double-tap settles on [Assumed: 2x, tuned at
// build]. Double-tap toggles between fit (1) and this level, anchored at
// the gesture point.
export const DEFAULT_ZOOM = 2;

// Double-tap recognizer window: two taps inside this interval with no
// wander between them zoom at the tap point; more than this is two taps.
export const DOUBLE_TAP_MS = 300;

// Maximum zoom the pinch gesture allows (past this the pixels are only
// spread, never resolved). Bounded so the pan math stays exact.
export const MAX_ZOOM = 5;

// The overlay/viewer glass chip's scrim: a translucent step of the dark
// page token, composed in the theme machinery (PORCH-042 token contract).
export const viewerTokens = {
  page: darkTokens.page,
  surface: darkTokens.surface,
  subtle: darkTokens.subtle,
  border: darkTokens.border,
  text: darkTokens.text.primary,
  textSecondary: darkTokens.text.secondary,
  amber: darkTokens.amber,
  amberHover: darkTokens.amberHover,
  amberInk: darkTokens.amberInk,
  scrim: tokenAlpha(darkTokens.page, 0.55),
  backdropBlur: "blur(10px)",
};

export const motion = { ease: "cubic-bezier(.2,.8,.2,1)", base: 180 };
// The overlay/chrome fade rides the established 140–220ms easing band.
export const FADE_MS = motion.base;

/**
 * The fit-stage media box inside the viewer viewport: object-fit contain
 * against the viewport, derived from the reserved geometry stamp (zero
 * reflow at open and page change — the frame is exact from first paint).
 */
export function fitDimensions(width, height, viewportWidth, viewportHeight) {
  if (!(width > 0) || !(height > 0) || !(viewportWidth > 0) || !(viewportHeight > 0)) return null;
  const scale = Math.min(viewportWidth / width, viewportHeight / height);
  return { width: width * scale, height: height * scale };
}

/**
 * Pan bounds while zoomed (ac-2 hook): translating the media must never
 * show the backdrop beyond the media edges, so each axis clamps to the
 * overflow the zoom adds in that direction.
 */
export function panBounds(scale, viewportWidth, viewportHeight, fitWidth, fitHeight) {
  const clamp = (value) => (Number.isFinite(value) ? value : 0);
  return {
    x: clamp(Math.max(0, (scale * fitWidth - viewportWidth) / 2)),
    y: clamp(Math.max(0, (scale * fitHeight - viewportHeight) / 2)),
  };
}

/** Clamp a pan offset into the bounds (each axis independently). */
export function clampPan(x, y, bounds) {
  return {
    x: Math.min(bounds.x, Math.max(-bounds.x, x)),
    y: Math.min(bounds.y, Math.max(-bounds.y, y)),
  };
}

/**
 * Pan a transform { scale, x, y } so the content point under (ax, ay)
 * stays anchored there (the gesture point): the transform is
 * `translate(x, y) scale(s)` with center origin, so the content-space
 * point under a viewport point is (a - x) / s.
 */
export function anchoredPan(prev, nextScale, anchorX, anchorY) {
  if (!(prev.scale > 0)) return { x: 0, y: 0 };
  const unitX = (anchorX - prev.x) / prev.scale;
  const unitY = (anchorY - prev.y) / prev.scale;
  return { x: anchorX - unitX * nextScale, y: anchorY - unitY * nextScale };
}

/**
 * Zoom to `nextScale` anchored at a viewport point, clamped into the
 * pan bounds for that scale. This is the pinch, double-tap, wheel, and
 * double-click zoom path — all zooms anchor at their gesture point.
 */
export function zoomTo(prev, nextScale, anchorX, anchorY, viewportWidth, viewportHeight, fitWidth, fitHeight) {
  // The pinch-settle threshold carries for every zoom path: a zoom request
  // at or below the settle band resolves to fit exactly, so a down-notch of
  // wheel drift never pins the track frozen at 1.0000-something.
  if (!(nextScale > 1.05) || !(fitWidth > 0)) return { scale: 1, x: 0, y: 0 };
  const scale = Math.min(MAX_ZOOM, nextScale);
  const bounds = panBounds(scale, viewportWidth, viewportHeight, fitWidth, fitHeight);
  const pan = clampPan(anchoredPan(prev, scale, anchorX, anchorY).x, anchoredPan(prev, scale, anchorX, anchorY).y, bounds);
  return { scale, x: pan.x, y: pan.y };
}

/**
 * One pinch step: the scale multiplies by the finger-distance ratio, the
 * anchor is the gesture midpoint.
 */
export function pinchTo(prev, startDistance, nowDistance, anchorX, anchorY, viewportWidth, viewportHeight, fitWidth, fitHeight) {
  if (!(startDistance > 0)) return { ...prev };
  return zoomTo(prev, prev.scale * (nowDistance / startDistance), anchorX, anchorY, viewportWidth, viewportHeight, fitWidth, fitHeight);
}

/**
 * Wheel zoom: the delta settles on the same anchored zoom path (each
 * notch is one multiplicative step).
 */
export function wheelZoom(prev, deltaY, anchorX, anchorY, viewportWidth, viewportHeight, fitWidth, fitHeight) {
  const factor = Math.exp(-(Number.isFinite(deltaY) ? deltaY : 0) * 0.002);
  return zoomTo(prev, prev.scale * factor, anchorX, anchorY, viewportWidth, viewportHeight, fitWidth, fitHeight);
}

/**
 * The zoomed-view original decision (ac-2): at fit the rendition ladder
 * answers every need (rendition-default ruling, PORCH-044) and the viewer
 * must not fetch originals; while zooming, the fetch fires once the zoom's
 * pixel need passes the LARGEST rendition rung — the member has zoomed
 * past rendition resolution — and only when the hub holds a wider
 * original to serve. Legacy payloads without a hydrating ladder never
 * trigger the fetch: what renders at fit there is already the original.
 */
export function needsOriginal(meta, scale, viewportWidth, devicePixelRatio) {
  if (!(scale > 1)) return false;
  const rungs = (meta?.renditions ?? [])
    .filter((rung) => rung.sha256 && (rung.width ?? 0) > 0 && rung.kind !== "poster" && rung.kind !== "playable")
    .sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  const largest = rungs.length ? rungs[rungs.length - 1].width : null;
  if (largest == null) return false;
  const need = viewportWidth * (devicePixelRatio || 1) * scale;
  return need > largest && (meta?.width ?? Infinity) > largest;
}

/**
 * The viewer's paged set with the end-card slot counted (ac-4): the
 * indicator's denominator is photos + 1 while the card reads as the last
 * swipe stop of the same sequence.
 */
export function viewerTotalCount(photoCount) {
  return Math.max(0, photoCount) + 1;
}

