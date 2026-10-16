// PORCH-095: the app-ready event bus. Readiness ends the boot — boot
// progress is driven by app readiness events, never a timer alone, and the
// crossfade fires the moment the app's first surface is ready (no
// artificial hold, no minimum display time). The bus is pure and shared:
// a caller that becomes ready before LanternBoot subscribes still ends the
// boot immediately (the boot never waits for an event already passed).

let ready = false;
const listeners = new Set();

/** The app's first surface is ready — idempotent; fires subscribers once. */
export function markAppReady() {
  if (ready) return;
  ready = true;
  const pending = [...listeners];
  listeners.clear();
  pending.forEach((fn) => fn());
}

/** Has the app announced readiness? */
export function getAppReady() {
  return ready;
}

/**
 * Subscribe to readiness. If readiness already fired, the callback runs
 * synchronously now (the boot fades immediately, never holds).
 * Returns the unsubscribe function.
 */
export function onAppReady(fn) {
  if (ready) {
    fn();
    return () => {};
  }
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test seam only: reset the bus between unit tests. */
export function resetAppReadyForTests() {
  ready = false;
  listeners.clear();
}