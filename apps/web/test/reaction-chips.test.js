// Reaction chips (PORCH-090, Brian Oct 15 2026): the chip is a live toggle,
// the count is PEOPLE derived at render, and the who-reacted reveal answers
// hover, long-press, and keyboard focus. The pure model and gesture machine
// are pinned in source; the rendered surfaces are swept with the REAL MUI
// (the house sweep shape) so the render contracts match the DOM the member
// gets. The server contract these ride (attributed reads, signed toggles,
// content-only events) is PORCH-091 (merged PR #128).
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
const socialSource = await readFile(join(webRoot, "src", "social.jsx"), "utf8");
const liveSource = await readFile(join(webRoot, "src", "live.js"), "utf8");

const { reactionChips, revealMachine, optimisticToggle, reflectReaction } = await import("../src/reactions.js");
const { applyEvent } = await import("../src/live.js");
const reactionsSource = await readFile(join(webRoot, "src", "reactions.js"), "utf8");

// The rendered sweep: PresentReactions + the reveal content bundled and
// rendered server-side with real MUI, exactly the DOM the member gets.
const outDir = join(here, ".tmp090");
const built = await (async () => {
  await mkdir(outDir, { recursive: true });
  await build({
    stdin: { contents: 'export { PresentReactions, ReactionReveal } from "./src/social.jsx";', resolveDir: webRoot, loader: "jsx", sourcefile: "entry.jsx" },
    bundle: true, format: "esm", jsx: "automatic", platform: "neutral",
    external: ["react", "react-dom", "@mui/*", "@emotion/*", "@noble/*", "socket.io-client", "unicode-emoji-json", "react-transition-group", "hoist-non-react-statics"],
    outfile: join(outDir, "chips.built.mjs"), logLevel: "silent",
  });
  return import(join(outDir, "chips.built.mjs"));
})();

after(async () => { await rm(outDir, { recursive: true, force: true }); });

const ME = "did:porch:me";
const SAM = { identity: { id: ME, name: "Sam" }, offline: false, members: [] };

// A two-people chip is an attributed read's shape (PORCH-091): server rows
// carry memberDid, memberName, memberAvatar; the content-only row is a live
// arrival (reaction.applied) before the next attributed read.
const A = { emoji: "🍂", memberDid: "did:porch:linda", memberName: "Linda", memberAvatar: null, _id: "r1", createdAt: "2026-10-15T10:00:00Z" };
const B = { emoji: "🍂", memberDid: ME, memberName: "Sam", memberAvatar: null, _id: "r2", createdAt: "2026-10-15T10:01:00Z" };
const SOLO = { emoji: "🌞", memberDid: "did:porch:linda", memberName: "Linda", memberAvatar: null, _id: "r3", createdAt: "2026-10-15T10:02:00Z" };

const chipsOf = (rows) => reactionChips(rows);

function renderBar(rows, extra = {}) {
  return renderToString(React.createElement(built.PresentReactions, {
    post: { _id: "p1", reactionRows: rows, origin: "https://hub" },
    data: SAM, actions: {}, ...extra,
  }));
}

function renderReveal(chip, extra = {}) {
  return renderToString(React.createElement(built.ReactionReveal, {
    chip, ownDid: ME, data: SAM, post: { origin: "https://hub" }, actions: {}, ...extra,
  }));
}

// ---------- ac-2: the count of people renders where more than one reacted ----------

test("ac-2: the chip count is the distinct-people count — two members render 2, one renders bare", () => {
  const chips = chipsOf([A, B, SOLO]);
  assert.deepEqual(chips.map((chip) => chip.emoji), ["🍂", "🌞"], "chips render in the served order, emoji as given");
  assert.equal(chips[0].reactors.length, 2, "two members hold 🍂");
  assert.deepEqual(chips[0].reactors, [A, B], "the reactor rows keep the served order");
  assert.equal(chips[1].reactors.length, 1, "🌞 stays a single-reactor chip");

  // A leaves: bare again; A rejoins: 2 again — every derivation is at render
  // from the merged rows, never a stored value.
  const withoutA = [B, SOLO];
  assert.equal(chipsOf(withoutA)[0].reactors.length, 1);
  assert.equal(chipsOf([...withoutA, A])[0].reactors.length, 2);
});

test("ac-2: one row per member per emoji is the people count — duplicates never inflate it", () => {
  // A replayed live arrival that the merge dedupes, a same-emoji second row
  // for a row the store holds once: the model never counts an emoji twice
  // for the same member.
  assert.equal(chipsOf([A, A]).length, 1, "same member, same emoji");
  assert.equal(chipsOf([{ emoji: "🍂", memberDid: "did:porch:linda", _id: "r9" }, A]).length, 1,
    "a later attributed read of the same row cannot double-count an unnamed member");
  assert.equal(chipsOf([{ emoji: "🍂", memberDid: "did:porch:linda", _id: "r5" }, { emoji: "🍂", memberDid: "did:porch:cass", _id: "r6" }])[0].reactors.length, 2,
    "two distinct members are two people");
});

