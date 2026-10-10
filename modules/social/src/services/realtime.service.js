/**
 * Real-time event delivery service (PORCH-047; PRD 8, TS 8). The server
 * half of the live-feed ruling (Brian, Oct 14, 2026): content arrives in
 * the timeline as it happens, delivered per origin network and never
 * further.
 *
 * Transport lives in the hub runtime (apps/server): this service owns the
 * domain half — per-origin room membership, membership-token enforcement
 * at subscribe time, revocation kill, payload shaping, and the bounded
 * replay window behind the REST catch-up path. It receives the
 * "event plane" (fan-out + replay window) fully injected: the real hub
 * wires a Redis-backed plane (pub/sub + stream, apps/server), tests and
 * daemon-less runs use the in-memory plane below.
 *
 * Payload privacy is the vote-privacy contract extended to transport: the
 * event vocabulary is closed (post.created, reply.created,
 * reaction.applied, media.attached — no vote type exists), and every
 * envelope is checked against the no-counts, no-vote-records, no-aggregates
 * contract before it is appended anywhere. Envelopes carry content only,
 * shaped with the shared member views (postView / commentView /
 * reactionView) that already strip rank inputs and actor signatures.
 */
export const EVENT_TYPES = Object.freeze(["post.created", "reply.created", "reaction.applied", "media.attached"]);

/** Field names that must NEVER appear on an event envelope (payload-privacy contract). */
const FORBIDDEN_ENVELOPE_FIELDS = [
  "interactionCounters",
  "voteCount",
  "upvotes",
  "downvotes",
  "voteRatio",
  "ratio",
  "volume",
  "score",
  "rank",
  "reactionCount",
  "commentCount",
  "deviceSignature",
  "votes",
];

/**
 * Guard the envelope before it is stored or delivered (PORCH-047 ac-2).
 * A payload carrying anything off the content-only contract is refused at
 * composition time — the audit surface can read this as the in-variant
 * enforcement, not a caller convention.
 */
function assertPayloadPrivacy(envelope) {
  for (const field of FORBIDDEN_ENVELOPE_FIELDS) {
    if (field in envelope) {
      throw new Error(`Event envelope carries forbidden field "${field}" (payload-privacy contract)`);
    }
  }
  const forbidden = envelope.content ? FORBIDDEN_ENVELOPE_FIELDS.filter((field) => field in envelope.content) : [];
  if (forbidden.length) {
    throw new Error(`Event payload carries forbidden field "${forbidden[0]}" (payload-privacy contract)`);
  }
}

/**
 * The event plane injected per hub. Contract (both the Redis-backed
 * adapters in apps/server and the in-memory plane implement it):
 *
 *   append(networkId, event)              → { seq }  — replay window write (Redis stream class)
 *   readSince(networkId, cursor)          → { events, stale, cursor } — replay read; stale=true
 *                                           when the cursor predates the retained window (client
 *                                           falls back to REST catch-up), cursor = newest retained seq
 *   publish(networkId, envelope)          → live fan-out (Redis pub/sub class)
 *   onInbound(handler)                    → handler(networkId, envelope) for fan-out arrivals
 *   close()                               → release subscriptions
 *
 * Cursor format is opaque to clients ("<epochMs>-<n>", numeric-parsed);
 * a cursor another plane cannot parse reads as a gap (stale) — never as
 * a silent skip.
 */
