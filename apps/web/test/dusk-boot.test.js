// Dusk boot behavior checks: first-paint asset, status rotation, readiness,
// accessibility, failure continuity, and deployed-hub coverage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToString } from "react-dom/server";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const src = async (name) => await readFile(join(webRoot, "src", name), "utf8");

const assets = await import("../src/loader-assets.js");
const theme = await import("../src/theme.js");

// Bundles the real src/lantern.jsx so the assertions ride the rendered
// markup (MUI-free by contract — the boot is a mode-invariant brand
// surface outside the theme's surface system).
async function withLantern(run) {
  const { build } = await import("esbuild");
  const { mkdir, rm } = await import("node:fs/promises");
  const tmp = join(here, ".tmp-dusk");
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
    const { LanternBoot, swapStatusLine } = await import("./.tmp-dusk/lantern.built.mjs");
    await run({ LanternBoot, swapStatusLine });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** The built CSS block — the shipped animation contract, template resolved. */
function styleOf(html) {
  return html.match(/<style>([\s\S]*?)<\/style>/)[1];
}

async function staticBootSlice() {
  const index = await readFile(join(webRoot, "index.html"), "utf8");
  return index.slice(index.indexOf('id="porch-boot"'), index.indexOf('id="root"'));
}

test("ac-1: the dusk boot carries the static app icon and lowercase wordmark", async () => {
  await withLantern(async ({ LanternBoot }) => {
    const html = renderToString(React.createElement(LanternBoot));
    // Deep navy canvas with the original, still Porchlight icon.
    assert.match(html, /background:var\(--porch-boot-bg\)/);
    assert.match(html, /alignItems:"center"|align-items:\s*center/);
    assert.match(html, /src="\/icon-512\.png"/);
    assert.match(html, /class="porch95-wordmark" aria-hidden="true">porchlight</, "the wordmark renders lowercase on this surface");
    // Layer order: mark above the wordmark, wordmark above the status box.
    const markAt = html.indexOf('src="/icon-512.png"');
    const wordAt = html.indexOf(">porchlight<");
    const boxAt = html.indexOf('class="porch95-statusbox"');
    assert.ok(markAt > -1 && wordAt > markAt && boxAt > wordAt, "mark → wordmark → status, no reordering");
    // No clipping and no horizontal scroll on 390px-class viewports: the
    // fixed layer clips its own overflow (the glow is wider than a phone).
    assert.match(html, /overflow:\s*hidden/);
  });
  const boot = await staticBootSlice();
  assert.match(boot, /style="[^"]*overflow:hidden/, "the pre-JS canvas clips its own overflow");
  assert.match(boot, /var\(--porch-boot-bg,#0B1622\)/, "deep navy rides the boot token pre-JS");
  assert.match(boot, />porchlight</);
  assert.match(boot, /src="\/icon-512\.png"/);
  // Brian, Oct 22: the lantern is 200% bigger — 184px on both canvases.
  assert.equal(assets.BOOT_MARK_H, 184, "the React boot mark doubles");
  assert.match(boot, /style="height:184px;width:184px"/, "the pre-JS canvas carries the doubled icon");
});

test("ac-2: layered lighting — halo behind the mark, flattened glow beneath, mark and typography never blurred", async () => {
  await withLantern(async ({ LanternBoot }) => {
    const css = styleOf(renderToString(React.createElement(LanternBoot)));
    // Halo: a soft round amber field centered behind the mark (z 0).
    assert.match(css, /\.porch-dusk-halo \{[^}]*transform:\s*translate\(-50%,\s*-50%\)/);
    assert.match(css, /\.porch-dusk-halo \{[^}]*border-radius:\s*50%/, "no hard edges on the halo");
    // The scene paint rides the boot token layer (PORCH-042: screens carry
    // no literal color); the halo's gradient fades to transparent — no
    // visible floor line. The pre-JS canvas mirrors the same literals as
    // fallback-only values.
    assert.match(css, /\.porch-dusk-halo \{[^}]*background: var\(--porch-boot-dusk-halo\)/);
    assert.match(theme.lightTokens.bootDuskHalo, /rgba\(255,190,87,0\)\s+70%/);
    // Floor glow: wider and flattened (scaleY), beneath the mark.
    const glow = css.match(/\.porch-dusk-glow \{[^}]*\}/)[0];
    assert.match(glow, /width:\s*440px/, "the glow is wider than the halo");
    assert.match(glow, /scaleY\(\.42\)/, "the glow is flattened — light on a porch floor, no floor drawn");
    const halo = css.match(/\.porch-dusk-halo \{[^}]*\}/)[0];
    assert.ok(Number(glow.match(/top:\s*(\d+)px/)[1]) > 100, "the glow sits beneath the mark");
    assert.ok(halo.includes("top: 50%"), "the halo sits behind the mark's center");
    // The image is an opaque sibling above the lighting, with an isolated
    // stacking context so no animated mote can paint over its pixels.
    assert.match(css, /\.porch-dusk-scene \{[^}]*isolation: isolate/);
    assert.match(css, /\.porch-dusk-mark \{[^}]*z-index: 3; opacity: 1/);
  });
  // The static canvas mirrors the scene rule for rule (pre-JS parity).
  const index = await readFile(join(webRoot, "index.html"), "utf8");
  for (const name of ["porch-dusk-scene", "porch-dusk-halo", "porch-dusk-glow", "porch-dusk-particles", "porch95-wordmark", "porch95-statusbox"]) {
    assert.match(index, new RegExp(`\\.${name}[^{]*\\{`), `the static canvas ships the ${name} scene layer`);
  }
  const boot = await staticBootSlice();
  // DOM order proves the layering: halo, glow, particles behind the mark.
  const haloAt = boot.indexOf("porch-dusk-halo");
  const glowAt = boot.indexOf("porch-dusk-glow");
  const partsAt = boot.indexOf("porch-dusk-particles");
  const markAt = boot.indexOf("porch-dusk-mark");
  assert.ok(haloAt < glowAt && glowAt < partsAt && partsAt < markAt, "lighting renders behind the mark");
});

