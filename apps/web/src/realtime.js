// Socket feed transport (PORCH-081): the browser consumes the hub's
// realtime event plane over socket.io — the shipped PORCH-047 server
// contract (per-origin rooms, membership-gated subscribe, revocation kill,
// cursor catch-up). One manager per origin per identity, app-scope and
// reused across screens: views never open sockets.
//
// Transport discipline: websocket ONLY. Polling transports are removed
// from the connection set — polling in any form (the fixed-interval
// refresh cycle PORCH-081 deletes, or a long-poll fallback) never returns
// as the live path; the keep-alive request cadence was the recorded
// reason. A transport loss re-establishes with the client's exponential
// backoff, and every (re)handshake reads the CURRENT credential through
// the auth callback, so a silent renewal or a dead token presents itself
// server-side — never a stale closure token.
import { io } from "socket.io-client";

export const RECONNECT_CONFIG = {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 15_000,
  randomizationFactor: 0.5,
};

// "origin#identity" → { socket, refs, listeners, connected }. Per-origin
// managers; the open identity's membership is part of the key — an identity
// switch on the same origin is a different room (its own membership), so it
// never reuses the previous identity's subscription.
const sockets = new Map();

/**
 * Open (or reuse) the origin's event stream. `getAuth()` is read at every
 * handshake — return `{ networkId, token }` from live storage, or null to
 * let the hub refuse (an absent credential is refused, never guessed).
 * Returns a handle: `state()` reports the connection fact, `close()`
 * releases this consumer's reference (the last one disconnects the socket).
 *
 * Every `onState` callback carries `established` alongside `connected`
 * (PORCH-117, Brian Oct 22, 2026 follow-up): true only after this stream
 * has completed at least one successful handshake. An establishment still
 * in flight — connect attempts failing or pending before the first
 * connect — is loading, never an earned error; the transport's own backoff
 * keeps working the state. Only an established-then-lost connection is a
 * definitive outage of record.
 */
export function openEventStream({ url, identityId, getAuth, onEvent, onState, log = console } = {}) {
  const origin = new URL(url).origin;
  const key = `${origin}#${identityId ?? ""}`;
  let entry = sockets.get(key);
  if (!entry) {
    const refs = new Set();
    const socket = io(origin, {
      transports: ["websocket"],
      ...RECONNECT_CONFIG,
      withCredentials: false,
      // Fresh credential at every handshake: the first connect and every
      // backoff re-establish read live storage — a renewed token presents
      // itself, a dead one is refused server-side with its own code.
      auth: (done) => done(getAuth?.() ?? null),
    });
    socket.on("event", (envelope) => {
      for (const ref of refs) ref.onEvent?.(envelope);
    });
    socket.on("connect", () => {
      if (entry) entry.connected = true;
      if (entry) entry.established = true;
      for (const ref of refs) ref.onState?.({ connected: true, established: true });
    });
    socket.on("disconnect", (reason) => {
      if (entry) entry.connected = false;
      for (const ref of refs) ref.onState?.({ connected: false, established: Boolean(entry?.established) });
      // PORCH-047 contract: a POLICY close (the revocation kill, a hub
      // closure/restart) is not a transport loss — socket.io does not
      // re-establish it itself, and the room must not reconnect-loop a dead
      // credential. The hub-restart path (the plane returns at the same
      // origin) gets ONE scheduled re-open at the backoff ceiling; a closed
      // membership is refused at that next handshake server-side. The
      // re-credential paths (renewal, device link, identity switch) own
      // everything after that.
      if (reason === "io server disconnect") {
        setTimeout(() => {
          const live = sockets.get(key);
          if (live === entry && entry.refs.size > 0) entry.socket.connect();
        }, RECONNECT_CONFIG.reconnectionDelayMax);
      }
    });
    socket.on("connect_error", (error) => {
      // The refusal is server-side truth (E_MUST_SIGN_IN / E_NOT_PERMITTED
      // / an unreachable hub class). Every open consumer sees it once; the
      // backoff re-establishes — no poll cycle is invented to compensate.
      if (log?.debug && error?.message) log.debug(`realtime unavailable (${error.message})`);
      for (const ref of refs) ref.onState?.({ connected: false, established: Boolean(entry?.established), error: error?.message ?? null });
    });
    entry = { socket, refs, connected: false, established: false };
    sockets.set(key, entry);
  }
  const ref = { onEvent, onState };
  entry.refs.add(ref);
  const state = () => entry.connected;
  return {
    state,
    close() {
      entry.refs.delete(ref);
      if (entry.refs.size === 0) {
        sockets.delete(key);
        entry.socket.close();
      }
    },
  };
}

/** Test seam: drop every live manager (never a poll; module teardown). */
export function closeEventStreams() {
  for (const [, entry] of sockets) entry.socket.close();
  sockets.clear();
}