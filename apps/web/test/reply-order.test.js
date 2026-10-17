// Reply ordering and composer (PORCH-084, Brian Oct 15, 2026): the two
// comment surfaces — the timeline card's conversation slice and the post
// detail's conversation column — render the ruled read order (threaded
// roots ahead, childless roots newest-first, replies chronological inside
// each tree), carry exactly one on-demand full-rail composer with
// per-target drafts, and render no vote affordance on any comment row.
// The pure order/window contract is pinned in slice.test.js; this file
// pins the surfaces' source contracts and sweeps the REAL rendered DOM
// (the components bundled and rendered server-side with the real MUI).
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

// One bundled build of src/social.jsx (third-party packages resolve from
// the hoisted root node_modules) shared by the two rendered sweeps; the
// fixture directory is removed when the suite ends.
const outDir = join(here, ".tmp084");
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

// The directive's e2e shape: five roots, root C carrying a 12-reply tree,
// the rest childless — C renders first, then the childless roots
// newest-first; C's replies render oldest-first inside its tree.
function ruledConversation() {
  const tree = Array.from({ length: 12 }, (_, index) => ({
    _id: `Ct${String(index).padStart(2, "0")}`, parentId: "C", authorDid: "dA", authorName: "Ari",
    body: `Ctree-${String(index).padStart(2, "0")}`, createdAt: ts(3 + index),
  }));
  return {
    comments: [
      { _id: "C", authorDid: "dC", authorName: "Carla", body: "C-root", createdAt: ts(2), responseCount: 12 },
      ...tree,
      { _id: "A", authorDid: "dA", authorName: "Ari", body: "A-root", createdAt: ts(0) },
      { _id: "B", authorDid: "dB", authorName: "Ben", body: "B-root", createdAt: ts(1) },
      { _id: "D", authorDid: "dD", authorName: "Dee", body: "D-root", createdAt: ts(14) },
      { _id: "E", authorDid: "dE", authorName: "Eli", body: "E-root", createdAt: ts(13) },
    ],
    tree,
  };
}

const data = { identity: {}, server: { url: "https://hub" }, network: { name: "Home" } };
const post = { _id: "p1", origin: "https://hub" };

test("ac-1: the detail thread renders the ruled order with the tree chronological", async () => {
  const { ReplyThread } = await surfaces();
  const { comments, tree } = ruledConversation();
  const html = renderToString(React.createElement(ReplyThread, { comments, post, data, actions: {}, navigate: null, composerFor: null, onReplyTarget: null }));
  assert.ok(inOrder(html, ["C-root", "D-root", "E-root", "B-root", "A-root"]),
    "the threaded root renders first, then the childless roots newest-first");
  assert.ok(tree.every((row) => html.indexOf(row.body) >= 0) && inOrder(html, tree.map((row) => row.body)),
    "C's replies render oldest-first inside the tree");
  // ac-5: rows key by comment id, never by arrival index — an arriving
  // reply cannot re-key (and so cannot remount) an open row.
  assert.match(social, /key=\{identityOf\(reply\) \|\| index\}/);
});

test("ac-2: the card slice renders the top four of the ruled sort with quantity-only expanders", async () => {
  const { ReplySliceBlock } = await surfaces();
  const roots = [
    { _id: "r1", authorDid: "dB", authorName: "Ben", body: "threaded-one", createdAt: ts(1), responseCount: 12 },
    { _id: "r2", authorDid: "dD", authorName: "Dee", body: "late-a", createdAt: ts(14) },
    { _id: "r3", authorDid: "dE", authorName: "Eli", body: "late-b", createdAt: ts(13) },
    { _id: "r4", authorDid: "dA", authorName: "Ari", body: "late-c", createdAt: ts(12) },
    { _id: "r5", authorDid: "dC", authorName: "Carla", body: "late-d", createdAt: ts(11) },
  ];
  const post52 = { _id: "p1", replySlice: roots, replyTotal: 52, origin: "https://hub" };
  const html = renderToString(React.createElement(ReplySliceBlock, { post: post52, slice: { replies: roots, total: 52 }, data, actions: {}, offline: false, origin: "https://hub", navigate: null }));
  // The threaded root renders ahead of the newer childless roots; the
  // window holds the top four, oldest childless falls into the count.
  assert.ok(inOrder(html, ["threaded-one", "late-a", "late-b", "late-c", "View 48 more comments"]),
    "the top four of the ruled sort render with the expander count as total minus rendered");
  // The responses expander rides the collapsed reply count, quantity-only.
  assert.match(html, /View 12 more responses/);
});

