// Comment reactions (PORCH-101, Brian Oct 16 2026): every rendered comment
// row — the timeline card slice and the post-detail conversation column —
// carries the SAME reaction affordance class as the post bar: the smile
// control opening the picker (PORCH-036, open vocabulary) plus the row's
// rendered chips; the toggle, the derived PEOPLE count, and the who-reacted
// reveal ride the comment-subject signed contract PORCH-098 serves; live
// comment-subject arrivals merge into that row's chips in place; tombstones
// and restores follow the lifecycle cascade. Rows render as today's DOM:
// the surfaces are swept with the REAL MUI (the house sweep shape) and the
// pure contracts (write shape, live merge, restore preservation) are pinned
// on source and unit level.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { build } from "esbuild";
import React from "react";
import { renderToString } from "react-dom/server";

import { applyEvent } from "../src/live.js";
import { applyCommentEditedRow } from "../src/lifecycle.js";
import { reactionChips } from "../src/reactions.js";
import { identityOf } from "../src/feed-filter.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const socialSource = await readFile(join(webRoot, "src", "social.jsx"), "utf8");
const memberActions = await readFile(join(webRoot, "src", "member-actions.js"), "utf8");
const mainSource = await readFile(join(webRoot, "src", "main.jsx"), "utf8");

// The rendered sweep: the comment surfaces plus the shared bar bundled and
// rendered server-side with real MUI, exactly the DOM the member gets.
const outDir = join(here, ".tmp101");
let surfacesModule = null;
async function surfaces() {
  if (surfacesModule) return surfacesModule;
  await mkdir(outDir, { recursive: true });
  await build({
    stdin: { contents: 'export { PresentReactions, ReplyThread, ReplySliceBlock } from "./src/social.jsx";', resolveDir: webRoot, loader: "jsx", sourcefile: "entry.jsx" },
    bundle: true, format: "esm", jsx: "automatic", platform: "neutral",
    external: ["react", "react-dom", "@mui/*", "@emotion/*", "@noble/*", "socket.io-client", "unicode-emoji-json", "react-transition-group", "hoist-non-react-statics"],
    outfile: join(outDir, "comment-chips.built.mjs"), logLevel: "silent",
  });
  surfacesModule = await import(join(outDir, "comment-chips.built.mjs"));
  return surfacesModule;
}
after(async () => { await rm(outDir, { recursive: true, force: true }); });

const ME = "did:porch:me";
const data = { identity: { id: ME, name: "You" }, server: { url: "https://hub" }, network: { name: "Home" }, members: [] };
const post = { _id: "p1", origin: "https://hub", originNetworkId: "net1", reactionRows: [{ emoji: "🌻", memberDid: "did:porch:linda", _id: "rP", createdAt: "2026-10-18T10:00:00Z" }] };

const LINDA = { emoji: "🍂", memberDid: "did:porch:linda", memberName: "Linda", memberAvatar: null, _id: "r1", createdAt: "2026-10-18T10:01:00Z" };
const OWN = { emoji: "🍂", memberDid: ME, memberName: "You", memberAvatar: null, _id: "r2", createdAt: "2026-10-18T10:02:00Z" };
const SOLO = { emoji: "🌞", memberDid: "did:porch:cass", memberName: "Cass", memberAvatar: null, _id: "r3", createdAt: "2026-10-18T10:03:00Z" };
const comment = { _id: "c1", postId: "p1", parentId: null, authorDid: "did:porch:linda", authorName: "Linda", body: "the comment", createdAt: "2026-10-18T10:00:30Z", reactionRows: [LINDA, OWN, SOLO] };

const ts = (minute) => `2026-10-18T10:${String(minute).padStart(2, "0")}:00Z`;

// ---------- ac-1: the bar rides every rendered comment row, both surfaces ----------

