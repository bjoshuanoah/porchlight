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

const tokens = (query) =>
  String(query || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Search the open-vocabulary catalog for humans: every whitespace-separated
 * term must appear in an emoji's name or slug. An empty query matches
 * everything — browse mode over the whole catalog.
 */
export function searchEmojis(query, emojis = EMOJI_CATEGORIES.flatMap((group) => group.emojis)) {
  const terms = tokens(query);
  if (!terms.length) return emojis;
  return emojis.filter((row) =>
    terms.every((term) => row.name.includes(term) || row.slug.includes(term)),
  );
}