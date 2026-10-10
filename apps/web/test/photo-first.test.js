// Photo-first timeline (PORCH-043): the build contract's published values
// and the viewport lock are the regression surface. Tests pin the contract
// module (apps/web/src/photo-first.js), the locked viewport meta (the SPA
// document and PWA entry), and the theme's ≥16px input font-size (the
// zoom-starvation mechanism that makes user-scalable=no safe).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { photoFirst } from "../src/photo-first.js";
import { theme } from "../src/theme.js";

const webRoot = fileURLToPath(new URL("../", import.meta.url));

test("PORCH-043 ac-5: posts ship with the 1px warm-neutral divider, not a card gap", () => {
  assert.equal(photoFirst.dividerColor, "#ECE8E1");
});

test("PORCH-043 ac-2: the 16px rail is the rail of record and media ignores it", () => {
  assert.equal(photoFirst.rail, 16);
  // Media pulls past both rail paddings (edge-to-edge, ac-1) and past the
  // desktop card padding (full interior width, ac-6).
  assert.equal(photoFirst.postPad, 20);
});

test("PORCH-043 ac-2: the vertical rhythm is tightened per the spacing table", () => {
  assert.equal(photoFirst.spacing.headerCaption, 8);
  assert.equal(photoFirst.spacing.captionMedia, 12);
  assert.equal(photoFirst.spacing.mediaUtility, 8);
  assert.equal(photoFirst.spacing.utilityActions, 16);
  assert.equal(photoFirst.spacing.actionsReactions, 12);
  assert.equal(photoFirst.spacing.endToDivider, 16);
});

test("PORCH-043 ac-3: natural ratios govern; the 85vh contain cap is the only exception", () => {
  assert.equal(photoFirst.extremeCap, "85vh");
  assert.equal(photoFirst.desktopMediaRadius, 12);
  assert.equal(photoFirst.mobileBelow, 900);
});

test("PORCH-043 ac-4: the SPA document carries the locked viewport meta", async () => {
  const html = await readFile(join(webRoot, "index.html"), "utf8");
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"\s*\/>/);
});

test("PORCH-043 ac-4: the PWA manifest keeps standalone display (meta equivalents match)", async () => {
  const manifest = JSON.parse(await readFile(join(webRoot, "public/manifest.webmanifest"), "utf8"));
  assert.equal(manifest.display, "standalone");
});

test("PORCH-043 ac-4: every text-entry control renders at ≥16px so focus never zooms", () => {
  // 1rem resolves to 16px on any unmodified root font-size; the lock starves
  // iOS auto-zoom structurally, which is the mechanism under our control.
  assert.equal(theme.components.MuiInputBase.styleOverrides.input.fontSize, "1rem");
});