test("ac-3: no composer by default; open renders one full-rail composer naming its target", async () => {
  const { ReplySliceBlock } = await surfaces();
  const roots = [
    { _id: "r1", authorDid: "dB", authorName: "Ben", body: "threaded-one", createdAt: ts(1), responseCount: 2 },
    { _id: "r2", authorDid: "dD", authorName: "Dee", body: "late-a", createdAt: ts(14) },
    { _id: "r3", authorDid: "dE", authorName: "Eli", body: "late-b", createdAt: ts(13) },
    { _id: "r4", authorDid: "dA", authorName: "Ari", body: "late-c", createdAt: ts(12) },
    { _id: "r5", authorDid: "dC", authorName: "Carla", body: "late-d", createdAt: ts(11) },
  ];
  const post52 = { _id: "p1", replySlice: roots, replyTotal: 52, origin: "https://hub" };
  const closed = renderToString(React.createElement(ReplySliceBlock, { post: post52, slice: { replies: roots, total: 52 }, data, actions: {}, offline: false, origin: "https://hub", navigate: null, composerFor: null }));
  assert.match(closed, /View 48 more comments/);
  assert.equal((closed.match(/<(input|textarea)/g) || []).length, 0, "no input renders beneath comments with the composer closed");

  const open = renderToString(React.createElement(ReplySliceBlock, { post: post52, slice: { replies: roots, total: 52 }, data, actions: {}, offline: false, origin: "https://hub", navigate: null, composerFor: "r3" }));
  assert.match(open, /Replying to Eli/, "the composer stays legible about whose comment it answers");
  // MUI's multiline field renders one visible textarea plus its autosize
  // mirror — the one composer is one form: exactly one target caption.
  assert.equal((open.match(/data-testid="reply-target"/g) || []).length, 1, "exactly one composer renders for the open target");
  assert.ok((open.match(/<(input|textarea)/g) || []).length >= 1, "a field renders for the open composer");
  // The composer renders at the block's foot (after every row and the
  // expander), full-rail — never a small input inside an indented row.
  assert.ok(htmlAfter(open, "View 48 more comments", "Replying to Eli"), "the composer sits at the rail's foot");
});

const htmlAfter = (haystack, first, then) => haystack.indexOf(first) >= 0 && haystack.indexOf(first) < haystack.indexOf(then);

