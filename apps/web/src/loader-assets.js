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
// smaller in-app (reserved space). Brian, Oct 22, 2026: the boot lantern
// doubles — 200% bigger than the tuned 92px boot size; the in-app loader
// mark is untouched.
export const BOOT_MARK_H = 184;
export const LOADER_MARK_H = 40;

// Crossfade into the app: a quick dissolve (~250ms), never a blank — the
// interface is already mounted beneath the boot layer.
export const BOOT_FADE_MS = 250;

// Status lines: family vocabulary only. PORCH-119 (Brian, Oct 21, 2026 —
// the dusk-boot ruling): this boot-path rotation supersedes the Oct 16
// family lines; the in-app loader copy is unchanged (flows keep their own
// status hooks, carry-through judgment 2). Reveal at 1.5s (ruled, no
// longer tuned), crossfade every 3s, looping after the final line — no
// timeout honesty line anymore: a stuck boot names its state through the
// ac-11 failure surface, never a variant copy. No spinner, no percentage,
// no progress bar. The string "Loading" renders nowhere on the boot path
// — not as a line, not as a fallback (the one sanctioned exception is the
// a11y announcement "Porchlight is loading", ruled Oct 21).
export const STATUS_THRESHOLD_MS = 1500;
export const STATUS_CYCLE_MS = 3000;
export const STATUS_LINES = [
  "lighting the porch…",
  "knocking on the front door…",
  "ringing the doorbell…",
  "finding you a seat…",
  "seeing who's home…",
];
// Crossfade duration of record for the status line (and the boot's other
// opacity transitions); the dissolve keeps BOOT_FADE_MS.
export const STATUS_FADE_MS = 250;

// PORCH-119 ac-11: the boot's earned-failure copy. Verbatim reuse of the
// ruled unreachable copy of record (Brian, Oct 21, 2026 — errors are
// earned states; "never a variant") — the boot failure surface is the
// same earned state, never new wording. The retry label stays a plain
// family action. [Assumption flagged: the ruling names no boot-failure
// copy verbatim; reusing the ruled verbatim copy keeps the no-variant
// discipline instead of inventing boot-specific wording.]
export const BOOT_FAILURE_LINE =
  "A family server is unreachable. Saved moments may be out of date.";
export const BOOT_RETRY_LABEL = "Try again";

/** Pure: the status line for a boot elapsed `ms` — or null before the threshold. */
export function bootStatusLine(ms) {
  if (ms < STATUS_THRESHOLD_MS) return null;
  const idx = Math.floor((ms - STATUS_THRESHOLD_MS) / STATUS_CYCLE_MS);
  return STATUS_LINES[idx % STATUS_LINES.length];
}