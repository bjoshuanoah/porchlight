import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, type RedisClientType } from "redis";
import { createRedisEventPlane } from "../src/services/event-plane.redis.js";

const REDIS_URL = process.env.PORCHLIGHT_TEST_REDIS_URL ?? null;

test("redis event plane: append/readSince/publish round-trip (env-gated, real daemon)", async (t) => {
  // Env-gated (PORCHLIGHT_TEST_REDIS_URL): the deterministic matrix never
  // touches daemons — this file only runs where a hub's own Redis daemon
  // is deliberately provided.
  if (!REDIS_URL) {
    t.skip();
    return;
  }
  const redis = createClient({ url: REDIS_URL }) as RedisClientType;
  try {
    await redis.connect();
  } catch {
    process.stderr.write("redis daemon unreachable — skipping\n");
    t.skip();
    return;
  }
  t.after(async () => {
    await redis.flushDb().catch(() => {});
    await redis.quit().catch(() => {});
  });
  const plane = await createRedisEventPlane(redis, { maxLength: 3 });
  t.after(async () => plane.close());

  // Empty origin, never emitted: fresh read = nothing, stale=false.
  const empty = await plane.readSince("net_x", null);
  assert.equal(empty.stale, false);
  assert.deepEqual(empty.events, []);

  // Append + in-order playback; the entry id is the cursor.
  const seqs = [];
  const arrivals: string[] = [];
  plane.onInbound((networkId, envelope) => {
    arrivals.push(`${networkId}:${envelope.content?.body}`);
  });
  for (const body of ["one", "two", "three", "four"]) {
    const result = await plane.append("net_x", { type: "post.created", networkId: "net_x", postId: null, createdAt: new Date().toISOString(), content: { body } });
    await plane.publish("net_x", { type: "post.created", networkId: "net_x", postId: null, createdAt: new Date().toISOString(), content: { body }, seq: result.seq });
    seqs.push(result.seq);
    // Real-daemon pub/sub delivery is asynchronous against the subscriber
    // socket; a short yield between writes keeps the assertion below read
    // the settled state (this file only runs where a daemon is provided).
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(arrivals, ["net_x:one", "net_x:two", "net_x:three", "net_x:four"]);

  // Window reads (the retained stream is the cursor's ground truth): exact
  // deltas replay in order and the fresh-device cursor is the newest seq.
  // (MAXLEN trim is approximate and defers to node boundaries; the stale
  // gap check is cursor-based — the 24h window contract is asserted in
  // modules/social/test/realtime.service.test.js.)
  const atFour = await plane.readSince("net_x", null);
  assert.equal(atFour.stale, false);
  assert.deepEqual(
    atFour.events.map((row: { content: { body: string } }) => row.content.body),
    ["one", "two", "three", "four"],
  );
  assert.equal(atFour.cursor, seqs[3]);
  const atTwo = await plane.readSince("net_x", seqs[1]);
  assert.equal(atTwo.stale, false);
  assert.deepEqual(
    atTwo.events.map((row: { content: { body: string } }) => row.content.body),
    ["three", "four"],
  );
  assert.equal(atTwo.cursor, seqs[3]);
  // A cursor at the newest entry replays nothing new.
  const atNewest = await plane.readSince("net_x", seqs[3]);
  assert.deepEqual(atNewest.events, []);

  // A foreign cursor reads stale (never a silent skip).
  const foreign = await plane.readSince("net_x", "garbage");
  assert.equal(foreign.stale, true);
  assert.deepEqual(foreign.events, []);

});
