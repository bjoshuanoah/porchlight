// Console-wide content sweeps (PORCH-130): the console build contract
// enforced over the every-file view — the SPA speaks only to same-origin
// engine paths and carries none of the forbidden vocabulary. These are
// file-content assertions on packages/console/src; they pin the network
// surface and the copy discipline, and they will break loudly if anything
// sneaks past.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else if (/\.(jsx?|mjs)$/.test(entry)) files.push(path);
  }
  return files;
}

const sources = new Map(walk(SRC).map((path) => [path, readFileSync(path, "utf8")]));

test("every source file declares an origin it may speak to: same-origin only", () => {
  // No absolute http(s) URL anywhere in src — every endpoint is a
  // same-origin path, and not a single analytics or third-party domain.
  const hits = [];
  for (const [path, text] of sources) {
    let index = 0;
    while ((index = text.indexOf("http", index)) !== -1) {
      hits.push(`${path.replace(SRC, "src")} — ${text.slice(index, index + 40)}`);
      index += 4;
    }
  }
  assert.deepEqual(hits, []);
});

test("quoted path literals are same-origin engine routes", () => {
  const allowed = ["/api/", "/live/", "/service", "/storage", "/cameras", "/media/", "/health"];
  const hits = [];
  for (const [path, text] of sources) {
    // Quoted or templated literals that open with a leading slash: the
    // console's whole external surface (fetch paths, media URLs, live
    // streams). "./"-style relative imports are module paths, not routes.
    for (const match of text.matchAll(/(?<![\w.])(["'`])(\/[^"`'\n]{1,90})\1/g)) {
      const literal = match[2];
      if (literal.startsWith("//")) continue; // never a route
      if (literal.includes(" ")) continue; // a multi-word display label (e.g. the Porchlight "/schedule 22:00–06:00" chip), not a fetch path
      if (allowed.some((prefix) => literal.startsWith(prefix) || literal === prefix.trimEnd())) continue;
      hits.push(`${path.replace(SRC, "src")} — ${literal}`);
    }
  }
  assert.deepEqual(hits, []);
});

test("the forbidden-word sweep is a zero", () => {
  // Zero hits across src/** — copy and code alike never name these; adjust
  // the copy instead of allowing an occurrence. The theme slice's own files
  // (main.jsx, theme.js, mode.js) are outside this sweep: the PORCH-042
  // vocabulary of record names its token contract there (tokenStyles,
  // lightTokens), and those files are another slice's exclusive ground.
  const pattern = /password|passwd|sign in|login|log in|email|apikey|api key|secret|token|did:/i;
  const themedNames = new Set(["main.jsx", "theme.js", "mode.js"]);
  const hits = [];
  for (const [path, text] of sources) {
    const base = path.split("/").pop();
    if (themedNames.has(base)) continue;
    if (pattern.test(text)) hits.push(path.replace(SRC, "src"));
  }
  assert.deepEqual(hits, []);
});

test("no vendor-anything buttons", () => {
  const pattern = /sign in with|continue with|oauth|apple id|google account|facebook/i;
  const hits = [];
  for (const [path, text] of sources) {
    if (pattern.test(text)) hits.push(path.replace(SRC, "src"));
  }
  assert.deepEqual(hits, []);
});

test("no engagement counting of any kind", () => {
  const pattern = /engagement|views count|view count|followers?|likes count/i;
  const hits = [];
  for (const [path, text] of sources) {
    if (pattern.test(text)) hits.push(path.replace(SRC, "src"));
  }
  assert.deepEqual(hits, []);
});

test("the tab bar carries the mobile contract: scrollable + fixed on xs", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  assert.match(app, /variant\s*=\s*["'`]scrollable["'`]/);
  assert.match(app, /position:\s*\{\s*xs:\s*"fixed"/);

  const tabs = readFileSync(join(SRC, "tabs.js"), "utf8");
  assert.match(tabs, /id:\s*"live"/);
  assert.match(tabs, /id:\s*"timeline"/);
  assert.match(tabs, /id:\s*"status"/);
});

test("the wizard copy names the deployment step and names nothing forbidden", () => {
  const wizard = readFileSync(join(SRC, "screens", "Wizard.jsx"), "utf8");
  assert.match(wizard, /deployment/i);
  assert.match(wizard, /Name the deployment/);
  // Duplicated from the whole-src zero above, scoped so a wizard regression
  // can never lean on the global sweep passing for other reasons.
  const pattern = /password|passwd|sign in|login|log in|email|apikey|api key|secret|token|did:/i;
  assert.equal(pattern.test(wizard), false);
});