test("ac-3: sparse firefly particles orbit the lantern on slow curved paths with bright heads and fading tails", async () => {
  await withLantern(async ({ LanternBoot }) => {
    const html = renderToString(React.createElement(LanternBoot));
    const css = styleOf(html);
    // Sparse: six orbiting motes, desynced and individually tuned.
    assert.equal((html.match(/class="porch-dusk-particle"/g) ?? []).length, 6, "the field stays sparse");
    // Slow (multi-second durations) with per-particle variation.
    const durations = [...css.matchAll(/--d:\s*(1[89]|[23]\d)s/g)].map((m) => m[1]);
    assert.ok(durations.length >= 6, "every firefly orbits on a multi-second rhythm");
    // Orbiting the lantern (Brian, Oct 22): the motes anchor at the mark's
    // center and circle it on per-particle elliptical paths.
    const moteRule = css.match(/\.porch-dusk-particle \{[^}]*\}/)[0];
    assert.match(moteRule, /left: 50%; top: 50%/, "the motes anchor at the mark's center");
    const radii = [...css.matchAll(/--r:\s*(\d+)px;.*--ry:\s*(\d+)px/g)].map((m) => [Number(m[1]), Number(m[2])]);
    assert.ok(radii.length >= 6, "each firefly carries its own orbit radius and squash");
    assert.ok(radii.every(([r, ry]) => r >= 60 && ry > 0 && ry < r), "the orbits are elliptical — squashed per mote");
    // Gently curved: the orbit keyframes travel eased waypoints with a
    // rotate wiggle (never a straight run).
    const orbitKey = css.match(/@keyframes porch-dusk-orbit \{[\s\S]*?\n\}/)[0];
    const waypoints = [...orbitKey.matchAll(/transform:/g)].length;
    assert.ok(waypoints >= 4, `the path curves through ${waypoints} waypoints`);
    assert.match(orbitKey, /rotate/, "the path carries gentle curvature");
    assert.match(css, /animation-direction: reverse/, "half the fireflies orbit the other way — no uniform swim");
    // Bright head, short fading tail — the paint rides the token layer; the
    // pre-JS canvas carries the same literals as fallback-only values.
    const mote = css.match(/\.porch-dusk-particle \{[^}]*\}/)[0];
    assert.match(mote, /background: var\(--porch-boot-dusk-mote\)/);
    assert.match(theme.lightTokens.bootDuskMote, /#FFE2B0 0%/, "the head is the bright core");
    assert.match(css, /porch-dusk-particle::after/, "the tail is a separate fading streak");
    const tail = css.match(/\.porch-dusk-particle::after \{[^}]*\}/)[0];
    assert.match(tail, /background: var\(--porch-boot-dusk-tail\)/);
    assert.match(theme.lightTokens.bootDuskTail, /linear-gradient\(to bottom, rgba\(255,190,87,\.55\), rgba\(255,190,87,0\)\)/, "the tail fades to nothing");
    assert.ok(Number(tail.match(/height:\s*(\d+)px/)[1]) <= 14, "the tail stays short");
    // Unobtrusive: the particles render behind the mark (their layer is z 0).
    assert.match(css, /\.porch-dusk-particles \{ position: absolute; inset: 0; z-index: 0; \}/);
  });
  const boot = await staticBootSlice();
  assert.equal((boot.match(/class="porch-dusk-particle"/g) ?? []).length, 6, "the pre-JS canvas carries the same sparse field");
});

