// Notification Settings screen (PORCH-060): the member's control room for
// push. The pure module is exercised directly (capability truth table,
// settings transforms, the Enable flow with injected fakes, tap-through);
// the wiring, the components, and the worker carry their contracts as
// source pins (the same style as the pwa-install and photo-first pins).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  CAPABILITY_LINES,
  EVENT_ROWS,
  HANDOFF_LINE,
  OWNER_EVENT_KEYS,
  OWNER_EVENT_LABEL,
  base64UrlToBytes,
  decodePushPayload,
  enablePush,
  muteRows,
  normalizeSettings,
  notificationCapability,
  postPath,
  reenableGuidance,
  receivesOwnerEvents,
  tapDecision,
  withEvent,
  withMaster,
  withMute,
  withOwnerEvents,
} from "../src/notifications.js";

// Per-network mute rows (ac-1): a row per network the open identity
// belongs to, deduplicated by networkId, with an honest name fallback.
test("PORCH-060 ac-1: mute rows cover the identity's networks, deduplicated, with honest names", () => {
  const rows = muteRows([
    { networkId: "net-a", name: "The Noah Family" },
    { networkId: "net-b", name: "Grandma's Hub" },
    { networkId: "net-a", name: "The Noah Family (again)" },
    { name: "no id — never renders" },
    null,
  ]);
  assert.deepEqual(rows, [
    { networkId: "net-a", name: "The Noah Family" },
    { networkId: "net-b", name: "Grandma's Hub" },
  ]);
  assert.deepEqual(muteRows(), []);
  assert.deepEqual(muteRows([{ networkId: "net-c" }]), [{ networkId: "net-c", name: "a network" }]);
});

const webRoot = join(dirname(fileURLToPath(new URL(import.meta.url))), "..");
const src = async (file) => await readFile(join(webRoot, file), "utf8");

// ac-1: the per-event rows carry the hub's event vocabulary (PORCH-059's
// PUSH_EVENT_TYPES), and the owner-events row exists only for roles that
// can receive it.
test("PORCH-060 ac-1: per-event rows ride the hub's event vocabulary with family labels", () => {
  assert.deepEqual(EVENT_ROWS.map((row) => row.key), ["reply", "mention", "reaction", "groupPost"]);
  assert.deepEqual(EVENT_ROWS.map((row) => row.label), ["Replies", "Mentions", "Reactions", "Group posts"]);
  assert.deepEqual(OWNER_EVENT_KEYS, ["joined", "deviceLink"]);
  assert.equal(OWNER_EVENT_LABEL, "Owner events");
});

test("PORCH-060 ac-1: the owner-events row exists only for a role that receives it", () => {
  assert.equal(receivesOwnerEvents("owner"), true);
  assert.equal(receivesOwnerEvents("delegate"), true);
  assert.equal(receivesOwnerEvents("member"), false);
  assert.equal(receivesOwnerEvents(null), false);
});

