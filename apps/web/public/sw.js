/*
 * Porchlight rendition service worker (PORCH-044 ac-3).
 *
 * Member-facing renditions are content-addressed and immutable: the URL
 * carries the rendition's sha256, so the worker keeps a cache-first store —
 * a repeat fetch (second view, revisit, offline read of a previously
 * loaded timeline) resolves from the browser cache without a network round
 * trip. The original-quality action (the explicit archive download) is
 * NEVER intercepted or pre-cached. Everything stays behind membership
 * tokens: the app relays each origin's access token here; the worker adds
 * `Authorization: Bearer` to rendition requests only, and nothing is
 * cached until the member's own authenticated fetch succeeded.
 */
const CACHE_NAME = "porchlight-renditions-v1";
// Bounded park for boot-window credential churn (see the 401 handler below):
// long enough to cover the silent renewal the read path waits for, short
// enough that a genuinely revoked member does not hang past it.
const PARK_BUDGET_MS = 8000;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== CACHE_NAME) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

/* Token relay: the app posts { type: "media-auth", tokensByOrigin } on boot,
 * on connection changes, and on every token renewal. First-load rendition
 * requests can START before the relay message lands in the worker — an
 * unauthenticated rendition would 401 and the <img>/<video> element never
 * retries (Brian's PORCH-044 report: media fails at boot). A rendition
 * request waits, bounded, for the relay instead of racing it; an identity
 * with no member token resolves as soon as the relay arrives anyway. */
let tokensByOrigin = {};
let tokenWaiters = [];
let relayWaiters = [];

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "media-auth") {
    const incoming = event.data.tokensByOrigin ?? {};
    // A relay with NO credentials (the boot-time sync can ride an empty
    // set) must not resolve a waiting rendition request — an unauthenticated
    // fetch would 401 and the media element never retries. Waiters wake on
    // the first publication that carries a token; parks additionally
    // require the published set to CHANGE (the renewal's publication).
    const publishedCredential = Object.values(incoming).some((token) => Boolean(token));
    const changed = publishedCredential && Object.keys(incoming).some(
      (origin) => tokensByOrigin[origin] !== incoming[origin],
    );
    tokensByOrigin = incoming;
    if (publishedCredential) {
      const waiters = tokenWaiters;
      tokenWaiters = [];
      for (const wake of waiters) wake();
    }
    if (changed) {
      const relays = relayWaiters;
      relayWaiters = [];
      for (const wake of relays) wake();
    }
  }
});

function tokenFor(origin, timeoutMs = 3000) {
  if (Object.prototype.hasOwnProperty.call(tokensByOrigin, origin)) {
    return Promise.resolve(tokensByOrigin[origin]);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const at = tokenWaiters.indexOf(wake);
      if (at >= 0) tokenWaiters.splice(at, 1);
      resolve(tokensByOrigin[origin]);
    }, timeoutMs);
    const wake = () => {
      clearTimeout(timer);
      resolve(tokensByOrigin[origin]);
    };
    tokenWaiters.push(wake);
  });
}

/** Resolves when a new token relay publishes (the renewal path), bounded. */
function relayPublication(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const at = relayWaiters.indexOf(wake);
      if (at >= 0) relayWaiters.splice(at, 1);
      resolve(false);
    }, timeoutMs);
    const wake = () => {
      clearTimeout(timer);
      resolve(true);
    };
    relayWaiters.push(wake);
  });
}

