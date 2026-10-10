// PORCH-042 (Brian, Oct 14, 2026): the display-mode store. One device-level
// preference — Light / Dark / System, System the default (prefers-color-scheme)
// — held in browser-local storage per origin. The server stores no display-mode
// state, ever (per the paired PRD: mode is a device setting on shared devices,
// not per identity and not per session). Explicitly choosing System removes the
// stored override so absence keeps meaning System.
export const MODE_KEY = "porchlight:mode";
export const MODES = ["light", "dark", "system"];
export const DEFAULT_MODE = "system";

export function isMode(value) {
  return MODES.includes(value);
}

// Invalid or absent values fall back to System — a corrupted entry never
// becomes a failed paint.
export function readStoredMode(storage) {
  if (!storage) return DEFAULT_MODE;
  try {
    const value = storage.getItem(MODE_KEY);
    return isMode(value) ? value : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

// "system" stores nothing: the stored-overrides-only model per the directive
// ("absence of an override resolves from prefers-color-scheme"). Storage
// failures (private-mode blocks) resolve back to System, never throw.
export function writeStoredMode(storage, mode) {
  if (!isMode(mode)) return DEFAULT_MODE;
  try {
    if (mode === "system") storage.removeItem(MODE_KEY);
    else storage.setItem(MODE_KEY, mode);
  } catch { /* the member's device decides the theme this visit */ }
  return mode;
}

// The single resolution rule: a manual Light/Dark choice wins; System (or
// absence) resolves from the device preference.
export function resolveMode(storedMode, systemDark) {
  if (storedMode === "light" || storedMode === "dark") return storedMode;
  return systemDark ? "dark" : "light";
}