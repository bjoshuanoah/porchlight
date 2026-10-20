// Constrained markdown parser (PORCH-111): unit tests for the block/inline
// shapes the release-notes renderers consume. Pure data, no node imports.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMarkdownBlocks, inline } from "../src/markdown.js";

test("headings, bullets, bold, links, and code spans parse to structured blocks", () => {
  const blocks = parseMarkdownBlocks(
    ["## v0.5.0 — 2026-10-20", "", "- a **bold** claim with [a link](https://example.com) and `code`", "- second bullet", "", "plain paragraph"].join("\n"),
  );
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["heading", "list", "paragraph"],
  );
  assert.deepEqual(blocks[0], { kind: "heading", level: 2, runs: [{ text: "v0.5.0 — 2026-10-20" }] });
  const list = blocks[1];
  assert.equal(list.ordered, false);
  assert.deepEqual(list.items[0].runs, [
    { text: "a " },
    { bold: true, text: "bold" },
    { text: " claim with " },
    { href: "https://example.com", text: "a link" },
    { text: " and " },
    { code: true, text: "code" },
  ]);
  assert.deepEqual(list.items[1].runs, [{ text: "second bullet" }]);
});

test("ordered lists and one nesting level via indentation parse as structured items", () => {
  const blocks = parseMarkdownBlocks(["1. first", "   - nested note", "2. second"].join("\n"));
  const list = blocks[0];
  assert.equal(list.kind, "list");
  assert.equal(list.ordered, true);
  assert.equal(list.items.length, 2);
  assert.deepEqual(list.items[0].items[0].runs, [{ text: "nested note" }]);
  assert.deepEqual(list.items[1].runs, [{ text: "second" }]);
});

test("raw HTML inside note content stays literal text data — never markup", () => {
  const blocks = parseMarkdownBlocks("- legit <script>alert('x')</script> tail and <b>tag soup</b>");
  assert.deepEqual(blocks[0].items[0].runs, [
    { text: "legit <script>alert('x')</script> tail and <b>tag soup</b>" },
  ]);
});

test("unmatched markdown delimiters stay literal readable text", () => {
  assert.deepEqual(inline("a **broken pair and a [lonely](hook("), [
    { text: "a **broken pair and a [lonely](hook(" },
  ]);
  assert.deepEqual(inline("snake_case_files_ stay whole"), [{ text: "snake_case_files_ stay whole" }]);
});

test("soft-wrapped list items ride their bullet; blank lines and rules become blocks", () => {
  const blocks = parseMarkdownBlocks(["- a bullet that keeps", "  wrapping onto the next line", "", "---"].join("\n"));
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].items[0].runs, [{ text: "a bullet that keeps wrapping onto the next line" }]);
  assert.deepEqual(blocks[1], { kind: "rule" });
});

test("fenced code becomes a pre block with its line structure preserved", () => {
  const blocks = parseMarkdownBlocks(["before", "", "```bash", "npm install -g porchlight", "porchlight start", "```", "", "after"].join("\n"));
  assert.deepEqual(blocks.map((block) => block.kind), ["paragraph", "pre", "paragraph"]);
  assert.deepEqual(blocks[1], { kind: "pre", text: ["npm install -g porchlight", "porchlight start"].join("\n") });
});

test("italics, bold nesting inside text, and empty input behave", () => {
  assert.deepEqual(inline("*emphasis* and **strong**"), [
    { italic: true, text: "emphasis" },
    { text: " and " },
    { bold: true, text: "strong" },
  ]);
  assert.deepEqual(inline("**x**"), [{ bold: true, text: "x" }]);
  assert.deepEqual(parseMarkdownBlocks(""), []);
  assert.deepEqual(parseMarkdownBlocks(null), []);
});