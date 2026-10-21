/**
 * Media slot fetch contract (PORCH-116, Brian Oct 21, 2026). Pure helpers
 * for the slot-owned fetch state machine: pending → loaded |
 * failed-retryable | failed-terminal. Classification reads the server
 * response class per the paired Porchlight Server media-pipeline amendment:
 * 404/410 (purged, tombstoned, or otherwise absent media) is the terminal
 * class; network errors, timeouts, 5xx responses, and interrupted in-flight
 * attempts are the retryable-transient class. Nothing else carries error
 * semantics. Retries are safe by construction: rendition URLs are
 * content-addressed and immutable, so a retried fetch cannot serve stale
 * bytes, and the long-lived Cache-Control contract carries unchanged.
 */

// Bounded retries with small backoff [Assumed: 2 attempts, tuned at build].
// Per re-arm episode a failed-retryable slot holds two retry attempts — the
// first after 1.2s, the second after 2.4s — then rests until the next
// re-arm (visibility re-entry or hub recovery). The absent copy never
// renders on any retryable state; failed-retryable holds the quiet
// placeholder.
export const MEDIA_RETRY_BUDGET = 2;
export const MEDIA_RETRY_BACKOFF_MS = 1200;

// A stalled attempt (a hung connection the tunnel or hub never closes)
// resolves to the retryable class so a slot cannot rest in pending
// forever; tuned generous against home-hub cold starts.
export const MEDIA_ATTEMPT_TIMEOUT_MS = 30000;

/**
 * The response class of one failed attempt. `status` is the HTTP status
 * the hub answered (or 0/undefined when the request never answered:
 * network error, timeout, or interruption). 404/410 are terminal; every
 * other answer is retryable-transient.
 */
export function mediaFailureClass(status) {
  return (status === 404 || status === 410) ? "failed-terminal" : "failed-retryable";
}

/** Backoff for the `retryNumber`-th retry (1-based): 1200ms, then 2400ms. */
export function mediaRetryDelayMs(retryNumber = 1) {
  return MEDIA_RETRY_BACKOFF_MS * Math.max(1, Math.min(MEDIA_RETRY_BUDGET, retryNumber));
}