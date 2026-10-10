/**
 * Fallback-mode media blob cache (PORCH-044): on surfaces where the
 * auth-relaying rendition worker can't run — insecure LAN origins, or a
 * hub timeline that predates mediaMeta hydration — the loader fetches
 * media bytes through the authorized call. Feed reads arrive on a cadence
 * (arrival poll, device poll, write reconcile), and a naive loader
 * re-fetches and re-resolves a NEW object URL on every application render,
 * revoking the old one first: media blanks out and reloads on every cycle
 * — the page-visible "site is reloading" churn (Brian's PORCH-044 report).
 *
 * This module owns the fallback object URLs by content identity (origin,
 * media id, rendition kind, version): a repeat request with the SAME
 * identity answers from memory — no second network read, no revoke, no
 * media remount. URLs are revoked only when their identity is replaced or
 * evicted from the cache tail.
 */
const mediaBlobs = new Map(); // identity key -> { url, blob, shape, at }

// Bounded only in effect: the cache holds at most this many entries and
// trades the least-recently-used ones — but never an entry that a surface
// could still be rendering within the last minute.
const CACHE_LIMIT = 200;
const EVICT_AFTER_MS = 60_000;

export function mediaBlobKey({ origin, mediaId, kind, version = null } = {}) {
  return `${String(origin)}|${String(mediaId)}|${String(kind)}|${version ?? ""}`;
}

/** The cached entry for an identity, or null. A read refreshes recency. */
export function readMediaBlob(key) {
  const row = mediaBlobs.get(key) ?? null;
  if (row) row.at = Date.now();
  return row;
}

/** Store one identity's bytes and object URL; replaces any prior URL for it. */
export function putMediaBlob(key, { url, blob, shape = null }) {
  const previous = mediaBlobs.get(key);
  if (previous && previous.url !== url) {
    try { URL.revokeObjectURL(previous.url); } catch { /* the URL was already gone */ }
  }
  const row = { url, blob, shape, at: Date.now() };
  mediaBlobs.set(key, row);
  if (mediaBlobs.size > CACHE_LIMIT) evict();
  return row;
}

function evict() {
  const cutoff = Date.now() - EVICT_AFTER_MS;
  let oldestKey = null;
  let oldestAt = Infinity;
  for (const [key, row] of mediaBlobs) {
    if (row.at < oldestAt) {
      oldestAt = row.at;
      oldestKey = key;
    }
  }
  if (oldestKey === null) return;
  if (mediaBlobs.get(oldestKey).at > cutoff) return; // everything is on-screen-fresh
  const row = mediaBlobs.get(oldestKey);
  try { URL.revokeObjectURL(row.url); } catch { /* already gone */ }
  mediaBlobs.delete(oldestKey);
}

/** Test + teardown surface: drop every identity (revoking nothing that a live surface may still render is not a concern there). */
export function clearMediaBlobs() {
  mediaBlobs.clear();
}

export function mediaBlobCount() {
  return mediaBlobs.size;
}