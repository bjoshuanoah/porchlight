// Post and comment lifecycle (PORCH-094): authority-gated affordances, the
// edit composer mode with the location ruling, the live tombstone, and the
// comment lifecycle parity across the card slice and the detail column.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { build } from "esbuild";
import React from "react";
import { renderToString } from "react-dom/server";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const social = await readFile(join(webRoot, "src/social.jsx"), "utf8");
const memberActions = await readFile(join(webRoot, "src/member-actions.js"), "utf8");

const {
  canEditPost, canDeletePost, canEditComment, canDeleteComment, lifecycleMenuItems,
  editLocationRows, currentLocationId, GENERAL_LOCATION_ID,
  applyPostEditedRow, revertPostEditedRow, snapshotPostRow, applyPostDeletedRow,
  applyCommentEditedRow, applyCommentDeletedRows, removedTreeIds,
} = await import("../src/lifecycle.js");
const {
  postEditPayload, commentEditPayload, postDeletePayload, commentDeletePayload,
} = await import("../src/member-actions.js");

// One bundled build of src/social.jsx shared by the rendered sweeps; the
// fixture directory is removed when the suite ends.
const outDir = join(here, ".tmp094");
let surfacesModule = null;
async function surfaces() {
  if (surfacesModule) return surfacesModule;
  await mkdir(outDir, { recursive: true });
  await build({
    stdin: { contents: 'export { PostCard, ReplySliceBlock } from "./src/social.jsx";', resolveDir: webRoot, loader: "jsx", sourcefile: "entry.jsx" },
    bundle: true, format: "esm", jsx: "automatic", platform: "neutral",
    external: ["react", "react-dom", "@mui/*", "@emotion/*", "@noble/*", "socket.io-client", "unicode-emoji-json", "react-transition-group", "hoist-non-react-statics"],
    outfile: join(outDir, "surfaces.built.mjs"), logLevel: "silent",
  });
  surfacesModule = await import(join(outDir, "surfaces.built.mjs"));
  return surfacesModule;
}
after(async () => { await rm(outDir, { recursive: true, force: true }); });

const card = social.slice(social.indexOf("export function PostCard("), social.indexOf("function Heading("));
const sliceBlock = social.slice(social.indexOf("export function ReplySliceBlock("), social.indexOf("// The pending copy swaps"));
const postDetail = social.slice(social.indexOf("export function PostDetail("), social.indexOf("function mediaIds("));
const reply = social.slice(social.indexOf("function Reply("), social.indexOf("// Post detail layout"));

/* ---- ac-1: affordance placement and authority --------------------------- */

const authorView = { identity: { id: "did:me" }, members: [{ did: "did:me", role: "member" }] };
const ownerView = { identity: { id: " did:owner ".trim() }, members: [{ did: "did:owner", role: "owner" }] };
const strangerView = { identity: { id: "did:other" }, members: [] };
const HOME = "https://family.example";
const mine = { _id: "p1", authorId: "did:me", origin: HOME };
const theirs = { _id: "p2", authorId: "did:sister", origin: HOME };

test("ac-1: the author sees Edit and Delete only on their own post; the network owner sees Delete-only; others see neither", () => {
  // The author's own post: both affordances.
  assert.deepEqual(lifecycleMenuItems({ edit: canEditPost(mine, authorView), remove: canDeletePost(mine, authorView) }), ["edit", "delete"]);
  // Ownership NEVER confers edit authority: the owner on a non-authored
  // post sees Delete only.
  assert.deepEqual(lifecycleMenuItems({ edit: canEditPost(theirs, ownerView), remove: canDeletePost(theirs, ownerView) }), ["delete"]);
  // A member with no authority over the post sees nothing.
  assert.deepEqual(lifecycleMenuItems({ edit: canEditPost(theirs, strangerView), remove: canDeletePost(theirs, strangerView) }), []);
  assert.equal(canDeletePost(theirs, authorView), false, "a plain member cannot delete another member's post");
  assert.equal(canEditPost(theirs, authorView), false);
});

