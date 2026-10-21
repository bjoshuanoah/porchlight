// PORCH-118: the loading experience contract — the boot and the quiet
// in-app loader both ride Brian's supplied animated webp (the asset of
// record, animating from its own frames). The suite pins the ruling's hard
// edges: the navy canvas with a no-flash first paint in both display
// modes and no vector-twin mark anywhere on the boot path, readiness
// ending the boot with no artificial hold (never timer-driven), the copy
// discipline (no "Loading…" literal, status lines only past the
// threshold), the reserved-space in-app loader (never over content, never
// forever), the reduced-motion static-first-frame treatments with WCAG
// 2.2 AA, and the bundle discipline (the webp ships in-bundle and loops
// forever; no spinner or animation library, fades/dissolves stay CSS).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import React from "react";
import { renderToString } from "react-dom/server";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const src = async (name) => await readFile(join(webRoot, "src", name), "utf8");

const assets = await import("../src/loader-assets.js");
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

test("ac-1: the boot renders the navy canvas with the animated webp mark above the wordmark — no spinner, no vector twin", async () => {
  await withLantern(async ({ LanternBoot }) => {
    const html = renderToString(React.createElement(LanternBoot));
    // One fixed navy layer, identical canvas for both modes (no mode branch).
    // The canvas rides the mode-invariant token (--porch-boot-bg, pinned
    // #0B1622 below and in the theme layer), never a screen literal.
    assert.match(html, /background:var\(--porch-boot-bg\)/);
    assert.equal(lt.bootBg, "#0B1622", "the boot canvas is Brian's near-black deep navy");
    assert.match(html, /position:fixed/);
    assert.ok(!/data-theme|porch-light|porch-dark/.test(html), "the boot canvas is mode-invariant");
    // The mark sits above the wordmark — the one sanctioned stacked lockup —
    // rendered as the webp of record, not a drawn SVG twin. The wordmark is
    // lowercase on this surface (PORCH-119, Brian Oct 21, 2026).
    const markAt = html.indexOf('src="/loader.webp"');
    const wordAt = html.indexOf(">porchlight</div>");
    assert.ok(markAt > -1 && wordAt > markAt, `mark renders above the wordmark (mark@${markAt} word@${wordAt})`);
    assert.doesNotMatch(html, /<svg|<path\b/, "no vector-twin mark renders on the boot path");
    assert.ok(!/>Porchlight</.test(html), "the boot wordmark never capitalizes");
    assert.equal(html.split(">porchlight<").length - 1, 1, "exactly one wordmark");
    // One polite announcement region (ac-9), never a visible status line.
    assert.match(html, />Porchlight is loading</);
    // No generic spinner, no progress bar, no percentage anywhere in the boot.
    assert.doesNotMatch(html, /progressbar|CircularProgress|aria-valuenow/);
    // Copy discipline in normal startup: the announcement plus nothing —
    // the ruled status lines only ever appear past the threshold (ac-3).
    assert.doesNotMatch(html, /[Ll]oading…/);
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
  // The animated webp plays here from the first byte, before any JavaScript.
  assert.match(bootSlice, /class="porch118-webp" src="\/loader\.webp"/, "the pre-JS mark is the animated webp of record");
  assert.match(bootSlice, /src="\/loader-still\.webp"/, "the reduced-motion still frame ships beside it");
  assert.match(bootSlice, />porchlight</, "the pre-JS wordmark is lowercase per the dusk ruling");
  assert.ok(!bootSlice.includes(">Porchlight<"), "the static canvas never capitalizes the wordmark");
  assert.doesNotMatch(bootSlice, /<svg|<path\b/, "the vector-twin lantern markup is retired from the static canvas");
  assert.doesNotMatch(bootSlice, /#8A6420/, "no facet choreography palette literal remains");
  assert.doesNotMatch(bootSlice, /[Ll]oading…/, "the static layer never says Loading as a status line");
  // The readiness dissolve rides the static canvas (250ms, in step with
  // BOOT_FADE_MS) — CSS only, no timer in the static layer.
  assert.match(index, /\.porch95-boot-fade \{ animation: porch95-fade 250ms ease-out forwards; \}/, "the readiness dissolve class rides the static canvas");
  // Adoption: the React layer manages status, readiness, and the dissolve
  // on this exact node — it never paints a second canvas over a healthy load.
  const lanternSource = await src("lantern.jsx");
  assert.match(lanternSource, /getElementById\("porch-boot"\)/);
  assert.match(lanternSource, /BOOT_FADE_CLASS/);
});

test("ac-2: readiness ends the boot immediately, even mid-loop of the animated webp — never a timer alone", async () => {
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
  // is the bounded dissolve cleanup, never a boot-end or minimum-hold timer.
  const source = await src("lantern.jsx");
  assert.match(source, /if \(readiness\.getAppReady\(\)\) \{\s*setFading\(true\);/);
  assert.match(source, /return readiness\.onAppReady\(\(\) => setFading\(true\)\);/);
  const timers = [...source.matchAll(/setTimeout\(([^,]+),\s*(\d+)\)/g)].map((m) => Number(m[2]));
  for (const ms of timers) assert.ok(ms <= assets.BOOT_FADE_MS + 80, `every timer is bounded by the fade (${ms}ms), not a boot hold`);
  // The animated asset never gates the boot: it loops forever and only
  // readiness ends the boot (the ~2.4s loop is pinned in the ac-6 asset sweep).
  assert.doesNotMatch(source, /onAnimationEnd|animationend/, "no animation-event hook can end the boot by itself");
  // main.jsx announces readiness through the boot settle: boots with no
  // settle sequence announce on mount; sequence boots announce when the
  // connect/first-fetch chain ends (PORCH-117 error display discipline).
  const mainSource = await src("main.jsx");
  assert.match(mainSource, /if \(!activeIdentityId \|\| signedOut\.current\) settleBoot\(\);/);
  assert.match(mainSource, /onSettle: settleBoot,/);
  assert.equal(appready.getAppReady(), false, "importing main.jsx sources announces nothing by itself");
});

test("ac-3: no Loading… below the threshold; the ruled dusk rotation rides the boot path (PORCH-119)", async () => {
  const { bootStatusLine, STATUS_LINES, STATUS_THRESHOLD_MS, STATUS_CYCLE_MS } = assets;
  assert.equal(bootStatusLine(1400), null, "normal startup renders the dusk scene and nothing else");
  // The ruled rotation of record (Brian, Oct 21, 2026): the five lines, in
  // order, revealed at 1.5s and crossfaded every 3s, looping after the last.
  assert.deepEqual(STATUS_LINES, [
    "lighting the porch…",
    "knocking on the front door…",
    "ringing the doorbell…",
    "finding you a seat…",
    "seeing who's home…",
  ], "the ruled five-line set rides the boot path verbatim");
  assert.equal(bootStatusLine(STATUS_THRESHOLD_MS), STATUS_LINES[0]);
  assert.equal(bootStatusLine(STATUS_THRESHOLD_MS + STATUS_CYCLE_MS - 1), STATUS_LINES[0]);
  for (let i = 1; i < STATUS_LINES.length; i += 1) {
    assert.equal(bootStatusLine(STATUS_THRESHOLD_MS + STATUS_CYCLE_MS * i), STATUS_LINES[i]);
  }
  // Looping after the final line — the rotation never runs dry.
  assert.equal(bootStatusLine(STATUS_THRESHOLD_MS + STATUS_CYCLE_MS * STATUS_LINES.length), STATUS_LINES[0]);
  for (const line of STATUS_LINES) {
    assert.doesNotMatch(line, /[Ll]oading/, `"${line}" never says Loading`);
    assert.match(line, /…$/, "status lines stay in family vocabulary");
  }
  assert.ok(STATUS_THRESHOLD_MS >= 1400 && STATUS_THRESHOLD_MS <= 1600, `the threshold sits in Brian's ~1.5-2s band (${STATUS_THRESHOLD_MS}ms)`);
  assert.equal(STATUS_CYCLE_MS, 3000, "the crossfade interval is the ruled 3s");
  // The rendered boot never says Loading as a status copy; the surface
  // variant rides its flow's own copy hook; the announcement is the one
  // sanctioned "loading" string (ac-9).
  await withLantern(async ({ LanternBoot, LanternLoader }) => {
    const boot = renderToString(React.createElement(LanternBoot));
    assert.doesNotMatch(boot, /[Ll]oading…/);
    assert.match(boot, />Porchlight is loading</);
    const withLine = renderToString(React.createElement(LanternBoot, { variant: "surface", status: "Opening your place…" }));
    assert.match(withLine, />Opening your place…</, "the surface variant rides its flow's own copy hook");
    assert.doesNotMatch(renderToString(React.createElement(LanternLoader, { label: "Reading your group" })), /(>|")[Ll]oading(…)?(<|")/, "the loader's visible text is never Loading");
  });
});

test("ac-4: the in-app loader renders the small animated webp in reserved space — never over content, never forever", async () => {
  await withLantern(async ({ LanternLoader }) => {
    const html = renderToString(React.createElement(LanternLoader, { label: "Reading your group", size: 30 }));
    // Reserved, centered space: no fixed layer, no overlay, no feed cover.
    assert.doesNotMatch(html, /position:\s*fixed|position:fixed/);
    assert.match(html, /align-items:\s*center/);
    assert.match(html, /role="status" aria-label="Reading your group"/);
    // The reserved box scales with the mark: size plus its own padding.
    assert.match(html, new RegExp(`min-width:${30 + Math.round(30 * 0.35) * 2}px`));
    // The mark is the webp of record at the requested size.
    assert.match(html, /class="porch118-webp" src="\/loader\.webp"/);
    // The `size` prop is the mark's CSS height on both swap siblings.
    assert.equal((html.match(/style="height:30px;width:auto"/g) ?? []).length, 2, "the still frame rides the same swap and size as the animated mark");
    // No choreography machinery (circuits, offset paths, glows) anywhere.
    assert.doesNotMatch(html, /porch95-circuit-el|offset-path|drop-shadow/);
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
  for (const name of ["lantern.jsx", "loader-assets.js", "identity.jsx", "social.jsx", "main.jsx"]) {
    const source = await src(name);
    // Real usage only: an import of an animation runtime, a video/GIF
    // element or asset — prose mentions inside the contract comments
    // never count.
    assert.doesNotMatch(source, /<video[\s>]|from\s+["'][^"']*(?:lottie|spinner|skeleton)/i, `${name} composes from CSS only`);
    assert.doesNotMatch(source, /["'`][^"'`]*\.(?:gif|mp4|webm|lottie)["'`]/i, `${name} references no animation asset`);
  }
  // The choreography module itself is gone from the source tree.
  assert.equal(existsSync(join(webRoot, "src", "lantern-geometry.js")), false, "no geometry-twin module remains");
});

test("ac-5: reduced motion renders the asset's static first frame, and the AA contrast holds", async () => {
  await withLantern(async ({ LanternBoot }) => {
    const css = styleOf(renderToString(React.createElement(LanternBoot)));
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)[1];
    // The swap is CSS-only: the animated asset hides, the static first
    // frame takes its place — on both load states (they share this CSS).
    assert.match(reduced, /\.porch118-webp \{ display: none; \}/, "the animated asset rests under reduced motion");
    assert.match(reduced, /\.porch118-webp-still \{ display: block; \}/, "the static first frame renders");
    assert.doesNotMatch(reduced, /animation:/, "the swap adds no staged animation of its own");
    // The plain fade into the app survives reduced motion (the boot still
    // dissolves; only the staged animation is swapped for the still frame).
    assert.match(css, /@keyframes porch95-fade/);
    assert.ok(!css.includes('animation: `porch118'), "no JS-composed animation joins the loading path");
  });
  // The static canvas carries its own reduced-motion swap: the pre-JS
  // mark renders the still frame, with the fade class live.
  const index = await readFile(join(webRoot, "index.html"), "utf8");
  const indexReduced = index.slice(index.indexOf("@media (prefers-reduced-motion: reduce)"), index.indexOf("</style>"));
  assert.match(indexReduced, /\.porch118-webp \{ display: none; \}/, "the pre-JS animated mark drops under reduced motion");
  assert.match(indexReduced, /\.porch118-webp-still \{ display: block; \}/, "the pre-JS still frame renders");
  assert.doesNotMatch(indexReduced, /porch95-boot-fade/, "the plain fade into the app survives reduced motion");
  // WCAG 2.2 AA on the navy canvas: all text pairs ≥ 4.5:1.
  assert.ok(contrast(lt.bootBg, lt.bootInk) >= 4.5, `wordmark ${contrast(lt.bootBg, lt.bootInk).toFixed(2)}:1 on navy`);
  assert.ok(contrast(lt.bootBg, lt.bootStatusInk) >= 4.5, `status text ${contrast(lt.bootBg, lt.bootStatusInk).toFixed(2)}:1 on navy`);
  // The same navy canvas in both display modes: the boot palette is
  // mode-invariant by contract.
  for (const key of ["bootBg", "bootInk", "bootStatusInk"]) {
    assert.equal(lt[key], (await import("../src/theme.js")).darkTokens[key], `boot token ${key} is mode-invariant`);
  }
});

test("ac-6: the webp ships in-bundle and loops, no second loading implementation exists, and the PORCH-051 reconciliation stays recorded as pending", async () => {
  // Asset of record: the animated webp is committed in the SPA's static
  // assets, carries every supplied frame, and loops forever (readiness —
  // never the loop's end — ends the boot).
  const anim = await readFile(join(webRoot, "public", "loader.webp"));
  const still = await readFile(join(webRoot, "public", "loader-still.webp"));
  assert.ok(anim.subarray(0, 4).toString("ascii") === "RIFF" && anim.subarray(8, 12).toString("ascii") === "WEBP", "the asset of record is a webp image");
  assert.ok(anim.includes(Buffer.from("ANIM")), "the asset of record is animated");
  const frames = [...anim.toString("latin1").matchAll(/ANMF/g)].length;
  assert.equal(frames, 36, `the asset carries the supplied frames (${frames})`);
  // The ANIM chunk's header holds the loop count (0 = infinite).
  const animChunk = anim.indexOf(Buffer.from("ANIM"));
  assert.equal(anim.readUInt16LE(animChunk + 8), 0, "the animated asset loops forever");
  assert.ok(still.subarray(8, 12).toString("ascii") === "WEBP" && !still.includes(Buffer.from("ANIM")), "the still frame is a single-frame webp");
  // No geometry-twin markup or choreography remains anywhere on the
  // loading path (index, source, or built output); fades/dissolves and the
  // reduced-motion swap are the only CSS.
  assert.equal(existsSync(join(webRoot, "src", "lantern-geometry.js")), false, "the drawn-twin module is retired");
  const lanternSource = await src("lantern.jsx");
  assert.doesNotMatch(lanternSource, /FACETS|NODES|GLOW_LOOP|PULSE|offset-path|<svg/, "no choreography or vector twin joins the React layer");
  const index = await readFile(join(webRoot, "index.html"), "utf8");
  assert.doesNotMatch(index, /porch95-facet|porch95-pulse|porch95-node|porch95-circuit|<svg/, "the static canvas carries no choreography keyframes");
  // The PORCH-051 reconciliation stays recorded as pending in the token layer.
  const themeSource = await src("theme.js");
  assert.match(themeSource, /PORCH-051/, "the manifest splash reconciliation is recorded in the token layer");
  assert.match(themeSource, /pending Brian's ruling/, "the reconciliation names itself pending");
  assert.match(themeSource, /implemented only on his word/, "the reconciliation is implemented only on his word");
  const manifest = await readFile(join(webRoot, "public", "manifest.webmanifest"), "utf8");
  assert.equal(JSON.parse(manifest).background_color, "#F7F5F0", "the manifest splash is untouched pending the ruling");
});