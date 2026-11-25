// Mobile composer bottom sheet (PORCH-144): the collapse law, the publish
// eligibility law, the destination targeting law, the staged-share mapping,
// and the mixed create payload — spec of record: the Porchlight UI unified
// composer pair (PRD 6b073a54549901c58e055d06 / TS 6b073a54549901c58e055d05).
// The mixed create payload rides PORCH-143's shipped contract (one write,
// ordered mediaRefs, the draft's text rides the caption under media).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { build } from "esbuild";
import React from "react";
import { renderToString } from "react-dom/server";

import {
  destinationLabel,
  destinationRows,
  destinationUnavailable,
  destinationUnavailableCopy,
  formatDuration,
  keyboardRaised,
  postEligible,
  publishPayload,
  sheetKeyboardBottom,
  sheetMode,
  stagedShareDraft,
  tilesVisible,
  attachmentKind,
} from "../src/compose-sheet.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const shell = await readFile(join(webRoot, "src/main.jsx"), "utf8");

const { ComposeSheet } = await (async () => {
  const outDir = join(here, ".tmp144");
  await mkdir(outDir, { recursive: true });
  await build({
    stdin: { contents: 'export { ComposeSheet } from "./src/compose-sheet.jsx";', resolveDir: webRoot, loader: "jsx", sourcefile: "entry.jsx" },
    bundle: true, format: "esm", jsx: "automatic", platform: "neutral",
    external: ["react", "react-dom", "@mui/*", "@emotion/*", "@noble/*", "socket.io-client", "unicode-emoji-json", "react-transition-group", "hoist-non-react-statics"],
    outfile: join(outDir, "compose-sheet.built.mjs"), logLevel: "silent",
  });
  const loaded = await import(join(outDir, "compose-sheet.built.mjs"));
  after(async () => { await rm(outDir, { recursive: true, force: true }); });
  return loaded;
})();

const ME = "did:porch:me";
const NET = "net-home";
const groupsFixture = [
  { _id: "g1", name: "Lake Weekend", members: [ME], networkId: NET },
  { _id: "g2", name: "Sister Only", members: ["did:porch:sister"], networkId: NET },
];
const sheetData = { identity: { id: ME }, network: { id: NET, name: "The Noah Family" }, groups: groupsFixture };
const PHOTO = { name: "lake.jpg", type: "image/jpeg" };
const VIDEO = { name: "jump.mp4", type: "video/mp4" };
const AUDIO = { name: "song.m4a", type: "audio/mp4" };
const render = (props) => renderToString(React.createElement(ComposeSheet, { onClose: () => {}, actions: {}, ...props }));
const buttonTag = (testid, html) => html.match(new RegExp(`<button[^>]*data-testid="${testid}"[^>]*>`))?.[0] ?? "";

/* ---- collapse law -------------------------------------------------------- */

test("ac-state: the collapse law holds — tiles only on the three-part reset", () => {
  // Empty: unfocused + keyboard closed + draft empty → tiles.
  assert.equal(sheetMode({ focused: false, keyboardOpen: false, text: "", attachments: [] }), "empty");
  assert.equal(tilesVisible("empty"), true);
  // Focused alone holds the compact controls.
  assert.equal(sheetMode({ focused: true, keyboardOpen: false, text: "", attachments: [] }), "typing");
  assert.equal(tilesVisible("typing"), false);
  // Open keyboard alone holds them.
  assert.equal(sheetMode({ focused: false, keyboardOpen: true, text: "", attachments: [] }), "typing");
  // Any draft text — even whitespace alone — holds them (never tiles over a draft).
  assert.equal(sheetMode({ focused: false, keyboardOpen: false, text: " ", attachments: [] }), "typing");
  // Media holds them regardless of focus/keyboard/text.
  assert.equal(sheetMode({ focused: false, keyboardOpen: false, text: "", attachments: [1] }), "attached");
  assert.equal(tilesVisible(sheetMode({ focused: false, keyboardOpen: false, text: "", attachments: [1] })), false);
});

/* ---- eligibility law ------------------------------------------------------ */

test("ac-eligibility: Post enables on nonblank text or media, never on whitespace alone", () => {
  assert.equal(postEligible({ text: "", attachments: [] }), false);
  assert.equal(postEligible({ text: "   \n  ", attachments: [] }), false, "whitespace alone keeps Post disabled");
  assert.equal(postEligible({ text: "Lake day!", attachments: [] }), true);
  assert.equal(postEligible({ text: "", attachments: [{}] }), true, "media alone is eligible");
  assert.equal(postEligible({ text: "   ", attachments: [{}] }), true);
});

/* ---- destination targeting law -------------------------------------------- */