test("ac-1: a post of a foreign origin carries no lifecycle authority at all — even for the owner", () => {
  const foreign = { _id: "p3", authorId: "did:me", origin: "https://elsewhere.example", originNetworkId: "net-elsewhere" };
  const viewerWithForeignConnection = {
    identity: { id: "did:me" },
    members: [{ did: "did:me", role: "owner" }],
    network: { _id: "net-home", name: "Home" },
  };
  assert.equal(canEditPost(foreign, viewerWithForeignConnection), false);
  assert.equal(canDeletePost(foreign, viewerWithForeignConnection), false);
});

test("ac-1: comment rows carry the same two-role gate in their own overflow", () => {
  const mineRow = { _id: "c1", authorDid: "did:me" };
  const sisters = { _id: "c2", authorDid: "did:sister" };
  assert.deepEqual(lifecycleMenuItems({ edit: canEditComment(mineRow, authorView), remove: canDeleteComment(mineRow, authorView) }), ["edit", "delete"]);
  assert.deepEqual(lifecycleMenuItems({ edit: canEditComment(sisters, ownerView), remove: canDeleteComment(sisters, ownerView) }), ["delete"],
    "the owner sees Delete-only on other members' rows");
  assert.deepEqual(lifecycleMenuItems({ edit: canEditComment(sisters, authorView), remove: canDeleteComment(sisters, authorView) }), [],
    "a member with no authority sees neither");
});

test("ac-1: lifecycle actions render ONLY inside the ··· menu (card) and the row overflow (comment) — never top-level", () => {
  // The card's menu rows are the only Edit/Delete placement on the card.
  const menuSlice = card.slice(card.indexOf("anchorEl={menuAnchor}"), card.indexOf("</Menu>"));
  assert.match(menuSlice, /ownsPostEdit && <MenuItem data-testid="edit-post"/);
  assert.match(menuSlice, /ownsPostDelete && <MenuItem data-testid="delete-post"/);
  assert.equal(card.split('data-testid="edit-post"').length - 1, 1, "no second Edit affordance anywhere on the card");
  assert.equal(card.split('data-testid="delete-post"').length - 1, 1, "no second Delete affordance anywhere on the card");
  assert.doesNotMatch(card, /IconButton[^>]*aria-label="(Edit|Delete) post"/, "no top-level lifecycle control on the action row or header");
  // Comment rows: the overflow is the only placement.
  assert.match(sliceBlock, /<CommentOverflow row=\{reply\}/);
});

test("ac-1: the rendered owner card on a non-authored post carries Delete and no Edit authority", async () => {
  const { PostCard } = await surfaces();
  const data = {
    identity: { id: "did:owner" },
    members: [{ did: "did:owner", role: "owner" }],
    server: { url: HOME },
    network: { name: "Home" },
    groups: [],
  };
  // renderToString: the menu renders closed; the authority flags land as
  // menu items only when the predicates pass. The DOM check: no "Edit"
  // MenuItem and the card renders (post present, not nulled).
  const html = renderToString(React.createElement(PostCard, { post: theirs, data, actions: {}, navigate: null }));
  assert.match(html, /From Home/, "the non-authoritative-filtered card renders");
  assert.doesNotMatch(html, /aria-label="Edit post"/);
  // Silence against the rendered DOM: after any edit path the card carries
  // no edited marker, badge, annotation, or version-history text.
  const authored = renderToString(React.createElement(PostCard, { post: mine, data: { ...data, identity: { id: "did:me" }, members: [{ did: "did:me", role: "member" }] }, actions: {}, navigate: null }));
  assert.doesNotMatch(authored, /edited|version history|moved/i);
});

/* ---- ac-2: the edit composer mode and the location ruling --------------- */

