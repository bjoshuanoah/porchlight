/**
 * Hub recovery signal for media slots (PORCH-116, Brian Oct 21, 2026).
 * The live transport owns the reconnect fact; media slots subscribe to
 * re-arm their failed-retryable fetches when serving resumes — the
 * restart-window recovery path (the slot sitting failed-retryable in the
 * viewport self-heals without member action or a refresh).
 */
const listeners = new Set();

/** Every live transport (re)connection hands its reconnect fact here. */
export function signalMediaRecovery() {
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* a failing slot consumer never blocks the others */ }
  }
}

/** Subscribe one slot consumer; returns the unsubscribe function. */
export function onMediaRecovery(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test + teardown surface. */
export function mediaRecoveryListenerCount() {
  return listeners.size;
}

export function clearMediaRecoveryListeners() {
  listeners.clear();
}