export function createMemoryEventPlane({ maxEntries = 1000 } = {}) {
  /** networkId → { entries: [envelope], counter, lastSeq } */
  const windows = new Map();
  let inbound = new Set();
  let closed = false;

  const windowOf = (networkId) => {
    let window = windows.get(networkId);
    if (!window) {
      window = { entries: [], counter: 0, lastSeq: null };
      windows.set(networkId, window);
    }
    return window;
  };

  const parseCursor = (cursor) => {
    const match = /^(\d+)-(\d+)$/.exec(String(cursor ?? ""));
    return match ? { at: Number(match[1]), n: Number(match[2]) } : null;
  };

  return {
    async append(networkId, event) {
      const window = windowOf(networkId);
      window.counter += 1;
      // The cursor format mirrors the Redis stream entry id: <epochMs>-<n>.
      const seq = `${Date.now()}-${window.counter}`;
      const envelope = { ...event, seq };
      window.entries.push(envelope);
      window.lastSeq = seq;
      while (window.entries.length > maxEntries) window.entries.shift();
      return { seq };
    },

    async readSince(networkId, cursor) {
      const window = windowOf(networkId);
      const given = cursor === undefined || cursor === null || cursor === "" ? null : parseCursor(cursor);
      // A cursor this plane cannot parse is a possible gap: the honest
      // answer is the REST fallback, never a silent skip.
      if (cursor != null && given === null) {
        return { events: [], stale: true, cursor: window.lastSeq };
      }
      let stale = false;
      if (given) {
        const oldest = window.entries[0] ?? null;
        if (window.entries.length === 0 && window.counter === 0) {
          // The origin has never emitted an event: nothing to miss.
          stale = false;
        } else if (oldest === null) {
          // Everything retained was consumed by the trim: a gap may exist.
          stale = true;
        } else {
          const oldestC = parseCursor(oldest.seq);
          stale = oldestC.at > given.at || (oldestC.at === given.at && oldestC.n > given.n);
        }
      }
      const events = given
        ? window.entries.filter((entry) => {
            const entrySeq = parseCursor(entry.seq);
            return entrySeq.at > given.at || (entrySeq.at === given.at && entrySeq.n > given.n);
          })
        : [...window.entries];
      return { events, stale, cursor: window.lastSeq };
    },

    async publish(networkId, envelope) {
      if (closed) return;
      for (const handler of [...inbound]) handler(networkId, envelope);
    },

    onInbound(handler) {
      inbound.add(handler);
      return () => inbound.delete(handler);
    },

    close() {
      closed = true;
      inbound = new Set();
    },
  };
}

/**
 * Real-time event delivery. The social domain's own event surface: rooms
 * are the registry of live member channels keyed to their ORIGIN network;
 * nothing here delivers across origins, subscribes without a live
 * membership token for that exact origin, or survives a member revocation.
 */
