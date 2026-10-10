/**
 * Rendition response policy (PORCH-044 ac-3, transport layer): rendition
 * URLs are content-addressed (`?v=<sha256>` of the rendition bytes) and
 * immutable — they serve with a long-lived PRIVATE Cache-Control so repeat
 * fetches resolve from the browser cache without a network round trip
 * (member-facing surfaces stay behind membership tokens; a shared cache
 * must never see member content). Originals are NEVER pre-cached: the
 * explicit archive action serves with no-store. Strong ETags ride the
 * content address, so a stale revalidation gets a bodyless 304.
 */

export const RENDITION_CACHE_CONTROL = "private, max-age=31536000, immutable";
export const ORIGINAL_CACHE_CONTROL = "no-store";

/** The requested content address matches the rendition's bytes (or is absent). */
export function contentAddressMatches(requestedVersion, sha256) {
  return requestedVersion == null || requestedVersion === sha256;
}

/** A browser conditional request revalidating the same content address. */
export function ifNoneMatchSatisfied(request, sha256) {
  const header = request.headers?.["if-none-match"];
  return typeof header === "string" && header === `"${sha256}"`;
}