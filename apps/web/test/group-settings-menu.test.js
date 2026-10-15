// Group settings menu (PORCH-089, Brian Oct 15 2026): the menu contract's
// pure half pinned in source, the wire shapes the app's writes carry, and
// the rendered surfaces swept with the REAL MUI (the house sweep shape).
// Enforcement is server-side (PORCH-088, merged PR #125); these tests pin
// what the client renders and the shapes it signs.
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
const groupService = await readFile(join(webRoot, "..", "..", "modules/social/src/services/group.service.js"), "utf8");

const {
  groupMenuRows, groupToggleLine, resolvedGroupNotification, withGroupPreference,
  GROUP_COLOR_ROWS, GROUP_NO_COLOR, GROUP_PRIVACY_ROWS, groupMemberRemoveCopy,
} = await import("../src/group-settings.js");
const { groupAvatarDeclaration, groupColorPayload, groupPostRemovePayload } = await import("../src/member-actions.js");

// The rendered sweep: the Groups page bundled and rendered server-side with
// real MUI, so the render contracts are checked against the DOM the member
// actually gets.
const outDir = join(here, ".tmp089");
let socialModule = null;
async function surfaces() {
  if (socialModule) return socialModule;
  await mkdir(outDir, { recursive: true });
  await build({
    stdin: { contents: 'export { Groups, GroupSettingsMenu } from "./src/social.jsx";', resolveDir: webRoot, loader: "jsx", sourcefile: "entry.jsx" },
    bundle: true, format: "esm", jsx: "automatic", platform: "neutral",
    external: ["react", "react-dom", "@mui/*", "@emotion/*", "@noble/*", "socket.io-client", "unicode-emoji-json", "react-transition-group", "hoist-non-react-statics"],
    outfile: join(outDir, "surfaces.built.mjs"), logLevel: "silent",
  });
  socialModule = await import(join(outDir, "surfaces.built.mjs"));
  return socialModule;
}
after(async () => { await rm(outDir, { recursive: true, force: true }); });

test("ac-1: the menu renders from the detail read's authority flags — owner set, member subset", () => {
  const ownerGroup = { notifications: { perGroup: true }, isManagingMember: true, isNetworkOwner: false };
  const ownerSuper = { notifications: { perGroup: true }, isManagingMember: false, isNetworkOwner: true };
  const memberGroup = { notifications: { perGroup: true }, isManagingMember: false, isNetworkOwner: false };
  assert.deepEqual(
    groupMenuRows(ownerGroup, {}),
    ["photo", "color", "members", "privacy", "notifications"],
    "the managing member sees the owner set plus the notifications row",
  );
  assert.deepEqual(groupMenuRows(ownerSuper, {}), groupMenuRows(ownerGroup, {}),
    "the network owner rides the same owner set (the superuser)");
  assert.deepEqual(groupMenuRows(memberGroup, {}), ["members", "notifications"],
    "a plain member's subset: the roster view and the notifications row");
  assert.deepEqual(groupMenuRows(null, {}), [], "no group anchors no menu");

  // Index rows (the groups read without the flags) fall back to the shipped
  // client predicate — creator or network role — and every write re-checks
  // authority at the hub.
  const viewer = { identity: { id: "did:me" }, members: [] };
  assert.deepEqual(groupMenuRows({ createdBy: "did:me" }, viewer),
    ["photo", "color", "members", "privacy", "notifications"]);
  assert.deepEqual(groupMenuRows({ createdBy: "did:other" }, viewer), ["members", "notifications"]);
  const ownerViewer = { identity: { id: "did:me" }, members: [{ did: "did:me", role: "owner" }] };
  assert.deepEqual(groupMenuRows({ createdBy: "did:other" }, ownerViewer),
    ["photo", "color", "members", "privacy", "notifications"]);
});

