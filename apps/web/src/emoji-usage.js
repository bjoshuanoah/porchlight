// The Frequently Used tab's account-level usage (PORCH-120, Brian Oct 21
// 2026): the member's usage memory lives on the hub at the identity level,
// so the tab follows the member across their devices — read from the
// member's own usage route every time a picker opens, never guessed from
// any device-local history. This module is the session cache around that
// read: the last-known list from the hub, so a picker opened while the hub
// is unreachable still renders the member's real usage (never a fake seed
// list — an unknown usage is an EMPTY list, the tab's honest cold state).
//
// Within a picker session, the member's own picks reflect immediately in
// the rendered order: each recorded add (a picker add and a chip join are
// the same signed route) moves the emoji to the front of the session list,
// between hub fetches. Cross-device freshness follows the account store on
// the next picker open.
//
// The list is emoji glyphs only — no counts, tallies, or quantities ever
// exist here to render (order is the only expression of frequency).

const cache = new Map();

/** The cache key: one identity's account record at one hub origin. */
function keyOf(connection) {
  const identity = connection?.identity?.id ? String(connection.identity.id) : "";
  let origin = "";
  try {
    origin = connection?.url ? new URL(connection.url).origin : "";
  } catch {
    origin = "";
  }
  return `${identity}@${origin}`;
}

/** The last-known usage list for the connection's identity (never mutated). */
export function cachedUsage(connection) {
  return cache.get(keyOf(connection)) ?? [];
}

/**
 * Read the member's account-level usage from their hub (the shared
 * `emojiUsage` action), cache it, and return the fresh list. A failure —
 * an unreachable hub, an offline moment — keeps the last-known list
 * cached; only with no known history does the caller see the empty list.
 */
export async function loadUsage(connection, read) {
  const key = keyOf(connection);
  const current = read instanceof Promise ? await read : read;
  const list = Array.isArray(current?.emoji) ? current.emoji.filter((row) => typeof row === "string" && row.length > 0) : null;
  if (list) cache.set(key, list);
  return cache.get(key) ?? [];
}

/**
 * Session-order reflection: the member's own just-recorded use moves the
 * emoji to the front of the session list (most-first), returning the new
 * list. Unknown emoji join the front (their first add makes them most
 * recently used); a glyph already leading stays put.
 */
export function recordSessionUse(connection, emoji) {
  const key = keyOf(connection);
  const list = cache.get(key) ?? [];
  const next = [emoji, ...list.filter((row) => row !== emoji)];
  cache.set(key, next);
  return next;
}