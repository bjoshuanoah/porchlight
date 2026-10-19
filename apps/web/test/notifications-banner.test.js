// The installed-context banner (PORCH-109, Brian Oct 19, 2026): the small
// turn-on-notifications banner riding the app's content surface while the
// installed app runs with an open identity session and notifications not
// enabled. The pure gate and the ONE shared walked enable flow are
// exercised directly with injected fakes; the shell wiring and the
// surface carry their contracts as source pins (the notifications pin
// style).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  INSTALL_SUPPRESSION_MS,
  installSuppressed,
} from "../src/install.js";
import {
  normalizeSettings,
  notificationsBannerVisible,
  notificationSection,
  walkedEnable,
} from "../src/notifications.js";

const webRoot = join(dirname(fileURLToPath(new URL(import.meta.url))), "..");
const src = async (file) => await readFile(join(webRoot, file), "utf8");

const off = normalizeSettings(null);
const on = normalizeSettings({ enabled: true });

/* ---- ac-1: the visibility gate ---- */

test("PORCH-109 ac-1: standalone + open session + notifications off together render the banner", () => {
  // "Notifications not enabled" reads the Oct 13 state machine's two
  // inputs as written: the persisted row is off OR the real permission is
  // not granted. A row off with a granted permission still shows: the
  // tap's walked flow completes in one motion (the granted prompt never
  // opens, the subscription merely registers).
  assert.equal(notificationsBannerVisible({ standalone: true, sessionOpen: true, settings: off, permission: "granted" }), true);
  assert.equal(notificationsBannerVisible({ standalone: true, sessionOpen: true, settings: off, permission: "default" }), true);
  // A denied member still holds the truthful off state: the banner stays
  // (ac-3) — the walked flow also reverts the row to off on denial, so no
  // enabled-row-behind-a-denied-permission phantom survives.
  assert.equal(notificationsBannerVisible({ standalone: true, sessionOpen: true, settings: off, permission: "denied" }), true);
  // The row's two-input disjunction: row on but the permission not yet
  // granted is still "not enabled" per the binding wording.
  assert.equal(notificationsBannerVisible({ standalone: true, sessionOpen: true, settings: on, permission: "default" }), true);
});

test("PORCH-109 ac-1: any other combo renders nothing", () => {
  assert.equal(notificationsBannerVisible({ standalone: false, sessionOpen: true, settings: off, permission: "default" }), false, "a plain browser tab never renders it");
  assert.equal(notificationsBannerVisible({ standalone: true, sessionOpen: false, settings: off, permission: "default" }), false, "no open identity session");
  assert.equal(notificationsBannerVisible({ standalone: true, sessionOpen: true, settings: on, permission: "granted" }), false, "an enabled identity never sees it");
  assert.equal(notificationsBannerVisible({ standalone: true, sessionOpen: true, settings: null, permission: "default" }), false, "an unknown row is not a silent off — the gate never nags on a guess");
  assert.equal(notificationsBannerVisible({ standalone: true, sessionOpen: true, settings: off, permission: "default", suppressed: true }), false, "a dismissed banner holds its window");
});

