// Vote display (PORCH-104, UI half of the Oct 19 ruling, Brian): the Lift
// button carries the post's up-vote count (small, quiet, quantity-class;
// zero renders no number), Lower never carries a number in any state, and
// the member's own effective vote colors the corresponding arrow — green
// for Lift, red for Lower, shown on hover or when the viewer has taken
// that action (Brian's second-round rendering, Oct 19, 2026),
// data-driven from the served two values, never inferred from prior
// taps. The pure vote model and the live-arrival merge are pinned in unit
// tests; the rendered surfaces are swept with the REAL MUI under a real
// Porchlight theme (the house sweep shape).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { build } from "esbuild";
import React from "react";
import { renderToString } from "react-dom/server";
import { ThemeProvider } from "@mui/material";

import { castVoteState, ownVoteOf, upCountOf } from "../src/reactions.js";
import { applyEvent } from "../src/live.js";
import { themeFor } from "../src/theme.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const social = await readFile(join(webRoot, "src", "social.jsx"), "utf8");
const memberActions = await readFile(join(webRoot, "src", "member-actions.js"), "utf8");

// One bundled build of src/social.jsx shared by the rendered sweeps; the
// fixture directory is removed when the suite ends.
const outDir = join(here, ".tmp104");
let surfacesModule = null;
async function surfaces() {
  if (surfacesModule) return surfacesModule;
  await mkdir(outDir, { recursive: true });
  await build({
    stdin: { contents: 'export { PostCard } from "./src/social.jsx";', resolveDir: webRoot, loader: "jsx", sourcefile: "entry.jsx" },
    bundle: true, format: "esm", jsx: "automatic", platform: "neutral",
    external: ["react", "react-dom", "@mui/*", "@emotion/*", "@noble/*", "socket.io-client", "unicode-emoji-json", "react-transition-group", "hoist-non-react-statics"],
    outfile: join(outDir, "surfaces.built.mjs"), logLevel: "silent",
  });
  surfacesModule = await import(join(outDir, "surfaces.built.mjs"));
  return surfacesModule;
}
after(async () => { await rm(outDir, { recursive: true, force: true }); });

const ME = "did:porch:me";
const HOME = "https://family.example";
// The vote-arrow accents, per mode (Brian's second-round rendering, Oct
// 19, 2026): green for Lift, red for Lower, shown on hover or when the
// viewer has taken that action; the resting arrow keeps the action bar's
// ink. The retired pressed treatment (the chips' amberSoft circle) is the
// no-regression witness below.
const VOTE_HEX = {
  light: { up: "#2E7D32", down: "#B3261E" },
  dark: { up: "#81C784", down: "#E57373" },
};
const AMBER_PRESSED = { light: "#F7E8CE", dark: "#3D2E1C" };
// The serialized rule shapes: the taken arrow's persistent rule reads
// `...-root svg{color:<hex>}`, a hover touch reads `...:hover svg{...}` —
// the hover rule never contains `root svg{`, so the two disambiguate.
const persistentRule = (hex) => new RegExp(`root svg\\{color:${hex};`);
const hoverRule = (hex) => new RegExp(`:hover svg\\{color:${hex};`);

const basePost = (extra = {}) => ({
  _id: "p1", type: "text", body: "The lake was flat all day.",
  authorId: "did:porch:sister", origin: HOME, originNetworkId: "net-home",
  ...extra,
});
const cardData = { identity: { id: ME, name: "Sam" }, members: [], offline: false };

const renderCard = async (post, { detail = false, mode = "light", extraProps = {} } = {}) => {
  const { PostCard } = await surfaces();
  return renderToString(React.createElement(ThemeProvider, { theme: themeFor(mode) }, React.createElement(PostCard, {
    post, data: cardData, actions: {}, navigate: null, detail, ...extraProps,
  })));
};