test("ac-4: breathing modulates the light layers only — never the mark's position or scale", async () => {
  await withLantern(async ({ LanternBoot }) => {
    const css = styleOf(renderToString(React.createElement(LanternBoot)));
    const breathe = css.match(/@keyframes porch-dusk-breathe \{[^}]*\}\s*\}\}/)?.[0]
      ?? css.match(/@keyframes porch-dusk-breathe[^{]*\{[\s\S]*?\}\s*\}/)[0];
    // Brighten and soften smoothly: opacity only.
    assert.doesNotMatch(breathe, /transform/, "breathing never moves or rescales anything");
    assert.match(breathe, /opacity/, "breathing modulates the light");
    // The rhythm is subtle and both light layers ride it (offset phases).
    assert.match(css, /animation: porch-dusk-breathe 4\.8s ease-in-out infinite/);
    assert.match(css, /\.porch-dusk-glow \{[^}]*animation-delay:\s*-2\.4s/, "the glow breathes off-phrase — no synchronized flash");
    assert.doesNotMatch(css.match(/\.porch-dusk-mark \{[^}]*\}/)[0], /animation|filter|transform/, "the icon is static, sharp and motionless");
    assert.ok(!breathe.includes("scale"), "no scale modulation on any breathing layer");
  });
});

test("ac-5: no status before 1.5s; the first ruled line reveals at the threshold", async () => {
  const { bootStatusLine, STATUS_THRESHOLD_MS, STATUS_LINES } = assets;
  assert.equal(bootStatusLine(0), null);
  assert.equal(bootStatusLine(700), null);
  assert.equal(bootStatusLine(STATUS_THRESHOLD_MS - 1), null);
  assert.equal(bootStatusLine(STATUS_THRESHOLD_MS), STATUS_LINES[0], `"${STATUS_LINES[0]}" appears at 1.5s`);
  // The fixed-height box: the reveal never shifts the composition.
  const index = await readFile(join(webRoot, "index.html"), "utf8");
  assert.match(index, /\.porch95-statusbox \{ position: relative; height: 20px; width: 300px; \}/);
});

test("ac-6: the rotation crossfades through the five ruled lines every 3s and loops", async () => {
  const { STATUS_LINES, STATUS_CYCLE_MS, bootStatusLine } = assets;
  // Order of record, verbatim.
  assert.deepEqual(
    [...STATUS_LINES].map((l) => l),
    ["lighting the porch…", "knocking on the front door…", "ringing the doorbell…", "finding you a seat…", "seeing who's home…"],
  );
  assert.equal(STATUS_CYCLE_MS, 3000);
  // Loop after the final message.
  assert.equal(bootStatusLine(1500 + 3000 * 5), STATUS_LINES[0], "the rotation loops");
  assert.equal(bootStatusLine(1500 + 3000 * 7), STATUS_LINES[2]);
  // Crossfade: dual stacked nodes fade in/out inside the fixed box.
  await withLantern(async ({ swapStatusLine }) => {
    assert.equal(typeof swapStatusLine, "function", "the crossfade writer ships from the boot layer");
  });
  const lantern = await src("lantern.jsx");
  assert.match(lantern, /\.porch95-status-out/, "the outgoing node fades while the incoming fades in");
  const index = await readFile(join(webRoot, "index.html"), "utf8");
  assert.match(index, /\.porch95-status \{[^}]*transition: opacity 250ms ease/, "the status crossfade is a CSS transition");
  assert.match(index, /\.porch95-statusbox \{[^}]*height: 20px/, "the fixed-height box holds the layout");
});

