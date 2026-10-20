// Release-notes rendering on the Releases/Updates card (PORCH-111): the web
// half is JSX, so the rendered law is asserted here the way the repo's other
// source-scoped tests assert JSX — the card renders the notes' markdown as
// structured blocks through the shared constrained parser and never a raw
// HTML node: no dangerouslySetInnerHTML, no injected markup, anywhere in the
// SPA.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { parseMarkdownBlocks } from "@porchlight/shared/markdown";

const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
const identity = await readFile(join(srcDir, "identity.jsx"), "utf8");

test("porch-111 ac-1: the Updates card renders the notes' markdown through the shared constrained parser", () => {
  assert.match(identity, /import \{ parseMarkdownBlocks \} from '@porchlight\/shared\/markdown'/);
  // The plaintext pre-wrap text node that rendered notes as glyph soup is
  // gone; the structured renderer takes its place under the same testid.
  assert.match(identity, /data-testid="release-notes"/);
  assert.match(identity, /<ReleaseNotesBlocks text=\{card\.notes\.text\} \/>/);
  assert.doesNotMatch(identity, /whiteSpace: 'pre-wrap', wordBreak: 'break-word', \.\.\.\(card\.notes\.source/);
});

test("porch-111 ac-2: no renderer in the SPA executes or injects raw HTML", async () => {
  for (const name of await readdir(srcDir)) {
    const source = await readFile(join(srcDir, name), "utf8");
    assert.ok(!source.includes("dangerouslySetInnerHTML"), `src/${name} renders raw HTML`);
  }
  // The unavailable prose branch stays a plain escaped text node too.
  assert.match(
    identity,
    /notes\.source === 'unavailable'\s*\?\s*<Typography variant="body2" color="text\.secondary"/,
  );
});

test("porch-111 ac-1: the parser the card consumes maps changelog-shaped markdown to structured blocks", () => {
  // The card feeds the notes' verbatim payload field straight into the
  // parser end-to-end; assert the exact shapes the MUI mapping consumes
  // for a release-notes cut of the shipped changelog shape.
  const blocks = parseMarkdownBlocks(
    ["- **Lifecycle ruling** (Brian, Oct 16, 2026): the author's delete cascades", "  - tombstone, 30 days, one hard purge", "- `porchlight update` rides the same notes"].join("\n"),
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].items[0].runs[0].bold, true);
  assert.deepEqual(blocks[0].items[0].items[0].runs, [{ text: "tombstone, 30 days, one hard purge" }]);
  assert.equal(blocks[0].items[1].runs[0].code, true);
});