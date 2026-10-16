// Colors of record: the boot's mode-invariant brand palette lives in the
// theme token layer (src/theme.js `bootTokens`, both display-mode sets, CSS
// custom properties --porch-boot-*) — screen code consumes properties only
// (PORCH-042). This module holds the mark's geometry and the motion
// schedule; the ramp, glow, and pulse timing ride these constants.
//
// PORCH-095: the lantern mark's node geometry — the animation model of
// record for the boot climb (LanternBoot) and the traveling glow
// (LanternLoader). PORCH-032 shipped the raster mark (public/lamp-mark.png);
// no SVG node model existed in the repo, so this module is the drawn twin
// built to the mark's silhouette: a hanging porch lantern with a flared
// crown, a two-band body, a warm cream core, and a stubbed base. Every
// animation composes from these coordinates with CSS/WAAPI — no video, no
// GIF, no Lottie, no spinner library enters the bundle (build contract,
// Brian Oct 16, 2026).
//
// The climb schedule: facets illuminate bottom → center → top with a
// staggered warm ramp; nodes glow briefly as the light reaches them, then
// settle. The fully-lit mark gives exactly one soft warm pulse (fill-mode
// forwards, never `infinite`). The full lit sequence is a CEILING of 1.5s:
// app readiness ends the boot the moment the first surface is ready, even
// mid-sequence (readiness is never held, never timer-driven).

export const MARK_VIEWBOX = "0 0 120 132";

// The mark reads ~72-88px on the boot (proposal tuned at build), ~36px
// in-app.
export const BOOT_MARK_SIZE = 80;
export const LOADER_MARK_SIZE = 36;

// Frame outline of the lantern, one closed path + its appurtenances.
// Hook ring and stem, crown (flared roof), neck collar, body upper (flares
// out), body lower (tapers in), base collar, two feet.
export const FRAME_PATHS = {
  hook: "M60 9 V16",
  hookRing: "M60 3 a3 3 0 1 0 0.01 0",
  crown: "M40 30 L52 16 L68 16 L80 30 Z",
  collar: "M46 30 H74 V36 H46 Z",
  bodyUpper: "M48 36 L72 36 L76 58 L44 58 Z",
  bodyLower: "M44 58 L76 58 L70 88 L50 88 Z",
  base: "M50 88 H70 V94 H50 Z",
  feet: "M52 94 V99 M68 94 V99",
};

// Glass facets, in climb order — bottom → center → top of the lantern.
// `delay` is the stagger into the warm ramp (ms); `rampMs` the facet's own
// illumination time. The cream core rides the center facet.
export const FACETS = [
  { id: "facet-bottom", path: FRAME_PATHS.bodyLower, level: "bottom", delay: 0 },
  { id: "facet-center", path: FRAME_PATHS.bodyUpper, level: "center", delay: 260, core: true },
  { id: "facet-top", path: FRAME_PATHS.crown, level: "top", delay: 520 },
];
export const FACET_RAMP_MS = 340;

// Nodes — the junction points where the frame's lines meet. The light
// glows each node briefly as it reaches the node's level, then settles.
export const NODES = [
  { cx: 60, cy: 3, level: "top" },
  { cx: 60, cy: 16, level: "top" },
  { cx: 40, cy: 30, level: "top" },
  { cx: 80, cy: 30, level: "top" },
  { cx: 46, cy: 36, level: "center" },
  { cx: 74, cy: 36, level: "center" },
  { cx: 44, cy: 58, level: "bottom" },
  { cx: 76, cy: 58, level: "bottom" },
  { cx: 50, cy: 88, level: "bottom" },
  { cx: 70, cy: 88, level: "bottom" },
  { cx: 50, cy: 94, level: "bottom" },
  { cx: 70, cy: 94, level: "bottom" },
];

// Node glow onset follows its level's facet delay, offset into the ramp so
// the light visibly "arrives" while the facet is still warming.
export const NODE_LEVEL_DELAY = { bottom: 0, center: 260, top: 520 };
export const NODE_GLOW_OFFSET_MS = 120;
export const NODE_GLOW_SETTLE_MS = 300;

// One soft warm pulse once fully lit: a single amber-glow bloom, 500ms,
// `animation-iteration-count: 1` — never a loop (the one-pulse rule).
export const PULSE_DELAY_MS = 950;
export const PULSE_MS = 500;

// Crossfade into the app: a quick dissolve (~250ms), never a blank — the
// interface is already mounted beneath the boot layer.
export const BOOT_FADE_MS = 250;

// Ceiling check: last facet (520) + ramp (340) ≈ 860ms; pulse runs to
// 950 + 500 = 1450ms — inside the 1-1.5s ceiling. Readiness cuts earlier.

// Status lines: family vocabulary only, cycled quietly after the copy
// threshold; no spinner, no percentage, no progress bar. The string
// "Loading" renders nowhere — not as a line, not as a fallback.
export const STATUS_THRESHOLD_MS = 1500;
export const STATUS_CYCLE_MS = 2000;
export const STATUS_LINES = [
  "Lighting the porch…",
  "Connecting…",
  "Fetching your feed…",
];
// Timeout honesty (assumed tuned at build): a boot that outlives the
// cycling lines names its state in plain family language instead of
// cycling silently forever.
export const STATUS_HONESTY_MS = STATUS_THRESHOLD_MS + STATUS_LINES.length * STATUS_CYCLE_MS;
export const STATUS_HONESTY_LINE = "Still lighting — your family server may still be waking up.";

/** Pure: the status line for a boot elapsed `ms` — or null before the threshold. */
export function bootStatusLine(ms) {
  if (ms < STATUS_THRESHOLD_MS) return null;
  const idx = Math.floor((ms - STATUS_THRESHOLD_MS) / STATUS_CYCLE_MS);
  if (idx < STATUS_LINES.length) return STATUS_LINES[idx];
  if (idx === STATUS_LINES.length) return STATUS_HONESTY_LINE;
  return STATUS_LINES[idx % STATUS_LINES.length];
}

// The loader's traveling glow circulates the mark's outline vertices — a
// closed path through the frame corners (crown eaves, waist, base) — as a
// quiet candlelight circuit, 2000ms [Assumed tuned at build: 1.6-2.4s
// band], never blinking or pulsing for attention.
export const GLOW_LOOP_PATH = "M40 30 L52 16 L68 16 L80 30 L76 58 L70 88 L50 88 L44 58 Z";
export const GLOW_LOOP_MS = 2000;