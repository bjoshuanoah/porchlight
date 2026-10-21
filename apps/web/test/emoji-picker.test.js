import { test } from "node:test";
import assert from "node:assert/strict";
import { EMOJI_CATEGORIES, searchEmojis } from "../src/emoji-data.js";

test("ac-1: the emoji catalog is organized into browsable categories", () => {
  assert.ok(EMOJI_CATEGORIES.length >= 9, `expected the full Unicode category set, got ${EMOJI_CATEGORIES.length}`);
  const everyEmoji = new Set();
  for (const group of EMOJI_CATEGORIES) {
    assert.ok(group.slug && group.label, "every category carries a slug and a human label");
    assert.ok(group.emojis.length >= 20, `category ${group.label} is browsable, not a stub`);
    for (const row of group.emojis) {
      assert.ok(row.emoji && row.name && row.slug, `every row of ${group.label} has emoji, name, slug`);
      everyEmoji.add(row.emoji);
    }
  }
  // No emoji renders twice: the catalog is one coherent list, not a union of sets.
  assert.equal([...everyEmoji].length, EMOJI_CATEGORIES.reduce((n, group) => n + group.emojis.length, 0));
});

test("ac-1: searchEmojis matches names and slugs across the whole catalog", () => {
  const hearts = searchEmojis("heart");
  assert.ok(hearts.some((row) => row.slug === "red_heart"), 'searching "heart" finds the heart');
  // Multi-term searches must match every term.
  const heartsSun = searchEmojis("heart sun");
  assert.equal(heartsSun.length, 0);
  const sunWithRays = searchEmojis("sun with");
  assert.ok(sunWithRays.some((row) => row.slug === "sun_with_face"));
  // Slug forms reach emoji whose names differ.
  assert.ok(searchEmojis("e_mail").some((row) => row.slug === "e_mail"));
  // Gibberish finds nothing; an empty query browses everything.
  assert.equal(searchEmojis("zzzzqqqq").length, 0);
  assert.equal(searchEmojis("").length, searchEmojis("   ").length);
  assert.equal(searchEmojis("").length, EMOJI_CATEGORIES.reduce((n, group) => n + group.emojis.length, 0));
});

test("ac-2: the catalog is open vocabulary — every Unicode emoji is offered", () => {
  const total = EMOJI_CATEGORIES.reduce((n, group) => n + group.emojis.length, 0);
  assert.ok(total >= 1000, `open vocabulary means the full set is offered, got ${total}`);
});

// ---------------------------------------------------------------------------
// PORCH-120 (Brian, Oct 21 2026): the catalog coverage pin. A pinned
// representative set (💯 back among them) asserts presence and
// search-resolution in the SHIPPED catalog, so a catalog or dependency
// update cannot silently drop a member's emoji again — the pin fails
// loudly on absence. The pin guards the shipped catalog's members and
// size; it never narrows the offered set (open vocabulary carries).
// ---------------------------------------------------------------------------

const REPRESENTATIVES = [
  // [glyph, expected slug, a term that must resolve it through search]
  ["💯", "hundred_points", "100"], // the reported drop (Brian's favorite)
  ["💯", "hundred_points", "hundred"],
  ["💯", "hundred_points", "perfect"],
  ["❤️", "red_heart", "heart"],
  ["🙂", "slightly_smiling_face", "slightly"],
  ["👍", "thumbs_up", "thumbs"],
  ["😂", "face_with_tears_of_joy", "tears"],
  ["🎉", "party_popper", "party"],
  ["✨", "sparkles", "sparkle"],
  ["🌞", "sun_with_face", "sun"],
];

test("ac-4: every pinned representative renders — presence in the shipped catalog", () => {
  const all = EMOJI_CATEGORIES.flatMap((group) => group.emojis);
  for (const [glyph, slug] of REPRESENTATIVES) {
    const hit = all.find((row) => row.emoji === glyph);
    assert.ok(hit, `pinned emoji missing from the shipped catalog: ${glyph} (${slug})`);
    assert.equal(hit.slug, slug, `pinned emoji ${glyph} carries its expected slug ${slug}, got ${hit.slug}`);
    assert.ok(hit.name.length > 0, `pinned emoji ${glyph} carries a searchable name`);
  }
});

test("ac-4: 💯 renders in its category and resolves through search (the reported drop)", () => {
  const smileys = EMOJI_CATEGORIES.find((group) => group.slug === "smileys_emotion");
  assert.ok(smileys, "the smileys & emotion category ships");
  assert.ok(smileys.emojis.some((row) => row.emoji === "💯"), "💯 renders in its category — the regression does not return");
  for (const term of ["100", "hundred", "perfect score"]) {
    const hits = searchEmojis(term);
    assert.ok(
      hits.some((row) => row.emoji === "💯"),
      `searching "${term}" resolves 💯 — a name the member types can never fail again`,
    );
  }
  // The alias extends search only; it narrows nothing, adds nothing.
  assert.equal(searchEmojis("").length, EMOJI_CATEGORIES.reduce((n, group) => n + group.emojis.length, 0));
});

test("ac-4: every pinned representative resolves through search", () => {
  for (const [glyph, , term] of REPRESENTATIVES) {
    const hits = searchEmojis(term);
    assert.ok(
      hits.some((row) => row.emoji === glyph),
      `searching "${term}" must resolve ${glyph}`,
    );
  }
});

test("ac-4: the full Unicode catalog stands — open vocabulary is never narrowed", () => {
  const total = EMOJI_CATEGORIES.reduce((n, group) => n + group.emojis.length, 0);
  assert.ok(total >= 1914, `the shipped catalog keeps its full breadth (1914 as shipped), got ${total}`);
  assert.equal(EMOJI_CATEGORIES.length, 9, "the nine Unicode category tabs ride");
});