test("ac-7: readiness dissolves immediately and completes inside 300ms — never waiting on a cycle", async () => {
  const lantern = await src("lantern.jsx");
  // The dissolve rides the existing readiness contract (PORCH-095): fires
  // the moment readiness lands, even mid-particle, mid-breath, or mid-line.
  assert.match(lantern, /readiness\.onAppReady\(\(\) => setFading\(true\)\)/);
  assert.match(lantern, /fadeMs = BOOT_FADE_MS/);
  assert.equal(assets.BOOT_FADE_MS, 250, "the dissolve completes inside 300ms, with headroom");
  assert.match(lantern, /if \(!fadingRef\.current && !failure && bootedAtRef\.current != null\)/, "no status tick outlives the dissolve decision");
  const index = await readFile(join(webRoot, "index.html"), "utf8");
  assert.match(index, /\.porch95-boot-fade \{ animation: porch95-fade 250ms ease-out forwards; \}/);
});

test("ac-8: reduced motion — static lighting, no particles, instant status swaps", async () => {
  await withLantern(async ({ LanternBoot }) => {
    const css = styleOf(renderToString(React.createElement(LanternBoot)));
    const dusk = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    assert.match(dusk, /\.porch-dusk-particle \{ display: none; \}/, "the particles rest");
    assert.match(dusk, /\.porch-dusk-halo, \.porch-dusk-glow \{ animation: none; opacity: \.85; \}/, "the lighting holds static");
    assert.match(dusk, /\.porch95-status \{ transition: none; \}/, "status swaps are instant");
  });
  const index = await readFile(join(webRoot, "index.html"), "utf8");
  const staticDusk = index.slice(index.lastIndexOf("@media (prefers-reduced-motion: reduce)"), index.indexOf("</style>"));
  assert.match(staticDusk, /\.porch-dusk-particle \{ display: none; \}/);
  assert.match(staticDusk, /\.porch-dusk-halo, \.porch-dusk-glow \{ animation: none; opacity: \.85; \}/);
  assert.match(staticDusk, /\.porch95-status \{ transition: none; \}/);
});

test("ac-9: one polite announcement, decorative layers hidden, no repeated announcements", async () => {
  await withLantern(async ({ LanternBoot }) => {
    const html = renderToString(React.createElement(LanternBoot));
    // The region is polite (role=status) and announces exactly once: the
    // announcement span is the region's only live content.
    assert.match(html, /role="status"/);
    assert.equal((html.match(/>Porchlight is loading</g) ?? []).length, 1, "one announcement");
    const announce = html.match(/<span class="porch95-announce"[\s\S]*?<\/span>/)?.[0];
    assert.ok(!announce.includes("aria-hidden"), "the announcement itself stays live for assistive tech");
    // Every decorative layer is hidden from the accessibility tree.
    for (const name of ["porch-dusk-scene", "porch95-wordmark"]) {
      assert.match(html, new RegExp(`class="${name}" aria-hidden="true"`));
    }
    assert.match(html, /class="porch95-statusbox" aria-hidden="true"/, "the rotating status box is hidden — no repeated announcements");
    const css = styleOf(html);
    assert.match(css, /\.porch95-announce \{[^}]*clip-path: inset\(50%\)/, "the announcement is visually silent on the canvas");
    assert.doesNotMatch(html, /aria-live="assertive"/, "nothing on the boot path barks");
  });
  const boot = await staticBootSlice();
  assert.match(boot, /<span class="porch95-announce">Porchlight is loading<\/span>/);
  assert.match(boot, /class="porch-dusk-scene" aria-hidden="true"/);
  assert.match(boot, /class="porch95-wordmark" aria-hidden="true"/);
  assert.match(boot, /class="porch95-statusbox" aria-hidden="true"/);
});

