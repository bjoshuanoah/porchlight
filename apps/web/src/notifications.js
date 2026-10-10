/**
 * Device notification settings + push permission flow (PORCH-060). Pure
 * logic only; the React surface rides notifications.jsx, the wiring rides
 * main.jsx, and the push delivery + tap-through listeners ride the ONE
 * already-registered rendition worker (public/sw.js — additively; that
 * handler intercepts no fetch). The hub side is PORCH-059: the settings
 * and subscription routes are identity-scoped member routes the open
 * identity's session token authorizes.
 */

/**
 * Per-event rows (ac-1). The keys are the hub's event vocabulary —
 * PUSH_EVENT_TYPES on Porchlight Server (PORCH-059); the labels are family
 * words. `groupPost` is the member-controlled toggle (server default off);
 * reply/reaction/mention ride the shipped server defaults.
 */
export const EVENT_ROWS = Object.freeze([
  { key: "reply", label: "Replies" },
  { key: "mention", label: "Mentions" },
  { key: "reaction", label: "Reactions" },
  { key: "groupPost", label: "Group posts" },
]);

/** Owner events (new member joined, device-link request) reach owners and
 * delegates only — one row, rendered only to a role that receives them. */
export const OWNER_EVENT_KEYS = Object.freeze(["joined", "deviceLink"]);
export const OWNER_EVENT_LABEL = "Owner events";

/** "Owner events where the member's role receives them" (ac-1): the row
 * exists only for the owner and delegate ladder roles; a plain member's
 * settings carry no such row. */
export function receivesOwnerEvents(role) {
  return role === "owner" || role === "delegate";
}

/**
 * Capability truth table (ac-4): PushManager presence plus existing
 * permission, the home-screen display mode, and the WebKit engine fact —
 * capability checks and display mode only, never device/user-agent device
 * strings (the PORCH-051 iPadOS class ruling carries). Returns one state:
 *   - supported        a push-capable browser (Enable can run here)
 *   - unsupported      a browser without PushManager of any engine class
 *   - ios-not-installed WebKit without PushManager outside the installed
 *                       home-screen app — the push gate rides the install
 *                       ( truthful handoff to the install flow, PORCH-051)
 *   - ios-unsupported   the installed iOS app cannot receive web push
 *                       (iOS before 16.4)
 */
export function notificationCapability({ pushCapable, standalone, webkit, permission = null } = {}) {
  if (pushCapable) return { canPush: true, state: "supported", permission: permission ?? "default" };
  if (!webkit) return { canPush: false, state: "unsupported", permission: permission ?? null };
  if (standalone) return { canPush: false, state: "ios-unsupported", permission: permission ?? null };
  return { canPush: false, state: "ios-not-installed", permission: permission ?? null };
}

/** Plain-language line per state (ac-4): the reason named, never silent. */
export const CAPABILITY_LINES = Object.freeze({
  supported: "",
  unsupported: "This browser can't receive Porchlight notifications. A recent version of Chrome, Edge, or Safari — installed as a home-screen app on iPhone or iPad — can.",
  "ios-not-installed": "Notifications arrive only inside the installed home-screen app. Add Porchlight to your home screen to turn them on.",
  "ios-unsupported": "This device's Porchlight cannot receive notifications. Update iOS to 16.4 or later, then notifications arrive through the installed app.",
});

/** The iOS-not-installed handoff rides the install flow's own guidance
 * words (PORCH-051): the Share-icon step, as a settings-surface card. */
export const HANDOFF_LINE = "To install, tap the Share icon and select “Add to Home Screen”. Notifications arrive through the installed app.";

/** Denied-state re-enable guidance (ac-3), platform-appropriate: the iOS
 * device's Settings path, or the Chrome-site-settings path elsewhere. */
export function reenableGuidance(webkit) {
  return webkit
    ? "Notifications are off for Porchlight in this device's Settings. Open Settings, tap Notifications, find Porchlight, and turn it on."
    : "Notifications are off in this browser's site settings. Open the site menu in the address bar (the lock or settings icon), choose Site settings, and allow notifications.";
}

/**
 * Settings mutation helpers (ac-1/ac-2): the screen edits a server-owned
 * settings object { enabled, events, mutes } optimistically and rolls the
 * previous object back on failure. These pure transforms keep the
 * component's state changes auditable without a DOM.
 */
export function withMaster(settings, value) {
  return { ...settings, enabled: value === true };
}

export function withEvent(settings, key, value) {
  return { ...settings, events: { ...settings.events, [key]: value === true } };
}

export function withOwnerEvents(settings, value) {
  const events = { ...settings.events };
  for (const key of OWNER_EVENT_KEYS) events[key] = value === true;
  return { ...settings, events };
}

