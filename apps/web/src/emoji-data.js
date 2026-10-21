// Unicode emoji catalog for the reaction picker (PORCH-036). The picker is
// bespoke by documented ruling — MUI is the component library of record and
// composed for everything else, but no MUI emoji-picking primitive exists,
// so the picker assembles MUI primitives over this catalog. The dataset is
// the full Unicode emoji set (unicode-emoji-json, MIT): open vocabulary by
// construction — every emoji the member prefers is selectable, and no
// hub-defined emoji set or reaction-asset id ever enters the client.
import emojiJson from "unicode-emoji-json/data-by-group.json" with { type: "json" };

export const EMOJI_CATEGORIES = emojiJson
  .filter((group) => group.slug !== "components")
  .map((group) => ({
    slug: group.slug,
    label: group.name,
    emojis: group.emojis.map((row) => ({ emoji: row.emoji, name: row.name, slug: row.slug })),
  }));

/**
 * Search aliases (PORCH-120): the way members NAME an emoji is wider than
 * its Unicode name, and a name-less hunt is how 💯 went "missing" — the
 * member searched "100" and the catalog answered nothing. Aliases extend
 * the search vocabulary only; they never narrow or reorder the catalog
 * (open vocabulary carries untouched) and never invent emoji that are not
 * shipped.
 */
const SEARCH_ALIASES = new Map([
  ["💯", ["100", "perfect score", "score"]],
]);

/** Every emoji exactly once, indexable by its glyph. */
const ROW_BY_EMOJI = new Map(
  EMOJI_CATEGORIES.flatMap((group) => group.emojis).map((row) => [row.emoji, row]),
);

/**
 * The catalog row for one emoji glyph (used by the Frequently Used tab to
 * render usage entries with the same names and grid treatment as category
 * tabs). A glyph that has left the shipped catalog still renders — the
 * tab never drops a remembered emoji — carrying the glyph itself as its
 * fallback name.
 */
export function emojiRowOf(emoji, fallback = null) {
  return ROW_BY_EMOJI.get(emoji) ?? fallback ?? { emoji, name: emoji, slug: "" };
}

const tokens = (query) =>
  String(query || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Does one emoji's search vocabulary match one query token? */
function termMatches(row, term) {
  if (row.name.includes(term) || row.slug.includes(term)) return true;
  return SEARCH_ALIASES.get(row.emoji)?.some((alias) => alias.includes(term)) ?? false;
}

/**
 * Search the open-vocabulary catalog for humans: every whitespace-separated
 * term must appear in an emoji's name, slug, or search alias. An empty
 * query matches everything — browse mode over the whole catalog.
 */
export function searchEmojis(query, emojis = EMOJI_CATEGORIES.flatMap((group) => group.emojis)) {
  const terms = tokens(query);
  if (!terms.length) return emojis;
  return emojis.filter((row) => terms.every((term) => termMatches(row, term)));
}