// Install machinery (PORCH-051): the Add to Home Screen decision logic for
// the Android/Chrome custom CTA and the iOS/Safari guided card. Pure logic
// only — the React surface rides the caller (main.jsx), the storage rides
// the browser-local per-origin helpers (store.js), and the prompt event
// rides one service-worker registration that already exists (the PORCH-044
// rendition worker): no second worker is ever registered.

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