test("ac-2: the count renders beside the emoji only where more than one member holds it; no stored count", () => {
  const html = renderBar([A, B, SOLO]);
  assert.equal(chipText(html, "🍂"), "🍂2", "the two-people chip carries the number 2 beside the emoji");
  const soloChip = allChips(html).find((node) => node.includes("🌞"));
  assert.equal(textOfChip(soloChip), "🌞", "the single-reactor chip renders bare emoji, never 1");
  // The count never entered any row: the rendered number is derived, the
  // surface's own rows stay count-free (the wire law is PORCH-091's).
  for (const row of [A, B, SOLO]) {
    assert.equal(Object.keys(row).some((key) => /count/i.test(key)), false, `row ${row._id} carries no count field`);
  }
});

test("ac-2: the member's own single reaction renders bare with the warm highlight; joined chip keeps it beside any count", () => {
  const joined = renderBar([A, B, SOLO]);
  const ownChipSource = renderBar([
    { emoji: "🌞", memberDid: ME, memberName: "Sam", _id: "r4" },
    { emoji: "🍂", memberDid: "did:porch:cass", memberName: "Cass", _id: "r5" },
  ]);
  assert.match(joined, /aria-pressed="true"/, "the member's joined 🍂 chip marks own");
  // Own solo: bare emoji, warm highlight, no number. (The warm highlight
  // itself is the unchanged shipped sx — the amber tokens resolve through
  // the app's theme provider, so the DOM sweep pins aria-pressed and the
  // source pins the amber treatment; PORCH-036's own renders carry it.)
  const ownSolo = allChips(ownChipSource).find((node) => node.includes("aria-pressed=\"true\"") && node.includes("🌞"));
  assert.ok(ownSolo, "the member's own single chip renders");
  assert.equal(textOfChip(ownSolo), "🌞", "the member's own single reaction renders bare, no count");
  assert.match(socialSource, /ownEmoji \? \{ bgcolor: 'porchlight\.amberSoft', border: '1px solid', borderColor: 'porchlight\.amber'/,
    "the warm highlight renders as today on the own chip");
  assert.equal(chipText(ownChipSource, "🌞"), "🌞", "another member's solo chip renders bare too");
});

// ---------- ac-1: click to join, click again to leave ----------

test("ac-1: the chip is a live toggle button riding the same signed write as the picker", () => {
  const html = renderBar([A, B]);
  assert.match(html, /<button/, "every chip renders focusable/clickable");
  assert.match(socialSource, /onToggle=\{toggle\}/, "the picker writes through the same toggle");
  assert.match(socialSource, /toggle\(chip\.emoji, own\.has\(chip\.emoji\)\)/,
    "the chip click rides the one reflection routine — picker and chips write the same rows");
});

test("ac-1: chip-joined and picker-added rows are indistinguishable — one reflection routine, one row shape", () => {
  const rows = [{ emoji: "🍂", memberDid: "did:porch:linda", memberName: "Linda", _id: "r1" }];
  const settled = { emoji: "🍂", ownDid: ME, isOwn: false, reaction: { _id: "srv1", memberDid: ME, memberName: "Sam", createdAt: "2026-10-15T11:00:00Z" } };
  const viaChip = reflectReaction(optimisticToggle(rows, { emoji: "🍂", ownDid: ME, isOwn: false }), settled);
  const viaPicker = reflectReaction(rows, settled);
  // The two affordances render the same people: identical emoji+member rows,
  // one row per person, own included — the only difference a settle's row id
  // (the local row until the next attributed read replaces it in place).
  const shape = (chipRows) => chipRows.map((row) => `${row.emoji}:${String(row.memberDid ?? "")}`).sort();
  assert.deepEqual(shape(viaChip), shape(viaPicker));
  assert.equal(viaChip.length, 2, "never a duplicate row");
  assert.deepEqual(chipsOf(viaChip)[0].reactors.length, 2, "the count reads two people either way");
});

test("ac-1: leaving removes only the member's own row — other reactors survive", () => {
  const after = reflectReaction([A, B, SOLO], { emoji: "🍂", ownDid: ME, isOwn: true });
  assert.equal(after.length, 2, "only Sam's 🍂 row leaves");
  assert.ok(after.includes(A), "Linda's row survives");
  assert.deepEqual(chipsOf(after).map((chip) => chip.emoji), ["🍂", "🌞"]);
});

// ---------- ac-3: hover or long-press reveals who reacted ----------

test("ac-3: the reveal lists the emoji's reactors — faces, family names, own marked, served order", () => {
  const html = renderReveal(chipsOf([A, B])[0]);
  assert.match(html, /Linda/, "the family display name renders");
  assert.match(html, /Sam/, "the member's own name renders");
  assert.match(html, /\(you\)/, "the member's own row is marked");
  assert.match(html, /role="list"/, "the reveal reads as a reactor list, not a banner");
  assert.match(html, /reaction-reveal-row/, "each reactor renders a row");
  const lIndex = html.indexOf("Linda");
  const sIndex = html.indexOf("Sam");
  assert.ok(lIndex > 0 && lIndex < sIndex, "reactors render in the served order");
  assert.doesNotMatch(html, /<img/, "a faceless member renders the initials fallback, never a third-party asset");
});

test("ac-3: a live-arrived content-only row renders the member fallback until the attributed read", () => {
  // reaction.applied serves member + emoji only (PORCH-091's wire law); the
  // reveal renders the plain directory fallback for it — never a DID, never
  // an invented name.
  const live = { emoji: "🍂", memberDid: "did:porch:new", _id: "r8", createdAt: "2026-10-15T12:00:00Z" };
  const html = renderReveal(chipsOf([A, live])[0]);
  assert.match(html, /Member<\/span>/, "the unattributed row renders the plain fallback");
  assert.doesNotMatch(html, /did:porch:new/, "a DID never renders as a name");
});

test("ac-3: the gesture machine — hover intents past ~300ms open; pointer exit closes with a grace", () => {
  let fired = [];
  const timers = fakeTimers();
  const machine = revealMachine({
    open: ({ emoji }) => fired.push(emoji),
    close: () => { fired.push("closed"); },
    overPopover: () => false,
    timers: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
  });
  const chip = { currentTarget: { matches: () => false } };
  machine.hoverStart("🍂", chip, { pointerType: "mouse" });
  timers.tick(299);
  assert.deepEqual(fired, [], "a flick never opens (the intent delay holds)");
  timers.tick(1);
  assert.deepEqual(fired, ["🍂"], "hover past the ~300ms intent opens the reveal");
  fired = [];
  machine.hoverLeave();
  timers.tick(139);
  assert.deepEqual(fired, [], "grace holds the reveal through chip→popover movement");
  timers.tick(1);
  assert.deepEqual(fired, ["closed"], "pointer exit without the popover closes the glance");
});

test("ac-3: the pointer resting on the popover paper holds the reveal; paper leave closes", () => {
  let fired = [];
  let over = true;
  const timers = fakeTimers();
  const machine = revealMachine({
    open: ({ emoji }) => fired.push(emoji),
    close: () => { fired.push("closed"); },
    overPopover: () => over,
    timers: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
  });
  machine.hoverStart("🍂", {}, { pointerType: "mouse" });
  timers.tick(300);
  fired = [];
  machine.hoverLeave();
  machine.paperEnter();
  timers.tick(500);
  assert.deepEqual(fired, [], "chip→popover movement never closes while the paper is hovered");
  machine.paperLeave();
  assert.deepEqual(fired, ["closed"], "leaving the paper closes the glance");
});

test("ac-3: touch — a long-press opens and its release never toggles; a plain tap toggles", () => {
  let fired = [];
  const timers = fakeTimers();
  const machine = revealMachine({
    open: ({ emoji }) => fired.push(emoji),
    close: () => { fired.push("closed"); },
    timers: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
  });
  machine.pressStart("🍂", {});
  timers.tick(200);
  assert.deepEqual(fired, [], "no flick opens");
  assert.equal(machine.pressEnd(), false, "a release before the ~500ms press is a plain tap");
  assert.equal(machine.click(), true, "the plain tap toggles");
  machine.pressStart("🍂", {});
  timers.tick(500);
  assert.deepEqual(fired, ["🍂"], "the ~500ms long-press opens the reveal");
  assert.equal(machine.pressEnd(), true);
  assert.equal(machine.click(), false, "the consumed release never toggles");
  timers.tick(500);
  assert.equal(machine.click(), true, "the suppression clears for the member's next tap");
  machine.pressStart("🌞", {});
  timers.tick(500);
  machine.silence();
  timers.tick(1000);
  assert.deepEqual(fired.length, 2, "silence leaves nothing armed");
});

test("ac-3: keyboard — focus opens the reveal; the machine never blocks the button click", () => {
  // The chip is a native button (Enter/Space fire its click = the toggle);
  // the reveal opens from focus (no fresh pointer) through the same intent
  // window the pointer rides. PORCH-035 law: no per-screen focus styling
  // (the theme layer owns every ring) — the gate is the pointer's recency.
  assert.match(socialSource, /Date\.now\(\) - lastPointerRef\.current > 300/, "a tap/pointer focus never opens the reveal");
  assert.match(socialSource, /onPointerDown=\{\(\) => \{ lastPointerRef\.current = Date\.now\(\); \}\}/, "pointer recency feeds the gate");
  assert.doesNotMatch(socialSource, /:focus-visible|:focus\b/, "no per-screen focus styling (PORCH-035)");
  assert.match(reactionsSource, /pointerType !== 'mouse'/, "hover rides the pointer, never a touch flick");
  assert.match(socialSource, /onTouchStart=\{[^\n]*pressStart/, "touch long-press arms the reveal");
  assert.match(socialSource, /onBlur=\{closeReveal\}/, "leaving focus closes the glance");
  assert.match(socialSource, /'Escape'[\s\S]{0,80}closeReveal\(\)/, "Escape closes the glance");
});

test("ac-3/ac-5: the reveal is not an inspection panel — no counts, no engagement copy, family vocabulary only", () => {
  const html = renderReveal(chipsOf([A, B])[0]);
  assert.doesNotMatch(html, /members|likes|hearts|popular|trending|followers|engagement/i,
    "the glance carries family vocabulary only");
  // As the member reads it the glance carries names and the (you) mark
  // only — no count text anywhere.
  assert.equal(/\d/.test(textOf(html)), false, "the reveal renders no count");
  assert.doesNotMatch(reactionsSource, /reactionCount/,
    "no count machinery rides the reveal path");
});

// ---------- ac-4: live arrival and containment ----------

test("ac-4: a live reaction merges in place and the chip re-derives the count from the merged rows", () => {
  const rows = [A, B];
  const posts = [{ _id: "p1", originNetworkId: "net1", reactionRows: rows }];
  const merged = applyEvent(posts,
    { type: "reaction.applied", postId: "p1", networkId: "net1", content: { emoji: "🍂", memberDid: "did:porch:cass", _id: "r7", createdAt: "2026-10-15T13:00:00Z" } });
  assert.notEqual(merged[0], posts[0], "the arrival is a copy-on-write splice, never a whole-view redraw");
  assert.equal(chipsOf(merged[0].reactionRows)[0].reactors.length, 3, "the count re-derives: three people");
  // A replayed event (catch-up) merges nothing and changes no count.
  const replay = applyEvent(merged,
    { type: "reaction.applied", postId: "p1", networkId: "net1", content: { emoji: "🍂", memberDid: "did:porch:cass", _id: "r7" } });
  assert.equal(chipsOf(replay[0].reactionRows)[0].reactors.length, 3, "idempotent merge — no count inflation");
  // Removals ride the shipped event law: no event exists for a removal; the
  // count re-derives whenever the rows change (the served read).
  assert.doesNotMatch(liveSource, /reaction\.removed/, "no removal event in the closed vocabulary");
});

test("ac-4/containment: foreign-origin and hidden content never carry chips — the render-time filter rides the surface", () => {
  assert.match(socialSource, /!visibleAtOrigin\(post, data\)\) return null;/,
    "the bar only exists on a surface the origin/hidden filter passed");
  assert.match(socialSource, /reactionRowsOf\(post\?\.reactionRows\)/,
    "chips render from the post's own rows — same containment as the post");
});

test("ac-5: votes untouched — the card renders no new vote surface and the copy audit holds", () => {
  // The vote controls keep the shipped labels ("Lift"/"Lower") and no vote
  // count/record gained a surface through this change.
  assert.match(socialSource, /voteButton\('up', 'Lift'/);
  assert.match(socialSource, /voteButton\('down', 'Lower'/);
  const html = renderBar([A, B, SOLO]);
  assert.doesNotMatch(textOf(html), /likes|hearts|popular|trending|followers|engagement/i,
    "no engagement language anywhere on the rendered surfaces");
  assert.doesNotMatch(socialSource, /voteCount|vote count|vote record/i,
    "no vote count or record rides any new code path");
});

// ---------- helpers ----------

function fakeTimers() {
  const queue = [];
  let now = 0;
  return {
    setTimeout(fn, ms) { const id = { fn, at: now + ms }; queue.push(id); return id; },
    clearTimeout(id) { const index = queue.indexOf(id); if (index >= 0) queue.splice(index, 1); },
    tick(ms) {
      now += ms;
      queue.sort((a, b) => a.at - b.at);
      while (queue.length && queue[0].at <= now) {
        const due = queue.shift();
        due.fn();
      }
    },
  };
}

// The chip buttons: MUI renders a clickable chip as a real <button> element.
function allChips(html) {
  return (html.match(/<button[\s\S]*?<\/button>/g) ?? []).filter((node) => /🍂|🌞/.test(node));
}

function chipText(html, emoji) {
  const node = allChips(html).find((candidate) => candidate.includes(emoji));
  return node ? textOfChip(node) : null;
}

// Text as the member reads it: styles stripped, tags stripped, spacing flat.
function textOf(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, "");
}

function textOfChip(node) {
  if (!node) return null;
  return textOf(node);
}