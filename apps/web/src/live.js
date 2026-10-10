// Live feed arrival (PORCH-046): new posts enter the feed without a manual
// refresh. Delivery rides the hub's event path when one exists (PORCH-047
// companion); with no realtime surface on the hub, this cadence drives the
// REST full-read degrade — every read merges through the in-place reflection
// path, and the reading place is compensated in scroll.js.

/**
 * Poll cadence for the REST-refresh degrade path (no realtime transport on
 * the hub yet). Visible tabs only; a returning visible tab refreshes first.
 */
export const arrivalPollMs = 20_000;