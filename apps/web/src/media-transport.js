/**
 * Media transport (PORCH-044). Service-worker mediation for the rendition
 * surfaces: the SPA loads rendition bytes straight from content-addressed
 * URLs (img srcset / img src / video src+poster), and the worker carries
 * the membership token onto those requests and keeps the immutable
 * rendition store. Insecure HTTP origins (LAN deployments) can't register
 * a worker — the caller falls back to the authorized-fetch blob path.
 */
let registration = null;
let pendingTokens = null;

function readyController(timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("service worker registration timed out")), timeoutMs);
    navigator.serviceWorker.ready.then((reg) => {
      clearTimeout(timer);
      resolve(reg.active ?? navigator.serviceWorker.controller);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Register the rendition worker once and relay the pending token set.
 * Resolves true when rendition URLs are served through the worker, false
 * when the environment can't host one (insecure origin).
 */
export async function registerMediaTransport() {
  if (typeof navigator === "undefined" || !navigator.serviceWorker || !window.isSecureContext) {
    return false;
  }
  if (!registration) {
    const timer = new Promise((_, reject) => setTimeout(() => reject(new Error("register timed out")), 3000));
    registration = await Promise.race([
      navigator.serviceWorker.register("/sw.js", { scope: "/" }),
      timer,
    ]).catch(() => null);
    if (!registration) return false;
  }
  try {
    const controller = await readyController(3000);
    // Relay only a token set the app has actually synced (syncMediaTransport
    // ran): posting the empty default here would defeat the worker's
    // bounded relay wait — rendition requests fired by the first direct
    // render would 401 and the media elements never retry.
    if (pendingTokens !== null) {
      controller?.postMessage({ type: "media-auth", tokensByOrigin: pendingTokens });
    }
    return Boolean(controller);
  } catch {
    return false;
  }
}

/** Relay the current token set (per hub origin) to the rendition worker. */
export function syncMediaTransport(tokensByOrigin) {
  pendingTokens = tokensByOrigin;
  const controller = navigator?.serviceWorker?.controller ?? null;
  if (controller && registration?.active) {
    controller.postMessage({ type: "media-auth", tokensByOrigin });
  }
}

/**
 * The existing worker's Registration (PORCH-060): the notification
 * settings screen's push subscription rides this same registration —
 * one worker by contract, never a second registration.
 */
export function workerRegistration() {
  return registration;
}