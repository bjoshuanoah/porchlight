// PORCH-102: freshness-note auto-recovery. The beyond-window catch-up
// (PORCH-081 ac-4's `stale` resolve) recovers by itself: on a reconnect whose
// replay resolves beyond the server's retained window, the client re-serves
// the visible surface fresh over REST — the exact refetch the Check again CTA
// performs — automatically, and the banner clears the frame fresh state lands.
// The machinery is event-driven on reconnect (the same trigger class PORCH-081
// ac-1 mandates against polling for): retries are BOUNDED with exponential
// backoff, and past the bound the banner persists with its Check again CTA as
// the manual path. No interval exists anywhere in this module — a bounded
// backoff chain while recovery is active is not a cadence, and nothing here
// re-arms itself after it exhausts.

/** Builds the [Assumed: 3 attempts, exponential] bound from the directive. */
export const STALE_RECOVERY_MAX_ATTEMPTS = 3;
export const STALE_RECOVERY_BASE_DELAY_MS = 1000;

/** Exponential backoff before retry n (1-indexed): 1s, 2s, … build-tuned. */
export function staleRecoveryDelayMs(n, baseDelayMs = STALE_RECOVERY_BASE_DELAY_MS) {
	return baseDelayMs * 2 ** (n - 1);
}

/**
 * The bounded recovery driver. `attempt` performs ONE full fresh serve
 * (returns a truthy value when fresh state landed); a thrown attempt is a
 * failed attempt, never a crash. Each failure waits out its backoff step,
 * never exceeding maxAttempts. Resolves with the outcome; it never throws
 * for exhausted attempts — exhaustion IS a defined outcome (the banner
 * persists for the manual CTA).
 */
export async function runStaleRecovery({
	attempt,
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	maxAttempts = STALE_RECOVERY_MAX_ATTEMPTS,
	baseDelayMs = STALE_RECOVERY_BASE_DELAY_MS,
} = {}) {
	for (let n = 1; n <= maxAttempts; n += 1) {
		let served = false;
		try {
			served = Boolean(await attempt());
		} catch {
			served = false;
		}
		if (served) return { recovered: true, attempts: n };
		if (n < maxAttempts) await sleep(staleRecoveryDelayMs(n, baseDelayMs));
	}
	return { recovered: false, attempts: maxAttempts };
}