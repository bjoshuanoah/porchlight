// PORCH-118: the loading asset of record and the boot copy/timing contract.
//
// loader mark is Brian's supplied animated webp (ruling, Oct 21, 2026: both load states — boot and in-app — carry the animated
// asset, animating from its own frames). The asset is committed at build
// into the SPA's static assets (apps/web/public/loader.webp, 36 frames @
// 15fps, derived exactly from the task's media) so the pre-JS static boot
// canvas (index.html) plays it before any JavaScript; the reduced-motion
// treatment renders the asset's static first frame
// (apps/web/public/loader-still.webp). The PORCH-095 drawn vector-twin
// choreography (facet climb, node glow, one pulse) is retired from the
// loading path by this ruling — what remains of that task here is the
// copy law and the dissolve timing. Colors of record (the boot's
// mode-invariant brand palette) stay in the theme token layer
// (src/theme.js bootTokens, --porch-boot-*).

// The asset of record — displayed at CSS height via the size constants
// below; the intrinsic dimensions keep the aspect locked for layout.
export const LOADER_ANIM_SRC = "/loader.webp";
export const LOADER_STILL_SRC = "/loader-still.webp";
export const LOADER_ANIM_W = 137;
export const LOADER_ANIM_H = 170;

// The mark reads fairly small on the boot (above the wordmark), much
// smaller in-app (reserved space).
export const BOOT_MARK_H = 92;
export const LOADER_MARK_H = 40;

// Crossfade into the app: a quick dissolve (~250ms), never a blank — the
// interface is already mounted beneath the boot layer.
export const BOOT_FADE_MS = 250;

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