// The two vote buttons, as rendered: from the accessible name through the
// button's own emotion style block and children — the region the vote
// display renders in, nothing else on the card.
const voteButton = (html, label) => {
  const start = html.indexOf(`aria-label="${label}"`);
  if (start < 0) return "";
  return html.slice(start, html.indexOf("</button>", start));
};

/* ---- the pure vote model ------------------------------------------------ */

test("ac-1 model: the served two values resolve and nothing else vote-derived renders", () => {
  assert.equal(ownVoteOf("up"), "up");
  assert.equal(ownVoteOf("down"), "down");
  assert.equal(ownVoteOf(null), null);
  assert.equal(ownVoteOf(undefined), null, "a pre-amendment row renders no self-state");
  assert.equal(upCountOf(3), 3);
  assert.equal(upCountOf(0), 0);
  assert.equal(upCountOf(undefined), null, "a row without a served upCount renders no number");
});

test("ac-1 model: one click casts or flips — the count derives from the public quantity", () => {
  // Cast from none: the up-count climbs.
  assert.deepEqual(castVoteState({ myVote: null, upCount: 2 }, "up"), { vote: "up", count: 3 });
  // A down-vote is silent on the count: Lower carries no quantity anywhere.
  assert.deepEqual(castVoteState({ myVote: null, upCount: 2 }, "down"), { vote: "down", count: 2 });
  // Flip up→down: the member's own vote leaves the up column.
  assert.deepEqual(castVoteState({ myVote: "up", upCount: 2 }, "down"), { vote: "down", count: 1 });
  // Flip down→up: the member's own vote joins the up column.
  assert.deepEqual(castVoteState({ myVote: "down", upCount: 0 }, "up"), { vote: "up", count: 1 });
  // Zero clamps: the count never renders negative.
  assert.deepEqual(castVoteState({ myVote: null, upCount: 0 }, "up"), { vote: "up", count: 1 });
});

test("ac-3 model: clicking a held vote is no write", () => {
  assert.equal(castVoteState({ myVote: "up", upCount: 4 }, "up"), null);
  assert.equal(castVoteState({ myVote: "down", upCount: 1 }, "down"), null);
  assert.equal(castVoteState({ myVote: "up" }, "sideways"), null);
});

/* ---- rendered sweep ------------------------------------------------------ */

test("ac-1: the Lift button carries the count beside the icon; zero renders no number", async () => {
  const html = await renderCard(basePost({ upCount: 3, myVote: null }));
  const lift = voteButton(html, "Lift");
  assert.match(lift, />3</, "the up-count renders as the quantity beside the icon");
  const zero = await renderCard(basePost({ upCount: 0, myVote: null }));
  const liftZero = voteButton(zero, "Lift");
  assert.doesNotMatch(liftZero, />\d</, "zero up-votes render no number; the button stays interactive");
});

test("ac-2: Lower never carries a number in any state (five-down fixture shape)", async () => {
  // The five down-votes live server-side; the wire serves the viewer's own
  // value alone (PORCH-103's payload audits), so the rendered surface can
  // only ever see myVote: "down" — Lower's arrow carries its red, and
  // Lower stays bare of any number.
  const html = await renderCard(basePost({ upCount: 2, myVote: "down" }));
  const lower = voteButton(html, "Lower");
  assert.doesNotMatch(lower, />\d</, "no digit, tally, or quantity of any kind renders on Lower");
  assert.match(lower, /<svg[\s\S]*<\/svg>/, "the taken Lower renders as an arrow state, not a number");
});

