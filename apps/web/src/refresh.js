// Update detection and refresh flow (PORCH-125, Brian, Oct 22, 2026): the
// client half of the refresh ruling. Detection and apply ride the ONE
// rendition service worker; nothing here touches /api/** — the marker read
// at cold open fetches the hub's static worker script, nothing else. Launch
// (the cold open) is the ONLY automatic apply point; the banner's tap is
// the in-session apply point; no timer and no automatic path ever applies
// an update or reloads the app underneath an active member (the
// no-hard-reload-mid-session principle; the banner renders on detection,
// never on failure — the error-display discipline is not this surface).
// Pure logic plus an injectable environment so the checks run under
// node --test without a browser.

/** The in-session banner's copy of record — verbatim, never a variant. */
export const UPDATE_BANNER_COPY = "New version available. Click here to refresh.";

/** sessionStorage key holding the fact an automatic cold-open reload already ran this session. */
export const COLD_OPEN_RELOAD_FLAG = "porchlight:cold-open-reload";

/** The banner holds while a pending update exists — no auto-dismiss, no timeout. */
export const UPDATE_CHECK_INTERVAL_MS = 60_000;

/** Bounded waits: detection and apply never block a boot beyond these. */
export const COLD_OPEN_UPDATE_BUDGET_MS = 4000;
export const COLD_OPEN_APPLY_SETTLE_MS = 4000;

/** The worker's `porchlight-apply-update` message — the only skipWaiting caller's entry. */
export const APPLY_UPDATE_MESSAGE = "porchlight-apply-update";

/**
 * Parses the stamped worker script's shell version: { stamp, build } —
 * the stamp as written, or null when unparseable; build as a number only
 * when the stamp is a build-epoch number (a dev/placeholder stamp carries
 * no comparable marker and never reads as newer or older).
 */
export function swShellVersion(swScriptText) {
  const match = /const SHELL_VERSION\s*=\s*"([^"]*)"/.exec(swScriptText || "");
  const stamp = match && match[1] ? match[1] : null;
  return { stamp, build: buildStamp(stamp) };
}

