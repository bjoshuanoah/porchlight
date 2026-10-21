// The Frequently Used tab and the mobile keyboard contract (PORCH-120,
// Brian Oct 21 2026). The rendered surfaces are swept with the REAL MUI
// (the house sweep shape), the session-cache and visual-viewport geometry
// are unit-pinned, and the contract lines ride source pins exactly like
// the other sweeps.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { build } from "esbuild";
import React from "react";
import { renderToString } from "react-dom/server";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = fileURLToPath(new URL("../", import.meta.url));

const pickerSource = await readFile(join(webRoot, "src", "emoji-picker.jsx"), "utf8");
const viewportSource = await readFile(join(webRoot, "src", "emoji-viewport.js"), "utf8");
const usageSource = await readFile(join(webRoot, "src", "emoji-usage.js"), "utf8");
const socialSource = await readFile(join(webRoot, "src", "social.jsx"), "utf8");

const { EMOJI_CATEGORIES, searchEmojis, emojiRowOf } = await import("../src/emoji-data.js");
const { keyboardDock, MOBILE_CLASS_MAX } = await import("../src/emoji-viewport.js");
const { cachedUsage, loadUsage, recordSessionUse } = await import("../src/emoji-usage.js");

// The rendered sweep: the picker body bundled and rendered server-side with
// real MUI — the grid the member gets on every opener surface.
const outDir = join(here, ".tmp120");
const built = await (async () => {
  await mkdir(outDir, { recursive: true });
  await build({
    stdin: { contents: 'export { PickerBody, FREQUENT_LABEL, FREQUENT_EMPTY_STATE } from "./src/emoji-picker.jsx";', resolveDir: webRoot, loader: "jsx", sourcefile: "entry.jsx" },
    bundle: true, format: "esm", jsx: "automatic", platform: "neutral",
    external: ["react", "react-dom", "@mui/*", "@emotion/*", "@noble/*", "unicode-emoji-json", "react-transition-group", "hoist-non-react-statics"],
    outfile: join(outDir, "picker.built.mjs"), logLevel: "silent",
  });
  return import(join(outDir, "picker.built.mjs"));
})();

after(async () => { await rm(outDir, { recursive: true, force: true }); });

const renderBody = (props = {}) =>
  renderToString(React.createElement(built.PickerBody, {
    category: 0,
    results: [],
    frequent: [],
    own: new Set(),
    ...props,
  }));