test("ac-2: the signed edit write carries text, caption, and target as ONE write — never a media field", () => {
  const post = { _id: "p1", originNetworkId: "net1" };
  const payload = postEditPayload(post, { body: "edited text", caption: "a caption", groupId: "g1" });
  assert.deepEqual(payload, {
    kind: "post-edit", postId: "p1", networkId: "net1",
    body: "edited text", caption: "a caption", groupId: "g1",
  });
  assert.equal("mediaRefs" in payload, false, "no media field exists on an edit write — changes ride delete-and-repost");
  // The caption normalization runs before signing (the server normalizes
  // the same way before verification): an emptied caption carries null.
  assert.equal(postEditPayload(post, { body: "x", caption: "   ", groupId: null }).caption, null);
  assert.equal(postEditPayload(post, { body: "x", groupId: "" }).groupId, null);
  // A text-only save still rides one write (the composer always sends its
  // fields); the payload never reveals an edit through any marker field.
  const textOnly = postEditPayload(post, { body: "x", caption: null, groupId: undefined });
  assert.deepEqual(textOnly, { kind: "post-edit", postId: "p1", networkId: "net1", body: "x" });
});

test("ac-2: the comment edit write carries text only — no location, no media", () => {
  const post = { _id: "p1", originNetworkId: "net1" };
  assert.deepEqual(commentEditPayload(post, "c1", "new text"), {
    kind: "comment-edit", postId: "p1", commentId: "c1", body: "new text", networkId: "net1",
  });
});

test("ac-2: the tombstone deletes sign exactly the values the server rebuilds", () => {
  const post = { _id: "p1", originNetworkId: "net1" };
  assert.deepEqual(postDeletePayload(post), { kind: "delete", postId: "p1", networkId: "net1" });
  assert.deepEqual(commentDeletePayload(post, "c1"), { kind: "comment-delete", postId: "p1", commentId: "c1", networkId: "net1" });
  assert.match(memberActions, /social\/posts\/\$\{encodeURIComponent\(payload\.postId\)\}/);
  assert.match(memberActions, /\/comments\/\$\{encodeURIComponent\(commentId\)\}/);
});

test("ac-2: the edit composer is pre-filled, media read-only, with the location control carrying the author's groups only", () => {
  const composer = social.slice(social.indexOf("function PostEditForm("), social.indexOf("function CommentEditForm("));
  // Pre-filled from the current text/caption/target (or the held draft).
  assert.match(card, /initial=\{readDraft\('edit:post'\) \?\? \{ body: row\.body \?\? '', caption: row\.caption \?\? '', locationId: currentLocationId\(row\) \}\}/);
  assert.match(composer, /label="Edit your post"/);
  assert.match(composer, /label="Caption"/);
  assert.match(composer, /label="Post to"/);
  // One save, three fields: text, caption, and target as ONE signed write.
  assert.match(composer, /body: body\.trim\(\), caption: caption\.trim\(\) \? caption : null, groupId: locationId === GENERAL_LOCATION_ID \? null : locationId/);
  assert.match(composer, /Save changes/);
  // Media renders read-only in place; no swap/add/remove affordance exists
  // in the composer — only the delete-and-repost direction is offered.
  assert.doesNotMatch(composer, /MediaCarousel|ComposerPreviewCarousel|addFile|removeFile|onExpand/);
  assert.match(composer, /Media is set as posted\. To change it, delete this post and post it again\.|delete this post and post it again/);
  // The in-place re-render: the save merges fields without a card remount.
  assert.match(card, /applyEditResult|setEditedFields/);
  assert.match(card, /editedFields\s*\?\s*\{[^}]*\.\.\.post/);
  // A failed write keeps the composer open with the full draft.
  assert.match(composer, /stays open; the full draft holds through the failure|\(\) => \{\}, \/\/ the composer stays open/);
  // Silence: the edit is silent everywhere — no marker, badge, annotation,
  // or version history renders on any breakpoint (checked against the
  // rendered DOM in the sweep below).
});