export function withMute(settings, networkId, muted) {
  const mutes = new Set(settings.mutes || []);
  if (muted) mutes.add(networkId); else mutes.delete(networkId);
  return { ...settings, mutes: [...mutes] };
}

/** Per-network mute rows (ac-1): the open identity's network memberships
 * as the caller assembled them — one row per network (networkId + name),
 * deduplicated, in connection order. */
export function muteRows(entries = []) {
  const seen = new Map();
  for (const entry of entries || []) {
    const networkId = entry?.networkId;
    if (!networkId || seen.has(networkId)) continue;
    seen.set(networkId, { networkId, name: entry?.name || entry?.network?.name || "a network" });
  }
  return [...seen.values()];
}

/** Read the server's settings row back defensively: anything off the shape
 * { enabled, events, mutes } falls to off-and-empty, never to guessed
 * local state (ac-2 — the screen never presents local-only state). */
export function normalizeSettings(raw) {
  const events = {};
  if (raw && typeof raw.events === "object" && !Array.isArray(raw.events)) {
    // Every key the hub sent, booleans only — the owner-event switches
    // (joined, deviceLink) ride the same pass or a later save would
    // silently revert them to the shipped defaults.
    for (const [key, value] of Object.entries(raw.events)) events[key] = value === true;
  }
  return {
    enabled: Boolean(raw?.enabled),
    events,
    mutes: Array.isArray(raw?.mutes) ? [...new Set(raw.mutes.map(String))] : [],
  };
}

/**
 * The VAPID public key arrives base64url from the hub route (PORCH-059);
 * PushManager wants the raw bytes as applicationServerKey. Junk input
 * throws before any subscribe call is attempted.
 */
export function base64UrlToBytes(value) {
  if (typeof value !== "string" || value.length === 0) throw new Error("The hub sent no notification key.");
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  let decoded;
  try {
    decoded = atob(padded);
  } catch {
    throw new Error("The hub's notification key arrived unreadable.");
  }
  const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  if (bytes.length < 32) throw new Error("The hub's notification key arrived incomplete.");
  return bytes;
}

/**
 * The Enable flow (ac-3), with every input injected: the prompt fires here
 * and nowhere else (pushManager.subscribe IS the explicit-tap prompt),
 * the hub's VAPID public key scopes the subscription, and the register
 * callback rides the open identity's authenticated session
 * (POST /api/social/push/subscriptions, PORCH-059). Nothing here calls
 * requestPermission at load or on navigation.
 */
export async function enablePush({ pushManager, vapidPublicKey, register }) {
  if (!pushManager || typeof pushManager.subscribe !== "function") throw new Error("This browser cannot receive notifications.");
  const applicationServerKey = base64UrlToBytes(vapidPublicKey);
  const subscription = await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  const descriptor = subscription.toJSON();
  if (!descriptor?.endpoint || !descriptor?.keys?.p256dh || !descriptor?.keys?.auth) {
    throw new Error("This browser declined to open a notification channel.");
  }
  return register({ endpoint: descriptor.endpoint, keys: descriptor.keys });
}

/** Whitelisted push envelope — the same content-only fields the hub's
 * pipeline composes (PORCH-059). Everything else is dropped on the floor. */
export const PUSH_FIELDS = Object.freeze(["type", "postId", "commentId", "authorName", "networkName", "excerpt"]);

/** Decode an incoming push payload defensively: strings from the whitelist
 * only, anything absent malformed, oversized, or off the list discarded. */
export function decodePushPayload(text) {
  let raw = {};
  try { raw = text ? JSON.parse(text) : {}; } catch { return {}; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const payload = {};
  for (const field of PUSH_FIELDS) {
    if (typeof raw[field] === "string" && raw[field].length > 0 && raw[field].length <= 300) payload[field] = raw[field];
  }
  return payload;
}

/** A tap's origin-contained target: the member's post detail surface. */
export function postPath(postId) {
  return `/posts/${encodeURIComponent(postId)}`;
}

/**
 * Tap-through decision (ac-5), pure: with a live client the existing
 * window is focused (and pointed at the target through a message); with
 * no client open, the target URL opens and the app's standard open flow
 * runs (front state → the opened identity's timeline). No badge decision
 * exists anywhere in this module: push only, no badge machinery (Brian,
 * Oct 10, 2026).
 */
export function tapDecision(clients, payload) {
  const existing = (clients || []).find((client) => Boolean(client));
  if (existing) return existing.id ? { action: "message", client: existing.id } : { action: "message" };
  const target = payload?.postId ? postPath(payload.postId) : "/";
  return { action: "open", url: target };
}