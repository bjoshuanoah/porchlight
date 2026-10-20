/**
 * Constrained markdown block/inline parser (PORCH-111). Pure data — no node
 * imports, no React, no HTML: the release notes' raw markdown (the CHANGELOG
 * `## vX.Y.Z` section carried verbatim by the update-check payload, or the
 * GitHub release body) parses into structured blocks and runs, and each
 * display surface maps them to its own formatting (the console Updates card,
 * `porchlight update`'s terminal output).
 *
 * Constrained, by contract: headings, bullets (ordered and unordered, one
 * nesting level via indentation), bold, italics, links, code spans, and
 * horizontal rules. Anything else — raw HTML carried inside note content
 * included — stays literal text data. No renderer that consumes these shapes
 * can execute or inject HTML: the parser never emits markup.
 */

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const LIST_LINE = /^(\s*)([-*+]|\d+[.)])\s+([\s\S]+)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE_OPEN = /^\s*(?:```|~~~)\s*([\w-]*)\s*$/;
const FENCE_CLOSE = /^\s*(?:```|~~~)\s*$/;
// Code spans first (highest priority), then links, then bold, then italics.
const INLINE =
  /(`+)([\s\S]+?)\1|(?:\[([^\]]+)\]\(([^)\s]+)\))|\*\*([\s\S]+?)\*\*|\*([^*\s](?:[^*]*[^*\s])?)\*/g;

export function parseMarkdownBlocks(markdown) {
  if (typeof markdown !== "string" || markdown.trim() === "") return [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ kind: "paragraph", runs: inline(paragraph.join(" ").trim()) });
      paragraph = [];
    }
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    const fence = line.match(FENCE_OPEN);
    if (fence) {
      flushParagraph();
      const code = [];
      while (index + 1 < lines.length && !FENCE_CLOSE.test(lines[index + 1])) {
        code.push(lines[index + 1]);
        index += 1;
      }
      if (index + 1 < lines.length) index += 1; // the closing fence
      blocks.push({ kind: "pre", text: code.join("\n") });
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1].length, runs: inline(heading[2]) });
      continue;
    }
    if (RULE.test(line)) {
      flushParagraph();
      blocks.push({ kind: "rule" });
      continue;
    }
    const bullet = line.match(LIST_LINE);
    if (bullet) {
      flushParagraph();
      const gathered = [{ indent: indentLevel(bullet[1]), marker: bullet[2], text: bullet[3] }];
      while (index + 1 < lines.length && lines[index + 1].trim() !== "") {
        const next = lines[index + 1].match(LIST_LINE);
        if (next) {
          gathered.push({ indent: indentLevel(next[1]), marker: next[2], text: next[3] });
          index += 1;
          continue;
        }
        // A list may soft-wrap its item text; continuation lines ride the
        // item above them.
        if (indentLevel(lines[index + 1]) > gathered[gathered.length - 1].indent) {
          gathered[gathered.length - 1].text += " " + lines[index + 1].trim();
          index += 1;
          continue;
        }
        break;
      }
      blocks.push(list(gathered));
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  return blocks;
}

function indentLevel(spaces) {
  return Math.min(3, Math.floor(spaces.length / 2));
}

/** One contiguous run of list lines becomes one list block with nesting.
 * Ordered lists carry their start number so the renderers number from the
 * marker the author wrote. */
function list(gathered) {
  const ordered = /^\d/.test(gathered[0].marker);
  const start = ordered ? Number(gathered[0].marker.match(/^(\d+)/)?.[1] ?? 1) : undefined;
  const items = [];
  let current = null;
  for (const { indent, text } of gathered) {
    if (indent === 0 || !current) {
      current = { runs: inline(text), items: [] };
      items.push(current);
    } else {
      current.items.push({ runs: inline(text), items: [] });
    }
  }
  return { kind: "list", ordered, start, items: items };
}

/** Inline markdown → run objects. Runs carry text data, never markup. */
export function inline(text, base = {}) {
  const runs = [];
  const push = (textPart, flags) => {
    if (textPart) runs.push({ ...base, ...flags, text: textPart });
  };
  let at = 0;
  for (let match; (match = INLINE.exec(text)); ) {
    if (match.index > at) push(text.slice(at, match.index));
    at = match.index + match[0].length;
    if (match[1] !== undefined) push(match[2].trim(), { code: true });
    else if (match[3] !== undefined) push(match[3], { href: match[4] });
    else if (match[5] !== undefined) push(match[5], { bold: true });
    else if (match[6] !== undefined) push(match[6], { italic: true });
  }
  if (at < text.length) push(text.slice(at));
  return runs;
}