import type { RedisClientType } from "redis";

export interface RealtimeEnvelope {
  seq: string;
  type: string;
  networkId: string;
  postId: string | null;
  createdAt: string;
  content: unknown;
}

/**
 * Event plane contract (PORCH-047), implemented by the Redis-backed plane
 * below for the real hub and by the in-memory plane in @porchlight/social
 * for tests and daemon-less runs:
 *
 *   append(networkId, event)         → { seq } — replay window write
 *   readSince(networkId, cursor)     → { events, stale, cursor }
 *   publish(networkId, envelope)     → live fan-out
 *   onInbound(handler)               → fan-out arrivals to this process
 *   close()
 */
export interface EventPlane {
  append(networkId: string, event: Record<string, unknown>): Promise<{ seq: string }>;
  readSince(networkId: string, cursor: string | null): Promise<{
    events: RealtimeEnvelope[];
    stale: boolean;
    cursor: string | null;
  }>;
  publish(networkId: string, envelope: Record<string, unknown>): Promise<void>;
  onInbound(handler: (networkId: string, envelope: RealtimeEnvelope) => void): () => void;
  close(): Promise<void>;
}

const CHANNEL_PREFIX = "porchlive";
const MAXLEN_DEFAULT = 5000;

/**
 * The Redis-backed event plane (PORCH-047, TS 8): the replay window rides
 * a Redis stream (stream class, XADD + MAXLEN trim) with one stream per
 * origin network, and live fan-out rides Redis pub/sub with one channel
 * per origin ("one room per origin network"). Every event terminates at
 * the hub: no external broker, no vendor relay — the plane speaks only to
 * the hub's own Redis daemon. The pub/sub side uses dedicated duplicate
 * clients because a node-redis connection is either in command mode or in
 * subscribe mode, never both, and the hub's main client keeps serving
 * sessions, queues, and readiness probes.
 */
export async function createRedisEventPlane(
  redis: RedisClientType,
  options: { maxLength?: number } = {},
): Promise<EventPlane> {
  const maxLength = options.maxLength ?? MAXLEN_DEFAULT;
  const channel = (networkId: string) => `${CHANNEL_PREFIX}:chan:${networkId}`;
  const networkFromChannel = (raw: string) => raw.slice(`${CHANNEL_PREFIX}:chan:`.length);

  const publisher = await redis.duplicate();
  await publisher.connect();
  const subscriber = await redis.duplicate();
  await subscriber.connect();

  const streamKey = (networkId: string) => `${CHANNEL_PREFIX}:events:${networkId}`;
  const everKey = (networkId: string) => `${CHANNEL_PREFIX}:ever:${networkId}`;

  const toEnvelope = (entry: { id: string; message: Record<string, string> }): RealtimeEnvelope => {
    const { content, ...event } = entry.message;
    return {
      ...event,
      postId: event.postId === "" ? null : event.postId,
      content: content === "" ? null : (JSON.parse(content) as unknown),
      seq: entry.id,
    } as RealtimeEnvelope;
  };

  const inbound = new Set<(networkId: string, envelope: RealtimeEnvelope) => void>();
  let patternSubscribed = false;
  // The one fan-out channel: hub-local delivery only. Subscribing the
  // pattern lazily on the first registration keeps a daemon-less test path
  // from ever touching Redis.
  const ensurePattern = async () => {
    if (patternSubscribed) return;
    patternSubscribed = true;
    await subscriber.pSubscribe(`${CHANNEL_PREFIX}:chan:*`, (message, raw) => {
      const envelope = JSON.parse(message) as RealtimeEnvelope;
      for (const handler of [...inbound]) handler(networkFromChannel(raw), envelope);
    });
  };

  /** The newest retained entry is the cursor a fresh client stores so the
   * next reconnect replays exactly what happens after this snapshot. */
  const newestEntryId = async (key: string): Promise<string | null> => {
    const newest = (await publisher.xRevRange(key, "+", "-", { COUNT: 1 })).at(0) ?? null;
    return newest?.id ?? null;
  };

  return {
    async append(networkId, event) {
      // The stream entry id IS the cursor (opaque "<epochMs>-<n>"); the
      // MAXLEN trim keeps the per-origin window bounded inside the 24h
      // replay contract (`realtime.replayHours`, packages/shared).
      const seq = await publisher.xAdd(
        streamKey(networkId),
        "*",
        {
          type: String(event.type),
          networkId: String(event.networkId),
          postId: String(event.postId ?? ""),
          createdAt: String(event.createdAt),
          content: event.content === undefined || event.content === null ? "" : JSON.stringify(event.content),
        },
        { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: maxLength } },
      );
      // "This origin has emitted events" marker: an EMPTY stream later
      // must still read as a possible gap (stale → REST fallback), never
      // as "nothing was ever missed".
      await publisher.set(everKey(networkId), "1", { NX: true });
      return { seq };
    },

    async readSince(networkId, cursor) {
      const key = streamKey(networkId);
      const given = cursor === undefined || cursor === null ? "" : String(cursor).trim();
      if (given.length === 0) {
        const all = await publisher.xRange(key, "-", "+");
        return { events: all.map(toEnvelope), stale: false, cursor: await newestEntryId(key) };
      }
      // A cursor this plane cannot resolve (foreign format, corruption) is
      // treated as beyond the window: the catch-up resolves via REST,
      // never as a silent skip.
      if (!/^\d+-\d+$/.test(given)) {
        return { events: [], stale: true, cursor: await newestEntryId(key) };
      }
      const first = (await publisher.xRange(key, "-", "+", { COUNT: 1 })).at(0) ?? null;
      // No event was EVER emitted at this origin → nothing to miss. An
      // emptied (fully trimmed) stream with an older cursor → possible
      // gap → stale.
      const ever = (await publisher.get(everKey(networkId))) === "1";
      if (first === null) {
        if (!ever) return { events: [], stale: false, cursor: null };
        return { events: [], stale: true, cursor: null };
      }
      const stale = compareIds(first.id, given) > 0;
      const events = (await publisher.xRange(key, `(${given}`, "+")).map(toEnvelope);
      return { events, stale, cursor: await newestEntryId(key) };
    },

    async publish(networkId, envelope) {
      await publisher.publish(channel(networkId), JSON.stringify(envelope));
    },

    onInbound(handler) {
      inbound.add(handler);
      void ensurePattern();
      return () => {
        inbound.delete(handler);
      };
    },

    async close() {
      await publisher.quit().catch(() => {});
      await subscriber.quit().catch(() => {});
    },
  };
}

/** Numeric-tuple compare over "<epochMs>-<n>" stream entry ids. */
function compareIds(a: string, b: string): number {
  const [aAt, aN] = a.split("-");
  const [bAt, bN] = b.split("-");
  const byAt = Number(aAt) - Number(bAt);
  if (byAt !== 0) return byAt;
  return Number(aN) - Number(bN);
}