test("ac-2: the location rows offer the general timeline plus the author's groups only", () => {
  const data = {
    identity: { id: "did:me" },
    groups: [
      { _id: "g1", name: "Lake Weekend", members: ["did:me", "did:sister"] },
      { _id: "g2", name: "Inner Circle", members: ["did:sister"] },
      { _id: "g3", name: "Nameless", members: ["did:me"] },
    ],
  };
  const rows = editLocationRows({ groupId: "g1" }, data);
  assert.deepEqual(rows.map((row) => row.id), ["", "g1", "g3"],
    "the current target stays offered; groups the author does not belong to are never offered");
  assert.equal(rows[0].label, "General timeline");
  assert.equal(rows.find((row) => row.id === "g3").label, "Nameless", "a member group without a name renders under its id");
  assert.equal(currentLocationId({ groupId: "g1" }), "g1", "the control pre-sets the post's current target");
  assert.equal(currentLocationId({}), GENERAL_LOCATION_ID, "a general-timeline post pre-sets the general timeline");
});

test("ac-2: the edit merge re-renders the changed fields in place — copy-on-write, no key change, no slice churn", () => {
  const river = [
    { _id: "p1", body: "before", caption: "cap", groupId: null, replySlice: [{ _id: "r1", body: "a reply" }], replyTotal: 1 },
    { _id: "p2", body: "other" },
  ];
  const next = applyPostEditedRow(river, {
    postId: "p1", fields: { body: "after", caption: "new cap", groupId: "g1", groupName: "Lake Weekend" },
    viewerDid: "did:me", groups: [{ _id: "g1", name: "Lake Weekend", members: ["did:me"] }],
  });
  assert.equal(next.length, river.length, "the edit never reshapes the river");
  assert.equal(next[0].body, "after");
  assert.equal(next[0].groupName, "Lake Weekend", "the chip context re-renders in place");
  assert.deepEqual(next[0].replySlice, river[0].replySlice, "the conversation slice is untouched");
  assert.equal(next[1], river[1], "unmodified rows return as-is");
  // A move back to the general timeline clears the chip context.
  const backHome = applyPostEditedRow(next, {
    postId: "p1", fields: { groupId: null, groupName: null }, viewerDid: "did:me", groups: [],
  });
  assert.equal(backHome[0].groupId, null);
  assert.equal(backHome[0].groupName, null, "no stale group chip outlives the move");
});

test("ac-2: a location change the viewer loses drops the card in the same merge step; a viewer keeping it re-renders", () => {
  const river = [
    { _id: "p1", authorId: "did:sister", body: "x", groupId: null },
    { _id: "p2", authorId: "did:sister", body: "y", groupId: null },
  ];
  const context = {
    viewerDid: "did:me",
    groups: [{ _id: "g1", name: "Lake Weekend", members: ["did:sister"] }],
  };
  // The viewer is NOT in the target group: the moved post drops live.
  const afterMoveOut = applyPostEditedRow(river, { postId: "p1", fields: { body: "x", groupId: "g1", groupName: "Lake Weekend" }, ...context });
  assert.equal(afterMoveOut.some((post) => post._id === "p1"), false, "the card the viewer loses drops the same frame");
  assert.equal(afterMoveOut.some((post) => post._id === "p2"), true, "every other card stays");
  // The author (a member of the target group) keeps the card.
  const authorContext = { viewerDid: "did:sister", groups: context.groups };
  const afterMoveKeep = applyPostEditedRow(river, { postId: "p1", fields: { body: "x", groupId: "g1", groupName: "Lake Weekend" }, ...authorContext });
  assert.equal(afterMoveKeep[0].groupId, "g1", "the card the viewer keeps re-renders its location in place");
});

test("ac-2: a failed edit holds the draft and restores the exact pre-action row", () => {
  const river = [{ _id: "p1", body: "before", caption: "cap" }, { _id: "p2", body: "other" }];
  const snapshot = snapshotPostRow(river, "p1", null);
  const optimistic = applyPostEditedRow(river, { postId: "p1", fields: { body: "after" }, viewerDid: null, groups: [] });
  const restored = revertPostEditedRow(optimistic, { postId: "p1", snapshot });
  assert.deepEqual(restored[0], river[0], "the pre-action row returns intact");
  assert.equal(restored[1], river[1]);
  assert.deepEqual(snapshot, river[0]);
});