test("ac-1: the card slice row renders the smile control and its chips — the shared bar family", async () => {
  const { ReplySliceBlock } = await surfaces();
  const html = renderToString(React.createElement(ReplySliceBlock, {
    post,
    slice: { total: 1, replies: [comment] },
    data, actions: {}, offline: false, origin: "https://hub", onReply: () => {}, navigate: null,
  }));
  assert.match(html, /aria-label="Add a reaction"/, "every rendered comment row carries the smile control opening the picker");
  assert.match(html, /aria-pressed="true"/, "the member's joined chip renders as a toggle");
  assert.match(html, /Reaction /, "the row's reaction chips render beside the row");
  assert.match(socialSource, /<PresentReactions post=\{post\} comment=\{reply\} data=\{data\} actions=\{actions\} spacingY=\{1\}\s*\n\s*actionRow=\{<>/,
    "the card slice row mounts the SHARED bar with the row's Reply action in the same section — no second implementation");
  // Brian's Oct 19 ruling: the smile control rides the SAME section as
  // Reply and the "···" overflow menu, and the dashed circle is gone —
  // compact like the row's own buttons (32, matching CommentOverflow).
  const smileAt = html.indexOf('aria-label="Add a reaction"');
  const replyAction = html.indexOf('>Reply</');
  assert.ok(replyAction > -1 && smileAt > replyAction, "the smile control renders in the Reply action section, not a detached row");
  assert.match(html, /aria-label="Add a reaction"[\s\S]*?aria-label="Reactions from your family"/, "the row's chips render quiet in the line below the action section");
  assert.match(socialSource, /actionRow \|\| comment\s*\? \{ width: 32, height: 32, p: 0, color: 'text\.secondary'/, "the comment smile control is compact — the oversized dashed circle is gone");
});

test("ac-1: the detail column row renders the same shared bar", async () => {
  const { ReplyThread } = await surfaces();
  const html = renderToString(React.createElement(ReplyThread, {
    comments: [comment], post, data, actions: {}, navigate: null,
  }));
  assert.match(html, /aria-label="Add a reaction"/, "the conversation column row carries the smile control");
  assert.match(html, /aria-pressed="true"/, "the joined chip renders on the detail column too");
  // Brian's Oct 19 ruling: the smile control rides the SAME section as the
  // row's Reply action (compact, dashed circle gone); the chips render in
  // the quiet line below.
  const smileAt = html.indexOf('aria-label="Add a reaction"');
  const replyAction = html.indexOf('>Reply</');
  assert.ok(replyAction > -1 && smileAt > replyAction, "the detail column row carries the smile control in the Reply action section");
  assert.match(html, /aria-label="Add a reaction"[\s\S]*?aria-label="Reactions from your family"/, "the detail column row's chips render in the line below");
  // The bar mounts inside the Reply row component — one mount site, keyed by
  // the row's identity (the ReplyThread render keys rows by identityOf).
  const replyBody = socialSource.slice(socialSource.indexOf("function Reply("));
  assert.match(replyBody, /PresentReactions post=\{post\} comment=\{reply\}/,
    "the detail column row mounts the shared bar keyed by comment id");
});

// ---------- ac-2: toggle, people count, and the who-reacted reveal ----------

test("ac-2: a comment chip renders the derived people count where more than one member holds the emoji", async () => {
  const { PresentReactions } = await surfaces();
  const html = renderToString(React.createElement(PresentReactions, { post, comment, data, actions: {} }));
  assert.match(html, /aria-label="Reaction 🍂, 2 people"/, "two reactors count two people, derived at render");
  assert.match(html, /aria-label="Reaction 🌞"/, "the single-reactor chip renders bare — never a 1");
  for (const row of comment.reactionRows) {
    assert.equal(Object.keys(row).some((key) => /count/i.test(key)), false, `row ${row._id} carries no count field`);
  }
});

test("ac-2: the toggle writes the comment-subject signed payload; the leave clears only the own row on THAT comment", () => {
  assert.match(socialSource, /invoke\(actions, isOwn \? 'unreactComment' : 'reactComment', post, comment, emoji\)/,
    "comment rows sign the comment-subject write through the comment actions");
  assert.match(socialSource, /invoke\(actions, isOwn \? 'unreact' : 'react', post, emoji\)/,
    "post rows keep the shipped write — one contract, one reflection routine, two subjects");
  assert.match(memberActions, /publishCommentReaction[\s\S]*?subjectType: "comment"[\s\S]*?commentId: comment\._id \|\| comment\.id/,
    "the add payload declares the comment subject");
  assert.match(memberActions, /unpublishCommentReaction[\s\S]*?subjectType: "comment"[\s\S]*?commentId: comment\._id \|\| comment\.id/,
    "the leave payload declares the same subject");
  assert.match(memberActions, /social\/posts\/\$\{encodeURIComponent\(post\._id \|\| post\.id\)\}\/reactions/,
    "the comment write rides the SAME signed reaction route");
  assert.match(mainSource, /reactComment: async \(post, comment, emoji\) => publishCommentReaction\(connectionForPost\(post\), post, comment, emoji\)/,
    "the action writes at the post's origin connection");
});

test("ac-2: picker-added and chip-added rows are indistinguishable — one reflection routine", () => {
  const chips = reactionChips([LINDA, OWN, SOLO]);
  assert.deepEqual(chips.map((chip) => chip.emoji), ["🍂", "🌞"]);
  assert.deepEqual(chips[0].reactors.map((row) => row.memberDid), [LINDA.memberDid, OWN.memberDid],
    "the reveal and the count read the same per-member rows the picker writes");
});

// ---------- ac-3: live merge, tombstone, and restore ----------

const envelopeFor = (content) => ({
  type: "reaction.applied", postId: "p1", networkId: "net1", seq: 9, content,
});
const commentArrival = envelopeFor({
  _id: "r9", memberDid: "did:porch:meg", memberName: "Meg", emoji: "🎉", createdAt: ts(9),
  subjectType: "comment", commentId: "c1", postId: null,
});
const river = () => [{ ...post, replySlice: [{ ...comment }] }];

test("ac-3: a comment-subject arrival merges into THAT row's chips in place — never the post's", () => {
  const merged = applyEvent(river(), commentArrival, {});
  assert.notEqual(merged, river(), "a changed merge is a copy-on-write splice");
  const card = merged[0];
  assert.deepEqual(card.reactionRows, post.reactionRows, "the post's chips never carry a comment-subject row");
  const row = card.replySlice.find((entry) => identityOf(entry) === "c1");
  assert.deepEqual(row.reactionRows.filter((entry) => entry.emoji === "🎉").map((entry) => entry.memberDid),
    ["did:porch:meg"], "the arrival rides the comment's own row");
});

test("ac-3: replays dedupe and a foreign comment id is a no-op — the merge never invents rows", () => {
  const base = river();
  const once = applyEvent(base, commentArrival, {});
  const twice = applyEvent(once, commentArrival, {});
  assert.equal(twice, once, "a replayed arrival (own echo, catch-up) re-renders nothing");
  const foreign = applyEvent(base, envelopeFor({ ...commentArrival.content, commentId: "c-absent" }), {});
  assert.equal(foreign, base, "a comment the card does not render resolves as no-op; the read carries it");
});

test("ac-3: post-subject arrivals keep the shipped post-chip merge", () => {
  const merged = applyEvent(river(), envelopeFor({ _id: "r10", memberDid: "did:porch:meg", emoji: "🍂", createdAt: ts(10) }), {});
  assert.equal(merged[0].reactionRows.length, 2, "the post row takes the post-subject row");
  assert.equal(merged[0].replySlice[0].reactionRows.length, 3, "the comment row stays untouched");
});

test("ac-3: a deleted comment's row — and its chips — leave live with the cascade event", () => {
  const merged = applyEvent(river(), {
    type: "comment.deleted", postId: "p1", networkId: "net1", seq: 11,
    content: { rootId: "c1", cascadeIds: [] },
  }, {});
  assert.notEqual(merged, river());
  assert.equal(merged[0].replySlice.some((entry) => identityOf(entry) === "c1"), false,
    "the row leaves — its chips leave with it, never orphaned");
});

test("ac-3: a comment.updated merge never wipes the row's decorated reactions", () => {
  const edited = applyCommentEditedRow(river(), {
    postId: "p1", networkId: "net1",
    // The served comment view's additive empty default (PORCH-098's
    // commentView): an edit or a restore event never carries authoritative
    // rows, so the merge keeps the row's decorated rows in place.
    comment: { _id: "c1", body: "edited body", reactionRows: [] },
  });
  const row = edited[0].replySlice.find((entry) => identityOf(entry) === "c1");
  assert.equal(row.body, "edited body", "the edit lands in place");
  assert.deepEqual(row.reactionRows, [LINDA, OWN, SOLO],
    "a restored comment's captured rows survive until the read that decorates them");
  const undecorated = applyCommentEditedRow(river(), {
    postId: "p1", networkId: "net1", comment: { _id: "c1", body: "edited again" },
  });
  const kept = undecorated[0].replySlice.find((entry) => identityOf(entry) === "c1");
  assert.deepEqual(kept.reactionRows, [LINDA, OWN, SOLO], "a payload without rows keeps the row's rows");
});

// ---------- ac-4: containment, vote defer, and the guardrail sweep ----------

test("ac-4: a foreign-origin arrival never merges anywhere", () => {
  const base = river();
  const foreignOrigin = applyEvent(base, { ...commentArrival, networkId: "net2" }, {});
  assert.equal(foreignOrigin, base, "origin containment gates the live merge like the reads");
});

test("ac-4: comment rows carry no vote affordance — the Oct 15 defer stands", () => {
  const replyBody = socialSource.slice(socialSource.indexOf("function Reply("), socialSource.indexOf("export function PostDetail"));
  const sliceBody = socialSource.slice(socialSource.indexOf("export function ReplySliceBlock"), socialSource.indexOf("export function ReplyThread"));
  for (const [name, body] of [["the detail column row", replyBody], ["the card slice row", sliceBody]]) {
    assert.doesNotMatch(body, /voteButton|invoke\(actions, 'vote'|ArrowUpward|ArrowDownward/,
      `${name} renders no vote affordance of any kind`);
  }
});

test("ac-4: no engagement language anywhere in the bar family — the people count is the only number", () => {
  const barBody = socialSource.slice(socialSource.indexOf("export function PresentReactions"), socialSource.indexOf("export function PostCard"));
  assert.doesNotMatch(barBody, /Trending|Popular|Like count|Reaction count|followers/i,
    "no engagement vocabulary enters the bar family's copy");
  assert.match(barBody, /people`/, "the chip's aria copy names PEOPLE — the ruled count class");
});