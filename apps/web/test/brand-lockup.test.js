// Brand lockup regression (PORCH-072 ac-4): the lockup is one horizontal
// row — icon left, wordmark right — on every surface, never stacked. The
// consumer bug this pins: Lockup used to forward a call-site `sx` straight
// onto the layout Box, replacing (not merging) the sx that keeps the
// container `display: inline-flex` + `alignItems: center`; any caller
// passing sx (the shell AppBar, the WhoIsHere header) then rendered the
// wordmark stacked beneath the icon. The test bundles the real component
// with @mui/material aliased to a recording stub and asserts what actually
// reaches Box: the base layout sx survives call-site sx, and the icon and
// wordmark ride the single row container, icon first, wordmark second.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import React from "react";
import { renderToString } from "react-dom/server";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = fileURLToPath(new URL("../", import.meta.url));

// Recording stub: Box and Typography hand their props to the test through a
// global side channel (the stub is bundled into the built brand module, so
// direct module imports are unreachable) and render inert markup, keeping
// the assertion surface on the pure component contract.
const stubSource = join(here, ".lockup-stub.mjs");
const stubCode = `
import React from "react";
export function Box(props) {
  (globalThis.__PORCH_LOCKUP_BOXES ??= []).push(props);
  return props.component === "img"
    ? React.createElement("img", { src: props.src, alt: props.alt })
    : React.createElement("span", null, props.children);
}
export function Typography(props) {
  return React.createElement("span", null, props.children);
}
`;

// Bundles the real src/brand.jsx with the stub in place of @mui/material.
async function bundleLockup(buildDir) {
  const source = await readFile(join(webRoot, "src", "brand.jsx"), "utf8");
  await build({
    stdin: { contents: source, resolveDir: join(webRoot, "src"), loader: "jsx", sourcefile: "brand.jsx" },
    bundle: true,
    format: "esm",
    jsx: "automatic",
    platform: "neutral",
    external: ["react"],
    alias: { "@mui/material": stubSource },
    outfile: join(buildDir, "brand.lockup.built.mjs"),
    logLevel: "silent",
  });
}

// One bundle + render environment per test; the built module lives under
// test/.tmp-lockup so Node resolves react/react-dom from the hoisted root
// node_modules. Every helper cleans up what it creates.
async function withLockup(run) {
  const tmp = join(here, ".tmp-lockup");
  await mkdir(tmp, { recursive: true });
  await writeFile(stubSource, stubCode);
  try {
    await bundleLockup(tmp);
    const { Lockup } = await import("./.tmp-lockup/brand.lockup.built.mjs");
    await run(Lockup);
  } finally {
    await rm(tmp, { recursive: true, force: true });
    await rm(stubSource, { force: true });
  }
}

function boxProp() {
  const boxes = globalThis.__PORCH_LOCKUP_BOXES ?? [];
  return boxes[0];
}

test("PORCH-072 ac-4: Lockup keeps the horizontal row contract when call sites pass sx", async () => {
  await withLockup(async (Lockup) => {
    globalThis.__PORCH_LOCKUP_BOXES = [];
    // Render exactly as the shell AppBar call site does — caller sx that
    // used to clobber the layout sx.
    renderToString(React.createElement(Lockup, { size: 30, sx: { minWidth: 180 } }));
    const box = boxProp();
    assert.ok(box, "the lockup container Box rendered");
    assert.ok(Array.isArray(box.sx), `the container sx is a merge array, got ${JSON.stringify(box.sx)}`);
    // The base layout sx is present FIRST — one row, icon left of wordmark.
    const [base, ...rest] = box.sx;
    assert.equal(base.display, "inline-flex", "the base container stays inline-flex");
    assert.equal(base.alignItems, "center", "icon and wordmark center on the row");
    assert.deepEqual(rest, [{ minWidth: 180 }], "the call-site sx rides the merge, never replaces the base");
    // Icon left, wordmark right: img is the first row child, wordmark second.
    const children = React.Children.toArray(box.children);
    assert.equal(children[0].type.name, "Box", "the lamp icon renders first, left of the wordmark");
    assert.equal(children[0].props.component, "img");
    assert.equal(children[0].props.src, "/lamp-mark.png");
    assert.equal(children[1].type.name, "Typography", "the wordmark rides beside the icon");
    assert.equal(children[1].props.children, "Porchlight");
  });
});

test("PORCH-072 ac-4: the row contract also holds with no call-site sx and with array call-site sx", async () => {
  await withLockup(async (Lockup) => {
    globalThis.__PORCH_LOCKUP_BOXES = [];
    renderToString(React.createElement(Lockup, { size: 28 }));
    const box = boxProp();
    assert.ok(Array.isArray(box.sx) && box.sx.length === 1, "sx-less callers get the base row contract alone");
    assert.equal(box.sx[0].display, "inline-flex");

    // Array-form call-site sx (the MUI merge idiom) must not clobber either.
    globalThis.__PORCH_LOCKUP_BOXES = [];
    renderToString(React.createElement(Lockup, { size: 28, sx: [{ mb: 3 }] }));
    const merged = boxProp();
    assert.equal(merged.sx[0].display, "inline-flex", "the base layout sx survives an array call-site sx");
    assert.deepEqual(merged.sx.slice(1), [{ mb: 3 }]);
  });
});

test("PORCH-072 ac-4: the rendered lockup markup is one container with icon before wordmark", async () => {
  await withLockup(async (Lockup) => {
    const html = renderToString(React.createElement(Lockup, { size: 30 }));
    const iconAt = html.indexOf('src="/lamp-mark.png"');
    const wordAt = html.indexOf(">Porchlight<");
    assert.ok(iconAt > -1 && wordAt > iconAt, `the icon renders before the wordmark, icon@${iconAt} word@${wordAt}`);
    // The lockup rides one span container: the row span opened before the
    // icon also closes the wordmark, so both share the single row.
    const rowOpen = html.indexOf("<span");
    const rowClose = html.lastIndexOf("</span>");
    assert.ok(rowOpen < iconAt && iconAt < wordAt && wordAt < rowClose, "icon and wordmark close inside the one row container");
    assert.equal(html.split(">Porchlight<").length, 2, "exactly one wordmark renders per lockup");
  });
});