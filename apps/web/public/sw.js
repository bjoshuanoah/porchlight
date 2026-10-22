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

/* Update detection and refresh flow (PORCH-125, Brian, Oct 22, 2026):
 * the version check. The build stamps this worker's shell version; the
 * stamp names the shell cache, so a newer hub build ships a newer stamp —
 * the browser installs the updated worker (updatefound / waiting signal
 * for the app's detectors), the shell cache bumps to the new name, and old
 * shell caches are cleaned on activate. The stamped worker WAITS by
 * default: nothing activates a waiting worker by a timer or an automatic
 * path, ever (the no-hard-reload-mid-session principle; the install-time
 * skipWaiting retired). Activation is member-owned through exactly two
 * apply points: the cold open (the boot path applies the pending update
 * before first paint, no banner there) and the update banner's tap (the
 * in-session apply point). The porchlight-apply-update message below is
 * the only skipWaiting caller. The rendition store and the staging store
 * are version-agnostic and carry across updates untouched. */
const SHELL_VERSION = "__PORCHLIGHT_SHELL_VERSION__";
const SHELL_CACHE = `porchlight-shell-${/^[0-9]+$/.test(SHELL_VERSION) ? SHELL_VERSION : "dev"}`;

self.addEventListener("install", () => {
  // Deliberately empty: a newer worker WAITS for an explicit apply (the
  // cold-open boot path or the update banner's tap) — never an automatic
  // activation under an active member.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // The share-target staging store (PORCH-105) persists across worker
      // updates like the rendition store itself: a staged share waits
      // through this sweep and is retrieved after the launch lands.
      const keep = new Set([CACHE_NAME, STAGE_CACHE, SHELL_CACHE]);
      for (const name of await caches.keys()) {
        if (!keep.has(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

/* Share target (PORCH-105 ac-1, ac-5): the manifest's share_target POSTs its
 * payload to /share — a launch surface, not an API surface. The worker
 * stages the shared files and text into a dedicated store and redirects the
 * launch into the app; the app retrieves the staging over the message
 * channel (requestStagedShare) and clears it once compose has taken the
 * payload. The staging store never holds an /api/** request and never serves
 * one: the boundary below stands untouched, and share-target staging never
 * enters the rendition cache. */
const STAGE_CACHE = "porchlight-share-staging";
const SHARE_TARGET_PATH = "/share";

// The in-flight staging of the current share-target launch, if any; reads
// wait for it so a fast boot never answers before the writes settle.
let shareStagingFlight = null;

const stageKey = (name) => new Request(`${SHARE_TARGET_PATH}/${name}`, { method: "GET" });

async function stageShareTarget(request) {
  try {
    const cache = await caches.open(STAGE_CACHE);
    // One share at a time: the newest supersedes earlier staging wholesale.
    for (const key of await cache.keys()) await cache.delete(key);
    const form = await request.formData();
    const files = form.getAll("media").filter((file) => file instanceof Blob || file instanceof File);
    const textOf = (field) => (typeof field === "string" ? field : "");
    await cache.put(stageKey("manifest"), new Response(JSON.stringify({
      title: textOf(form.get("title")), text: textOf(form.get("text")),
      url: textOf(form.get("url")), files: files.length, at: Date.now(),
    }), { headers: { "content-type": "application/json" } }));
    await Promise.all(files.map((file, index) => cache.put(stageKey(`file-${index}`), new Response(file, {
      headers: {
        "content-type": file.type || "application/octet-stream",
        "x-porchlight-share-name": encodeURIComponent(file.name || `Shared ${index + 1}`),
      },
    }))));
  } catch { /* an unparseable share payload leaves no staging; the launch still opens the app */ }
  return Response.redirect(new URL("/?", request.url).href, 303);
}

async function readStagedShare() {
  try {
    if (shareStagingFlight) await shareStagingFlight;
    const cache = await caches.open(STAGE_CACHE);
    const manifest = await cache.match(stageKey("manifest"));
    const meta = manifest ? await manifest.json() : null;
    if (!meta) return { title: "", text: "", url: "", files: [] };
    const files = [];
    for (let index = 0; index < Number(meta.files ?? 0); index += 1) {
      const staged = await cache.match(stageKey(`file-${index}`));
      if (!staged) continue;
      const blob = await staged.blob();
      const named = staged.headers.get("x-porchlight-share-name");
      files.push({
        name: named ? decodeURIComponent(named) : `Shared ${files.length + 1}`,
        type: blob.type || "application/octet-stream",
        blob,
      });
    }
    return { title: meta.title ?? "", text: meta.text ?? "", url: meta.url ?? "", files };
  } catch { return { title: "", text: "", url: "", files: [] }; }
}

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
  } else if (event.data?.type === "share-staged-request") {
    // PORCH-105: the app's staged-share retrieval — the staging and the
    // staged bytes hand to the requesting client over the channel port. No
    // /api/** request rides this path; the staging clears only on the app's
    // explicit share-staged-clear (compose has taken the payload).
    event.waitUntil((async () => {
      const payload = await readStagedShare();
      event.source?.postMessage({ type: "share-staged", payload });
    })());
  } else if (event.data?.type === "share-staged-clear") {
    event.waitUntil((async () => {
      const cache = await caches.open(STAGE_CACHE);
      for (const key of await cache.keys()) await cache.delete(key);
      event.source?.postMessage({ type: "share-staged-cleared" });
    })());
  } else if (event.data?.type === "porchlight-apply-update") {
    // PORCH-125: the ONLY activation entry — the cold open's boot path or
    // the update banner's tap posts this; no timer and no automatic path
    // ever reaches skipWaiting (the waiting worker is never activated
    // underneath an active member). The activate sweep above claims the
    // clients and cleans the old shell caches.
    event.waitUntil(self.skipWaiting());
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
  // Share target launch first (PORCH-105): the platform's POST to /share is
  // a launch surface the worker answers itself — staged, then redirected
  // into the app. It never reaches the rendition filter and never the
  // network (the hub has no /share route; the launch surface lives here).
  if (request.method === "POST" && new URL(request.url).pathname === SHARE_TARGET_PATH) {
    const flight = stageShareTarget(request);
    // The app's boot can race the staging writes (the launch navigation and
    // the page's staged-share request can both land immediately); a read
    // waits for the in-flight staging instead of answering empty.
    shareStagingFlight = flight.finally(() => { shareStagingFlight = null; });
    event.respondWith(flight);
    return;
  }
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Renditions FIRST (the PORCH-051 /api repair, Brian's PORCH-052 report:
  // preview images not loading). The genuine rendition URLs are
  // /api/social/**/renditions/... — their Authorization must ride this
  // worker, so the rendition filter runs BEFORE any /api boundary check;
  // an early /api return ships every rendition request out
  // unauthenticated and 401s every direct <img>/<video> rendition.
  if (url.pathname.includes("/renditions/")) {
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
    return;
  }
  // App shell serving (PORCH-125): versioned caches and update application
  // ride this same one listener — the /api/** boundary stands here verbatim
  // AFTER the rendition interception above: the rendition serve paths are
  // the standing PORCH-052 repair carve-out (their Authorization must ride
  // this worker), and every other /api/** request is never intercepted,
  // never fulfilled from a cache. No non-2xx response is ever cached on
  // any branch.
  if (url.pathname.startsWith("/api/")) return;
  // Navigation requests: network-first — a cold open online always serves
  // the fresh document (the stale shell is never silently presented after
  // an update); offline, the cached shell carries the open (the
  // offline-behavior pattern carries). Only ok responses enter the shell
  // cache, keyed by the requested path.
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(SHELL_CACHE);
          await cache.put(request, response.clone());
        }
        return response;
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        const shell = (await cache.match(request, { ignoreVary: true }))
          ?? (await cache.match(new Request("/?"), { ignoreVary: true }));
        if (shell) return shell;
        return Response.error();
      }
    })());
    return;
  }
  // Hashed static assets (the build's /assets/ output): immutable by
  // construction, so cache-first answers from the versioned shell cache
  // without a network round trip; the stamp change bumps the cache name
  // and the activate sweep collects the old shell cache.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(request, { ignoreVary: true });
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })());
  }
});
/* Device notifications (PORCH-060): push delivery and tap-through ride this
 * SAME single worker — additive listeners only; none of the handlers below
 * ever intercepts or caches a request (the fetch boundary above is
 * untouched, so no /api/** request can ever be fulfilled from a cache and
 * no non-2xx response can enter a cache). Payloads are content-only by the
 * hub contract and COMPOSED HUB-SIDE (PORCH-115: type, postId, commentId,
 * title, body — the hub writes every line; this worker renders them as
 * delivered); no badge machinery of any kind exists in V1 (push
 * only; no badge API calls and no badge property anywhere). */

// The composed envelope whitelist (PORCH-115): the hub composes every
// line — the network-name main line (title), the actor line, the excerpt —
// decoded defensively: malformed, oversized, or off-list values are
// dropped on the floor, never surfaced. No product copy exists here.
const PUSH_FIELDS = ["type", "postId", "commentId", "title", "body"];

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
    // PORCH-115 (Brian, Oct 20, 2026): pure passthrough — title and body
    // render exactly as delivered; this renderer writes no line of its
    // own and carries no product-name copy (the prior client-side
    // composition — the invented body line and the product-name fallback —
    // is gone). An envelope without its composed main line is malformed
    // and dropped.
    if (!data.title) return;
    await self.registration.showNotification(data.title, {
      body: data.body ?? "",
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