test("ac-2: the ruled accent palette mirrors the server's palette tokens, named", () => {
  // The server tokens (modules/social GROUP_COLOR_PALETTE) read from source.
  const tokens = [...groupService.matchAll(/"#[0-9A-Fa-f]{6}"/g)].map((match) => match[0].replaceAll('"', ""));
  assert.deepEqual(
    GROUP_COLOR_ROWS.map((row) => row.value),
    tokens,
    "the color view offers exactly the palette the hub validates",
  );
  assert.equal(GROUP_COLOR_ROWS.every((row) => typeof row.name === "string" && row.name), true,
    "every swatch carries its family name");
  assert.equal(GROUP_NO_COLOR, null, "the no-color swatch writes the neutral reset");
  assert.deepEqual(groupColorPayload("#D88A24"), { scope: "group-avatar", action: "color", color: "#D88A24" });
  assert.deepEqual(groupColorPayload(null), { scope: "group-avatar", action: "color", color: null });
});

test("ac-2: the color write's signed payload and the avatar declaration shapes are exact", () => {
  assert.deepEqual(groupAvatarDeclaration({ size: 4242, sha256: "ab12", contentType: "image/png" }),
    { scope: "group-avatar", action: "set", size: 4242, sha256: "ab12", contentType: "image/png" },
    "the avatar write's header declaration, scoped group-avatar");
  assert.deepEqual(groupColorPayload("#7E8F6E"),
    { scope: "group-avatar", action: "color", color: "#7E8F6E" },
    "the color write's device-signed JSON payload");
  // Source pins: the routes the bytes and bodies ride.
  assert.match(memberActions, /social\/groups\/\$\{encodeURIComponent\(groupId\)\}\/avatar/);
  assert.match(memberActions, /"x-porchlight-avatar-payload"[\s\S]*?JSON\.stringify\(payload\)/);
  assert.match(memberActions, /social\/groups\/\$\{encodeURIComponent\(groupId\)\}\/color/);
  assert.match(memberActions, /method: "PATCH"/);
});

test("ac-3: the remove-post payload and its confirmation copy are exact", () => {
  assert.deepEqual(
    groupPostRemovePayload({ _id: "p1", groupId: "g1", originNetworkId: "net1" }),
    { kind: "group_post_remove", postId: "p1", groupId: "g1", networkId: "net1" },
    "the signed moderation payload the server rebuilds and verifies",
  );
  assert.match(social, /This removes the post everywhere it appears/);
  assert.match(social, /remove-group-post/);
  assert.match(memberActions, /social\/groups\/\$\{encodeURIComponent\(payload\.groupId\)\}\/posts\/\$\{encodeURIComponent\(payload\.postId\)\}/);
});

test("ac-4: the corrected pairing verbatim, both directions, never inverted", () => {
  assert.equal(groupToggleLine(true), "On: you'll get notifications for this group's posts.");
  assert.equal(groupToggleLine(false), "Off: this group's notifications are paused.");
  assert.equal(resolvedGroupNotification({ notifications: { perGroup: true } }), true);
  assert.equal(resolvedGroupNotification({ notifications: { perGroup: false } }), false);
  assert.equal(resolvedGroupNotification({}), true, "unset resolves ON");
  assert.equal(resolvedGroupNotification(null), true, "no state resolves ON");
  // The toggle writes the member's settings row whole: the persisted groups
  // entries merge, never drop.
  assert.deepEqual(
    withGroupPreference({ enabled: true, events: { reply: true }, mutes: [], groups: { g1: false } }, "g2", false),
    { enabled: true, events: { reply: true }, mutes: [], groups: { g1: false, g2: false } },
  );
  assert.deepEqual(withGroupPreference({}, "g1", true).groups, { g1: true });
});

test("ac-6: the confirmations render copy in place; cancel refuses by construction", () => {
  assert.equal(
    groupMemberRemoveCopy("Cassidy", { name: "Boat Club" }),
    "This removes Cassidy from Boat Club. Their posts stay in place, and they cannot rejoin unless re-invited.",
  );
  assert.equal(groupMemberRemoveCopy(null, null),
    "This removes this member from this group. Their posts stay in place, and they cannot rejoin unless re-invited.");
  // The privacy rows carry the ruled consequence lines verbatim.
  assert.deepEqual(
    GROUP_PRIVACY_ROWS.map((row) => [row.value, row.label, row.line]),
    [
      ["public", "Public", "Public: any member can find it and join."],
      ["private", "Private", "Private: invite-only."],
    ],
  );
});

