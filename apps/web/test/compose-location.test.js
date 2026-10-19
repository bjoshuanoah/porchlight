// Compose card location control pre-populated from context (PORCH-096,
// Brian Oct 16 2026 compose pre-population ruling): opening from a group
// surface pre-populates that group, opening from the main timeline
// pre-populates the general timeline; the target is always visible and
// pre-set, never implicit. The control is the edit composer's location
// control — the general timeline plus the author's groups only — riding
// the existing create write, no new server surface.
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
const shell = await readFile(join(webRoot, "src/main.jsx"), "utf8");

import { composableGroups, composePresetLocationId, groupRows, isGroupMember } from "../src/groups.js";

const { Groups } = await (async () => {
  const outDir = join(here, ".tmp096");
  await mkdir(outDir, { recursive: true });
  await build({
    stdin: { contents: 'export { Groups } from "./src/social.jsx";', resolveDir: webRoot, loader: "jsx", sourcefile: "entry.jsx" },
    bundle: true, format: "esm", jsx: "automatic", platform: "neutral",
    external: ["react", "react-dom", "@mui/*", "@emotion/*", "@noble/*", "socket.io-client", "unicode-emoji-json", "react-transition-group", "hoist-non-react-statics"],
    outfile: join(outDir, "surfaces.built.mjs"), logLevel: "silent",
  });
  const loaded = await import(join(outDir, "surfaces.built.mjs"));
  after(async () => { await rm(outDir, { recursive: true, force: true }); });
  return loaded;
})();

const composeSlice = social.slice(social.indexOf("export function Compose("), social.indexOf("export function Albums("));
const groupsSlice = social.slice(social.indexOf("export function Groups("), social.indexOf("function CreateGroupDialog("));

const ME = "did:porch:me";
const SIB = "did:porch:sister";
const NET = "net-home";
const groupsFixture = [
  { _id: "g1", name: "Lake Weekend", members: [ME, SIB], networkId: NET },
  { _id: "g2", name: "Inner Circle", members: [SIB], networkId: NET },
  { _id: "g3", name: "Cousins", members: [ME], networkId: "net-elsewhere" },
];
const composeData = {
  identity: { id: ME },
  network: { _id: NET, name: "The Noah Family" },
  groups: groupsFixture,
};

/* ---- ac-1: pre-population from context ---------------------------------- */

test("ac-1: the pre-set resolver carries a context group the author belongs to, and the general timeline everywhere else", () => {
  const offered = composableGroups(groupRows(groupsFixture, NET), ME);
  assert.equal(composePresetLocationId("g1", offered, ME), "g1", "a group surface composes into that group");
  assert.equal(composePresetLocationId("", offered, ME), "", "the main timeline composes onto the general timeline");
  assert.equal(composePresetLocationId(null, offered, ME), "", "no context target pre-sets the general timeline");
  // Option law holds for the pre-set too: a group the author does not
  // belong to never pre-populates what the control cannot carry.
  assert.equal(composePresetLocationId("g2", offered, ME), "", "a non-member group falls back to the general timeline");
  assert.equal(composePresetLocationId("g3", offered, ME), "", "a foreign network's group falls back to the general timeline");
});

test("ac-1: the compose card pre-sets the staged target on every open, never mid-open", () => {
  assert.match(composeSlice, /presetRef\.current = composePresetLocationId\(target, groups, data\.identity\?\.id\)/);
  assert.match(composeSlice, /if \(open && !lastOpenRef\.current\) \{\n\s*setGroupId\(presetRef\.current\);[\s\S]*?\n\s*\}\n\s*lastOpenRef\.current = open;/,
    "the open transition pre-populates the location control from context");
});