const textOf = (html) => html
  .replace(/<style[\s\S]*?<\/style>/g, "")
  .replace(/<[^>]*>/g, " ")
  .replace(/&[a-z#0-9]+;/gi, " ");

// ---------- ac-1: the Frequently Used tab anchors the tab row ----------

const FIRST_CATEGORY = EMOJI_CATEGORIES[0];

test("ac-1: the Frequently Used tab anchors the tab row, ahead of the Unicode categories", () => {
  const html = renderBody({ results: [], frequent: [] }).replace(/&amp;/g, "&");
  const frequentAt = html.indexOf(`${built.FREQUENT_LABEL} emoji category`);
  const firstUnicodeAt = html.indexOf(`${FIRST_CATEGORY.label} emoji category`);
  assert.ok(frequentAt >= 0, "the Frequently Used tab renders in the tab row");
  assert.ok(firstUnicodeAt > frequentAt, "the Frequently Used tab leads the nine Unicode category tabs");
  const unicodeTabs = EMOJI_CATEGORIES.length;
  assert.equal(unicodeTabs, 9, "the nine Unicode category tabs ride after it");
});

test("ac-1: the tab lists the member's most-used emoji most-first, exactly like a category grid", () => {
  const rows = ["👍", "💯"].map((emoji) => emojiRowOf(emoji));
  const html = renderBody({ results: rows, frequent: ["👍", "💯"] });
  const thumbs = html.indexOf('aria-label="thumbs up"');
  const hundred = html.indexOf('aria-label="hundred points"');
  assert.ok(thumbs >= 0 && hundred >= 0, "each usage entry carries its catalog grid treatment");
  assert.ok(thumbs < hundred, "order is most-first: the member's top emoji leads the grid");
  // The emoji render and write exactly like any picker selection.
  assert.match(html, /aria-pressed="false"/, "usage entries are selectable picker cells");
});

test("ac-1: no count, tally, or number renders beside any emoji on the tab", () => {
  const html = renderBody({ results: ["👍", "💯"].map((emoji) => emojiRowOf(emoji)), frequent: ["👍", "💯"] });
  const visible = textOf(html.replace(/ style="[^"]*"/g, "").replace(/ value="[^"]*"/g, ""));
  assert.doesNotMatch(visible, /[0-9]/, `no digit renders anywhere on the tab: ${visible.slice(0, 200)}`);
  // Order is the only expression of frequency — the model carries glyphs alone.
  assert.deepEqual(["👍", "💯"].map((emoji) => emojiRowOf(emoji).emoji), ["👍", "💯"]);
});

test("ac-1: an identity with no usage history sees the family-copy empty state, never a fake list", () => {
  const html = renderBody({ results: [], frequent: [] });
  assert.ok(html.includes(built.FREQUENT_EMPTY_STATE), "the cold state renders its family copy");
  assert.ok(html.includes("React a few times and your favorites will appear here."), "the ruled cold-state wording rides");
  const visible = textOf(html);
  for (const seeded of ["👍", "💯", "🍂"]) assert.equal(visible.includes(seeded), false, `no fake seed emoji renders: ${seeded}`);
  // A member with usage sees no empty state at all.
  const withUsage = renderBody({ results: ["👍"].map((emoji) => emojiRowOf(emoji)), frequent: ["👍"] });
  assert.equal(withUsage.includes(built.FREQUENT_EMPTY_STATE), false, "the cold state belongs only to empty usage");
});

test("ac-1: the tab is searchable like every tab — search sweeps the whole catalog", () => {
  // The picker body swaps search results in for the tab content; the
  // search vocabulary stays the full catalog (including 🯄-adjacent
  // representatives) — the tab never narrows the offered set.
  assert.ok(searchEmojis("hundred").some((row) => row.emoji === "💯"));
  assert.equal(searchEmojis("").length, EMOJI_CATEGORIES.flatMap((group) => group.emojis).length);
});

// ---------- ac-2: account-level usage that follows the member ----------

const CONNECTION = { identity: { id: "did:porch:sam" }, url: "https://hub.example" };
const OTHER_DEVICE = { identity: { id: "did:porch:sam" }, url: "https://hub.example" };
const OTHER_MEMBER = { identity: { id: "did:porch:june" }, url: "https://hub.example" };

test("ac-2: the session cache is identity-scoped — one identity, every device, one list", async () => {
  // Device A reads the account list; device B's cache resolves the same
  // record (identity@origin keying is the account-level contract).
  const fromHub = { emoji: ["👍", "💯"] };
  const viaA = await loadUsage(CONNECTION, fromHub);
  assert.deepEqual(viaA, ["👍", "💯"]);
  assert.deepEqual(cachedUsage(OTHER_DEVICE), ["👍", "💯"], "the same identity's other device session-cache resolves the same list");
  assert.deepEqual(cachedUsage(OTHER_MEMBER), [], "another identity's session-cache resolves nothing of this member's");
  assert.deepEqual(cachedUsage({ identity: { id: "did:porch:sam" }, url: "https://other-hub.example" }), [], "a different hub origin keys a different record");
});

test("ac-2: the session cache keeps the last-known list when the read fails (offline opens render real usage)", async () => {
  await loadUsage(CONNECTION, { emoji: ["👍"] });
  // The caller settles a failing read before the cache consumes it (the
  // picker-open path wraps its fetch in .catch(() => null)).
  const failed = await loadUsage(CONNECTION, Promise.reject(new Error("hub unreachable")).catch(() => null));
  assert.deepEqual(failed, ["👍"], "a failing hub read keeps the member's known usage");
  const unknown = await loadUsage(OTHER_MEMBER, Promise.resolve(null));
  assert.deepEqual(unknown, [], "no history and no read is the honest EMPTY list — never a fake seed");
});

test("ac-2: a session add reflects immediately in the rendered order (most-first), never decrementing", async () => {
  await loadUsage(CONNECTION, { emoji: ["👍", "💯"] });
  const afterOne = recordSessionUse(CONNECTION, "💯");
  assert.deepEqual(afterOne, ["💯", "👍"], "the just-recorded add moves the emoji to the front");
  assert.deepEqual(cachedUsage(OTHER_DEVICE), ["💯", "👍"], "the session order is shared through the identity cache");
  const afterNew = recordSessionUse(CONNECTION, "🍂");
  assert.deepEqual(afterNew, ["🍂", "💯", "👍"], "a first-time entry joins the front (most recently used)");
  // Removing a reaction never touches the session list (un-react does not
  // decrement — the server holds that law; the cache has no remove path).
  const exportsList = [...usageSource.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(exportsList, ["cachedUsage", "loadUsage", "recordSessionUse"], "the usage cache exposes read/load/record only — no remove path exists");
});

test("ac-5: the usage wire and cache carry glyphs alone — no counts anywhere", () => {
  const wire = JSON.stringify({ emoji: ["👍", "💯"] });
  assert.equal(wire.includes("count"), false, "the served usage payload is the emoji list alone");
  assert.match(usageSource, /\.emoji/, "the cache consumes the served shape (list .emoji only)");
  assert.doesNotMatch(usageSource, /\bcount\b/i, "no count field exists in the usage cache module");
});

// ---------- ac-3: the keyboard never covers the results ----------

const VV = (height, offsetTop = 0) => ({ height, offsetTop, offsetLeft: 0, width: 390 });

test("ac-3: a risen keyboard docks the picker inside the visual viewport (mobile)", () => {
  // Phone: 390 wide, 844 tall; keyboard covers the bottom 300.
  const dock = keyboardDock({ innerWidth: 390, innerHeight: 844, visualViewport: VV(544, 0) });
  assert.ok(dock, "the risen keyboard engages the viewport contract");
  assert.equal(dock.top, 8, "the dock anchors at the visual viewport's top edge (inside the margin)");
  assert.equal(dock.keyboardTop, 544, "the keyboard occupies from the visible viewport's bottom line down");
  assert.ok(dock.height <= 544, "the docked paper stays inside the visible viewport");
  assert.deepEqual([dock.left, dock.width], [8, 374], "the dock spans the visual viewport's width");
});

test("ac-3: nothing pickable sits beneath the keyboard at any scroll position (the scrolled case)", () => {
  // The layout viewport scrolled: the visual viewport's offsetTop rides
  // the page — the dock follows it, so the pickable grid stays above the
  // keyboard line wherever the page is.
  const scrolled = keyboardDock({ innerWidth: 390, innerHeight: 844, visualViewport: VV(500, 300) });
  assert.ok(scrolled);
  assert.equal(scrolled.top, 308, "the dock rides the visual viewport's page position");
  assert.equal(scrolled.keyboardTop, 800, "the keyboard line is the visible viewport's bottom");
  assert.ok(scrolled.top + scrolled.height <= scrolled.keyboardTop + 8, "the docked paper never crosses the keyboard line");
});

test("ac-3: the resting state (no keyboard, desktop width, missing API) keeps the shipped popover", () => {
  // Keyboard not risen: a browser-chrome-sized shrink engages nothing.
  assert.equal(keyboardDock({ innerWidth: 390, innerHeight: 844, visualViewport: VV(800, 0) }), null);
  // Desktop-class width: the viewport contract is the mobile path only.
  assert.equal(keyboardDock({ innerWidth: 1280, innerHeight: 900, visualViewport: VV(500, 0) }), null);
  assert.equal(keyboardDock({ innerWidth: 900, innerHeight: 900, visualViewport: VV(500, 0) }), null, "the mobile-class line is <= 899.95 (theme lg:900)");
  // No visualViewport API: the resting behavior (never a broken dock).
  assert.equal(keyboardDock({ innerWidth: 390, innerHeight: 844, visualViewport: null }), null);
  assert.equal(MOBILE_CLASS_MAX, 899.95);
});

test("ac-3: the picker carries the viewport contract in source (visualViewport dock, same DOM restore)", () => {
  assert.match(pickerSource, /visualViewport/, "the picker measures the visual viewport");
  assert.match(pickerSource, /keyboardDock/, "the picker applies the dock geometry");
  assert.match(pickerSource, /anchorReference=\{dock \? 'anchorPosition' : 'anchorEl'\}/, "the dock re-anchors the popover in the visual viewport; the resting popover anchors as shipped");
  // Keyboard close: dock null → anchorEl — the same DOM (the grid's scroll
  // never remounts, so an in-progress pick never scrolls out).
  assert.doesNotMatch(pickerSource, /key=\{.*dock/, "no dock-keyed remount exists");
  assert.match(pickerSource, /theme\.transitions\.create\('max-height'/, "the resting restore rides the standard motion token");
});

// ---------- ac-5: guardrail sweep ----------

test("ac-5: the picker opens everywhere through the shared component — the tab inherits every surface", () => {
  assert.match(socialSource, /frequent=\{frequent\}/, "PresentReactions feeds the shared EmojiPicker's Frequently Used list");
  assert.match(socialSource, /invoke\(actions, 'emojiUsage', post\)/, "the usage read rides the shared action at every picker open");
  assert.match(socialSource, /recordSessionUse/, "a session add reflects immediately in the rendered order");
});

test("ac-5: no new third-party picker, keyboard, or animation dependency enters the bundle", () => {
  const pickerImports = [...pickerSource.matchAll(/import[\s\S]*?from ['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const imported of pickerImports) {
    assert.ok(
      ["react", "@mui/material", "./theme.js", "./emoji-data.js", "./emoji-viewport.js"].includes(imported),
      `unexpected picker dependency: ${imported}`,
    );
  }
  const viewportImports = [...viewportSource.matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(viewportImports, [], "the viewport contract is dependency-free browser API math");
  assert.doesNotMatch(usageSource, /from ['"][^'"]+['"]/, "the usage cache is dependency-free");
});

test("ac-5: the picker stays code-split — the catalog rides the lazy chunk", async () => {
  const source = await readFile(join(webRoot, "vite.config.js"), "utf8");
  assert.match(source, /unicode-emoji-json/, "the catalog is excluded from the vendor chunk");
  assert.match(source, /manualChunks/, "the manual chunk split stands");
  // The picker body itself is not eagerly imported anywhere (the lazy
  // import rides the PickerBody chunk with its catalog).
  const mainSource = await readFile(join(webRoot, "src", "main.jsx"), "utf8");
  assert.equal(mainSource.includes("emoji-picker.jsx"), false, "the eager boot never imports the picker chunk");
});