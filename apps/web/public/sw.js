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
let tokensByOrigin = {};

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
 * on connection changes, and on every token renewal. */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "media-auth") {
    tokensByOrigin = event.data.tokensByOrigin ?? {};
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Renditions only: rungs, the video poster, and the playable rendition —
  // every one of them under /renditions/. Originals bypass (no pre-cache).
  if (!url.pathname.includes("/renditions/")) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request, { ignoreVary: true });
      if (cached) return cached;
      const token = tokensByOrigin[url.origin];
      const headers = new Headers(request.headers);
      if (token) headers.set("authorization", `Bearer ${token}`);
      const response = await fetch(new Request(request, { headers }));
      // Only fully-authenticated content-addressed responses enter the
      // store; originals cannot land here (the pathname check above).
      if (response.ok && url.searchParams.has("v") && token) {
        await cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});