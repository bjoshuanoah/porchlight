import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { readStoredMode, writeStoredMode, resolveMode, MODE_KEY, MODES } from "../src/mode.js";
import { lightTokens, darkTokens } from "../src/theme.js";

const webRoot = join(dirname(fileURLToPath(new URL(import.meta.url))), "..");

// Storage stub: the same shape the browser gives window.localStorage.
function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
  };
}

// ac-1: System is the default; a manual choice persists client-side per
// origin; the server stores no display-mode state.
test("PORCH-042 ac-1: mode resolution defaults to System and follows the device preference", () => {
  const storage = memoryStorage();
  assert.equal(MODES.join(" "), "light dark system");
  assert.equal(readStoredMode(storage), "system");
  assert.equal(resolveMode("system", false), "light");
  assert.equal(resolveMode("system", true), "dark");
  assert.equal(resolveMode(undefined, true), "dark"); // no override at all
});

test("PORCH-042 ac-1: a manual Light/Dark choice is stored, persists, and wins over the device", () => {
  const storage = memoryStorage();
  writeStoredMode(storage, "dark");
  assert.equal(storage.getItem(MODE_KEY), "dark");
  assert.equal(readStoredMode(storage), "dark");
  assert.equal(resolveMode(readStoredMode(storage), false), "dark");
  writeStoredMode(storage, "light");
  assert.equal(resolveMode(readStoredMode(storage), true), "light");
});

test("PORCH-042 ac-1: choosing System clears the override and junk values resolve to System", () => {
  const storage = memoryStorage();
  writeStoredMode(storage, "dark");
  writeStoredMode(storage, "system");
  assert.equal(storage.getItem(MODE_KEY), null); // absence-of-override model
  assert.equal(readStoredMode(storage), "system");
  storage.setItem(MODE_KEY, "midnight");
  assert.equal(readStoredMode(storage), "system");
  // A throwing storage (private-mode block) degrades to System, never throws.
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
  assert.equal(readStoredMode(broken), "system");
  assert.equal(writeStoredMode(broken, "dark"), "dark"); // returns the mode; paint still follows
});

// ac-2: the pre-paint script in the SPA document resolves the stored mode
// (or the media query) before first render and sets html[data-theme] plus
// the background so dark never flashes warm-cream.
test("PORCH-042 ac-2: index.html carries the pre-paint mode script ahead of the app bundle", async () => {
  const html = await readFile(join(webRoot, "index.html"), "utf8");
  const script = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));
  assert.match(script, /localStorage\.getItem\("porchlight:mode"\)/);
  assert.match(script, /prefers-color-scheme: dark/);
  assert.match(script, /dataset\.theme = dark \? "dark" : "light"/);
  assert.match(script, /style\.backgroundColor = dark \? "#17120E" : "#F7F5F0"/);
  assert.match(script, /meta\[name="theme-color"\]/);
  assert.match(script, /matchMedia/);
  // The two background hexes are the token sets' page values, not freehand.
  assert.match(script, new RegExp(`#\\S+" : "#F7F5F0"`));
  assert.equal(script.includes("#17120E"), darkTokens.page === "#17120E");
  assert.equal(script.includes("#F7F5F0"), lightTokens.page === "#F7F5F0");
  // It must run before the module bundle so the attribute precedes render.
  // The pre-paint script must run ahead of the module bundle.
  assert.ok(html.indexOf("<script>") < html.indexOf('"/src/main.jsx"'));
});

// ac-2: the app wires the mode system — React resolves the mode, listens to
// device changes, and materializes the MUI theme per resolved mode (no
// reload during a switch).
test("PORCH-042 ac-2: main.jsx resolves mode pre-theme, tracks the device preference, and syncs the document", async () => {
  const source = await readFile(join(webRoot, "src", "main.jsx"), "utf8");
  assert.match(source, /readStoredMode\(stored\)/);
  assert.match(source, /resolveMode\(modePref, systemDark\)/);
  assert.match(source, /themeFor\(displayMode\)/);
  assert.match(source, /prefers-color-scheme: dark/);
  assert.match(source, /addEventListener\("change"/); // system preference is live
  assert.match(source, /dataset\.theme = displayMode/);
  assert.match(source, /<ThemeProvider theme=\{muiTheme\}>/); // one provider, per-mode theme
  assert.match(source, /chooseMode/);
  assert.match(source, /tokenStyles\(\)/); // both mode token blocks, injected pre-render
  // No reload on switch: the SPA never re-fetches the document for a mode change.
  assert.doesNotMatch(source, /location\.reload|window\.location =/);
});

// Regression (user-reported, Oct 10 2026): clicking System did not stick —
// the Profile toggle was controlled by the *resolved* mode, so choosing
// System on a device whose theme already matched the cleared override snapped
// the selection straight back and looked like nothing happened. The control
// must be bound to the stored preference, and the resolved mode must keep
// driving only the theme.
test("PORCH-042 regression: the Profile appearance control is bound to the preference, not the resolved mode", async () => {
  const source = await readFile(join(webRoot, "src", "main.jsx"), "utf8");
  assert.match(source, /mode: modePref/); // preference drives the control
  assert.doesNotMatch(source, /mode: displayMode/); // resolved mode never controls it
  // The resolution stays theme-only: themeFor consumes displayMode.
  assert.match(source, /const muiTheme = themeFor\(displayMode\)/);
});

// ac-1: the appearance setting renders in Profile with the three modes.
test("PORCH-042 ac-1: the Profile appearance setting offers Light / Dark / System", async () => {
  const source = await readFile(join(webRoot, "src", "identity.jsx"), "utf8");
  assert.match(source, /Appearance<\/Typography>/);
  assert.match(source, /ToggleButtonGroup exclusive/);
  assert.match(source, /value="light" aria-label="Light mode">Light</);
  assert.match(source, /value="dark" aria-label="Dark mode">Dark</);
  assert.match(source, /value="system" aria-label="Follow this device's theme">System</);
  assert.match(source, /The choice stays on this device for everyone using it/);
  // Device-level, not identity-scoped: the chooser rides actions.chooseMode.
  assert.match(source, /actions\.chooseMode\(next\)/);
});