// Feed context preservation and arrival geometry (PORCH-046):
// - ac-1: content that lands ABOVE the reading position moves everything
//   below it, so the reader's place moves unless scrollTop is compensated
//   by the exact displacement. A stable per-post anchor — the topmost still-
//   visible card — measures movement before and after an arrival.
// - ac-3: navigating to a conversation and back must not destroy the
//   timeline's reading place; the scroll memory records offsets per route.
// DOM glue (captureFeedAnchor / applyFeedCompensation) keeps the DOM
// reading here; the anchor math is pure and pinned in tests.

const anchorKey = (entry) => {
  if (typeof entry?.getAttribute !== 'function') return null;
  return entry.getAttribute('data-feed-entry');
};

/**
 * The reading anchor: the topmost feed entry still reaching the viewport
 * (its bottom below the viewport top). `null` when nothing is on screen —
 * an arrival at an empty viewport needs no compensation.
 */
export function pickFeedAnchor(entries, viewportTop = 0) {
  for (const entry of entries ?? []) {
    const rect = typeof entry.getBoundingClientRect === 'function' ? entry.getBoundingClientRect() : entry.rect;
    if (!rect || rect.bottom === undefined) continue;
    if (rect.bottom > viewportTop) return { key: anchorKey(entry), top: rect.top };
  }
  return null;
}

/**
 * The displacement measured at the reading anchor: positive when content
 * above it was removed (the anchor rose), negative when content arrived
 * above (the anchor sank). A missing or replaced anchor measures nothing —
 * no invented compensation, no jolt.
 */
export function anchorCompensation(before, after) {
  if (!before || !after || before.key !== after.key) return 0;
  if (!Number.isFinite(before.top) || !Number.isFinite(after.top)) return 0;
  return before.top - after.top;
}

/** The scroll adjustment needed to hold the reading place; 0 compensates nothing. */
export function compensationScroll(before, after) {
  return -anchorCompensation(before, after) || 0;
}

/** DOM glue: measure the current reading anchor of the feed. */
export function captureFeedAnchor(scope = document, viewportTop = 0) {
  if (!scope?.querySelectorAll) return null;
  return pickFeedAnchor([...scope.querySelectorAll('[data-feed-entry]')], viewportTop);
}

/** DOM glue: apply the post-arrival scroll compensation once, after the merge renders. */
export function applyFeedCompensation(before, after, win = window) {
  const delta = compensationScroll(before, after);
  if (win?.scrollBy && delta) win.scrollBy(0, delta);
  return delta;
}

// Route scroll memory (ac-3): leaving a route notes the reading offset;
// returning to it recalls the exact position.
export function createScrollMemory() {
  const offsets = new Map();
  return {
    note(route, offset) {
      if (typeof route !== 'string' || !Number.isFinite(offset) || offset < 0) return;
      offsets.set(route, Math.floor(offset));
    },
    recall(route) {
      return offsets.has(route) ? offsets.get(route) : null;
    },
    forget(route) {
      offsets.delete(route);
    },
  };
}