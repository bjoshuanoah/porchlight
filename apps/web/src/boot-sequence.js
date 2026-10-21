// PORCH-117 (Brian, Oct 21 2026 — error display discipline): the boot
// settle chain. Errors are earned states and loading is not failure: the
// connect / first-fetch sequence runs on the standing bounded backoff
// while the boot surface holds, a failed attempt defers its earned render
// until the chain exhausts, and a success mid-chain renders nothing — a
// hub that comes back while the loading surface still shows was never an
// error. The chain always settles the boot (so an exception cannot strand
// the lantern), and the earned failure applies only after the settle
// decision, so any error lands after the app surface mounts and rides the
// offline state until the state resolves (never a timer).
//
// The pure driver for retry bounds lives in stale-recovery.js (PORCH-102,
// unit-tested); this module composes it into the boot contract.

import { runStaleRecovery } from "./stale-recovery.js";

/**
 * Runs one boot sequence.
 *
 * @param {object}   options
 * @param {Function} [options.connect]          The session-open step (silent
 *   renewal). A throw is a failed connect attempt — the first-fetch chain
 *   below owns the earned render, so a connect failure alone earns nothing.
 * @param {Function} options.attempt            ONE first-fetch attempt;
 *   resolves truthy when fresh state landed, false/throws when not. Must
 *   defer its failed result (the caller's reload({ deferFailure: true })).
 * @param {Function} [options.lastFailure]      Returns the deferred failed
 *   result the chain recorded, if any.
 * @param {Function} [options.onEarnedFailure] Called exactly once with the
 *   deferred failure, only when every attempt spent without recovery.
 * @param {Function} [options.onSettle]         Settles the boot; always
 *   runs, exactly once, after the chain regardless of outcome.
 * @param {number}   [options.maxAttempts]      Backoff bound (PORCH-102 law).
 * @param {number}   [options.baseDelayMs]
 * @param {Function} [options.sleep]            Injected backoff wait.
 */
export async function runBootSequence({
  connect = null,
  attempt,
  lastFailure = null,
  onEarnedFailure = null,
  onSettle = null,
  maxAttempts,
  baseDelayMs,
  sleep,
} = {}) {
  try {
    if (connect) {
      try {
        await connect();
      } catch {
        // A failed connect is a failed attempt for the chain, not an
        // earned state of its own: the first fetch re-proves the hub, and
        // only the exhausted chain earns the offline render.
      }
    }
    const outcome = await runStaleRecovery({ attempt, maxAttempts, baseDelayMs, sleep });
    if (!outcome.recovered && onEarnedFailure) {
      const earned = lastFailure ? lastFailure() : null;
      if (earned) onEarnedFailure(earned);
    }
  } finally {
    // Settling is unconditional: the boot never strands, and the earned
    // error (applied above) lands in the same settle decision — after the
    // loading surface stops working the state, never under it.
    if (onSettle) onSettle();
  }
}