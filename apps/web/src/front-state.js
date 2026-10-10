/**
 * Device front state (PORCH-055): zero open sessions is a first-class
 * device state. A registered device that explicitly signed out (Switch
 * included) rides a client-local, per-origin marker in browser-local
 * storage: the next open renders the WhoIsHere front state instead of a
 * semi-usable app shell. Devices that never sign out keep the
 * forever-logged-in silent reopen. Helpers are pure; the screens own the
 * member-facing copy.
 */
import { readJoinQuery } from "./frontdoor.js";
import { readLocal, writeLocal, storagePrefix } from "./store.js";

function signedOutKey(origin) {
  return `${storagePrefix}${origin}:signed-out`;
}

/** True only while an explicit sign-out (or Switch) is marked on this device. */
export function readSignedOut(storage, origin) {
  return readLocal(storage, origin, "signed-out", false) === true;
}

export function markSignedOut(storage, origin) {
  try {
    writeLocal(storage, origin, "signed-out", true);
  } catch { /* storage unavailable: the forever-logged-in route stays */ }
}

export function clearSignedOut(storage, origin) {
  try {
    storage.removeItem(signedOutKey(origin));
  } catch { /* nothing was stored */ }
}

/**
 * Boot routing.
 * 1. A deep path passes through untouched: the join and device link routes
 *    own their grant consumption wherever the device is.
 * 2. A device with no registrations is the join front door.
 * 3. A signed-out registered device renders the front state; grant
 *    consumption wins over the chooser, so a join link tapped on the front
 *    state routes into its flow immediately (never a dead chooser).
 * 4. A device that never signed out keeps the shared-device chooser rule
 *    (multiple registrations, or a pinned face) or the direct timeline.
 */
export function bootRoute({ pathname, search, connections, signedOut = false, pinned = false }) {
  if (pathname && pathname !== "/") return pathname;
  if (!connections.length) return "/join";
  if (signedOut) return readJoinQuery(search) ? "/join" : "/who-is-here";
  return connections.length > 1 || pinned ? "/who-is-here" : "/timeline";
}