function authedRequest(request, token) {
  if (!token) return request;
  // PORCH-050: the intercepted <img>/<video> request is mode "no-cors", and
  // re-issuing it with a merged header rides the request-no-cors headers
  // guard — a guard not required to carry non-safelisted values, and
  // Authorization is not safelisted. Engines disagree (Safari drops the
  // value), so a merged-header re-issue can leave the hub unanswered with
  // 401s for every rendition while the same media loads elsewhere (the
  // reported desktop album-401 signature). Rebuild the request from its URL
  // in cors mode, where the header always carries: same-origin needs no
  // preflight and runs no CORS check, and credentials stay same-origin like
  // the original.
  const headers = new Headers();
  const accept = request.headers.get("accept");
  if (accept) headers.set("accept", accept);
  headers.set("authorization", `Bearer ${token}`);
  return new Request(new URL(request.url), { method: "GET", mode: "cors", credentials: "same-origin", headers });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Renditions FIRST (the PORCH-051 /api repair, Brian's PORCH-052 report:
  // preview images not loading). The genuine rendition URLs are
  // /api/social/**/renditions/... — their Authorization must ride this
  // worker, so the rendition filter runs BEFORE any /api boundary check;
  // an early /api return ships every rendition request out
  // unauthenticated and 401s every direct <img>/<video> rendition.
  if (!url.pathname.includes("/renditions/")) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request, { ignoreVary: true });
      if (cached) return cached;
      const token = await tokenFor(url.origin);
      let response = await fetch(authedRequest(request, token));
      if (response.status === 401 && token) {
        // A PRESENT-but-rejected token is boot/credential churn, not a
        // member failure: the set relayed at boot can predate the silent
        // renewal the read path is already waiting for — and an
        // <img>/<video> element never retries. Park the request and retry
        // with each renewed-token publication until one answers or the
        // park budget expires (a genuinely revoked member surfaces its
        // 401 at the bound; a member with no token at all surfaces it
        // immediately, unparked).
        const deadline = Date.now() + PARK_BUDGET_MS;
        while (response.status === 401 && Date.now() < deadline) {
          await relayPublication(Math.max(0, deadline - Date.now()));
          if (Date.now() >= deadline) break;
          response = await fetch(authedRequest(request, tokensByOrigin[url.origin]));
        }
      }
      // Only fully-authenticated content-addressed responses enter the
      // store; originals cannot land here (the pathname check above).
      if (response.ok && url.searchParams.has("v") && token) {
        await cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});
/* Device notifications (PORCH-060): push delivery and tap-through ride this
 * SAME single worker — additive listeners only; none of the handlers below
 * ever intercepts or caches a request (the fetch boundary above is
 * untouched, so no /api/** request can ever be fulfilled from a cache and
 * no non-2xx response can enter a cache). Payloads are content-only by the
 * hub contract (type, postId, commentId, authorName, networkName, excerpt —
 * PORCH-059); no badge machinery of any kind exists in V1 (push
 * only; no badge API calls and no badge property anywhere). */

// The content-only whitelist, decoded defensively: malformed, oversized, or
// off-list values are dropped on the floor, never surfaced.
const PUSH_FIELDS = ["type", "postId", "commentId", "authorName", "networkName", "excerpt"];

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload = {};
    try {
      const text = event.data ? await event.data.text() : "";
      const parsed = text ? JSON.parse(text) : {};
      payload = Array.isArray(parsed) ? {} : parsed;
    } catch { payload = {}; }
    const data = {};
    for (const field of PUSH_FIELDS) {
      if (typeof payload[field] === "string" && payload[field].length > 0 && payload[field].length <= 300) data[field] = payload[field];
    }
    const title = data.authorName || data.networkName || "Porchlight";
    const body = data.excerpt
      || (data.authorName && data.networkName ? `${data.authorName} in ${data.networkName}` : "A new moment from your family.");
    await self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png",
      tag: data.postId ? `porchlight-${data.postId}` : undefined,
      data,
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const data = (event.notification && typeof event.notification.data === "object" && !Array.isArray(event.notification.data)) ? event.notification.data : {};
    // The origin-contained target (ac-5): the member's post detail surface
    // under the currently open identity; with no client open, the SPA's
    // own standard open flow runs first (front state → opened identity).
    const target = data.postId ? `/posts/${encodeURIComponent(data.postId)}` : "/";
    const existing = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = existing[0];
    if (client) {
      await client.focus();
      // A focused client is pointed at the target: the app navigates to
      // the origin-contained post detail under the open identity.
      if (data.postId) client.postMessage({ type: "porchlight-open-post", postId: String(data.postId) });
      return;
    }
    await self.clients.openWindow(target);
  })());
});