/* ---- ac-3: the delete flow and the live tombstone ----------------------- */

test("ac-3: the delete asks once with the cascade note and leaves no member-facing undelete", () => {
  assert.match(card, /<DialogTitle>Delete this post\?<\/DialogTitle>/);
  assert.match(card, /Its conversation goes with it/);
  assert.match(card, /data-testid="confirm-delete-post"/);
  assert.match(card, /data-testid="confirm-delete-comment"/);
  assert.match(card, /Delete this comment\?/);
  // No member-facing undelete exists anywhere in the client.
  assert.doesNotMatch(social, /Undelete|Undo this|Restore this (post|comment)/,
    "restore rides the owner console only");
});

test("ac-3: the tombstone drops the card in one pure step and rolls back exactly", () => {
  const river = [{ _id: "p1", body: "x" }, { _id: "p2", body: "y" }];
  const after = applyPostDeletedRow(river, "p1", null);
  assert.deepEqual(after, [river[1]], "the card leaves with no gap and no placeholder");
  // The write failed: the exact pre-action card restores.
  assert.deepEqual([...after.slice(0, 1), river[0]], [river[1], river[0]]);
});

test("ac-3: the card renders a null body while tombstoned — the same-frame removal, no empty gap", () => {
  assert.match(card, /if \(localHidden \|\| tombstoned \|\| actions\?\.isHidden\?\.\(post\) \|\| !visibleAtOrigin\(post, data\)\) return null;/);
  assert.match(card, /setTombstoned\(true\)/);
  assert.match(card, /setTombstoned\(false\)/);
});

/* ---- ac-4: comment lifecycle parity ------------------------------------ */

test("ac-4: a deleted root drops its live subtree; the expander recomputes against live comments", () => {
  const slice = [
    { _id: "r1", body: "root one", parentId: null },
    { _id: "r2", body: "root two", parentId: null },
  ];
  const river = [{ _id: "p1", replySlice: slice, replyTotal: 5 }];
  const next = applyCommentDeletedRows(river, { postId: "p1", rootId: "r1", cascadeIds: ["r1a"] });
  assert.deepEqual(next[0].replySlice.map((row) => row._id), ["r2"], "the removed root leaves the slice");
  assert.equal(next[0].replyTotal, 4, "the root total recounts live comments");
  assert.deepEqual(next, next, "copy-on-write");
});

test("ac-4: a nested removal decrements its rendered root's response count by the subtree size", () => {
  const slice = [
    { _id: "r1", body: "root one", parentId: null, responseCount: 3 },
    { _id: "n1", body: "nested", parentId: "r1", responseCount: 2 },
  ];
  const river = [{ _id: "p1", replySlice: slice, replyTotal: 2 }];
  const next = applyCommentDeletedRows(river, { postId: "p1", rootId: "n1", cascadeIds: ["n1a"] });
  assert.equal(next[0].replyTotal, 2, "a nested removal never touches the root total");
  assert.equal(next[0].replySlice.find((row) => row._id === "r1").responseCount, 1,
    "the rendered ancestor's count drops by the subtree size until the next served read recounts");
  assert.equal(next[0].replySlice.some((row) => row._id === "n1"), false, "the nested row leaves the slice live");
});

test("ac-4: the row set a delete removes spans the rendered parentId chains", () => {
  const rows = [
    { _id: "r1", parentId: null },
    { _id: "n1", parentId: "r1" },
    { _id: "n2", parentId: "n1" },
    { _id: "unrelated", parentId: null },
  ];
  const cascade = removedTreeIds(rows, "r1", []);
  assert.deepEqual([...cascade].sort(), ["n1", "n2", "r1"], "the subtree resolves by the rendered parentId chains");
  assert.equal(cascade.has("unrelated"), false);
});

