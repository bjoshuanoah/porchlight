// Cross-tab token custody (PORCH-028, lean option (a)).
//
// The hub keeps one live identity session per (did, deviceId): every renewal
// supersedes the tokens every other tab still presents, which is the 401
// burst. Session custody stays single-live; the tokens are shared: whichever
// tab renews publishes the fresh token set through localStorage (plain
// saveConnections writes), sibling tabs adopt it via storage events, and a
// per-origin renewal slot serializes re-credentialing so tabs never race two
// supersessions past each other.
import { readConnections, renewSlotKey, storagePrefix } from "./store.js";

// A renewal holds the slot for at most its network round-trips; a crashed tab
// cannot release it, so the timestamp bounds the hold.
const SLOT_TTL_MS = 15_000;
// How long a tab hit by a 401 waits for an in-flight renewal elsewhere to
// publish before giving the original error back to the caller.
const PUBLISH_WAIT_MS = 10_000;

function readSlot(storage, origin) {
  try {
    return JSON.parse(storage.getItem(renewSlotKey(origin)) || "null");
  } catch {
    return null;
  }
}

// `ownerId` is per-custody (per tab): a tab re-enters its own held slot
// freely, another tab's fresh held slot is busy, and release removes only
// the holder's own key.
function acquireSlot(storage, origin, ownerId) {
  const existing = readSlot(storage, origin);
  if (existing?.owner === ownerId) return true; // re-entrant: our own renewal in progress
  if (existing && Date.now() - existing.at < SLOT_TTL_MS) return false; // another tab is renewing
  storage.setItem(renewSlotKey(origin), JSON.stringify({ owner: ownerId, at: Date.now() }));
  return true;
}

function releaseSlot(storage, origin, ownerId) {
  const slot = readSlot(storage, origin);
  if (slot?.owner === ownerId) storage.removeItem(renewSlotKey(origin));
}

export function createCustody({ storage, origin, publishWaitMs = PUBLISH_WAIT_MS } = {}) {
  const safeOrigin = origin || (globalThis.window ? window.location.origin : "http://localhost");
  const safeStorage = storage || (globalThis.window ? window.localStorage : null);
  const ownerId = globalThis.crypto?.randomUUID?.() || `tab-${Math.random().toString(36).slice(2)}`;
  const waiters = new Map(); // origin -> resolve() of the pending publication wait
  let performRenew = null; // App-provided re-credential (renew in main.jsx)
  let onAdopt = null; // App state hook: adopted tokens flow into React state
  let renewalInFlight = null;

  // window "storage" events land here; they never fire in the writing tab.
  function notify(event) {
    if (!event.key?.startsWith(storagePrefix) || !event.key.endsWith(":connections")) return;
    const originOf = event.key.slice(storagePrefix.length, -":connections".length);
    const pending = waiters.get(originOf);
    if (pending) {
      waiters.delete(originOf);
      pending();
    }
  }

  function awaitPublication(targetOrigin, ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(targetOrigin);
        resolve(false);
      }, ms);
      waiters.set(targetOrigin, () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  // Sibling adoption: the published copy for the same identity, keeping the
  // plane of the token the failed request presented (identity vs membership).
  function adopt(connection) {
    const fresh = readConnections(safeStorage, safeOrigin);
    const match = fresh.find((item) => item.identity?.id === connection.identity?.id);
    if (!match) return null;
    const plane = connection.token === connection.identityToken ? "identityToken" : "token";
    const token = match[plane] ?? match.token;
    if (!token || token === connection.token) return null;
    return { ...match, token };
  }

  // Recovered custody must not leak back as repeated 401s: the app's
  // connection state is refreshed the moment tokens are adopted, so the next
  // poll presents the published token instead of consulting recovery again.
  function publishAdoption() {
    if (onAdopt) onAdopt(readConnections(safeStorage, safeOrigin));
  }

  // One renewal at a time per tab: identical joins, and the slot makes it
  // one at a time per origin across tabs.
  function runRenewal(args) {
    if (renewalInFlight) return renewalInFlight;
    if (!performRenew) return Promise.resolve(false);
    if (!acquireSlot(safeStorage, safeOrigin, ownerId)) return Promise.resolve(false);
    renewalInFlight = (async () => {
      try {
        return await performRenew(args);
      } catch {
        return false;
      } finally {
        releaseSlot(safeStorage, safeOrigin, ownerId);
        renewalInFlight = null;
      }
    })();
    return renewalInFlight;
  }

  // Tab-initiated renewal (gate interval, visibility wake, first load).
  // Skips silently when another tab holds the slot: its publication lands
  // through the storage event and this tab's next requests adopt it.
  async function renew(args = {}) {
    const renewed = await runRenewal(args);
    if (renewed) publishAdoption();
    return renewed;
  }

  // The 401 hook api.js consults before surfacing the error. Returns a
  // replacement connection to retry with, or null to leave the failure.
  async function recover({ connection, error }) {
    if (error?.status !== 401) return null;
    if (!safeStorage) return null;
    const adopted = adopt(connection);
    if (adopted) {
      publishAdoption();
      return adopted;
    }
    const canRenew = Boolean(performRenew);
    const slot = readSlot(safeStorage, safeOrigin);
    const busyElsewhere = Boolean(slot) && Date.now() - slot.at < SLOT_TTL_MS && slot.owner !== ownerId;
    if (canRenew && !busyElsewhere) {
      // Route through the shared renewal: a renewal already in flight in this
      // tab is awaited, never duplicated (a duplicate would supersede it).
      const renewed = await runRenewal({ did: connection.identity?.id || null });
      if (renewed) {
        publishAdoption();
        const afterRenewal = adopt(connection);
        if (afterRenewal) return afterRenewal;
      }
      return null;
    }
    // Nothing published and renewal impossible here (another tab's slot, or a
    // foreign hub): wait for an in-flight publication, then adopt or give up.
    const published = await awaitPublication(safeOrigin, publishWaitMs);
    if (published) {
      const lateAdoption = adopt(connection);
      if (lateAdoption) {
        publishAdoption();
        return lateAdoption;
      }
    }
    return null;
  }

  return {
    notify,
    recover,
    renew,
    setRenew(fn) {
      performRenew = fn;
    },
    setOnAdopt(fn) {
      onAdopt = fn;
    },
  };
}