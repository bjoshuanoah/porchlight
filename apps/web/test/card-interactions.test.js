// Card-level react and reply (PORCH-038): the timeline card carries quiet
// react and reply affordances; both write into the post's own origin
// conversation through the same routing and the same reflection routine the
// post detail uses, and no engagement count exists anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reactionRowsOf, ownEmojiRows, reflectReaction } from "../src/reactions.js";
import { connectionForPostOrigin } from "../src/api.js";

const ME = "did:porch:me";
const SIB = "did:porch:sister";
const own = (rows) => ownEmojiRows(rows, ME);

test("ac-2: the reaction loader yields only real emoji rows to the surfaces", () => {
  assert.deepEqual(reactionRowsOf([
    { emoji: "🌻", memberDid: ME, _id: "r1" },
    { memberDid: SIB, _id: "r2" },
    "noise",
  ]), [{ emoji: "🌻", memberDid: ME, _id: "r1" }]);
  assert.deepEqual(reactionRowsOf(null), []);
  assert.deepEqual(reactionRowsOf({ reactions: [] }), []);
});

test("ac-2: a reaction added from the card reflects on the card as the member's own", () => {
  const rows = reflectReaction([{ emoji: "🌻", memberDid: SIB, _id: "r1" }], {
    emoji: "🍂", ownDid: ME, isOwn: false, reaction: { _id: "r9", createdAt: "2026-10-09T12:00:00Z" },
  });
  assert.deepEqual(own(rows), new Set(["🍂"]));
  // The rendered surface dedupes emoji VALUES from per-member rows: no
  // count, no who-reacted inspection surface, ever.
  const rendered = [...new Set(rows.map((row) => row.emoji))];
  assert.deepEqual(rendered, ["🌻", "🍂"]);
});

test("ac-2: tapping an own reaction clears only that row", () => {
  const base = [
    { emoji: "🍂", memberDid: ME, _id: "r9" },
    { emoji: "🍂", memberDid: SIB, _id: "r1" },
    { emoji: "🌻", memberDid: SIB, _id: "r2" },
  ];
  const rows = reflectReaction(base, { emoji: "🍂", ownDid: ME, isOwn: true });
  assert.deepEqual(rows, [
    // The sister's identical emoji survives an own-row clear: reactions
    // render as given, per member, never as an aggregate.
    { emoji: "🍂", memberDid: SIB, _id: "r1" },
    { emoji: "🌻", memberDid: SIB, _id: "r2" },
  ]);
  assert.deepEqual(own(rows), new Set());
});

test("ac-2/3: re-adding an own reaction is idempotent — no duplicates, no count inflation", () => {
  const base = [{ emoji: "🍂", memberDid: ME, _id: "r9" }];
  const rows = reflectReaction(base, { emoji: "🍂", ownDid: ME, isOwn: false, reaction: { _id: "r10" } });
  assert.equal(rows, base);
  assert.equal(rows.length, 1);
});

test("ac-3: one reflection routine serves card and detail — the same rows render on both", () => {
  // The card's local state and the detail's state derive from the same
  // origin conversation rows (actions.loadReactions) and pass through the
  // same reflectReaction; the routine only ever touches the member's own
  // rows and preserves every other member's row intact, so the two surfaces
  // can never diverge.
  const loaded = [
    { emoji: "🍂", memberDid: ME, _id: "r9" },
    { emoji: "🌻", memberDid: SIB, _id: "r2" },
  ];
  const cardRows = reflectReaction(reactionRowsOf(loaded), { emoji: "🪑", ownDid: ME, isOwn: false });
  const detailRows = reflectReaction(reactionRowsOf(loaded), { emoji: "🍂", ownDid: ME, isOwn: true });
  assert.deepEqual(cardRows.filter((row) => row.memberDid === SIB), detailRows.filter((row) => row.memberDid === SIB));
  assert.deepEqual([...own(cardRows)].sort(), ["🍂", "🪑"]);
  assert.deepEqual([...own(detailRows)], []);
  // A cleared reflection of the detail surface leaves the card's rows
  // untouched — each reflect call owns its own copy, no shared mutation.
  assert.equal(loaded[0].emoji, "🍂");
});

test("ac-4: a card reply or reaction rides the connection owning the post's origin", () => {
  const home = { url: "https://family.example", token: "home" };
  const cousins = { url: "https://cousins.example", token: "cousins" };
  const post = { _id: "p1", origin: "https://cousins.example" };
  assert.equal(connectionForPostOrigin(post, [home, cousins], home), cousins);
});

test("ac-4: a group post's card write stays inside the group's origin conversation", () => {
  const home = { url: "https://family.example", token: "home" };
  const cousins = { url: "https://cousins.example", token: "cousins" };
  const groupPost = { _id: "p2", groupId: "g1", groupName: "Lake Weekend", origin: "https://cousins.example" };
  // The group rides the origin, not the active connection: reaction and
  // reply from its card write to the group's own contained conversation.
  assert.equal(connectionForPostOrigin(groupPost, [home, cousins], home), cousins);
});

test("ac-4: a post without a live connection falls back to the active connection", () => {
  const home = { url: "https://family.example", token: "home" };
  const orphan = { _id: "p3", origin: "https://elsewhere.example" };
  assert.equal(connectionForPostOrigin(orphan, [home], home), home);
  // No origin at all (current-hub post) resolves to the active connection,
  // the same target the detail surface writes through.
  assert.equal(connectionForPostOrigin({ _id: "p4" }, [home], home), home);
  assert.equal(connectionForPostOrigin(null, [home], home), home);
});

test("ac-4: an unparsable connection URL never wins and never throws", () => {
  const home = { url: "https://family.example", token: "home" };
  const broken = { url: "not a url", token: "x" };
  const post = { _id: "p5", origin: "https://family.example" };
  assert.equal(connectionForPostOrigin(post, [broken, home], home), home);
  assert.equal(connectionForPostOrigin(post, [broken], home), home);
});