/** The app bundle's own stamped build marker as a comparable number (null = no comparable marker). */
export function buildStamp(value) {
  return typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : null;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Applies the waiting worker: posts the only skipWaiting message, waits a
 * bounded settle for the claimed control, then — on the banner-tap path —
 * reloads EXACTLY once. Reload is the caller' decision: the cold open
 * passes no reload (the boot serves the fresh shell) and the banner tap
 * passes location.reload. Returns true when a pending update was applied.
 * The settle never rethrows: a worker that does not claim in time leaves
 * the reload to the next navigation rather than wedging the session.
 */
export async function applyPendingUpdate({
  registration,
  serviceWorker,
  reload = null,
  settleMs = COLD_OPEN_APPLY_SETTLE_MS,
  delay: settle = delay,
  onControlled = null,
} = {}) {
  const waiting = registration && registration.waiting;
  if (!waiting || typeof waiting.postMessage !== "function") return false;
  // The apply is not synchronous: the worker processes the message the
  // moment its scope runs (a real, observable multi-second gap in some
  // engines). Settle on the CONTROLLING change (the claimed worker), or on
  // the waiting slot emptying — a landed apply empties the slot. Both are
  // bounded; the caller decides the reload.
  const controlled = new Promise((resolve) => {
    if (serviceWorker && typeof serviceWorker.addEventListener === "function") {
      serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
    }
  });
  const slotCleared = (async () => {
    for (let waitedMs = 0; waitedMs < settleMs; waitedMs += 100) {
      await settle(100);
      if (!registration.waiting) return true;
    }
    return false;
  })();
  waiting.postMessage({ type: APPLY_UPDATE_MESSAGE });
  const claimed = await Promise.race([controlled, slotCleared]);
  if (onControlled) onControlled();
  if (reload) reload();
  return Boolean(claimed || reload);
}

/**
 * The cold-open apply (ac-3): the boot path's one automatic apply point.
 * Forces a bounded worker update check; when a waiting worker exists it is
 * applied (skipWaiting + the activate sweep's claim and old-cache cleanup)
 * with NO reload and NO banner. Then the marker read at boot: the hub's
 * stamped worker script against this shell's own stamped build. A newer
 * hub marker with a stale shell reloads once — bound to the boot hold
 * (`stillBooting`) so an already-active member is never reloaded under,
 * and loop-guarded by sessionStorage so one session carries at most one
 * automatic reload; past that bound the banner renders instead (the stale
 * shell is never silently presented).
 * Returns { pending } — pending true means a member-facing refresh
 * affordance should render on this open.
 */
export async function coldOpenRefresh({
  registration,
  ownBuild,
  readHubScript,
  sessionStorageLike,
  reload,
  stillBooting = () => true,
  updateBudgetMs = COLD_OPEN_UPDATE_BUDGET_MS,
  settleMs = COLD_OPEN_APPLY_SETTLE_MS,
  delay: settle = delay,
} = {}) {
  if (!registration) return { pending: false };
  // The forced check installs a newer worker as WAITING (the worker never
  // self-activates); offline or an unreachable hub leaves it untouched.
  try {
    await Promise.race([
      Promise.resolve(registration.update?.()).then(
        () => true,
        () => true,
      ),
      settle(updateBudgetMs).then(() => false),
    ]);
  } catch {
    // the check never blocks the boot; a failed check is a no-op here
  }
  // The cold-open apply point holds, bounded, for the newer worker's
  // arrival: the browser's own parallel check (a reload's soft update) may
  // install a beat after our update() resolves. The hold never blocks the
  // boot chain — it only times the refresh flow's own decision window.
  if (!registration.installing && !registration.waiting) {
    const arrived = await new Promise((resolve) => {
      const onUpdateFound = () => {
        clearTimeout(bound);
        registration.removeEventListener?.("updatefound", onUpdateFound);
        resolve(true);
      };
      const bound = setTimeout(() => {
        registration.removeEventListener?.("updatefound", onUpdateFound);
        resolve(false);
      }, settleMs);
      registration.addEventListener?.("updatefound", onUpdateFound);
    });
    if (!arrived) return { pending: false };
  }
  const installing = registration.installing ?? null;
  if (installing && !registration.waiting) {
    await new Promise((resolve) => {
      const bound = setTimeout(resolve, settleMs);
      installing.addEventListener("statechange", () => {
        if (installing.state === "installed") {
          clearTimeout(bound);
          resolve();
        }
      });
    });
  }
  const waitingNow = registration.waiting ?? null;
  if (waitingNow) {
    // The apply is not synchronous (the worker runs the message whenever
    // its scope starts), and the target can be superseded mid-apply by an
    // in-flight update check. A bounded retarget loop posts to the CURRENT
    // waiting slot until it empties (activation) — skipWaiting is
    // idempotent, and no timer anywhere applies without this explicit
    // cold-open context.
    for (let waitedMs = 0; waitedMs < settleMs; waitedMs += 200) {
      const target = registration.waiting ?? null;
      if (!target) break;
      target.postMessage({ type: APPLY_UPDATE_MESSAGE });
      await settle(200);
    }
  }
  // The marker read at boot: hub's stamped worker script vs this shell.
  let hub = null;
  try {
    hub = swShellVersion(await readHubScript());
  } catch {
    hub = null;
  }
  const page = buildStamp(ownBuild);
  if (!hub || hub.build == null || page == null || hub.build <= page) {
    return { pending: Boolean(registration.waiting) };
  }
  // A stale shell with a newer hub: the guarded automatic reload.
  let seen = null;
  try {
    seen = typeof sessionStorageLike?.getItem === "function" ? sessionStorageLike.getItem(COLD_OPEN_RELOAD_FLAG) : null;
  } catch {
    seen = null;
  }
  if (seen || !stillBooting()) {
    // One automatic reload per session already ran (or the boot hold
    // passed before the marker read): never silently stale — the banner
    // renders, and its tap is the explicit member-owned apply.
    return { pending: true };
  }
  try {
    sessionStorageLike?.setItem?.(COLD_OPEN_RELOAD_FLAG, String(page));
  } catch { /* a blocked storage leaves the bound to the one-shot flag read above */ }
  reload();
  return { pending: false, reloaded: true };
}

/**
 * The in-session detector (ac-1): the waiting-worker signal is the primary
 * detector — updatefound → the installing worker reaches "installed" → the
 * registration's waiting slot is set → onPending, exactly once. A bounded
 * periodic check keeps detection alive in a navigation-less SPA session
 * (the browser's own update checks ride navigations); detection only —
 * nothing in this watch ever applies, reloads, or times anything out.
 * Returns the stop function.
 */
export function startUpdateWatch(registration, onPending, {
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
  isVisible = () => typeof document === "undefined" ? true : document.visibilityState === "visible",
} = {}) {
  if (!registration) return () => {};
  let reported = false;
  const reportPending = () => {
    if (reported || !registration.waiting) return;
    reported = true;
    onPending();
  };
  reportPending();
  const onUpdateFound = () => {
    const installing = registration.installing;
    if (installing) installing.addEventListener("statechange", reportPending);
    reportPending();
  };
  registration.addEventListener("updatefound", onUpdateFound);
  const timer = intervalMs > 0
    ? setInterval(() => {
      // Detection only — the check installs a waiting worker at most;
      // apply stays member-owned (the banner tap).
      if (!isVisible()) return;
      void Promise.resolve(registration.update?.()).catch(() => { /* the next tick reads again */ });
    }, intervalMs)
    : null;
  return () => {
    if (timer) clearInterval(timer);
    registration.removeEventListener("updatefound", onUpdateFound);
  };
}