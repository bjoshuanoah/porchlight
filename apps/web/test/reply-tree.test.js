// Reply attach hierarchy (PORCH-099, Brian Oct 16, 2026): a reply to a
// comment renders inside THAT comment's reply tree at the child position —
// on both comment surfaces, freshly written (optimistic pending → confirmed
// keep-alive, clean rollback) and never re-homed to the root list or set as
// a sibling of unrelated roots. Reply-to-reply continues the nesting under
// the existing indent cap with the connector line preserving the relation.
// The pure row/tree contracts are pinned on slice.js; the rendered surfaces
// (bundled and rendered server-side with the real MUI, as PORCH-084's
// reply-order.test.js does) pin the tree structure; the card's write→land
// flow is pinned on the surface source.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { build } from "esbuild";
import React from "react";
import { renderToString } from "react-dom/server";
import { pendingReply, repliesByParent, reconcileNestedRows, rootAncestorId } from "../src/slice.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const social = await readFile(join(webRoot, "src/social.jsx"), "utf8");

// One bundled build of src/social.jsx shared by the rendered sweeps; the
// fixture directory is removed when the suite ends.
const outDir = join(here, ".tmp099");
let surfacesModule = null;
async function surfaces() {
  if (surfacesModule) return surfacesModule;
  await mkdir(outDir, { recursive: true });
  await build({
    stdin: { contents: 'export { PostDetail, ReplyThread, ReplySliceBlock, PostCard } from "./src/social.jsx";', resolveDir: webRoot, loader: "jsx", sourcefile: "entry.jsx" },
    bundle: true, format: "esm", jsx: "automatic", platform: "neutral",
    external: ["react", "react-dom", "@mui/*", "@emotion/*", "@noble/*", "socket.io-client", "unicode-emoji-json", "react-transition-group", "hoist-non-react-statics"],
    outfile: join(outDir, "surfaces.built.mjs"), logLevel: "silent",
  });
  surfacesModule = await import(join(outDir, "surfaces.built.mjs"));
  return surfacesModule;
}
after(async () => { await rm(outDir, { recursive: true, force: true }); });

// Body occurrences appear in DOM (render) order; indices must ascend.
const inOrder = (haystack, markers) => {
  const indices = markers.map((marker) => haystack.indexOf(marker));
  return indices.every((index, at) => index >= 0 && (at === 0 || indices[at - 1] < index));
};

const ts = (minute) => `2026-10-14T10:${String(minute).padStart(2, "0")}:00Z`;
const data = { identity: { id: "did:porch:me", name: "You" }, server: { url: "https://hub" }, network: { name: "Home" } };
const post = { _id: "p1", origin: "https://hub" };

// ac-1: the write carries the comment it answers — the composer target rides
// the payload as parentId, so the row belongs to that comment's tree.
test("ac-1: an optimistic nested reply carries its attach target; a root row stays null", () => {
  const nested = pendingReply(post, "to your point", { did: "did:porch:me", name: "You", localId: "local:nested-1", parentId: "c-comment" });
  const root = pendingReply(post, "to the post", { did: "did:porch:me", name: "You", localId: "local:reply-2", parentId: null });
  assert.equal(nested.parentId, "c-comment");
  assert.equal(root.parentId, null);
  // The tree law mounts a nested row's pending render under the target:
  const served = [{ _id: "R1", parentId: null, body: "root", createdAt: ts(1) }, { _id: "C1", parentId: "R1", body: "first", createdAt: ts(2) }];
  const byParent = repliesByParent([...served, nested, root]);
  assert.deepEqual([...byParent.get("c-comment")].map((row) => row._id), ["local:nested-1"],
    "the pending row mounts as a child of the comment it answers, never at root level");
  assert.deepEqual([...byParent.get("")].map((row) => row._id), ["R1", "local:reply-2"],
    "the root pending row rides the root list as before");
});

// ac-1: the tree-open key is the rendered ancestor — opening keyed by a
// nested parent's own id would render nothing; keyed by the depth-0
// ancestor the render law expands under (the card's expansion set carries
// depth-0 ids only).
test("ac-1: rootAncestorId resolves a nested reply's rendered ancestor", () => {
  const rows = [
    { _id: "R1", parentId: null },
    { _id: "C1", parentId: "R1" },
    { _id: "C1a", parentId: "C1" },
    { _id: "S1", parentId: null },
    { _id: "R2", parentId: null },
  ];
  assert.equal(rootAncestorId("C1a", rows), "R1", "a reply to a reply opens the ancestor's tree — the relation the render law keys");
  assert.equal(rootAncestorId("C1", rows), "R1");
  assert.equal(rootAncestorId("S1", rows), "S1", "a slice root's target opens its own tree");
  assert.equal(rootAncestorId("unknown", rows), "unknown", "an id with no known chain resolves to itself");
});