test("ac-10: cleanup is total on unmount, and the full-screen treatment never returns mid-session", async () => {
  const lantern = await src("lantern.jsx");
  // Interval + dissolve timer both run their cleanup on unmount; the
  // failure block's DOM cleanup rides its own effect teardown.
  assert.match(lantern, /return \(\) => clearInterval\(iv\);/);
  assert.match(lantern, /return \(\) => clearTimeout\(done\);/);
  assert.match(lantern, /failCleanupRef\.current\?\.\(\);/, "the injected failure node unbinds with the effect");
  assert.match(lantern, /staticBoot\?\.remove\(\);/, "the adopted canvas leaves the DOM with the boot");
  // In-app loading keeps the interface: LanternLoader is unchanged — it
  // never renders fixed, never overlays content, and routine operations
  // get skeletons/reserved frames, not the boot.
  assert.match(lantern, /export function LanternLoader/);
  assert.doesNotMatch(lantern.slice(lantern.indexOf("export function LanternLoader")), /position:\s*"fixed"/);
  // No new event listeners anywhere on the boot layer (the ac-10 listener
  // sweep): the only listener the failure state adds dies with its node.
  assert.doesNotMatch(lantern, /addEventListener\("(?!click)/, "no global listeners join the boot");
});

test("ac-11: the earned failure holds — cycling stops, clear copy, a retry that restarts initialization", async () => {
  await withLantern(async ({ LanternBoot }) => {
    const html = renderToString(React.createElement(LanternBoot, { failure: true, onRetry: () => {} }));
    // Verbatim copy of record, never a variant.
    assert.match(html, /A family server is unreachable\. Saved moments may be out of date\./);
    assert.match(html, /role="alert"/, "the failure is announced — an earned state, not a flash");
    assert.match(html, /class="porch95-retry"[^>]*>Try again</, "one plain retry action");
    // The layer takes pointer events only in failure mode — the retry is
    // exactly the one interactive element, and nothing cycles beneath it.
    assert.match(html, /(pointer-events:auto|pointerEvents:"auto")/);
    assert.doesNotMatch(html, /porch95-status-out/, "no status cycling machinery in the failure render");
  });
  const [lantern, main] = await Promise.all([src("lantern.jsx"), src("main.jsx")]);
  // The adopted static path holds the failure on the live surface too.
  assert.match(lantern, /staticBoot\.style\.pointerEvents = "auto"/, "the retry is reachable on the pre-JS canvas");
  assert.match(lantern, /fail\.setAttribute\("role", "alert"\)/, "the adopted failure renders an alert");
  // Boot continuity (PORCH-117 + PORCH-119): the settle decision reads the
  // failure — the boot never dissolves INTO its error.
  assert.match(main, /if \(bootFailedRef\.current\) return;/, "readiness is withheld while the failure holds");
  // Only the unreachable class holds; a dead credential settles into its
  // own named state (PORCH-050 law unchanged).
  assert.match(main, /failure\.status !== 401/);
  // Retry restarts initialization: the same chain, no page reload.
  assert.match(main, /const retryBoot = useCallback\(\(\) => runBootChain\(\), \[runBootChain\]\);/);
  assert.match(main, /<LanternBoot failure=\{bootFailed\} onRetry=\{retryBoot\} \/>/);
  assert.doesNotMatch(main.slice(main.indexOf("const runBootChain")), /location\.reload|window\.location/, "the retry never reloads the page — it re-runs the boot chain");
});

test("ac-12: bundle discipline — the scene composes from CSS only, and the stage-2 record stands", async () => {
  await withLantern(async ({ LanternBoot }) => {
    const html = renderToString(React.createElement(LanternBoot));
    assert.doesNotMatch(html, /<canvas|<iframe|<video|<svg|<script/, "no imperative scene surface — CSS composes the dusk");
  });
  const lantern = await src("lantern.jsx");
  assert.doesNotMatch(lantern, /offset-path|FACETS|PULSE|GLOW_LOOP/, "no choreography engine returns");
  assert.doesNotMatch(lantern, /from\s+["'][^"']*(?:lottie|spinner|skeleton|animate|motion)/i, "no animation runtime joins the boot layer");
  assert.doesNotMatch(lantern, /["'`][^"'`]*\.(?:gif|mp4|webm|lottie)["'`]/i, "no animation asset references");
  const pkg = JSON.parse(await readFile(join(webRoot, "package.json"), "utf8"));
  for (const dep of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]) {
    if (dep.startsWith("@emotion") || dep.startsWith("react")) continue;
    assert.doesNotMatch(dep, /lottie|gsap|framer|animate\.css|anime\.js|react-spring|spring/i, `${dep} is not an animation library`);
  }
  // The dusk scene lives in exactly two places — the pre-JS canvas and the
  // React fallback (no third copy to drift).
  const index = await readFile(join(webRoot, "index.html"), "utf8");
  for (const cls of ["porch-dusk-halo", "porch-dusk-glow", "porch-dusk-particle", "porch-dusk-orbit", "porch-dusk-breathe"]) {
    assert.match(index, new RegExp(cls));
    assert.match(lantern, new RegExp(cls));
  }
  // Stage-2 (deployed-hub re-verification per the Oct 12 contract) is
  // recorded on the task trail; the record itself is this file's job to
  // keep the local half honest, the hub half is external evidence.
  assert.match(index, /PORCH-119/, "the shipped contract names the ruling in place");
});