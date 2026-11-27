// PORCH-130 console theming slice — the PORCH-042 mode contract ported to the
// console: mode resolution semantics, the pre-paint script in index.html, the
// no-branch screen rule over src/, the porch-lamp dark token contract, and
// the themeFor/tokenStyles machinery. Source-text + pure-module node --test
// per the repo pattern (apps/web/test/display-modes.test.js is the template);
// no DOM, no React rendering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { MODE_KEY, MODES, readStoredMode, writeStoredMode, resolveMode } from "../src/mode.js";
import { lightTokens, darkTokens, themeFor, tokenStyles, cssVars, tokenAlpha } from "../src/theme.js";

const consoleRoot = join(dirname(fileURLToPath(new URL(import.meta.url))), "..");

// Storage stub: the same shape the browser gives window.localStorage.
function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
  };
}

// Mode resolution: the exact storage semantics of src/mode.js (System is the
// default; a manual choice wins; absence keeps meaning System; a throwing
// or junk storage entry never becomes a failed paint).
test("PORCH-042 mode resolution: System default, manual choice wins, storage failures degrade to System", () => {
  assert.equal(MODES.join(" "), "light dark system");
  const storage = memoryStorage();
  assert.equal(readStoredMode(storage), "system");
  assert.equal(resolveMode("system", false), "light");
  assert.equal(resolveMode("system", true), "dark");
  assert.equal(resolveMode(undefined, true), "dark"); // no override at all
  writeStoredMode(storage, "dark");
  assert.equal(storage.getItem(MODE_KEY), "dark");
  assert.equal(resolveMode(readStoredMode(storage), false), "dark");
  writeStoredMode(storage, "light");
  assert.equal(resolveMode(readStoredMode(storage), true), "light"); // manual wins
  writeStoredMode(storage, "system");
  assert.equal(storage.getItem(MODE_KEY), null); // absence-of-override model
  assert.equal(readStoredMode(storage), "system");
  storage.setItem(MODE_KEY, "midnight");
  assert.equal(readStoredMode(storage), "system"); // junk resolves to System
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
  assert.equal(readStoredMode(broken), "system"); // private-mode block: never throws
  assert.equal(writeStoredMode(broken, "dark"), "dark"); // returns the mode; paint still follows
});

// The pre-paint script in the console document resolves the stored mode (or
// the media query) before the bundle executes and sets html[data-theme] plus
// the background color so dark never flashes warm-cream.
test("PORCH-042: index.html carries the pre-paint mode script ahead of the console bundle", async () => {
  const html = await readFile(join(consoleRoot, "index.html"), "utf8");
  const script = html.slice(html.indexOf("<script>"), html.indexOf("</script>"));
  assert.match(script, /localStorage\.getItem\("porchlight:mode"\)/);
  assert.match(script, /prefers-color-scheme: dark/);
  assert.match(script, /dataset\.theme = dark \? "dark" : "light"/);
  assert.match(script, /style\.backgroundColor = dark \? "#17120E" : "#F7F5F0"/);
  assert.match(script, /meta\[name="theme-color"\]/);
  assert.match(script, /matchMedia/);
  // The two background hexes are the token sets' page values, not freehand.
  assert.equal(script.includes("#17120E"), darkTokens.page === "#17120E");
  assert.equal(script.includes("#F7F5F0"), lightTokens.page === "#F7F5F0");
  // It must run before the module bundle so the attribute precedes render.
  assert.ok(html.indexOf("<script>") < html.indexOf('"/src/main.jsx"'));
});

// Guardrail: components consume custom properties only — no console source
// carries the mode machinery. theme.js is the token layer, mode.js is
// storage-only, main.jsx is the bootstrap/switching machinery; those are the
// only files allowed to name data-theme, prefers-color-scheme, or matchMedia.
test("PORCH-042: no console source branches on display mode outside the machinery files", async () => {
  const srcDir = join(consoleRoot, "src");
  const branchPattern = /data-theme|prefers-color-scheme|matchMedia/;
  const machinery = new Set(["theme.js", "mode.js", "main.jsx"]);
  // The console src nests screens and models under subpackages (screens/,
  // transcripts/, compute/, profiles/, editor/) — the rule walks all of it.
  async function walk(dir) {
    const files = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) files.push(...await walk(join(dir, entry.name)));
      else files.push(join(dir, entry.name));
    }
    return files;
  }
  for (const path of await walk(srcDir)) {
    if (machinery.has(path.slice(srcDir.length + 1))) continue;
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, branchPattern, `${path} branches on display mode (two token sets, one component code)`);
  }
});

