// formatReleaseNotes (PORCH-111): the notes' markdown maps to plain terminal
// lines — headings bold, bullets marked and indented, bold carried, links
// named with their URL, code spans de-glyphed — with ANSI emphasis only when
// explicitly asked for, and a literal readable fallback for anything the
// constrained parser leaves unmapped (raw HTML included).
import test from "node:test";
import assert from "node:assert/strict";

import { formatReleaseNotes } from "../src/notes.mjs";

test("porch-111 ac-3: headings, bullets, and bold map to terminal lines; links and code stay readable, not glyphs", () => {
  const markdown = [
    "## What v0.5.0 changes",
    "",
    "- **Lifecycle deletes** ride the tombstone pattern — see [the ruling](https://example.com/ruling) and `one-time purge`.",
    "  - nested detail line",
    "",
    "2. ordered item with **bold** — numbered from the marker it carries",
    "3. next ordered item",
  ].join("\n");
  assert.equal(
    formatReleaseNotes(markdown, { color: false }),
    [
      "What v0.5.0 changes",
      "",
      "• Lifecycle deletes ride the tombstone pattern — see the ruling (https://example.com/ruling) and one-time purge.",
      "  • nested detail line",
      "",
      "2. ordered item with bold — numbered from the marker it carries",
      "3. next ordered item",
    ].join("\n"),
  );
});

test("ansi emphasis only when color is requested — piped output stays clean", () => {
  const markdown = "## A heading\n\n- a **bold** bullet with `code`";
  const colored = formatReleaseNotes(markdown, { color: true });
  assert.ok(colored.includes("\x1b[1mA heading\x1b[22m"));
  assert.ok(colored.includes("\x1b[1mbold\x1b[22m"));
  assert.ok(colored.includes("\x1b[2mcode\x1b[22m"));
  assert.equal(
    formatReleaseNotes(markdown, { color: false }),
    ["A heading", "", "• a bold bullet with code"].join("\n"),
  );
  // A same-text link prints the bare URL once — never doubled.
  assert.equal(formatReleaseNotes("see [https://example.com](https://example.com)", { color: false }), "see https://example.com");
});

test("raw HTML and unknown markup fall through as literal readable text — nothing executes", () => {
  const line = "- carries <script>alert('x')</script> and <b>soup</b> verbatim";
  assert.equal(formatReleaseNotes(line, { color: false }), "• carries <script>alert('x')</script> and <b>soup</b> verbatim");
  assert.equal(formatReleaseNotes("plain prose line", { color: false }), "plain prose line");
  assert.equal(formatReleaseNotes("", { color: false }), "");
});

test("fenced code keeps its line structure instead of collapsing into one string", () => {
  assert.equal(
    formatReleaseNotes(["before", "", "```bash", "npm install -g porchlight", "porchlight start", "```"].join("\n"), { color: false }),
    ["before", "", "  npm install -g porchlight", "  porchlight start"].join("\n"),
  );
});