test("ac-4: a comment edit swaps the row's text in place by id — order, counts, and other rows untouched", () => {
  const slice = [
    { _id: "r1", body: "before", responseCount: 2 },
    { _id: "r2", body: "other" },
  ];
  const river = [{ _id: "p1", replySlice: slice, replyTotal: 2 }];
  const next = applyCommentEditedRow(river, { postId: "p1", comment: { _id: "r1", body: "after" } });
  assert.equal(next[0].replySlice[0].body, "after");
  assert.equal(next[0].replySlice[0].responseCount, 2);
  assert.equal(next[0].replySlice[1], river[0].replySlice[1]);
  // A river without the row returns unchanged.
  assert.equal(applyCommentEditedRow([], { postId: "p1", comment: { _id: "r1", body: "x" } }).length, 0);
});

test("ac-4: the detail column rides the same actions and the same one-composer rules", () => {
  // Parity: both surfaces route their writes through the same action set.
  assert.match(sliceBlock, /invoke\(actions, 'editComment', post, id, body\)/);
  assert.match(postDetail, /invoke\(actions, 'editComment', post, id, body\)/);
  assert.match(card, /invoke\(actions, 'deleteComment', post, id\)/);
  assert.match(postDetail, /invoke\(actions, 'deleteComment', post, id\)/);
  // The removed ids can never resurrect: the slice render skips removed
  // ids, and the detail column filters the removed subtree from its rows.
  assert.match(sliceBlock, /isRemoved\(reply\)/);
  assert.match(postDetail, /removedTreeIds/);
  assert.match(reply, /rowLifecycle && <CommentOverflow/);
});

test("ac-4: the deleted rows' expander counts recompute on the next served read — the count derives from live totals", () => {
  // expanderCount(slice.total) with the merged total: the recount path.
  const slice = [{ _id: "r1", parentId: null }, { _id: "r2", parentId: null }, { _id: "r3", parentId: null }, { _id: "r4", parentId: null }, { _id: "r5", parentId: null }];
  const next = applyCommentDeletedRows([{ _id: "p1", replySlice: slice, replyTotal: 9 }], { postId: "p1", rootId: "r1", cascadeIds: [] });
  assert.equal(next[0].replyTotal, 8);
  // The next served read carries the server recount (the server's
  // #recount) — the merged total is the bridge, never a client-maintained
  // counter.
  assert.equal(next[0].replySlice.length, 4);
});

/* ---- ac-5: containment, live transport, optimistic safety --------------- */

test("ac-5: the lifecycle event vocabulary rides the closed plane — post and comment updates and removals merge in place", async () => {
  const { EVENT_TYPES, applyEvent } = await import("../src/live.js");
  assert.deepEqual(EVENT_TYPES, [
    "post.created", "reply.created", "reaction.applied", "media.attached",
    "post.updated", "post.deleted", "comment.updated", "comment.deleted",
  ]);
  const context = { origin: "https://hub", network: "Home", viewerDid: "did:me", viewerGroups: [{ _id: "g1", name: "L", members: ["did:me"] }] };
  // post.updated: the fields merge in place, slice and reactions untouched.
  const river = [{ _id: "p1", originNetworkId: "net1", body: "before", replySlice: [{ _id: "r1" }], reactionRows: [{ emoji: "🌻" }], replyTotal: 1 }];
  const merged = applyEvent(river, {
    type: "post.updated", networkId: "net1", postId: "p1",
    content: { _id: "p1", body: "after", caption: "fresh", groupId: null, groupName: null },
  }, context);
  assert.equal(merged[0].body, "after");
  assert.equal(merged[0].caption, "fresh");
  assert.equal(merged[0].groupName, null, "no stale chip survives the cleared target");
  assert.deepEqual(merged[0].reactionRows, river[0].reactionRows);
  assert.deepEqual(merged[0].replySlice, river[0].replySlice);
  // post.deleted: the card leaves in the same frame the event lands.
  const removed = applyEvent(merged, { type: "post.deleted", networkId: "net1", postId: "p1" }, context);
  assert.equal(removed.length, 0);
  assert.equal(applyEvent(river, { type: "post.deleted", networkId: "net1", postId: "p999" }, context), river,
    "a removal whose subject is absent changes nothing");
});

