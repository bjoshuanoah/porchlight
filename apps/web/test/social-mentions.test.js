// Mention handling (PORCH-037): the member types @Name, the roster is
// origin-membership resolved, and no identity id ever renders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mentionAnchor, mentionDraft, applyMention, mentionSegments } from "../src/mentions.js";

test("ac-1: typing @ opens an autocomplete anchored on the name being typed", () => {
  assert.deepEqual(mentionAnchor("Thanks @Jun", 11), { start: 7, query: "Jun" });
  assert.deepEqual(mentionAnchor("@", 1), { start: 0, query: "" });
  assert.deepEqual(mentionAnchor("hey @", 5), { start: 4, query: "" });
  // Multi-word family names stay inside one anchor while typing.
  assert.deepEqual(mentionAnchor("@June Bell", 10), { start: 0, query: "June Bell" });
  assert.deepEqual(mentionAnchor("a @June Be", 10), { start: 2, query: "June Be" });
});

test("ac-1: ordinary text never anchors a mention autocomplete", () => {
  assert.equal(mentionAnchor("email me at home", 0), null);
  assert.deepEqual(mentionAnchor("@June is here, and", 18), { start: 0, query: "June is here, and" });
  assert.equal(mentionAnchor("", 0), null);
  assert.equal(mentionAnchor("thanks @June\nnew line", 13), null, "a newline ends the anchor");
  assert.equal(mentionAnchor("thanks @@June", 13), null, "a second @ breaks the anchor");
});

test("ac-1: a completed pick closes its own autocomplete until new typing", () => {
  // A token equal to a picked name is closed, trailing space included;
  // more characters make it a new draft and reopen the roster.
  assert.equal(mentionDraft(mentionAnchor("Thanks @June Bell ", 18), ["June Bell"]), null);
  assert.deepEqual(mentionDraft(mentionAnchor("Thanks @June Bell S", 19), ["June Bell"]), { start: 7, query: "June Bell S" });
  assert.deepEqual(mentionDraft(mentionAnchor("hey @", 5), ["June Bell"]), { start: 4, query: "" });
  assert.equal(mentionDraft(null, ["June Bell"]), null);
});

test("ac-2: picking a member inserts the family-facing name, never an id", () => {
  const anchor = mentionAnchor("Thanks @Jun", 11);
  const applied = applyMention("Thanks @Jun", anchor, "June Bell");
  assert.equal(applied.text, "Thanks @June Bell ");
  assert.equal(applied.caret, "Thanks @June Bell".length + 1);
  // The inserted text carries the name only — a DID never enters the draft.
  assert.equal(applied.text.includes("did:"), false);
  assert.equal(applyMention("Thanks @", mentionAnchor("Thanks @", 8), "Meg Rivers").text, "Thanks @Meg Rivers ");
});

test("ac-2: mentions render as the member's name; ids cannot surface", () => {
  const body = "Thanks @June Bell and @Meg Rivers for lunch";
  const segments = mentionSegments(body, ["June Bell", "Meg Rivers"]);
  assert.deepEqual(
    segments.map((segment) => ({ text: segment.text, mention: segment.mention })),
    [
      { text: "Thanks ", mention: null },
      { text: "@June Bell", mention: "June Bell" },
      { text: " and ", mention: null },
      { text: "@Meg Rivers", mention: "Meg Rivers" },
      { text: " for lunch", mention: null },
    ],
  );
  const rendered = segments.map((segment) => segment.text).join("");
  assert.equal(rendered, body);
  assert.equal(rendered.includes("did:"), false);
});

test("ac-2: partial and unmatched tokens render plain, never as fabricated members", () => {
  // A half-typed token is not a member yet: it highlights nothing.
  assert.deepEqual(mentionSegments("hey @Jun", ["June Bell"]), [
    { text: "hey @Jun", mention: null },
  ]);
  // An unresolved mention (member gone, name null at the hub) renders the
  // plain body — no id in, no id out.
  assert.deepEqual(mentionSegments("missing @June Bell here", [null]), [
    { text: "missing @June Bell here", mention: null },
  ]);
  assert.deepEqual(mentionSegments("@june bell waves", ["June Bell"]), [
    { text: "@june bell", mention: "June Bell" },
    { text: " waves", mention: null },
  ], "matching is case-insensitive");
  assert.deepEqual(mentionSegments("nothing to see here", ["June Bell"]), [
    { text: "nothing to see here", mention: null },
  ]);
  assert.deepEqual(mentionSegments(null, ["June Bell"]), []);
});