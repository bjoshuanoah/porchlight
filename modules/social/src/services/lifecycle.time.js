/**
 * Lifecycle timing of record (PORCH-093). The restore window (Brian, Oct
 * 16, 2026): 30 days from deletion — purgeAt = deletedAt + window; the
 * day-30 reaper claims tombstones whose purgeAt has passed. A leaf module
 * so the write services and the lifecycle service share the one value
 * without an import cycle.
 */
export const RESTORE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** purgeAt of record for a deletion timestamp. */
export function purgeAtFor(deletedAt) {
  return new Date(new Date(deletedAt).getTime() + RESTORE_WINDOW_MS).toISOString();
}