test("ac-3: the served self-state colors the arrow — up greens Lift, down reds Lower, none rests", async () => {
  const up = await renderCard(basePost({ upCount: 1, myVote: "up" }));
  assert.match(voteButton(up, "Lift"), persistentRule(VOTE_HEX.light.up), "the taken Lift arrow carries its green persistently");
  assert.match(voteButton(up, "Lift"), hoverRule(VOTE_HEX.light.up), "and on hover — the same green");
  assert.doesNotMatch(voteButton(up, "Lift"), new RegExp(AMBER_PRESSED.light), "no circle background marks the vote — the arrow alone");
  assert.doesNotMatch(voteButton(up, "Lift"), persistentRule(VOTE_HEX.light.down), "Lift never carries Lower's red persistently");
  assert.doesNotMatch(voteButton(up, "Lower"), persistentRule(VOTE_HEX.light.down), "Lower rests when the vote is up — its red waits for a hover");
  assert.doesNotMatch(voteButton(up, "Lower"), new RegExp(AMBER_PRESSED.light), "and no circle background on Lower either");
  const down = await renderCard(basePost({ upCount: 1, myVote: "down" }));
  assert.match(voteButton(down, "Lower"), persistentRule(VOTE_HEX.light.down), "Lower carries its red when the vote is down");
  assert.doesNotMatch(voteButton(down, "Lift"), persistentRule(VOTE_HEX.light.up), "Lift rests when the vote is down — its green waits for a hover");
  const none = await renderCard(basePost({ upCount: 0, myVote: null }));
  assert.doesNotMatch(voteButton(none, "Lift"), persistentRule(VOTE_HEX.light.up), "no self-state, no persistent arrow color");
  assert.doesNotMatch(voteButton(none, "Lower"), persistentRule(VOTE_HEX.light.down), "no self-state, no persistent arrow color");
  assert.match(voteButton(none, "Lift"), hoverRule(VOTE_HEX.light.up), "a hover still previews Lift's green");
  assert.doesNotMatch(voteButton(none, "Lift"), new RegExp(AMBER_PRESSED.light), "the resting surface carries no pressed circle");
});

test("ac-1: the detail surface carries the same render as the card", async () => {
  const html = await renderCard(basePost({ upCount: 3, myVote: "up" }), { detail: true });
  const lift = voteButton(html, "Lift");
  const lower = voteButton(html, "Lower");
  assert.match(lift, />3</);
  assert.match(lift, persistentRule(VOTE_HEX.light.up), "the detail's taken Lift arrow carries its green like the card");
  assert.doesNotMatch(lower, />\d</);
  assert.doesNotMatch(lower, persistentRule(VOTE_HEX.light.down), "the resting Lower colors only on hover");
  assert.doesNotMatch(lift, new RegExp(AMBER_PRESSED.light), "no circle background on the detail's vote either");
});

/* ---- source sweeps: one derivation, one write, no other vote data -------- */

test("ac-4: the render layer reads only the two ruled values — no down counts, ratios, or counters", () => {
  // The vote block derives from upCount/myVote alone; no other vote-derived
  // field is referenced anywhere in the rendered surfaces.
  assert.doesNotMatch(social, /downVolume|voteRatio|interactionCounters|deviceSignature/i);
  assert.match(social, /upCountOf\(post\?\.upCount\)/);
  assert.match(social, /ownVoteOf\(post\?\.myVote\)/);
  // The one vote write: the signed publishVote builder, riding every click.
  assert.match(social, /invoke\(actions, 'vote', post, direction\)/);
  // Exactly one testid pair — the vote display never duplicates on expander
  // rows, menus, or overlays.
  assert.equal((social.match(/data-testid=\{`vote-\$\{direction\}`\}/g) ?? []).length, 1);
});