test("menu shape: the options control is an MUI IconButton anchored menu on the group surface", () => {
  assert.match(social, /aria-label="Group options"/);
  assert.match(social, /data-testid="group-settings-menu"/);
  assert.match(social, /<MoreVertOutlined \/><\/IconButton>/);
});

test("presentation: chips stay color-independent; faces render through the hub's own loads", () => {
  // The group chip's amber treatment is the shipped constant — the color is
  // never allowed to ride the chips.
  assert.match(social, /post\.groupName && <Chip label=\{post\.groupName\}[^\n]*'porchlight\.amberSoft'/);
  // The group face's bytes ride the authorized rung loader (hub origin
  // only, blob-cached) — never a raw third-party URL.
  assert.match(social, /loadGroupAvatarRendition/);
  assert.doesNotMatch(social, /https?:\/\/[^"'` ]*\.(?:png|jpg|svg)/);
});

test("render sweep: the group page carries the options control and no on-face members card", async () => {
  const { Groups } = await surfaces();
  const group = {
    _id: "grp_boat", networkId: "net1", name: "Boat Club",
    visibility: "public", members: ["did:me", "did:cass"], names: { "did:me": "Sam", "did:cass": "Cassidy" },
    createdBy: "did:me", color: null, avatar: null,
  };
  const data = {
    identity: { id: "did:me", name: "Sam" },
    server: { url: "https://hub" },
    network: { _id: "net1", name: "Home" },
    groups: [group],
    members: [],
  };
  const actions = {};
  // The viewer's own loaded read stands in for the detail fetch's shape.
  const html = renderToString(React.createElement(Groups, { data, actions, navigate: null, id: "grp_boat" }));
  assert.ok(html.includes("Group options"), "the group surface renders the options control");
  assert.ok(html.includes("Boat Club"), "the identity header renders the group name");
  // The roster is off the face: the shipped members card's face copy and
  // controls are gone from the page.
  assert.doesNotMatch(html, /You created this group/);
  assert.ok(html.includes("Removed — they cannot rejoin") === false);
  // The neutral default: no avatar bytes exist, so no face image renders —
  // the fallback block stays neutral, exactly as the page read before.
  assert.doesNotMatch(html, /<img[^>]*src=/);
});

test("render sweep: a colored avatar-less group carries the color accent; a neutral group renders plain", async () => {
  const { Groups } = await surfaces();
  const group = {
    _id: "grp_boat", networkId: "net1", name: "Boat Club",
    visibility: "private", members: ["did:me"], createdBy: "did:me",
    color: "#C4674B", avatar: null,
  };
  const colored = renderToString(React.createElement(Groups, {
    data: {
      identity: { id: "did:me" }, server: { url: "https://hub" },
      network: { _id: "net1", name: "Home" }, groups: [group], members: [],
    },
    actions: {}, navigate: null, id: "grp_boat",
  }));
  assert.ok(colored.includes("#C4674B"), "the color renders as the header's accent on the fallback block");
  const plain = renderToString(React.createElement(Groups, {
    data: {
      identity: { id: "did:me" }, server: { url: "https://hub" },
      network: { _id: "net1", name: "Home" }, members: [],
      groups: [{ ...group, color: null }],
    },
    actions: {}, navigate: null, id: "grp_boat",
  }));
  assert.equal(
    GROUP_COLOR_ROWS.some((row) => plain.includes(row.value)),
    false,
    "the neutral group renders without any accent color from the group palette",
  );
});

test("render sweep: the menu's surface control is hidden with the group — timeline never gated", async () => {
  const { Groups } = await surfaces();
  // No group row available (loading state): nothing anchors; the page keeps
  // rendering its timeline shell.
  const html = renderToString(React.createElement(Groups, {
    data: {
      identity: { id: "did:me" }, server: { url: "https://hub" },
      network: { _id: "net1", name: "Home" }, members: [], groups: [null, {}],
    },
    actions: {}, navigate: null, id: "grp_lost",
  }));
  assert.doesNotMatch(html, /Group options/, "no options control without a group row");
});