test("ac-3/ac-4: surfaces hold one composer state with per-target drafts and full-rail placement", () => {
  // The card and the detail column each own exactly one composer state; the
  // Reply actions point that state — opening a target closes the open one
  // in the same setState frame, and no per-row local composer state remains.
  const detail = social.slice(social.indexOf("export function PostDetail("), social.indexOf("function mediaIds("));
  const oneState = "const [composerFor, setComposerFor] = useState(null); // null | 'post' | comment id";
  assert.equal(social.split(oneState).length - 1, 2, "the card and the detail column each own the one composer state");
  assert.equal(social.split("useState(() => new Map())").length - 1, 2, "each surface holds its own per-target draft map");
  assert.doesNotMatch(social, /editingId|setEditingId/, "no per-row inline composer state remains");
  // The composer mounts per target (draft preserved on reopen) and closes
  // on a confirmed send.
  assert.match(social, /key=\{composerTarget\}/);
  assert.match(social, /key=\{composerFor\}/);
  assert.match(social, /initialText=\{readDraft\(/);
  assert.match(social, /onDraft=\{\(text\) => holdDraft\(/);
  assert.match(social, /onDone=\{\(\) => \{ setComposerFor\(null\); holdDraft\(/);
  // Detail: the composer renders on demand only, full column width; the
  // post-level Reply trigger lives beside the heading.
  assert.match(detail, /data-testid="detail-reply"/);
  assert.match(detail, /\{!data\.offline && composerFor && <ReplyForm/);
  assert.doesNotMatch(detail, /composerFor === null/);
  // Card: the on-demand post composer rides the full CardContent text rail.
  const card = social.slice(social.indexOf("function PostCard("), social.indexOf("function Heading("));
  assert.match(card, /\{!detail && composerFor === 'post' && !data\.offline && <ReplyForm/);
  // The composer field renders as a full-width stretch inside its rail: no
  // width cap and no shrunken variant exists on the composer internals.
  const form = social.slice(social.indexOf("function ReplyForm("), social.indexOf("function Reply("));
  assert.doesNotMatch(form, /size="small"|\bmaxWidth:|\bwidth: '?\d/);
});

test("ac-5: the merge rides id-keyed rows and the composer key holds under arrival", () => {
  const block = social.slice(social.indexOf("export function ReplySliceBlock("), social.indexOf("// The pending copy swaps for the confirmed server row by id: the confirm"));
  // The slice window re-sorts through the one ruled comparator (slice.js):
  // renderRow keys by comment id, and the surface's merge paths
  // (sliceDisplay + live.js knownResponses) dedupe by id, so an arriving
  // reply merges in place without remounting the open composer.
  assert.match(block, /key=\{id\}/);
  // The slice block's Reply action points the surface state, never local
  // per-row state.
  assert.match(block, /onReplyTarget\?\.\(id === composerFor \? null : id\)/);
});

test("ac-6: no vote affordance renders on any comment row — votes stay on posts", async () => {
  const { ReplyThread, ReplySliceBlock } = await surfaces();
  const comments = ruledConversation().comments;
  const thread = renderToString(React.createElement(ReplyThread, { comments, post, data, actions: {}, navigate: null, composerFor: null, onReplyTarget: null }));
  const roots = [
    { _id: "r1", authorDid: "dB", authorName: "Ben", body: "threaded-one", createdAt: ts(1), responseCount: 2 },
    { _id: "r2", authorDid: "dD", authorName: "Dee", body: "late-a", createdAt: ts(14) },
    { _id: "r3", authorDid: "dE", authorName: "Eli", body: "late-b", createdAt: ts(13) },
    { _id: "r4", authorDid: "dA", authorName: "Ari", body: "late-c", createdAt: ts(12) },
  ];
  const slice = renderToString(React.createElement(ReplySliceBlock, { post: { _id: "p1", replySlice: roots, replyTotal: 4, origin: "https://hub" }, slice: { replies: roots, total: 4 }, data, actions: {}, offline: false, origin: "https://hub", navigate: null }));
  for (const html of [thread, slice]) {
    assert.ok(!/>(Lift|Lower)</.test(html) && !html.includes("aria-label=\"Lift\"") && !html.includes("aria-label=\"Lower\""),
      "no up/down vote affordance renders on any root comment or reply row");
  }
  // The vote affordance of record is the post's alone: the single vote
  // control binds to the post argument on both surfaces' action bars.
  assert.match(social, /invoke\(actions, 'vote', post, direction\)/);
});

// PORCH-086 trail (Brian's hub, Oct 15): since PORCH-084 landed, the card's
// per-target draft map took `.current` off the useState PAIR —
// `useState(() => new Map()).current` — so every PostCard render threw
// "undefined is not iterable" and the whole timeline crashed to a white
// surface. The draft map is the plain useState Map again (the detail
// surface's shape) and a real PostCard render survives it.
test("PORCH-086 regression: the timeline card renders — the draft map is a plain useState Map", async () => {
  assert.doesNotMatch(social, /useState\(\(\) => new Map\(\)\)[^\n]*\.current/,
    "no hook takes .current off the useState pair anywhere");
  const { PostCard } = await surfaces();
  const cardPost = { _id: "p1", origin: "https://hub", type: "text", body: "the ruled order post",
    authorDid: "dA", authorName: "Ari", createdAt: ts(1), replySlice: [], replyTotal: 0 };
  const html = renderToString(React.createElement(PostCard, { post: cardPost, data, actions: {}, navigate: null, onHide: null }));
  assert.ok(html.includes("the ruled order post"), "the rendered card carries the post body");
  assert.match(html, /Lift|data/, "the card renders its action surface (render past the old crash point)");
});

// PORCH-100 (Brian, Oct 16, 2026, verbatim: "Also the input field is too
// narrow. It must fill the full width of the available space."): MUI's
// TextField root is an inline-flex FormControl that shrinks to its content
// until the fullWidth prop resolves width: 100%. Every composer TextField
// riding the comment surfaces — the reply composer (card rail and detail
// column) and the edit modes (post and comment) — carries fullWidth, so the
// input ELEMENT spans the governing space, not merely its container.
test("ac-1/ac-2: every composer field on the comment surfaces carries fullWidth", () => {
  const fields = (slice) => slice.match(/<TextField\b/g)?.length ?? 0;
  const fullWidthFields = (slice) => slice.match(/<TextField\b\s*\n\s*fullWidth\b/g)?.length ?? 0;
  const form = social.slice(social.indexOf("function ReplyForm("), social.indexOf("\nfunction Reply("));
  const postEdit = social.slice(social.indexOf("function PostEditForm("), social.indexOf("// The comment's edit composer"));
  const commentEdit = social.slice(social.indexOf("function CommentEditForm("), social.indexOf("\n/**\n * A comment row's lifecycle overflow"));
  for (const [name, slice] of [["ReplyForm", form], ["PostEditForm", postEdit], ["CommentEditForm", commentEdit]]) {
    assert.ok(fields(slice) > 0, `${name} renders a TextField`);
    assert.equal(fields(slice), fullWidthFields(slice), `every ${name} TextField carries fullWidth`);
  }
  // No width cap anywhere in the composer internals (the shrunken variant
  // the report showed): no maxWidth, no fixed width, no size="small".
  for (const [name, slice] of [["ReplyForm", form], ["PostEditForm", postEdit], ["CommentEditForm", commentEdit]]) {
    assert.doesNotMatch(slice, /\bmaxWidth:|\bwidth: ['"]?\d|size=["']small["']/, `${name} carries no width cap`);
  }
});

test("ac-1/ac-2: the rendered composer field element is a full-width FormControl and input", async () => {
  const { ReplySliceBlock } = await surfaces();
  const roots = [
    { _id: "r1", authorDid: "dB", authorName: "Ben", body: "threaded-one", createdAt: ts(1), responseCount: 0 },
    { _id: "r3", authorDid: "dE", authorName: "Eli", body: "late-b", createdAt: ts(13), responseCount: 0 },
  ];
  const post6 = { _id: "p1", replySlice: roots, replyTotal: 2, origin: "https://hub" };
  // Reply mode: the composer's FormControl and input root carry the
  // fullWidth classes the styled chain resolves width: 100% from.
  const reply = renderToString(React.createElement(ReplySliceBlock, { post: post6, slice: { replies: roots, total: 2 }, data, actions: {}, offline: false, origin: "https://hub", navigate: null, composerFor: "r3" }));
  assert.match(reply, /MuiFormControl-fullWidth/, "the composer FormControl renders fullWidth");
  assert.match(reply, /MuiInputBase-fullWidth/, "the composer input root renders fullWidth");
  // Edit mode: the comment edit field is the same full-width styled chain.
  const edit = renderToString(React.createElement(ReplySliceBlock, { post: post6, slice: { replies: roots, total: 2 }, data, actions: {}, offline: false, origin: "https://hub", navigate: null, editFor: "r3" }));
  assert.match(edit, /MuiFormControl-fullWidth/, "the comment edit FormControl renders fullWidth");
  assert.match(edit, /MuiInputBase-fullWidth/, "the comment edit input root renders fullWidth");
});