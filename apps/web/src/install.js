// Install machinery (PORCH-051): the Add to Home Screen decision logic for
// the Android/Chrome custom CTA and the iOS/Safari guided card. Pure logic
// only — the React surface rides the caller (main.jsx), the storage rides
// the browser-local per-origin helpers (store.js), and the prompt event
// rides one service-worker registration that already exists (the PORCH-044
// rendition worker): no second worker is ever registered.

/** Usage gate (PORCH-110, Brian Oct 19, 2026): install surfaces wait for
 * real use — the Android CTA and the iOS guidance card render only after
 * the member has used the app for at least 2 minutes in the current
 * browsing session [Assumed: 120s of in-app presence, a client-side timer
 * per origin, tuned at build]. The gate governs the render, never the
 * capture, and never touches the server. */
export const INSTALL_USAGE_GATE_MS = 2 * 60 * 1000;

/**
 * Advance the session's in-app presence. Presence accumulates only real
 * in-app time: a delta arrives only from a visible document (the caller
 * passes 0 while the tab is hidden or the app is backgrounded), and the
 * elapsed total caps at the gate so a reached gate never re-renders.
 */
export function advanceUsagePresence(elapsedMs, deltaMs) {
  const delta = Number.isFinite(deltaMs) ? Math.max(0, deltaMs) : 0;
  return Math.min(elapsedMs + delta, INSTALL_USAGE_GATE_MS);
}

/**
 * The render decision for either install surface (PORCH-110): the usage
 * gate stacked beneath the existing checks — the dismissal suppression
 * window and the already-installed retirement still win at any elapsed
 * use, and elapsed use never resurrects a suppressed or installed surface
 * (the classification's null already covers standalone absence).
 */
export function installSurfaceVisible({ installKind, usageElapsedMs, suppressed, gateMs = INSTALL_USAGE_GATE_MS }) {
  if (!installKind) return false;
  if (suppressed) return false;
  return usageElapsedMs >= gateMs;
}

/** Suppression window: a dismissal hides both install surfaces for two
 * weeks, client-side, per origin (build contract [Assumed: 14 days]). */
export const INSTALL_SUPPRESSION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Is the install surface still suppressed by a previous dismissal?
 * A dismissal at T hides the surface until T + windowMs; a zero or absent
 * timestamp (never dismissed, or the window long expired) does not.
 */
export function installSuppressed(dismissedAt, now = Date.now(), windowMs = INSTALL_SUPPRESSION_MS) {
  if (!dismissedAt || dismissedAt <= 0) return false;
  return now - dismissedAt < windowMs;
}

/**
 * Which install surface does this device earn, if any? Capability checks
 * only — iPadOS presents as desktop Mac by default, so user-agent device
 * strings are never the signal (the paired PRD ruling). Standalone wins
 * first: an installed surface is never asked to install again.
 *
 *   - standalone:   already running from the home screen → null
 *   - canPrompt:    a beforeinstallprompt was captured (Android/Chrome)
 *                   → "android"
 *   - otherwise a touch-capable WebKit (iOS-class Safari, including
 *     iPadOS in desktop presentation) → "ios"
 */
export function surfaceInstallKind({ standalone, canPrompt, touchCapable, webkit }) {
  if (standalone) return null;
  if (canPrompt) return "android";
  if (touchCapable && webkit) return "ios";
  return null;
}

/**
 * The installed surface never shows an install prompt again. Returns the
 * next standalone state given the device signals: the appinstalled event
 * or the display-mode standalone check makes the state sticky.
 */
export function isStandaloneLaunch({ navigatorStandalone, standaloneQuery }) {
  return Boolean(navigatorStandalone) || Boolean(standaloneQuery);
}

/**
 * WebKit-engine test for the iOS-class classification. iPadOS presents as a
 * desktop Mac by default, so device strings are never the signal (paired
 * PRD ruling): the engine token is the WebKit fact; Firefox's UA carries no
 * WebKit token, and the Chromium forks are excluded by their engine tokens —
 * engine facts, not device facts.
 */
export function webkitClass(userAgent) {
  return /webkit/i.test(userAgent || "") && !/Chrom(e|ium)|Edg\//i.test(userAgent || "");
}

/**
 * Fire the stored deferred prompt exactly once. The deferred prompt is
 * consumed on the first fire; a repeat call never re-prompts (Chrome would
 * throw), it resolves as null and the caller hides the CTA.
 */
const consumedPrompts = new WeakSet();

export function consumeInstallPrompt(prompt) {
  if (!prompt || consumedPrompts.has(prompt)) return Promise.resolve(null);
  consumedPrompts.add(prompt);
  prompt.prompt();
  return prompt.userChoice;
}