// ac-3: the confirmed row retires exactly when a read carries it (never
// rendered twice); a pending row survives any read — its own write
// lifecycle swaps or reverts it.
test("ac-3: reconcileNestedRows retires served rows by id and spares pending rows", () => {
  const confirmed = { _id: "c9", parentId: "C1", body: "confirmed row", createdAt: ts(6) };
  const pending = { _id: "local:nested-3", parentId: "C1", body: "pending row", createdAt: ts(7) };
  const kept = reconcileNestedRows({ pending: [pending], confirmed: [confirmed] }, [
    { _id: "C1", parentId: "R1", body: "first", createdAt: ts(2) },
  ]);
  assert.equal(kept.confirmed.length, 1, "a row no read has served yet keeps rendering inside the tree");
  assert.equal(kept.pending.length, 1);
  const retired = reconcileNestedRows({ pending: [pending], confirmed: [{ _id: "c9" }] }, [{ _id: "c9", parentId: "C1" }, { _id: "C1" }]);
  assert.equal(retired.confirmed.length, 0, "the confirmed row retires the moment its serving read arrives");
  assert.equal(retired.pending.length, 1, "a pending row is retired by its own lifecycle, never by a read");
  const blank = reconcileNestedRows(null, null);
  assert.deepEqual(blank, { pending: [], confirmed: [] }, "empty state reconciles to empty state");
});

// ac-2 (detail): the ruled read serves a flat ordered thread; the column's
// tree mounts each reply inside its parent's block — a reply to a reply
// nests the next indent rung with the connector line, under the cap.
test("ac-2: detail column renders a reply-to-reply nested under the same parent with connectors", async () => {
  const { ReplyThread } = await surfaces();
  const comments = [
    { _id: "R1", parentId: null, authorDid: "dA", authorName: "Ari", body: "R1-root", createdAt: ts(1) },
    { _id: "C1", parentId: "R1", authorDid: "dB", authorName: "Ben", body: "C1-reply", createdAt: ts(2) },
    { _id: "C1a", parentId: "C1", authorDid: "dC", authorName: "Cy", body: "C1a-deeper", createdAt: ts(3) },
    { _id: "C2", parentId: "R1", authorDid: "dD", authorName: "Dee", body: "C2-reply", createdAt: ts(4) },
  ];
  const html = renderToString(React.createElement(ReplyThread, { comments, post, data, actions: {}, navigate: null, composerFor: null, onReplyTarget: null }));
  assert.ok(inOrder(html, ["R1-root", "C1-reply", "C1a-deeper", "C2-reply"]),
    "the reply-to-reply renders inside C1's rung of the tree, chronological order holds");
  // The connector line of record: each nested rung's row box carries the
  // tree's connector (renderToString serves classNames, not emotion CSS —
  // the connector's presence is pinned on the source of both surfaces).
  assert.match(social, /borderLeft: '2px solid', borderColor: 'divider'/, "the detail row's connector line stands");
  assert.match(social, /borderLeft: '1px solid', borderColor: 'divider'/, "the card rung's connector line stands");
  // The indent cap is the existing rendered-tree law, unchanged.
  assert.match(social, /Math\.min\(depth, 4\) \* 3/, "the detail column's indent cap stands");
  assert.match(social, /Math\.min\(depth, 3\) \* 3\.5/, "the card slice's indent cap stands");
});

// ac-1 (card): the served slice shows the ruled root window only — a
// nested reply is never re-homed to the card's root list, and the collapsed
// tree's quantity expander carries the count (quantity, not engagement).
test("ac-1: the card slice shows its roots only; a collapsed tree never re-homes a child", async () => {
  const { ReplySliceBlock } = await surfaces();
  const roots = [
    { _id: "r1", parentId: null, authorDid: "dB", authorName: "Ben", body: "inline-root", createdAt: ts(1), responseCount: 1 },
    { _id: "r2", parentId: null, authorDid: "dD", authorName: "Dee", body: "second-root", createdAt: ts(2) },
  ];
  const html = renderToString(React.createElement(ReplySliceBlock, { post, slice: { replies: roots, total: 2 }, data, actions: {}, offline: false, origin: "https://hub", navigate: null }));
  assert.ok(inOrder(html, ["inline-root", "second-root"]), "the rendered slice carries the served root rows");
  assert.ok(!html.includes("R1-child") && !html.includes("C1-child"),
    "no nested row renders at the card's root level — children mount only inside an open tree");
  assert.match(html, /View 1 more responses/, "the collapsed tree names its response quantity");
});

