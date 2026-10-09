// Mentions (PORCH-037): the member types @Name and the family knows who they
// mean. Identity ids (DIDs) ride the write payload only — they never render,
// never autocomplete, and are never what a member types to find someone.
// Autocomplete keys on the name the family knows each other by, resolved
// against the origin network's membership only (client architecture spec).

/**
 * The mention anchor under the caret, or null.
 * An anchor is a `@` + name-so-far token that starts at the text start or
 * right after whitespace and carries no `@` or newline before the caret.
 * Returned `start` is the caret offset of the `@`; `query` is what the
 * member typed after it (empty string right after typing `@`).
 */
export function mentionAnchor(value, caret = value.length) {
  const before = String(value).slice(0, Math.max(0, Math.min(caret, String(value).length)));
  const match = /(?:^|\s)@([^\n@]*)$/.exec(before);
  if (!match) return null;
  return { start: match.index + match[0].length - match[1].length - 1, query: match[1] };
}

/**
 * Replace the anchor's in-progress token with the picked member's name —
 * the family-facing name exactly as the hub resolved it — and leave the
 * caret after the name + trailing space, ready for the next words.
 */
export function applyMention(value, anchor, name) {
  if (!anchor) return { text: value, caret: null };
  const before = String(value).slice(0, anchor.start);
  const after = String(value).slice(anchor.start + anchor.query.length + 1);
  const token = `@${name} `;
  return { text: `${before}${token}${after}`, caret: anchor.start + token.length };
}

/**
 * The anchor the composer should autocomplete against, or null. A completed
 * pick closes its own autocomplete: once the typed token equals a name the
 * member already chose (trailing space included), the roster stays out of
 * the way until new characters make it a new draft.
 */
export function mentionDraft(anchor, appliedNames = []) {
  if (!anchor) return null;
  const query = anchor.query.trim();
  if (query && appliedNames.some((name) => typeof name === "string" && name.toLowerCase() === query.toLowerCase())) {
    return null;
  }
  return anchor;
}

/**
 * Split reply body into render segments: plain runs and `@`-tokens that
 * exactly match one of the hub-resolved mention names (case-insensitive,
 * at the text start or after whitespace). Unmatched text and unresolvable
 * mentions (a member since gone) render as plain body text — an identity
 * id never reaches this module, so it can never surface.
 *
 * @param {string} body
 * @param {Array<string | null>} names hub-resolved mention names, aligned with the comment's mentions
 * @returns {Array<{ text: string, mention: string | null }>}
 */
export function mentionSegments(body, names = []) {
  const text = String(body ?? "");
  const list = [...new Set((Array.isArray(names) ? names : []).filter((entry) => typeof entry === "string" && entry))]
    .sort((a, b) => b.length - a.length);
  if (!text || !list.length) return text ? [{ text, mention: null }] : [];
  const escaped = list.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?:^|(?<=\\s))@(${escaped.join("|")})`, "gi");
  const segments = [];
  let last = 0;
  let match;
  while ((match = pattern.exec(text))) {
    const canonical = list.find((name) => name.toLowerCase() === match[1].toLowerCase());
    if (match.index > last) segments.push({ text: text.slice(last, match.index), mention: null });
    segments.push({ text: match[0], mention: canonical });
    last = match.index + match[0].length;
  }
  const rest = text.slice(last);
  if (rest) segments.push({ text: rest, mention: null });
  return segments;
}