test("ac-destination: the picker offers Main timeline plus the author's groups only", () => {
  const composable = groupsFixture.filter((group) => group.members.includes(ME));
  // The offered rows never include a group the author does not hold — the
  // existing composableGroups gate rides unchanged above the row shaper.
  assert.deepEqual(destinationRows(composable), [
    { value: "", label: "Main timeline" },
    { value: "g1", label: "Lake Weekend" },
  ]);
  assert.equal(destinationLabel(composable, ""), "Main timeline", "the default reads Main timeline");
  assert.equal(destinationLabel(composable, "g1"), "Lake Weekend", "a group destination reads the group's render");
});

test("ac-destination: an unavailable destination is named, never silently retargeted", () => {
  const composable = groupsFixture.filter((group) => group.members.includes(ME));
  assert.equal(destinationUnavailable("", composable, NET), false, "the general timeline is never stale");
  assert.equal(destinationUnavailable("g1", composable, NET), false, "a held group is reachable");
  assert.equal(destinationUnavailable("g2", composable, NET), true, "membership lost between selection and send is stale");
  assert.match(destinationUnavailableCopy("Sister Only"), /Sister Only is no longer a destination you can post to/);
});

/* ---- publish payload (merged create, PORCH-143 contract) ------------------- */

test("ac-publish: text-only publishes as the text shape", () => {
  assert.deepEqual(
    publishPayload({ text: " Hello porch ", attachments: [], mediaRefs: [], groupId: "", previewId: "prev1" }),
    { type: "text", body: "Hello porch", caption: null, mediaRefs: [], groupId: null, previewId: "prev1" });
});

test("ac-publish: mixed (text + photos + videos) rides ONE create with the ordered mediaRefs — no per-kind fork", () => {
  const payload = publishPayload({ text: "Lake day!", attachments: [{ kind: "photo" }, { kind: "video" }, { kind: "photo" }], mediaRefs: ["m1", "m2", "m3"], groupId: "g1" });
  // One write, ordered refs, stored type = the first attachment's kind
  // (type=mixed is the server's read projection); the draft's text rides
  // the caption; body stays null under media.
  assert.deepEqual(payload, {
    type: "photo", body: null, caption: "Lake day!", mediaRefs: ["m1", "m2", "m3"], groupId: "g1", previewId: null,
  });
  const videoFirst = publishPayload({ text: "", attachments: [{ kind: "video" }], mediaRefs: ["m9"], groupId: "" });
  assert.equal(videoFirst.type, "video");
  assert.equal(videoFirst.caption, null, "media-only publishes without a caption write");
  assert.equal(videoFirst.body, null);
});

/* ---- staged-share mapping --------------------------------------------------- */

test("ac-staging: a staged share opens the unified draft; audio stages nothing but keeps the text", () => {
  const photoShare = stagedShareDraft({ type: "photo", files: [PHOTO], body: "", caption: "From my phone" });
  assert.equal(photoShare.text, "From my phone");
  assert.deepEqual(photoShare.attachments.map((row) => row.kind), ["photo"]);
  const textShare = stagedShareDraft({ type: "text", files: [], body: "Hello", caption: "" });
  assert.equal(textShare.text, "Hello");
  assert.deepEqual(textShare.attachments, []);
  const audioShare = stagedShareDraft({ type: "audio", files: [AUDIO], body: "", caption: "" });
  assert.deepEqual(audioShare.attachments, [], "audio stages nothing on the unified surfaces");
  assert.match(audioShare.notice, /The audio file cannot be added/);
  assert.equal(attachmentKind(PHOTO), "photo");
  assert.equal(attachmentKind(VIDEO), "video");
  assert.equal(attachmentKind(AUDIO), null);
});

/* ---- keyboard geometry ------------------------------------------------------ */

test("ac-keyboard: a visual-viewport shrink ≥ 120px counts as the risen keyboard; the footer rides above it", () => {
  assert.equal(keyboardRaised({ windowHeight: 800, viewportHeight: 700 }), false, "browser chrome resizes are below the keyboard class");
  assert.equal(keyboardRaised({ windowHeight: 800, viewportHeight: 680 }), true, "a 120px shrink is the keyboard");
  assert.equal(keyboardRaised({ windowHeight: 800, viewportHeight: 681 }), false);
  assert.equal(sheetKeyboardBottom({ windowHeight: 800, viewportHeight: 660, offsetTop: 0 }), 140);
  assert.equal(sheetKeyboardBottom({ windowHeight: 800, viewportHeight: 660, offsetTop: 20 }), 120, "a scrolled visual viewport lifts only its visible remainder");
  assert.equal(sheetKeyboardBottom({ windowHeight: 800, viewportHeight: 800, offsetTop: 0 }), 0, "keyboard closed → the sheet rests flush");
  assert.equal(sheetKeyboardBottom({ windowHeight: 800, viewportHeight: 900, offsetTop: 0 }), 0);
  assert.equal(sheetKeyboardBottom({}), 0);
});