// ac-1/ac-2/ac-3 (both surfaces): the write→land flow — the composer target
// is the comment it answers; the tree opens keyed by the rendered ancestor;
// the optimistic pending row mounts at the child position; the confirmed
// row keeps rendering in place reconciled by the reads; the detail column's
// written reply joins the flat set its tree nests from.
test("ac-3: the card's write lands the reply inside the parent's tree in place", () => {
  const block = social.slice(social.indexOf("export function ReplySliceBlock("), social.indexOf("// The pending copy swaps for the confirmed server row by id: the confirm"));
  assert.match(block, /onSubmit=\{\(body, mentions\) => submitNested\(body, composerTarget, mentions\)\}/,
    "the composer's target is the comment it answers — the write attaches to that comment");
  assert.match(block, /rootAncestorId\(String\(parentId\), targetRows\(\)\)/,
    "the tree opens keyed by the reply's rendered ancestor, never beside unrelated roots");
  assert.match(block, /repliesByParent\(\[\.\.\.\(loaded \?\? \[\]\), \.\.\.freshRows\]\)/,
    "the rendered tree mounts the freshly written rows alongside the served rows");
  assert.match(block, /pendingReply\(post, body, \{[\s\S]*?parentId,\s*\}\)/, "the optimistic row carries its attach target");
  assert.equal(block.split("reconcileNestedRows(current, comments)").length - 1, 2,
    "both read paths reconcile the written rows — never rendered twice after a read carries them");
  assert.match(block, /pending: current\.pending\.filter\(\(row\) => row\._id !== localId\)/,
    "the failed write reverts exactly — the pending row leaves the tree");
  const detail = social.slice(social.indexOf("export function PostDetail("), social.indexOf("function mediaIds("));
  assert.match(detail, /comments: \[\.\.\.current\.comments, result\.comment\]/,
    "the detail column's confirmed reply joins the set its tree nests from");
  // The composer holds its key while rows land — no remount of the open
  // composer (ac-3), and rows key by id (ac-5's law, re-pinned here).
  assert.match(block, /key=\{composerTarget\}/);
  assert.match(block, /key=\{id\}/);
});

// ac-3 (card, live arrival): an arriving reply under a rendered root merges
// through the river in place; the open tree re-reads on the decorated
// arrival and never re-homes the row to the root list (the idempotence
// ledger and the nested count bump are live.js contracts).
test("ac-3: live arrival merges under the parent without re-homing — the surface re-reads in place", async () => {
  const { applyEvent } = await import("../src/live.js");
  const context = {};
  const river = [{ _id: "p1", origin: "https://hub", originNetworkId: "net1", replyTotal: 2, replySlice: [
    { _id: "r1", parentId: null, body: "threaded", responseCount: 1, createdAt: ts(1) },
    { _id: "r2", parentId: null, body: "late", responseCount: 0, createdAt: ts(5) },
  ] }];
  const envelope = { type: "reply.created", postId: "p1", networkId: "net1", content: { _id: "r9", parentId: "r1", body: "arriving", createdAt: ts(6) } };
  const merged = applyEvent(river, envelope, context);
  assert.notEqual(merged, river);
  assert.deepEqual(merged[0].replySlice.map((row) => row._id), ["r1", "r2"],
    "the arriving nested reply never re-homes to the root window");
  assert.equal(merged[0].replySlice[0].responseCount, 2, "its presence renders through the parent's quantity");
  // The ledger is seeded with the slice the last read decorated, then the
  // arriving id — a replay re-renders nothing.
  assert.deepEqual(merged[0].knownResponses, ["r1", "r2", "r9"], "the ledger seeds from the slice and carries the arrival");
  // The card's open tree re-reads on the decorated arrival — the surface
  // effect keys on the slice signature (count move), so the open tree
  // refreshes in place: no remount of an open composer (keyed by target).
  const block = social.slice(social.indexOf("export function ReplySliceBlock("), social.indexOf("// The pending copy swaps for the confirmed server row by id: the confirm"));
  assert.match(block, /only a changed decorated slice refreshes an open thread/, "the open tree refreshes on the decorated arrival");
  assert.match(social, /key=\{composerTarget\}/, "an open composer keeps its key through the refresh");
});