test("ac-4: the signed vote wire carries only postId and value — nothing else vote-derived crosses", () => {
  const builder = memberActions.match(/export async function publishVote[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(builder, /value/);
  assert.doesNotMatch(builder, /ratio|count|signature|memberDid/i, "the vote write payload carries postId and the value alone");
});

test("ac-4: comment rows render no vote affordance (the Oct 15 defer stands)", () => {
  const commentRow = social.slice(social.indexOf("function CommentRow") >= 0
    ? social.indexOf("function CommentRow")
    : social.indexOf("function Reply("), social.indexOf("// Post detail layout"));
  assert.doesNotMatch(commentRow, /aria-label="Lift"|aria-label="Lower"|vote-/, "no count, no highlight, nothing new on comment rows");
});

/* ---- live arrival -------------------------------------------------------- */

test("ac-1: an arriving up-vote delta merges into the river row in place — no remount, no slice disturbance", () => {
  const row = {
    _id: "p1", originNetworkId: "net-home", body: "hello",
    upCount: 3, myVote: null,
    replySlice: [{ _id: "c1", body: "first" }],
    knownResponses: ["c1"], replyTotal: 1,
    reactionRows: [{ emoji: "🍂", memberDid: ME, _id: "r1" }],
    lastActivityAt: "2026-10-19T12:00:00Z",
  };
  // The post.updated envelope class (the one event shape carrying upCount —
  // the vocabulary has no vote event; a missed delta re-derives on the next
  // served refetch, never a dedicated poll). The envelope carries no
  // per-member vote, ever: the river row's own myVote survives untouched.
  const next = applyEvent([row], {
    type: "post.updated", postId: "p1", networkId: "net-home", seq: 2,
    content: { body: "hello", upCount: 4 },
  }, { origin: HOME, network: HOME, log: console });
  assert.equal(next.length, 1, "the row updates in place, never remounts");
  const merged = next[0];
  assert.equal(merged.upCount, 4, "the count updates off the served payload delta");
  assert.equal(merged.replyTotal, 1);
  assert.deepEqual(merged.knownResponses, ["c1"]);
  assert.deepEqual(merged.replySlice, row.replySlice);
  assert.deepEqual(merged.reactionRows, row.reactionRows);
  assert.equal(merged.myVote, null);
});

/* ---- optimistic write shape (PORCH-038 class) and mode carry ------------- */

test("ac-3: the optimistic shadow and the rollback wiring ride the card's write", () => {
  const postCard = social.slice(social.indexOf("export function PostCard("), social.indexOf("function Heading("));
  // Same-frame optimism: the override applies before the write runs.
  assert.match(postCard, /const next = castVoteState\(post, direction\);/);
  assert.match(postCard, /setVoteOverride\(next\);[\s\S]{0,120}?operation\.run\(/s);
  // A failed write rolls the highlight and count back together; the refusal
  // renders in plain language (operation.error rides the card foot Alert).
  assert.match(postCard, /\(\) => setVoteOverride\(null\),/);
  assert.match(postCard, /operation\.error && <Alert severity="error"/);
  // The settled render is always the served value: the override retires the
  // moment the served row carries the same self-state.
  assert.match(postCard, /\(post\?\.myVote \?\? null\) === voteOverride\.vote\) setVoteOverride\(null\)/);
  // The response's effective vote re-derives the highlight.
  assert.match(postCard, /result\?\.vote\?\.effective/);
});

test("ac-5: count and arrow accent carry both display modes identically", async () => {
  const post = basePost({ upCount: 3, myVote: "up" });
  const light = await renderCard(post, { mode: "light" });
  const dark = await renderCard(post, { mode: "dark" });
  for (const html of [light, dark]) {
    const lift = voteButton(html, "Lift");
    const lower = voteButton(html, "Lower");
    assert.match(lift, />3</, "the count survives the mode switch unchanged");
    assert.doesNotMatch(lower, />\d</, "Lower stays bare in both modes");
    assert.doesNotMatch(lift, new RegExp(AMBER_PRESSED.light), "no circle background in either mode");
  }
  assert.match(voteButton(light, "Lift"), persistentRule(VOTE_HEX.light.up), "the light treatment rides the light token set");
  assert.match(voteButton(dark, "Lift"), persistentRule(VOTE_HEX.dark.up), "the lifted green rides the dark token set");
  assert.doesNotMatch(voteButton(dark, "Lift"), persistentRule(VOTE_HEX.light.up), "the dark set never serves the light green");
});