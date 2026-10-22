// Loading assets and boot copy/timing contract. The initial dusk boot uses
// the full-resolution static app icon (/icon-512.png); only LanternLoader,
// the small in-app waiting mark, uses the animated webp and its reduced-
// motion still frame. The PORCH-095 readiness/dissolve remains unchanged.

// The asset of record — displayed at CSS height via the size constants
// below; the intrinsic dimensions keep the aspect locked for layout.
export const LOADER_ANIM_SRC = "/loader.webp";
export const LOADER_STILL_SRC = "/loader-still.webp";
export const LOADER_ANIM_W = 137;
export const LOADER_ANIM_H = 170;

// Brian's Oct 22 doubled boot size (184px) applies to the static icon.
// The in-app animated mark retains its reserved-space size.
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