export class RealtimeService {
  /**
   * @param {object} deps
   * @param {import("./membership.service.js").MembershipService} deps.membership
   * @param {{ append: Function, readSince: Function, publish: Function, onInbound: Function, close?: Function }} deps.plane
   *   The injected event plane (Redis-backed in the hub runtime; in-memory
   *   in tests and daemon-less runs).
   * @param {number} [deps.replayHours]
   *   The bounded replay window the client contract names (24h);
   *   documented config value (`realtime.replayHours`, packages/shared).
   */
  constructor({ membership, plane, replayHours = 24 }) {
    this.membership = membership;
    this.plane = plane;
    this.replayHours = replayHours;
    /** channelId → { id, networkId, membershipId, did, emit, close } — the live rooms. */
    this.channels = new Map();
    /** Per-origin publish serialization: append/publish order = delivery order. */
    this.#chains = new Map();
    this.plane.onInbound((networkId, envelope) => this.#deliver(networkId, envelope));
  }

  /** Non-serializable field (class private state). */
  #chains;

  /**
   * Compose + fan out one origin event (closed vocabulary, content-only
   * payload). Write services call this after the origin commit lands.
   * The envelope is privacy-checked BEFORE the plane ever sees it.
   */
  async published({ networkId, type, postId = null, content }) {
    if (!EVENT_TYPES.includes(type)) {
      throw new Error(`Unknown event type "${type}" (the event vocabulary is closed)`);
    }
    const event = {
      type,
      networkId: String(networkId),
      postId: postId ?? null,
      content: content ?? null,
      createdAt: new Date().toISOString(),
    };
    assertPayloadPrivacy(event);
    return this.#enqueue(networkId, event);
  }

  /**
   * Subscribe a live channel to its origin's room. The membership token
   * must be live for exactly the origin subscribing (ac-4): the verified
   * perimeter resolves nothing else. `channel` is the transport's
   * injection: { id, emit(envelope), close() } — the service owns none of
   * socket.io.
   */
  async subscribe({ token, networkId, channel } = {}) {
    if (typeof channel?.id !== "string" || channel.id.length === 0 || typeof channel.emit !== "function" || typeof channel.close !== "function") {
      const error = new Error("This event channel is malformed.");
      error.code = "E_CHANNEL_INVALID";
      throw error;
    }
    if (!token) {
      const error = new Error("Sign in to your membership to join the live timeline.");
      error.code = "E_MUST_SIGN_IN";
      throw error;
    }
    const perimeter = await this.membership.verifyAccessToken(token, { networkId, surface: "events" });
    if (!perimeter) {
      // Rooms never accept cross-origin or non-member connections: the
      // membership token is scoped to exactly one network, and THAT
      // network is the only room this channel can join.
      const error = new Error("You are not a member of the network this room belongs to.");
      error.code = "E_NOT_PERMITTED";
      throw error;
    }
    const membershipId = perimeter.membership._id;
    const resolvedNetworkId = String(perimeter.membership.networkId);
    this.channels.set(String(channel.id), {
      id: String(channel.id),
      networkId: resolvedNetworkId,
      membershipId,
      did: perimeter.session.did,
      emit: channel.emit,
      close: channel.close,
    });
    return { did: perimeter.session.did, membershipId, networkId: resolvedNetworkId };
  }

  /** Drop a channel (disconnect / transport close). */
  unsubscribe(channelId) {
    this.channels.delete(String(channelId));
  }

  /**
   * Revocation kill (ac-4): the moment the membership row goes inactive,
   * every live channel for it closes — not at the next request.
   */
  killMembership(membershipId) {
    for (const [id, channel] of [...this.channels]) {
      if (channel.membershipId === membershipId) {
        this.channels.delete(id);
        channel.close?.();
      }
    }
  }

  /**
   * The REST catch-up read (ac-3): the returning device's delta since its
   * own last cursor, delivered without a manual refresh. Events inside the
   * replay window replay verbatim; beyond the window `stale: true` sends
   * the client to the plain REST reads with the freshness note.
   */
  async catchUp({ accessToken, since } = {}) {
    if (!accessToken) {
      const error = new Error("Sign in to your membership before catching up.");
      error.code = "E_MUST_SIGN_IN";
      throw error;
    }
    const perimeter = await this.membership.verifyAccessToken(accessToken, { surface: "events" });
    if (!perimeter) {
      const error = new Error("This action is not available to you in this network.");
      error.code = "E_NOT_PERMITTED";
      throw error;
    }
    const networkId = perimeter.membership.networkId;
    const sinceCursor = typeof since === "string" && since.length > 0 && since.length <= 128 ? since : null;
    // The bounded window contract: a cursor OLDER than the replay window
    // resolves stale (REST fallback with the freshness note) even when the
    // plane still holds the entries — the delta the device asks for is no
    // longer the promised recent window.
    const ageCursor = sinceCursor ? /^(\d+)-(\d+)$/.exec(sinceCursor) : null;
    const pastWindow =
      ageCursor !== null &&
      Date.now() - Number(ageCursor[1]) > this.replayHours * 60 * 60 * 1000;
    const { events, stale, cursor } = await this.plane.readSince(networkId, pastWindow ? null : sinceCursor);
    return {
      events: stale || pastWindow ? [] : events,
      stale: stale || pastWindow,
      cursor,
      replayHours: this.replayHours,
    };
  }

  /** Every live channel (owner-console/shutdown diagnostics). */
  channelsFor(networkId) {
    return [...this.channels.values()].filter((channel) => channel.networkId === networkId);
  }

  /** Disconnect every live channel (hub shutdown). */
  close() {
    for (const channel of [...this.channels.values()]) {
      this.channels.delete(channel.id);
      channel.close?.();
    }
    this.plane.close?.();
  }

  /** Serialize per origin so seq order == delivery order. */
  #enqueue(networkId, event) {
    const chain = this.#chains.get(networkId) ?? Promise.resolve();
    const run = chain
      .catch(() => {})
      .then(async () => {
        const { seq } = await this.plane.append(networkId, event);
        await this.plane.publish(networkId, { ...event, seq });
        return { seq };
      });
    this.#chains.set(networkId, run);
    return run;
  }

  /** Deliver one fan-out arrival to every live channel of the origin — and only those. */
  #deliver(networkId, envelope) {
    for (const channel of this.channels.values()) {
      if (channel.networkId === String(networkId)) channel.emit(envelope);
    }
  }
}

export default RealtimeService;