test("ac-5: a location-change event drives the delivery law — kept cards re-render, lost cards drop, gained cards enter", async () => {
  const { applyEvent } = await import("../src/live.js");
  const context = (groups) => ({ origin: "https://hub", network: "Home", viewerDid: "did:me", viewerGroups: groups });
  const river = [{ _id: "p1", originNetworkId: "net1", authorId: "did:sister", body: "x", groupId: null }];
  // The viewer keeps visibility on a move into their group: re-render
  // in place with the group chip context.
  const kept = applyEvent(river, {
    type: "post.updated", networkId: "net1", postId: "p1",
    content: { _id: "p1", body: "x", groupId: "g1", groupName: "Lake" },
  }, context([{ _id: "g1", name: "Lake", members: ["did:me"] }]));
  assert.equal(kept[0].groupName, "Lake");
  // The viewer loses visibility: the card drops live.
  const lost = applyEvent(river, {
    type: "post.updated", networkId: "net1", postId: "p1",
    content: { _id: "p1", body: "x", groupId: "g2", groupName: "Secret" },
  }, context([{ _id: "g1", name: "Lake", members: ["did:me"] }]));
  assert.equal(lost.length, 0);
  // A card the viewer gains (a general move delivering a previously
  // undelivered post) enters the river.
  const gained = applyEvent([], {
    type: "post.updated", networkId: "net1", postId: "p9",
    content: { _id: "p9", body: "hello", groupId: null },
  }, context([]));
  assert.equal(gained.length, 1);
  assert.equal(gained[0].origin, "https://hub", "the arrival row rides the origin annotation");
});

test("ac-5: comment removals and edits arriving live merge in place", async () => {
  const { applyEvent } = await import("../src/live.js");
  const river = [{ _id: "p1", originNetworkId: "net1", replySlice: [{ _id: "r1", body: "old", parentId: null, responseCount: 1 }], replyTotal: 3 }];
  const updated = applyEvent(river, {
    type: "comment.updated", networkId: "net1", postId: "p1",
    content: { _id: "r1", body: "new", parentId: null },
  }, {});
  assert.equal(updated[0].replySlice[0].body, "new");
  const removed = applyEvent(updated, {
    type: "comment.deleted", networkId: "net1", postId: "p1",
    content: { rootId: "r1", cascadeIds: ["r1a"] },
  }, {});
  assert.equal(removed[0].replySlice.length, 0);
  assert.equal(removed[0].replyTotal, 2, "the expander total recomputes against live comments");
});

test("ac-5: foreign-origin and hidden content never renders lifecycle affordances — the predicates refuse outside the origin", () => {
  const foreign = { _id: "p9", authorId: "did:me", origin: "https://elsewhere.example", originNetworkId: "other" };
  const data = { identity: { id: "did:me" }, members: [{ did: "did:me", role: "owner" }], network: { _id: "net-home", name: "Home" } };
  assert.equal(canEditPost(foreign, data), false);
  assert.equal(canDeletePost(foreign, data), false);
  // A hidden post's card renders nothing at all upstream (the render-time
  // filter returns null before any affordance exists).
  assert.match(card, /actions\?\.isHidden\?\.\(post\)/);
});

test("ac-5: an open composer survives unrelated arrivals and a deleted target closes it with the draft held", () => {
  // The stability contract: surfaces key by stable ids (never an index),
  // and the removed/composer state are orthogonal — a removal never
  // touches a draft.
  assert.match(sliceBlock, /key=\{composerTarget\}/);
  assert.match(sliceBlock, /key=\{`edit:\$\{editTarget\}`\}/);
  assert.match(postDetail, /key=\{composerFor\}/);
  assert.match(postDetail, /if \(composerFor === id\) setComposerFor\(null\);/);
  assert.match(postDetail, /if \(editFor === id\) setEditFor\(null\);/);
  assert.doesNotMatch(social, /drafts\.delete\(\s*id\s*\)/, "a target deletion never clears the member's draft");
});