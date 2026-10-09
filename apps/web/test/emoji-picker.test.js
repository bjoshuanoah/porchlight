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