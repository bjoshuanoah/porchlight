// PORCH-095: the loading experience contract — the lantern boot and the
// quiet in-app loader. The suite pins the ruling's hard edges: the navy
// canvas with the dim mark as first paint in both display modes (never a
// flash), the facet climb bottom → center → top with node glows and one
// single pulse (never a loop), readiness ending the boot with no artificial
// hold (never timer-driven), the copy discipline ("Loading" renders nowhere
// on the boot path), the reserved-space in-app loader with the traveling
// glow (never over content), the reduced-motion static treatments with
// WCAG 2.2 AA, and the no-third-party-animation guard (no spinner,
// no Lottie, no video — CSS/SVG only, from the mark's node geometry).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import React from "react";
import { renderToString } from "react-dom/server";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const src = async (name) => await readFile(join(webRoot, "src", name), "utf8");

const geometry = await import("../src/lantern-geometry.js");
const { lightTokens: lt } = await import("../src/theme.js");
const appready = await import("../src/appready.js");

// Bundles the real src/lantern.jsx (MUI-free by contract — the boot and
// loader are mode-invariant brand surfaces outside the theme's surface
// system) so the assertions ride the rendered markup.
async function withLantern(run) {
  const tmp = join(here, ".tmp-lantern");
  await mkdir(tmp, { recursive: true });
  await build({
    stdin: { contents: await src("lantern.jsx"), resolveDir: join(webRoot, "src"), loader: "jsx", sourcefile: "lantern.jsx" },
    bundle: true,
    format: "esm",
    jsx: "automatic",
    platform: "neutral",
    external: ["react"],
    outfile: join(tmp, "lantern.built.mjs"),
    logLevel: "silent",
  });
  try {
    const { LanternBoot, LanternLoader } = await import("./.tmp-lantern/lantern.built.mjs");
    await run({ LanternBoot, LanternLoader });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** The built CSS block — the shipped animation contract, template resolved. */
function styleOf(html) {
  return html.match(/<style>([\s\S]*?)<\/style>/)[1];
}

// WCAG 2.2 relative luminance/contrast, computed here so the palette pins
// break loudly if anyone tunes a token out of compliance.
function luminance(hex) {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("ac-1: the boot renders the navy canvas, the dim mark above the wordmark, and no spinner", async () => {
  await withLantern(async ({ LanternBoot }) => {
    const html = renderToString(React.createElement(LanternBoot));
    // One fixed navy layer, identical canvas for both modes (no mode branch).
    // The canvas rides the mode-invariant token (--porch-boot-bg, pinned
    // #0B1622 below and in the theme layer), never a screen literal.
    assert.match(html, /background:var\(--porch-boot-bg\)/);
    assert.equal(lt.bootBg, "#0B1622", "the boot canvas is Brian's near-black deep navy");
    assert.match(html, /position:fixed/);
    assert.ok(!/data-theme|porch-light|porch-dark/.test(html), "the boot canvas is mode-invariant");
    // The mark sits above the wordmark — the one sanctioned stacked lockup.
    const markAt = html.indexOf("<svg");
    const wordAt = html.indexOf(">Porchlight</div>");
    assert.ok(markAt > -1 && wordAt > markAt, `mark renders above the wordmark (mark@${markAt} word@${wordAt})`);
    assert.equal(html.split(">Porchlight<").length - 1, 1, "exactly one wordmark");
    // No generic spinner, no progress bar, no percentage anywhere in the boot.
    assert.doesNotMatch(html, /progressbar|CircularProgress|aria-valuenow/);
    // Copy discipline in normal startup: mark + wordmark and nothing else.
    assert.doesNotMatch(html, /[Ll]oading/);
    // The layer is never an interaction wall — the app beneath stays live.
    assert.match(html, /pointer-events:\s*none|pointerEvents:\s*none|pointer-events:none/);
  });
  const index = await readFile(join(webRoot, "index.html"), "utf8");
  // First paint is static, pre-JS, and the same navy: the mode script can
  // never flash cream or white before it in either display mode.
  assert.match(index, /id="porch-boot"/);
  const bootSlice = index.slice(index.indexOf('id="porch-boot"'), index.indexOf('id="root"'));
  assert.match(bootSlice, /#0B1622/, "the pre-JS canvas carries the navy literal (tokens have not loaded yet)");
  assert.match(bootSlice, /var\(--porch-boot-bg,#0B1622\)/, "the canvas prefers the theme token with the same literal as fallback");
  assert.match(bootSlice, /#8A6420/, "the pre-JS mark renders dim (low-luminance amber)");
  assert.match(bootSlice, />Porchlight</);
  assert.doesNotMatch(bootSlice, /Loading/i, "the static layer never says Loading");
  // The climb lives here: the boot's only guaranteed pre-JS window. The
  // pulse stays single — static CSS, `both`, never infinite.
  const staticCss = index.slice(index.indexOf("@keyframes porch95-facet-ramp"), index.indexOf("</style>"));
  for (const name of ["porch95-facet-ramp", "porch95-core-ramp", "porch95-frame-ramp", "porch95-node-glow", "porch95-pulse", "porch95-fade"]) {
    assert.ok(staticCss.includes(`@keyframes ${name} `), `the static canvas carries ${name}`);
  }
  const staticPulse = staticCss.match(/\.porch95-boot-mark \{[^}]*\}/)[0];
  assert.match(staticPulse, new RegExp(`porch95-pulse ${geometry.PULSE_MS}ms ease-in-out ${geometry.PULSE_DELAY_MS}ms both`));
  assert.doesNotMatch(staticPulse, /infinite|alternate/);
  assert.match(staticCss, /porch95-boot-fade \{ animation: porch95-fade 250ms ease-out forwards; \}/, "the readiness dissolve class rides the static canvas");
  // Adoption: the React layer manages status, readiness, and the dissolve
  // on this exact node — it never paints a second canvas over a healthy load.
  const lanternSource = await src("lantern.jsx");
  assert.match(lanternSource, /getElementById\("porch-boot"\)/);
  assert.match(lanternSource, /BOOT_FADE_CLASS/);
});

test("ac-2: the facet climbs bottom → center → top, nodes glow on arrival, one pulse never loops", async () => {
  const levels = geometry.FACETS.map((facet) => facet.level);
  assert.deepEqual(levels, ["bottom", "center", "top"], "the climb order is bottom → center → top");
  const delays = geometry.FACETS.map((facet) => facet.delay);
  assert.deepEqual(delays, [...delays].sort((a, b) => a - b), "later facets start later");
  assert.ok(delays[0] === 0, "the bottom facet lights first");
  for (const node of geometry.NODES) {
    assert.ok(geometry.NODE_LEVEL_DELAY[node.level] != null, `node (${node.cx},${node.cy}) rides a climb level`);
  }
  // Node glows begin with their level's facet and settle after a brief glow.
  for (const facet of geometry.FACETS) {
    assert.ok(geometry.NODE_LEVEL_DELAY[facet.level] <= facet.delay + geometry.NODE_GLOW_OFFSET_MS,
      `the ${facet.level} nodes glow as the light reaches them`);
  }
  // One soft warm pulse: single iteration, never infinite, after the climb.
  const climbEnd = geometry.FACETS[2].delay + geometry.FACET_RAMP_MS;
  assert.ok(climbEnd <= geometry.PULSE_DELAY_MS + geometry.PULSE_MS, "the pulse lands after the climb completes");
  assert.ok(geometry.PULSE_DELAY_MS + geometry.PULSE_MS <= 1500, `the full lit sequence stays a 1.5s ceiling (ends at ${geometry.PULSE_DELAY_MS + geometry.PULSE_MS}ms)`);
  // Rendered marks carry the staggered delays; the built CSS carries the
  // single pulse; the core rides the center facet.
  await withLantern(async ({ LanternBoot }) => {
    const html = renderToString(React.createElement(LanternBoot));
    const css = styleOf(html);
    const pulseRule = css.match(/\.porch95-mark \{[^}]*\}/)[0];
    assert.match(pulseRule, new RegExp(`porch95-pulse ${geometry.PULSE_MS}ms ease-in-out ${geometry.PULSE_DELAY_MS}ms both`));
    assert.doesNotMatch(pulseRule, /infinite|alternate/, "the pulse never loops");
    const delayList = [...html.matchAll(/animation-delay:(\d+)ms/g)].map((m) => Number(m[1]));
    for (const facet of geometry.FACETS) assert.ok(delayList.includes(facet.delay), `facet delay ${facet.delay}ms renders`);
    for (const level of ["bottom", "center", "top"]) {
      const expected = geometry.NODE_LEVEL_DELAY[level] + geometry.NODE_GLOW_OFFSET_MS;
      assert.ok(delayList.includes(expected), `${level} node glow delay ${expected}ms renders`);
    }
    assert.match(html, /porch95-core-el/, "the cream core rides the center facet");
  });
  // The static canvas carries the same climb delays (it paints pre-JS).
  const index = await readFile(join(webRoot, "index.html"), "utf8");
  const staticDelays = [...index.matchAll(/animation-delay:(\d+)ms/g)].map((m) => Number(m[1]));
  for (const facet of geometry.FACETS) assert.ok(staticDelays.includes(facet.delay), `static facet delay ${facet.delay}ms renders`);
  for (const level of Object.keys(geometry.NODE_LEVEL_DELAY)) {
    const expected = geometry.NODE_LEVEL_DELAY[level] + geometry.NODE_GLOW_OFFSET_MS;
    assert.ok(staticDelays.includes(expected), `static ${level} node delay ${expected}ms renders`);
  }
});

test("ac-3: readiness ends the boot — no artificial hold, never timer-driven", async () => {
  // The bus: readiness is idempotent, late subscribers fire immediately,
  // and the boot never waits on an event already passed.
  appready.resetAppReadyForTests();
  let fired = 0;
  const off = appready.onAppReady(() => fired += 1);
  assert.equal(fired, 0, "no early fire before readiness");
  appready.markAppReady();
  assert.equal(appready.getAppReady(), true);
  appready.markAppReady();
  assert.equal(fired, 1, "markAppReady fires its subscribers exactly once");
  off();
  appready.onAppReady(() => fired += 1);
  assert.equal(fired, 2, "a subscriber after readiness fires synchronously — the boot never holds");
  appready.resetAppReadyForTests();
  // The component: ready ⇒ fade now; not ready ⇒ subscribe; the only timer
  // is the bounded dissolve cleanup, never a boot-end timer.
  const source = await src("lantern.jsx");
  assert.match(source, /if \(readiness\.getAppReady\(\)\) \{\s*setFading\(true\);/);
  assert.match(source, /return readiness\.onAppReady\(\(\) => setFading\(true\)\);/);
  const timers = [...source.matchAll(/setTimeout\(([^,]+),\s*(\d+)\)/g)].map((m) => Number(m[2]));
  for (const ms of timers) assert.ok(ms <= geometry.BOOT_FADE_MS + 80, `every timer is bounded by the fade (${ms}ms), not a boot hold`);
  // main.jsx announces readiness through the boot settle: boots with no
  // settle sequence announce on mount; sequence boots announce when the
  // connect/first-fetch chain ends (PORCH-117 error display discipline).
  const mainSource = await src("main.jsx");
  assert.match(mainSource, /if \(!activeIdentityId \|\| signedOut\.current\) settleBoot\(\);/);
  assert.match(mainSource, /onSettle: settleBoot,/);
  assert.equal(appready.getAppReady(), false, "importing main.jsx sources announces nothing by itself");
});

test("ac-4: no Loading… below the threshold; the long lines rotate in family vocabulary", async () => {
  const { bootStatusLine, STATUS_LINES, STATUS_THRESHOLD_MS, STATUS_CYCLE_MS, STATUS_HONESTY_MS } = geometry;
  assert.equal(bootStatusLine(1400), null, "normal startup renders mark + wordmark and nothing else");
  assert.equal(bootStatusLine(STATUS_THRESHOLD_MS), STATUS_LINES[0]);
  assert.equal(bootStatusLine(STATUS_THRESHOLD_MS + STATUS_CYCLE_MS - 1), STATUS_LINES[0]);
  assert.equal(bootStatusLine(STATUS_THRESHOLD_MS + STATUS_CYCLE_MS), STATUS_LINES[1]);
  assert.equal(bootStatusLine(STATUS_HONESTY_MS), geometry.STATUS_HONESTY_LINE, "a boot that outlives its lines names its state");
  for (const line of [...STATUS_LINES, geometry.STATUS_HONESTY_LINE]) {
    assert.doesNotMatch(line, /[Ll]oading/, `"${line}" never says Loading`);
    assert.match(line, /…$|waking up\.$/, "status lines stay in family vocabulary");
  }
  assert.ok(STATUS_THRESHOLD_MS >= 1400 && STATUS_THRESHOLD_MS <= 1600, `the threshold sits in Brian's ~1.5-2s band (${STATUS_THRESHOLD_MS}ms)`);
  assert.ok(STATUS_CYCLE_MS >= 1800 && STATUS_CYCLE_MS <= 2200, `the cycle rides the ~1.8-2.2s interval (${STATUS_CYCLE_MS}ms)`);
  // The rendered boot never carries the literal, in any variant.
  await withLantern(async ({ LanternBoot, LanternLoader }) => {
    assert.doesNotMatch(renderToString(React.createElement(LanternBoot)), /[Ll]oading/);
    const withLine = renderToString(React.createElement(LanternBoot, { variant: "surface", status: "Connecting…" }));
    assert.match(withLine, />Connecting…</, "the surface variant rides its flow's own copy hook");
    assert.doesNotMatch(renderToString(React.createElement(LanternLoader, { label: "Reading your group" })), /(>|")[Ll]oading(…)?(<|")/, "the loader's visible text is never Loading");
  });
});

test("ac-5: the in-app loader is a small reserved-space mark with a traveling glow — never over content", async () => {
  await withLantern(async ({ LanternLoader }) => {
    const html = renderToString(React.createElement(LanternLoader, { label: "Reading your group" }));
    // Reserved, centered space: no fixed layer, no overlay, no feed cover.
    assert.doesNotMatch(html, /position:\s*fixed|position:fixed/);
    assert.match(html, /align-items:\s*center/);
    assert.match(html, /role="status" aria-label="Reading your group"/);
    // The traveling glow circulates the mark's vertices on a quiet loop,
    // through the mark's own outline path.
    assert.match(html, /porch95-circuit-el/);
    const css = styleOf(html);
    const circuitRule = css.match(/\.porch95-circuit-el \{[^}]*\}/)[0];
    assert.match(circuitRule, new RegExp(`offset-path:\\\\?\\s*path\\('${geometry.GLOW_LOOP_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'\\)`));
    const loop = Number(circuitRule.match(/porch95-circuit (\d+)ms/)[1]);
    assert.ok(loop >= 1600 && loop <= 2400, `the glow loop sits in the 1.6-2.4s band (${loop}ms)`);
    assert.match(circuitRule, /linear infinite/, "the candlelight circuit is the one sanctioned loop");
  });
  // No spinner exists in the migrated call sites; the media-frame stamp
  // fallback keeps its PORCH-043 machinery (content-surface carve-out).
  const identity = await src("identity.jsx");
  assert.doesNotMatch(identity, /CircularProgress/);
  assert.match(identity, /<LanternBoot variant="surface" status=\{arrivalBeatCopy\} \/>/);
  // The session open behind the chooser rides the boot surface too,
  // under its own copy hook.
  assert.match(identity, /<LanternBoot variant="surface" status="Opening your place…" \/>/);
  const social = await src("social.jsx");
  const socialSpinners = social.match(/<CircularProgress/g) ?? [];
  assert.equal(socialSpinners.length, 1, "only the unstamped-media fallback keeps its bounded spinner");
  const main = await src("main.jsx");
  assert.doesNotMatch(main, /CircularProgress/);
  // No second loading implementation enters the bundle: no spinner, no
  // skeleton, no Lottie — the dependencies stay clean of loader libraries.
  const pkg = JSON.parse(await readFile(join(webRoot, "package.json"), "utf8"));
  const deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
  for (const dep of deps) assert.doesNotMatch(dep, /spinner|lottie|skeleton|shimmer|loader/i, `${dep} is not a loading library`);
  for (const name of ["lantern.jsx", "lantern-geometry.js", "identity.jsx", "social.jsx", "main.jsx"]) {
    const source = await src(name);
    // Real usage only: an import of an animation runtime, a video/GIF
    // element or asset — prose mentions inside the contract comments
    // never count.
    assert.doesNotMatch(source, /<video[\s>]|from\s+["'][^"']*(?:lottie|spinner|skeleton)/i, `${name} composes from CSS/SVG only`);
    assert.doesNotMatch(source, /["'`][^"'`]*\.(?:gif|mp4|webm|lottie)["'`]/i, `${name} references no animation asset`);
  }
});

test("ac-6: reduced motion renders both static treatments, and the AA contrast holds", async () => {
  await withLantern(async ({ LanternBoot }) => {
    const css = styleOf(renderToString(React.createElement(LanternBoot)));
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)[1];
    assert.match(reduced, /animation: none !important/, "both surfaces drop their staged animation");
    assert.match(reduced, /fill: var\(--porch-boot-facet\) !important/, "the boot renders the static fully-lit mark");
    assert.match(reduced, /fill: var\(--porch-boot-core\) !important/, "the core reads lit");
    assert.match(reduced, /porch95-circuit-el \{ opacity: 0 !important; \}/, "the loader's traveling glow rests");
    // The plain fade into the app survives reduced motion (the boot still
    // dissolves; only the staged climb is dropped).
    assert.ok(!reduced.includes("porch95-bootlayer") && !reduced.includes("porch95-fade"));
  });
  // The static canvas carries its own reduced-motion block: the pre-JS
  // climb renders the static fully-lit mark, with the fade class live.
  const index = await readFile(join(webRoot, "index.html"), "utf8");
  const indexReduced = index.slice(index.indexOf("@media (prefers-reduced-motion: reduce)"), index.indexOf("</style>"));
  assert.match(indexReduced, /animation: none !important/, "the pre-JS climb drops under reduced motion");
  assert.match(indexReduced, /porch95-boot-facet \{ fill: var\(--porch-boot-facet, #FFBE57\) !important/, "the pre-JS mark renders fully lit");
  assert.doesNotMatch(indexReduced, /porch95-boot-fade/, "the plain fade into the app survives reduced motion");
  // WCAG 2.2 AA on the navy canvas: text pairs ≥ 4.5:1, the dim mark's
  // non-text ink ≥ 3:1.
  assert.ok(contrast(lt.bootBg, lt.bootInk) >= 4.5, `wordmark ${contrast(lt.bootBg, lt.bootInk).toFixed(2)}:1 on navy`);
  assert.ok(contrast(lt.bootBg, lt.bootStatusInk) >= 4.5, `status text ${contrast(lt.bootBg, lt.bootStatusInk).toFixed(2)}:1 on navy`);
  assert.ok(contrast(lt.bootBg, lt.bootFrameDim) >= 3, `dim mark ${contrast(lt.bootBg, lt.bootFrameDim).toFixed(2)}:1 on navy`);
  assert.ok(contrast(lt.bootBg, lt.bootFacet) >= 3, `lit mark ${contrast(lt.bootBg, lt.bootFacet).toFixed(2)}:1 on navy`);
  // The same navy canvas in both display modes: the boot palette is
  // mode-invariant by contract.
  for (const key of ["bootBg", "bootInk", "bootStatusInk", "bootFrame", "bootFacet", "bootCore"]) {
    assert.equal(lt[key], (await import("../src/theme.js")).darkTokens[key], `boot token ${key} is mode-invariant`);
  }
});

test("ac-7: geometry-composed CSS/SVG only, and the PORCH-051 reconciliation stays recorded as pending", async () => {
  // The animation composes from the mark's node coordinates (the geometry
  // module) with CSS/WAAPI — the suite's package.json sweep already pins
  // the no-third-party half; this pins the source-of-record half.
  const themeSource = await src("theme.js");
  assert.match(themeSource, /PORCH-051/, "the manifest splash reconciliation is recorded in the token layer");
  assert.match(themeSource, /pending Brian's ruling/, "the reconciliation names itself pending");
  assert.match(themeSource, /implemented only on his word/, "the reconciliation is implemented only on his word");
  const manifest = await readFile(join(webRoot, "public", "manifest.webmanifest"), "utf8");
  assert.equal(JSON.parse(manifest).background_color, "#F7F5F0", "the manifest splash is untouched pending the ruling");
});