// The porch-lamp dark contract (build contract §6; cold-generic dark banned
// by the console UI standard): dark is a warm rendering of the same token
// contract — the signature tokens all differ, and every dark surface hex
// satisfies red ≥ green ≥ blue (never neutral gray, never blue-shifted).
function hexChannels(hex) {
  const value = String(hex).replace("#", "");
  return [value.slice(0, 2), value.slice(2, 4), value.slice(4, 6)].map((pair) => parseInt(pair, 16));
}
test("PORCH-042: the porch-lamp dark set is a warm rendering of the same token contract", () => {
  const surfaces = ["page", "surface", "subtle", "warm", "border", "borderStrong"];
  for (const key of [...surfaces, "amber", "amberSoft", "amberHover", "timelineDivider", "appbarBg", "amberInk", "composeBackdrop", "mediaOverlay"]) {
    assert.notEqual(darkTokens[key], lightTokens[key], `dark ${key} differs from light`);
  }
  for (const tier of ["primary", "secondary", "muted", "inverse"]) {
    assert.notEqual(darkTokens.text[tier], lightTokens.text[tier], `dark text.${tier} differs from light`);
  }
  // Warmth invariant across every dark surface token.
  for (const key of surfaces) {
    const [r, g, b] = hexChannels(darkTokens[key]);
    assert.ok(r >= g && g >= b, `dark ${key} (${darkTokens[key]}) must stay warm-toned`);
  }
  // The porch-lamp pins of record (calibrated at build, apps/web parity).
  assert.equal(darkTokens.page, "#17120E");
  assert.equal(darkTokens.surface, "#221B16");
  assert.equal(darkTokens.amber, "#E8A54F");
  assert.equal(darkTokens.text.muted, "#9A8E81"); // the AA calibration step
  // The light set is untouched by the mode system (PORCH-022 pins stay valid).
  assert.equal(lightTokens.page, "#F7F5F0");
  assert.equal(lightTokens.surface, "#FFFFFF");
});

// One component code, two token sets: themeFor materializes the MUI theme
// per display mode, and tokenStyles() emits both modes' custom properties in
// one static style string — light block first (the :root default), dark
// second so the later block wins on html[data-theme="dark"].
test("PORCH-042: themeFor resolves per mode (system falls through the bootstrap) and tokenStyles carries both modes", () => {
  const darkTheme = themeFor("dark");
  assert.equal(darkTheme.palette.mode, "dark");
  assert.equal(darkTheme.palette.background.default, darkTokens.page);
  assert.equal(darkTheme.palette.primary.main, darkTokens.navy);
  assert.deepEqual(Object.keys(themeFor("light")), Object.keys(darkTheme));
  assert.deepEqual(Object.keys(themeFor("light").components), Object.keys(darkTheme.components));
  assert.equal(JSON.stringify(themeFor("light").typography), JSON.stringify(darkTheme.typography));
  // Memoized: a switch swaps one prebuilt theme in one render.
  assert.equal(themeFor("dark"), darkTheme);
  // "system" is never a display mode: the bootstrap resolves it to light/dark
  // first, and the materializer falls through to the light contract.
  assert.equal(themeFor("system"), themeFor("light"));
  const styles = tokenStyles();
  const blockName = /--porch-([a-z0-9-]+):/g;
  const varNames = (block) => [...block.matchAll(blockName)].map((match) => match[1]);
  const lightStart = styles.indexOf(':root,[data-theme="light"]');
  const darkStart = styles.indexOf('[data-theme="dark"]');
  assert.ok(lightStart >= 0 && darkStart > lightStart, "light block first, dark second");
  const lightBlock = styles.slice(lightStart, darkStart);
  const darkBlock = styles.slice(darkStart);
  assert.deepEqual(varNames(darkBlock), varNames(lightBlock), "one contract: the same custom-property names in both blocks");
  // The signature values resolve per mode inside the single style string.
  assert.ok(lightBlock.includes(`--porch-page:${lightTokens.page};`));
  assert.ok(darkBlock.includes(`--porch-page:${darkTokens.page};`));
  assert.notEqual(lightBlock, darkBlock);
  // Screen-facing map and the sanctioned alpha escape resolve.
  assert.equal(cssVars.page, "var(--porch-page)");
  assert.equal(cssVars.borderStrong, "var(--porch-border-strong)");
  assert.equal(tokenAlpha("#D88A24", 0.28), "rgba(216, 138, 36, 0.28)");
});