test("ac-misc: video thumbs render duration bottom-right in the clock class", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(2200), "0:02");
  assert.equal(formatDuration(65_000), "1:05");
  assert.equal(formatDuration(null), "0:00");
});

/* ---- rendered sheet (SSR) ---------------------------------------------------- */

test("ac-render: the Empty state renders the sheet anatomy", () => {
  const html = render({ open: true, target: null, data: sheetData, staged: null });
  assert.match(html, /data-testid="compose-sheet"/);
  assert.match(html, /New post/);
  assert.match(html, /aria-label="Close"/);
  assert.match(html, /data-testid="sheet-photo-tile"/);
  assert.match(html, /data-testid="sheet-video-tile"/);
  assert.match(html, /Write something…/);
  assert.match(html, /data-testid="sheet-destination"/);
  assert.match(html, /Main timeline/, "the default destination reads the preselected general timeline");
  // Post is muted-disabled on the empty draft.
  assert.match(buttonTag("sheet-post", html), /\bdisabled\b/);
  // The compact add controls never render in the Empty state.
  assert.doesNotMatch(html, /sheet-add-photo/);
});

test("ac-destination: opening from a group surface preselects that group (Oct 16 targeting law)", () => {
  const html = render({ open: true, target: "g1", data: sheetData, staged: null });
  assert.match(html, /Lake Weekend/, "the footer control reads the preselected group");
  // A non-member group context falls back to the general timeline.
  const foreign = render({ open: true, target: "g2", data: sheetData, staged: null });
  assert.match(foreign, /Main timeline/);
});

test("ac-render: the compact footer holds the Add controls over a draft, no tiles", () => {
  const html = render({ open: true, target: null, data: sheetData, staged: { type: "text", files: [], body: "Hello porch", caption: "", notice: null, dropped: [] } });
  assert.match(html, /data-testid="sheet-add-photo"/);
  assert.match(html, /data-testid="sheet-add-video"/);
  assert.doesNotMatch(html, /sheet-photo-tile/, "the composer never re-renders a large tile over a draft");
  assert.match(html, /Hello porch/, "the staged text rides the field");
});

test("ac-render: one attachment fills the preview width with its remove control; a set rides the carousel with the position indicator", () => {
  const single = render({ open: true, target: null, data: sheetData, staged: { type: "photo", files: [PHOTO], body: "", caption: "", notice: null, dropped: [] } });
  assert.match(single, /aria-label="Remove photo"/);
  assert.doesNotMatch(single, /data-testid="sheet-carousel"/, "one attachment renders the single full-width preview, never the carousel");
  const mixed = render({ open: true, target: null, data: sheetData, staged: { type: "photo", files: [PHOTO, VIDEO], body: "", caption: "", notice: null, dropped: [] } });
  assert.match(mixed, /data-testid="sheet-carousel"/);
  assert.match(mixed, /aria-label="1 of 2"/, "the quantity position indicator reads the visible slide");
  assert.match(mixed, /aria-label="Remove photo"/);
  assert.match(mixed, /aria-label="Remove video"/);
  assert.match(mixed, /data-testid="attachment-video"/, "a video thumb renders with its play affordance");
  assert.match(mixed, /Attached video 2 of 2/, "the mixed draft's slides render kind-aware in attachment order");
  const mixedText = render({ open: true, target: null, data: sheetData, staged: { type: "photo", files: [PHOTO, VIDEO], body: "", caption: "Both", notice: null, dropped: [] } });
  assert.match(mixedText, /Both/, "the staged text rides the field under the carousel");
});

test("ac-render: the sheet renders nothing when closed and the offline state names itself", () => {
  assert.equal(render({ open: false, target: null, data: sheetData, staged: null }), "");
  const offline = render({ open: true, target: null, data: { ...sheetData, offline: true }, staged: null });
  assert.match(offline, /Posting is unavailable while your family server is unreachable. Your draft stays here./);
  assert.match(buttonTag("sheet-post", offline), /\bdisabled\b/, "Post stays disabled while the hub is unreachable");
});

test("ac-shell: the shell mounts the surface selector — the sheet below the mobile line, the modal frozen on desktop", () => {
  assert.match(shell, /import \{ ComposeSheet \} from "\.\/compose-sheet\.jsx";/);
  assert.match(shell, /import \{ MOBILE_CLASS_MAX \} from "\.\/compose-sheet\.js";/);
  assert.match(shell, /composeVariant === "mobile"\n\s*\? <ComposeSheet open=\{composeOpen\}/,
    "below the mobile line the bottom sheet is the composer of record");
  assert.match(shell, /: <Compose open=\{composeOpen\} onClose/,
    "at ≥900px the existing desktop modal carries unchanged");
  assert.match(shell, /if \(!composeOpenRef\.current\) setComposeVariant\(query\.matches \? "mobile" : "desktop"\);/,
    "the surface variant freezes while the composer is open — no remount under a live draft");
});
