// Link previews (PORCH-052): the PURE client helpers the tests pin —
// compose URL detection, the body segmenter that renders pasted URLs as
// real links (external links open in a new tab, the standing law), and the
// hub-origin lookup for a post's preview image.

/** The first http(s) URL in a body/caption, or null (compose detection). */
export function firstUrlIn(text) {
  const match = /https?:\/\/[^\s<>"')\]]+/.exec(String(text ?? ""));
  return match ? match[0] : null;
}

/**
 * Body render segments: plain runs and http(s) URLs. Pure helper so the
 * surface renders target=_blank anchor segments and tests pin the split.
 */
export function linkSegments(text) {
  const value = String(text ?? "");
  if (!value) return [];
  const pattern = /https?:\/\/[^\s<>"')\]]+/g;
  const segments = [];
  let last = 0;
  let match;
  while ((match = pattern.exec(value))) {
    if (match.index > last) segments.push({ text: value.slice(last, match.index), url: null });
    segments.push({ text: match[0], url: match[0] });
    last = match.index + match[0].length;
  }
  const rest = value.slice(last);
  if (rest) segments.push({ text: rest, url: null });
  return segments;
}

/** The hub origin a post's preview image loads from (its own origin only). */
export function previewOrigin(post, data = {}) {
  return post?.origin ?? data?.server?.url ?? null;
}