test("PORCH-109 ac-1: the banner rides the shell's content surface, off the front-door states, with its own hub read", async () => {
  const main = await src("src/main.jsx");
  assert.match(main, /\{!frontDoor && <NotificationsBanner \{\.\.\.props\} \/>\}/);
  const component = await src("src/notifications.jsx");
  assert.match(component, /data-testid="notifications-banner"/);
  assert.match(component, /notificationsBannerVisible\(\{/);
  // The gate's hub read happens only in installed context with an open
  // session; a plain browser tab fetches nothing and touches no push API.
  assert.match(component, /const gateFetchable = Boolean\(standalone\) && Boolean\(identity\?\.id\)/);
  // The standalone fact is injected from the shell (the mode-branch
  // guardrail carries): the screen file never matchesMedia.
  assert.match(component, /Boolean\(data\?\.standalone\)/);
  assert.doesNotMatch(component, /matchMedia/);
});

/* ---- ac-2: the tap runs the walked enable flow ---- */

test("PORCH-109 ac-2: the tap runs THE shared walked flow — enabled=true persists first, one prompt, subscribe, the settled row lands", async () => {
  const calls = [];
  let row = { enabled: false, events: { reply: false }, mutes: [] };
  const result = await walkedEnable({
    load: async () => { calls.push("load"); return { settings: { ...row } }; },
    save: async (settings) => { calls.push(["save", settings.enabled]); row = { ...settings }; return { settings }; },
    // The injected enable IS the prompt surface: pushManager.subscribe
    // fires exactly once, from this single tap's flow.
    enable: async () => { calls.push("enable"); },
  });
  assert.deepEqual(calls, ["load", ["save", true], "enable", "load"]);
  assert.equal(result.enabled, true);
  // Rows expand on grant: the settled enabled row with the granted channel
  // is the expanded state of the Oct 13 machine.
  assert.equal(notificationSection({ enabled: result.enabled, granted: true }), "expanded");
});

test("PORCH-109 ac-2: the banner's Turn on runs the one shared enable path — no separate implementation exists", async () => {
  const component = await src("src/notifications.jsx");
  const banner = (component.slice(component.indexOf("export function NotificationsBanner")));
  assert.match(banner, /const settled = await walkedEnable\(\{/);
  assert.match(banner, /load: actions\.loadNotificationSettings/);
  assert.match(banner, /save: actions\.saveNotificationSettings/);
  assert.match(banner, /enable: actions\.enableNotifications/);
  const main = await src("src/main.jsx");
  // The enable action (the prompt surface) stays the shell's ONE
  // implementation; the banner wires no second flow.
  assert.equal(main.match(/enableNotifications: async \(\) => \{/g).length, 1);
});

/* ---- ac-3: denial holds the truthful off state ---- */

test("PORCH-109 ac-3: a denied tap reverts enabled=false, leaves nothing registered standing, and the banner stays visible", async () => {
  const calls = [];
  const refusal = Object.assign(new Error("permission denied"), { name: "NotAllowedError" });
  let row = { enabled: false, events: {}, mutes: [] };
  await assert.rejects(walkedEnable({
    load: async () => ({ settings: { ...row } }),
    save: async (settings) => { row = { ...settings }; calls.push(settings.enabled); return { settings }; },
    enable: async () => { calls.push("prompt"); throw refusal; },
  }), (cause) => cause?.name === "NotAllowedError");
  assert.deepEqual(calls, [true, "prompt", false], "the revert write restores enabled=false through the route");
  assert.equal(row.enabled, false);
  // And the gate keeps the banner visible while the off state holds.
  assert.equal(notificationsBannerVisible({ standalone: true, sessionOpen: true, settings: row, permission: "denied" }), true);
});

test("PORCH-109 ac-3: the denied banner renders the platform's re-enable guidance", async () => {
  const component = await src("src/notifications.jsx");
  const banner = (component.slice(component.indexOf("export function NotificationsBanner")));
  assert.match(banner, /setDenied\(true\)/);
  assert.match(banner, /refused \? reenableGuidance\(webkit\)/);
});

/* ---- ac-4: the dismissal window ---- */

test("PORCH-109 ac-4: dismissal suppresses client-side for the established window class — its own key, per origin", () => {
  assert.equal(INSTALL_SUPPRESSION_MS, 14 * 24 * 60 * 60 * 1000, "the established 14-day window carries");
  assert.equal(installSuppressed(1000, 1000 + INSTALL_SUPPRESSION_MS - 1), true);
  // While the off state holds, the banner returns after the window.
  assert.equal(installSuppressed(1000, 1000 + INSTALL_SUPPRESSION_MS), false);
});

test("PORCH-109 ac-4: the dismissal key is the banner's own — a banner Not now never hides the install surfaces", async () => {
  const main = await src("src/main.jsx");
  assert.match(main, /notificationsBannerDismissed: \(\) => installSuppressed\(readLocal\(stored, origin, "notifications-banner-dismissed-at", 0\)\)/);
  assert.match(main, /dismissNotificationsBanner: \(\) => \{/);
  const component = await src("src/notifications.jsx");
  const banner = (component.slice(component.indexOf("export function NotificationsBanner")));
  assert.match(banner, /dismissNotificationsBanner\(\); setHiddenByDismissal\(true\)/);
  assert.match(banner, /data-testid="notifications-banner-dismiss"/);
  // The install surfaces keep their own key.
  assert.match(main, /readLocal\(stored, origin, "install-dismissed-at", 0\)/);
});

/* ---- ac-5: zero ambient prompts ---- */

test("PORCH-109 ac-5: zero PushManager or permission-prompt touches outside the explicit tap", async () => {
  const component = await src("src/notifications.jsx");
  assert.doesNotMatch(component, /requestPermission/);
  assert.doesNotMatch(component, /\.subscribe\(/);
  // The banner reads the permission's CURRENT value only — a status read
  // that asks nothing; the prompt fires solely inside the enable action's
  // pushManager.subscribe, behind the single walked flow's tap.
  assert.match(component, /window\.Notification\.permission/);
  const pure = await src("src/notifications.js");
  assert.equal(pure.match(/\.subscribe\(/g).length, 1, "pushManager.subscribe is reachable only through enablePush");
  const main = await src("src/main.jsx");
  assert.doesNotMatch(main, /requestPermission\s*\(/);
});