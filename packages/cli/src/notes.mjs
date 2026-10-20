// Terminal formatting for release notes (PORCH-111): `porchlight update`
// maps the notes' raw markdown to plain terminal lines — headings bold,
// bullets marked and indented, bold runs carried, links named with their
// URL, code spans de-glyphed — through the same shared constrained parser
// the console card reads. Anything the constrained parser leaves unmapped
// (raw HTML in the content, unknown markup) stays literal readable text:
// the parser only emits text data, so nothing terminal-side can execute.
import { parseMarkdownBlocks } from "@porchlight/shared/markdown";

const BOLD_ON = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const FAINT_ON = "\x1b[2m";
const FAINT_OFF = "\x1b[22m";

/**
 * The notes' markdown → terminal-ready text (no trailing newline; the
 * caller writes its own). `color` gates the ANSI emphasis: off by default
 * so piped or captured output stays clean plain text — the readable
 * fallback — and the TTY paths pass true for styled emphasis.
 */
export function formatReleaseNotes(markdown, { color = false } = {}) {
  const bold = (t) => (color ? BOLD_ON + t + BOLD_OFF : t);
  const faint = (t) => (color ? FAINT_ON + t + FAINT_OFF : t);
  const runs = (runs) =>
    runs
      .map((run) => {
        let text = run.text;
        if (run.href && text !== run.href) text = `${text} (${run.href})`;
        if (run.bold) text = bold(text);
        else if (run.code) text = faint(text);
        return text;
      })
      .join("");
  const lines = [];
  const emitList = (list, depth) => {
    list.items.forEach((item, index) => {
      const marker = list.ordered ? `${(list.start ?? 1) + index}. ` : "• ";
      lines.push("  ".repeat(depth) + marker + runs(item.runs));
      item.items.forEach((child) => emitList({ ...list, items: [child] }, depth + 1));
    });
  };
  for (const block of parseMarkdownBlocks(markdown)) {
    if (block.kind === "heading") lines.push(bold(runs(block.runs)), "");
    else if (block.kind === "rule") lines.push("─".repeat(24), "");
    else if (block.kind === "pre") {
      // Fenced code keeps its line structure; a faint two-space indent (or
      // plain indent) is the readable terminal mapping.
      for (const line of block.text.split("\n")) lines.push(faint(`  ${line}`));
      lines.push("");
    } else if (block.kind === "list") {
      emitList(block, 0);
      lines.push("");
    } else lines.push(runs(block.runs), "");
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}