test("PORCH-060 ac-1: the settings card renders the master switch, per-event toggles, and per-network mute rows in member settings", async () => {
  const card = await src("src/notifications.jsx");
  assert.match(card, /data-testid="notification-settings"/);
  // Master switch row.
  assert.match(card, /"Device notifications"/);
  // Every per-event label renders as a toggle row (the labels ride the
  // module's EVENT_ROWS mapping; their literal wording is pinned above).
  assert.match(card, /EVENT_ROWS\.map\(\(\{ key, label \}\)/);
  assert.match(card, /OWNER_EVENT_LABEL/);
  // Mute rows derive from the OPEN identity's connections — per-network
  // rows (name + toggle), never another identity's networks.
  assert.match(card, /connection\?\.identity\?\.id === identity\?\.id && connection\.networkId/);
  assert.match(card, /muteRows\(identityConnections\)/);
  // The card rides the member settings shell (Profile renders it).
  const identity = await src("src/identity.jsx");
  assert.match(identity, /import \{ NotificationSettings \} from '\.\/notifications\.jsx';/);
  assert.match(identity, /<NotificationSettings data=\{data\} actions=\{actions\} \/>/);
});

// ac-2: settings transform pure helpers + optimistic rollback pins.
test("PORCH-060 ac-2: the settings transforms are pure, immutable, and complete", () => {
  const origin = { enabled: false, events: { reply: false, mention: false, reaction: false, groupPost: false, joined: false, deviceLink: false }, mutes: ["net-a"] };
  assert.deepEqual(withMaster(origin, true), { ...origin, enabled: true });
  assert.equal(withMaster(origin, true).enabled, true);
  assert.equal(origin.enabled, false, "the original settings object is never mutated");
  const evented = withEvent(origin, "groupPost", true);
  assert.equal(evented.events.groupPost, true);
  assert.equal(origin.events.groupPost, false, "the original event switches are never mutated");
  assert.deepEqual(withOwnerEvents(origin, true).events, { ...origin.events, joined: true, deviceLink: true });
  const less = withMute(origin, "net-a", false);
  assert.deepEqual(less.mutes, []);
  const more = withMute(less, "net-b", true);
  assert.deepEqual(more.mutes, ["net-b"]);
  // Dedup by nature of set semantics; original list untouched.
  assert.deepEqual(origin.mutes, ["net-a"]);
});

test("PORCH-060 ac-2: the read-back normalizes to the hub's own shape, never guessed local state", () => {
  assert.deepEqual(normalizeSettings({ enabled: true, events: { reply: true, joined: true }, mutes: ["x", "x", 7] }),
    { enabled: true, events: { reply: true, joined: true }, mutes: ["x", "7"] });
  assert.deepEqual(normalizeSettings(null), { enabled: false, events: {}, mutes: [] });
  assert.deepEqual(normalizeSettings({ events: "junk" }), { enabled: false, events: {}, mutes: [] });
});

test("PORCH-060 ac-2: persistence rides the hub's member routes with optimistic updates and rollback on failure", async () => {
  const main = await src("src/main.jsx");
  // GET + PUT through the open identity's connection (per-identity writes).
  assert.match(main, /loadNotificationSettings: \(\) => request\(active, "social\/push\/settings"\)/);
  assert.match(main, /saveNotificationSettings: \(settings\) => request\(active, "social\/push\/settings", \{\s*\n\s*method: "PUT"/);
  const card = await src("src/notifications.jsx");
  // Optimistic: the next settings object takes the screen immediately…
  assert.match(card, /const previous = settings;\s*\n\s*setSettings\(next\);/);
  // …the authoritative server row is rendered back on success…
  assert.match(card, /normalizeSettings\(result\?\.settings \?\? next\)/);
  // …and a failure rolls the previous server-backed values back verbatim.
  assert.match(card, /catch \(cause\) \{[\s\S]*?setSettings\(previous \?\? normalizeSettings\(null\)\);/);
});

// ac-3: the prompt fires only from the explicit Enable action.
test("PORCH-060 ac-3: Enable subscribes with the hub's VAPID key and registers hub-side", async () => {
  // A deterministic RFC-style vector: 32 bytes of 0xAB in base64url.
  const vapidKey = "q6vr4K-_r6-vrw".repeat(4).slice(0, 43); // 32 bytes
  const calls = [];
  const pushManager = {
    subscribe: async (options) => {
      calls.push(["subscribe", options]);
      return { toJSON: () => ({ endpoint: "https://push.example/v1/sub-1", keys: { p256dh: "p-256dh", auth: "auth-key" } }) };
    },
  };
  const result = await enablePush({
    pushManager,
    vapidPublicKey: vapidKey,
    register: async (descriptor) => { calls.push(["register", descriptor]); return { subscription: descriptor }; },
  });
  assert.deepEqual(calls, [
    ["subscribe", { userVisibleOnly: true, applicationServerKey: base64UrlToBytes(vapidKey) }],
    ["register", { endpoint: "https://push.example/v1/sub-1", keys: { p256dh: "p-256dh", auth: "auth-key" } }],
  ]);
  assert.deepEqual(result, { subscription: { endpoint: "https://push.example/v1/sub-1", keys: { p256dh: "p-256dh", auth: "auth-key" } } });
});

test("PORCH-060 ac-3: Enable refuses to run without a push channel or a real VAPID key", async () => {
  await assert.rejects(enablePush({ pushManager: null, vapidPublicKey: "x".repeat(43), register: async () => ({}), }), /cannot receive notifications/);
  await assert.rejects(enablePush({ pushManager: { subscribe: async () => null }, vapidPublicKey: "not base64url!", register: async () => ({}) }), /notification key/);
  await assert.rejects(Promise.resolve().then(() => base64UrlToBytes("AAAA")), /incomplete/);
  await assert.rejects(Promise.resolve().then(() => base64UrlToBytes("")), /notification key/);
});

test("PORCH-060 ac-3: the browser permission prompt fires only from the explicit Enable tap — never at load or on navigation", async () => {
  const main = await src("src/main.jsx");
  // The app never CALLS requestPermission; pushManager.subscribe (fired
  // inside enableNotifications from the toggle tap) IS the prompt.
  assert.doesNotMatch(main, /requestPermission\s*\(/);
  assert.match(main, /enableNotifications: async \(\) => \{/);
  assert.match(main, /social\/push\/vapid/);
  assert.match(main, /social\/push\/subscriptions/);
  const install = await src("src/install.js");
  assert.doesNotMatch(install, /requestPermission/);
  const card = await src("src/notifications.jsx");
  // The master toggle is the only explicit-tap surface that runs the
  // Enable flow before the settings write, and a promptable (default)
  // permission stays silent at load — the quiet refresh runs only when
  // the permission is already granted.
  assert.match(card, /if \(capability\.permission !== "granted"\) \{ setDeviceOn\(false\); return undefined; \}/);
  assert.match(card, /toggleMaster/);
  assert.match(card, /if \(checked && !deviceOn\) \{\s*\n\s*await actions\.enableNotifications\(\);/);
});

test("PORCH-060 ac-3: denial mirrors the real permission and renders platform-appropriate re-enable guidance", async () => {
  assert.notEqual(reenableGuidance(true), reenableGuidance(false));
  assert.match(reenableGuidance(true), /device's Settings/);
  assert.match(reenableGuidance(false), /site settings/);
  const card = await src("src/notifications.jsx");
  assert.match(card, /capability\.permission === "denied"/);
  assert.match(card, /reenableGuidance\(capability\.webkit\)/);
  assert.match(card, /setDenied\(true\); setDeviceOn\(false\);/);
});

// ac-4: capability-first detection and truthful states.
test("PORCH-060 ac-4: the capability truth table rides PushManager presence, display mode, and the engine fact only", () => {
  assert.deepEqual(notificationCapability({ pushCapable: true, standalone: false, webkit: false, permission: "granted" }),
    { canPush: true, state: "supported", permission: "granted" });
  assert.equal(notificationCapability({ pushCapable: false, standalone: false, webkit: false }).state, "unsupported");
  assert.equal(notificationCapability({ pushCapable: false, standalone: true, webkit: true }).state, "ios-unsupported");
  assert.equal(notificationCapability({ pushCapable: false, standalone: false, webkit: true }).state, "ios-not-installed");
  // Permission defaults are honest, never invented.
  assert.equal(notificationCapability({ pushCapable: true, standalone: true, webkit: true }).permission, "default");
  assert.equal(notificationCapability({ pushCapable: false, standalone: false, webkit: true, permission: "denied" }).permission, "denied");
});

test("PORCH-060 ac-4: every non-supported state names its reason in plain language", () => {
  for (const state of ["unsupported", "ios-not-installed", "ios-unsupported"]) {
    assert.ok(CAPABILITY_LINES[state].length > 40, `${state} carries a full reason`);
  }
  assert.equal(CAPABILITY_LINES.supported, "");
});

test("PORCH-060 ac-4: the iOS-not-installed state hands off to the install flow with the established dismissal window", async () => {
  const card = await src("src/notifications.jsx");
  assert.match(card, /data-testid="install-handoff"/);
  // The handoff words ride the install flow's own guidance line; the
  // dismissal reuses the suppression window and key of PORCH-051.
  assert.equal(HANDOFF_LINE.includes("Add to Home Screen"), true);
  assert.match(card, /notificationsHandoffDismissed/);
  const main = await src("src/main.jsx");
  assert.match(main, /notificationsHandoffDismissed: \(\) => installSuppressed\(readLocal\(stored, origin, "install-dismissed-at", 0\)\)/);
  assert.match(main, /dismissNotificationsHandoff: \(\) => \{/);
  const install = await src("src/install.js");
  assert.match(install, /export const INSTALL_SUPPRESSION_MS = 14 \* 24 \* 60 \* 60 \* 1000;/);
});

test("PORCH-060 ac-4: toggles render disabled with the reason named — never a dead switch pretending", async () => {
  const card = await src("src/notifications.jsx");
  // Disable rule and reason line both exist, and the master switch is
  // gated by the same rule.
  assert.match(card, /const canEdit = capability\.canPush && !denied;/);
  assert.match(card, /disabled=\{!canEdit \|\| busy\}/);
  assert.match(card, /CAPABILITY_LINES\[capability\.state\]/);
  // Detection rides capability facts, never user-agent device strings.
  assert.doesNotMatch(card, /iPad|iPhone|Android/i);
  assert.match(card, /webkitClass\(window\.navigator\.userAgent\)/);
  assert.match(card, /typeof window\.PushManager === "function"/);
});

// ac-5: tap-through and shared devices, no badges.
test("PORCH-060 ac-5: a tap focuses the existing client or opens the origin-contained post target", async () => {
  const clientA = { id: 1, type: "window" };
  assert.deepEqual(tapDecision([clientA], { postId: "p-9" }), { action: "message", client: 1 });
  assert.deepEqual(tapDecision([], { postId: "p 9/" }), { action: "open", url: postPath("p 9/") });
  assert.equal(postPath("p 9/"), "/posts/p%209%2F");
  assert.deepEqual(tapDecision([], {}), { action: "open", url: "/" });
});

test("PORCH-060 ac-5: push payloads are decoded on the content-only whitelist", () => {
  const payload = decodePushPayload(JSON.stringify({
    type: "reply", postId: "p1", commentId: "c1", authorName: "Ada", networkName: "The Noah Family", excerpt: "Hi!",
    // Forbidden classes never cross into the payload (vote privacy etc.).
    voteCount: 9, upvotes: 4, downvotes: 5, followers: 12,
  }));
  assert.deepEqual(payload, { type: "reply", postId: "p1", commentId: "c1", authorName: "Ada", networkName: "The Noah Family", excerpt: "Hi!" });
  assert.deepEqual(decodePushPayload("not json"), {});
  assert.deepEqual(decodePushPayload(""), {});
  assert.deepEqual(decodePushPayload('{"postId":"too-long:' + "x".repeat(400) + '"}'), {});
});

test("PORCH-060 ac-5: the single worker carries push delivery and tap-through, additively — no badge machinery", async () => {
  const worker = await src("public/sw.js");
  assert.match(worker, /self\.addEventListener\("push"/);
  assert.match(worker, /self\.addEventListener\("notificationclick"/);
  // The push handler intercepts NOTHING: the worker still has exactly one
  // respondWith (the rendition fetch boundary), untouched by these listeners.
  assert.equal(worker.match(/respondWith/g).length, 1);
  // Tap-through: focus the existing client (and hand it the target), or
  // open the post target so the SPA's standard open flow runs.
  assert.match(worker, /self\.clients\.matchAll\(\{ type: "window", includeUncontrolled: true \}\)/);
  assert.match(worker, /client\.focus\(\)/);
  assert.match(worker, /porchlight-open-post/);
  assert.match(worker, /openWindow\(target\)/);
  assert.match(worker, /\/posts\/\$\{encodeURIComponent\(data\.postId\)\}/);
  // No badge machinery of any kind: push only (Brian, Oct 10, 2026).
  assert.doesNotMatch(worker, /setAppBadge|clearAppBadge/);
  for (const file of ["src/notifications.jsx", "src/notifications.js", "src/main.jsx", "src/identity.jsx"]) {
    assert.doesNotMatch(await src(file), /setAppBadge|clearAppBadge|Badges/);
  }
});

test("PORCH-060 ac-5: the shared-tablet edges — per-identity settings, per-identity subscriptions — are the open identity's own", async () => {
  const main = await src("src/main.jsx");
  // Subscriptions register under the OPEN identity's session connection.
  assert.match(main, /enableNotifications: async \(\) => \{/);
  assert.match(main, /register: \(descriptor\) => request\(active, "social\/push\/subscriptions"/);
  const card = await src("src/notifications.jsx");
  const cardConnections = await src("src/main.jsx");
  // The card reads/writes the open identity's settings only.
  assert.match(card, /connection\?\.identity\?\.id === identity\?\.id/);
  assert.match(cardConnections, /loadNotificationSettings: \(\) => request\(active/);
  // "Who's using Porchlight?" governs who is speaking: no open identity, no settings.
  assert.match(card, /!identity\?\.id\) return undefined;/);
});