test("ac-1: the shell derives the context target from the surface — a group route pre-sets that group, anywhere else the general timeline", () => {
  assert.match(shell, /composeTargetOfRoute = \(path\) => \{[\s\S]*?\^\\\/groups\\\/\(\[\^\/\?#\]\+\)\/[\s\S]*?decodeURIComponent\(match\[1\]\)/,
    "the /groups/<id> route names the composing group");
  assert.match(shell, /setComposeTarget\(composeTargetOfRoute\(window\.location\.pathname\)\)/,
    "the /compose navigation captures the surface it opened from");
  assert.match(shell, /const openCompose = \(\) => \{ setComposeTarget\(composeTargetOfRoute\(route\)\); setComposeOpen\(true\); \}/,
    "the shell compose controls open from the current surface");
  assert.match(shell, /<Compose open=\{composeOpen\} onClose=\{\(\) => \{ setComposeOpen\(false\); setComposeStaging\(null\); \}\} target=\{composeTarget\} staged=\{composeStaging\} \{\.\.\.props\} \/>/,
    "the staged context target rides the compose mount; closing compose discards staged share content");
});

test("ac-1: the group surface carries the '+ New post' compose entry riding the pre-populated control", async () => {
  // Rendered sweep: the entry belongs to the group surface and only to
  // members — a non-member's offered targets never include this group.
  const memberHtml = renderToString(React.createElement(Groups, { data: { ...composeData }, actions: {}, navigate: null, id: "g1" }));
  assert.match(memberHtml, /data-testid="group-new-post"/);
  assert.match(memberHtml, /\+ New post/);
  const outsiderHtml = renderToString(React.createElement(Groups, { data: { ...composeData, identity: { id: "did:porch:outsider" } }, actions: {}, navigate: null, id: "g1" }));
  assert.doesNotMatch(outsiderHtml, /group-new-post/, "no group-surface entry where the group is not an offered target");
  assert.match(groupsSlice, /onClick=\{\(\) => navigate\?\.\('\/compose'\)\} data-testid="group-new-post"/,
    "the entry opens the compose card, target never implicit");
  assert.equal(isGroupMember(groupsFixture[0], ME), true);
});

/* ---- ac-2: the option law ----------------------------------------------- */

test("ac-2: the location control always renders, pre-set, with the general timeline plus the author's groups only", () => {
  assert.match(composeSlice, /label="Post to"/, "the same control the edit composer carries");
  assert.doesNotMatch(composeSlice, /Group \(optional\)/, "the silent optional-group phrasing is superseded");
  assert.doesNotMatch(composeSlice, /groups\.length > 0 && <FormControl/, "the target is always visible and pre-set");
  assert.match(composeSlice, /<MenuItem value="">General timeline<\/MenuItem>/);
  assert.match(composeSlice, /composableGroups\(groupRows\(data\.groups, data\.network\?\.id\), data\.identity\?\.id\)/,
    "the offered rows are the author's groups within the open network");
  // The rows the control actually consumes: member groups of the open
  // network only — never a non-member group, never another network.
  const rows = composableGroups(groupRows(groupsFixture, NET), ME).map((group) => group.name);
  assert.deepEqual(rows, ["Lake Weekend"]);
});

test("ac-2: a staged choice survives roster refreshes — only the open transition pre-sets", () => {
  assert.match(composeSlice, /lastOpenRef\.current = open;\n\s{2}\}, \[open\]\)/,
    "the preset effect holds only the open transition, not [target]/[groups]");
});

/* ---- ac-3: the write path ------------------------------------------------ */

test("ac-3: the staged target rides the existing create write — no new server surface", () => {
  // General timeline → null (the existing general creation); group → the
  // group id through the same submitPost contract.
  assert.match(composeSlice, /groupId: groupId \|\| null/);
  assert.match(social, /invoke\(actions, 'submitPost', \{ type, body: mediaType \? null : body\.trim\(\), caption/);
  assert.match(composeSlice, /operation\.error && <Alert severity="error">\{operation\.error\}<\/Alert>/,
    "a refused target renders the hub's plain-language copy and posts nothing");
});

/* ---- ac-4: the cross-post boundary --------------------------------------- */

test("ac-4: the compose card binds the single-network path — no cross-post block exists in it", () => {
  // The cross-post block renders only when the member belongs to multiple
  // networks; the V1 compose card is bound to the open network (connection
  // per origin), so the block does not exist here and the location control
  // binds the single-network path (general timeline + this network's
  // groups via groupRows' networkId scoping).
  assert.doesNotMatch(composeSlice, /Each network gets its own post|checked|Checkbox|networks\.map/,
    "no per-network checkbox block in the compose card");
  assert.match(composeSlice, /groupRows\(data\.groups, data\.network\?\.id\)/,
    "the control scopes its groups to the open network — the single-network path");
  // Cross-network writes are per-post origin-decided (a group post rides
  // its own origin, never the active connection) — pinned in
  // test/card-interactions.test.js (connectionForPostOrigin).
  assert.match(shell, /const \[connections, setConnections\]/, "one origin connection at a time per open identity");
});