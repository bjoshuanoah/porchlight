// Transport contract (PORCH-081): the client consumes the PORCH-047 server
// event plane over socket.io — websocket only, membership token at the
// handshake, envelope delivery, backoff re-establish after a transport
// loss, and the fresh credential re-read at every (re)handshake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { openEventStream, closeEventStreams, RECONNECT_CONFIG } from "../src/realtime.js";

const here = dirname(fileURLToPath(import.meta.url));
const envelope = { type: "post.created", networkId: "net_family", postId: "p1", groupId: null, content: { _id: "p1", body: "hello" }, createdAt: "2026-10-15T11:00:00Z", seq: "100-1" };

async function spawnHub() {
  const http = createServer();
  const io = new SocketIOServer(http, { serveClient: false });
  const handshakes = [];
  io.use((socket, next) => {
    handshakes.push(socket.handshake.auth);
    if (!socket.handshake.auth?.token) return next(new Error("Sign in to your membership."));
    // The connection IS the subscription (PORCH-047): the verified channel
    // receives single-wire `event` messages.
    socket.emit("event", envelope);
    return next();
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = http.address().port;
  return {
    io, port, handshakes,
    close: () => new Promise((resolve) => { io.close(); http.closeAllConnections?.(); http.close(resolve); }),
  };
}

test("connect carries explicit websocket-only transports — polling is off", async () => {
  const source = await readFile(join(here, "..", "src", "realtime.js"), "utf8");
  assert.ok(/transports:\s*\[\s*["']websocket["']\s*\]/.test(source), "the connection option names websocket only");
  assert.equal(RECONNECT_CONFIG.reconnectionAttempts, Infinity, "a transport loss re-establishes with backoff");
  assert.ok(RECONNECT_CONFIG.reconnectionDelayMax > 0);
});

test("envelopes arrive through the hub's `event` wire messages", async (t) => {
  t.after(() => closeEventStreams());
  const hub = await spawnHub();
  closeEventStreams();
  let received = null;
  const stream = openEventStream({
    url: `http://127.0.0.1:${hub.port}`,
    identityId: "did_1",
    getAuth: () => ({ networkId: "net_family", token: "t1" }),
    onEvent: (message) => { received = message; },
  });
  while (!received) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(received.type, "post.created");
  assert.equal(received.seq, "100-1");
  assert.equal(received.networkId, "net_family");
  assert.ok(!("interactionCounters" in received), "no engagement field is consumed, as given");
  stream.close();
  await hub.close();
});

test("a transport loss re-establishes with backoff and re-reads the CURRENT credential; a revocation kill closes the subscription without a reconnect loop", async (t) => {
  t.after(() => closeEventStreams());
  const hub = await spawnHub();
  let token = "t1";
  const states = [];
  const stream = openEventStream({
    url: `http://127.0.0.1:${hub.port}`,
    identityId: "did_1",
    getAuth: () => ({ networkId: "net_family", token }),
    onState: (state) => states.push(state),
  });
  while (!stream.state()) await new Promise((resolve) => setTimeout(resolve, 25));
  // A transport loss (engine close — a hub dying mid-conversation): the
  // client re-establishes on its own — no manual refresh is asked of the
  // member, and no poll cycle stands in for realtime.
  token = "t2";
  for (const socket of [...hub.io.of("/").sockets.values()]) socket.conn.close();
  while (hub.handshakes.length < 2) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(hub.handshakes, [
    { networkId: "net_family", token: "t1" },
    { networkId: "net_family", token: "t2" },
  ], "every handshake reads the live credential, never a stale closure");
  assert.equal(states.at(-1)?.connected, true, "reconnected");
  assert.ok(states.every((state) => typeof state.established === "boolean"),
    "every connection state carries the establishment fact (PORCH-117 follow-up)");
  assert.ok(states.some((state) => state.connected && state.established),
    "an established stream reports its establishment");
  // A POLICY close (the revocation kill, PORCH-047) is server truth: the
  // subscription is closed and no reconnect-loop rides back inside the
  // backoff ceiling — the ONE scheduled re-open (hub-restart recovery) is
  // refused server-side for a closed membership.
  const handshakesAtKill = hub.handshakes.length;
  for (const socket of [...hub.io.of("/").sockets.values()]) socket.disconnect(true);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(hub.handshakes.length, handshakesAtKill, "a revocation closure never re-subscribes a dead room inside the backoff ceiling");
  assert.equal(stream.state(), false, "the connection fact reports the closure truthfully");
  stream.close();
  await hub.close();
});

test("an establishment still in flight reports established: false — a first-attempt connect_error never claims a lost connection (PORCH-117 follow-up)", async (t) => {
  t.after(() => closeEventStreams());
  // Nothing listens on this port: every websocket attempt fails before a
  // handshake — exactly Brian's report window ("not enough time to have
  // established a connection").
  const states = [];
  const stream = openEventStream({
    url: "http://127.0.0.1:1",
    identityId: "did_est",
    getAuth: () => ({ networkId: "net_family", token: "t1" }),
    onState: (state) => states.push(state),
  });
  await new Promise((resolve) => setTimeout(resolve, 600));
  stream.close();
  assert.ok(states.length >= 1, "the failed establishment reached the consumer");
  for (const state of states) {
    assert.equal(state.connected, false);
    assert.equal(state.established, false,
      "no handshake ever completed — connection trouble here renders loading only, never the earned banner");
  }
});

test("closeEventStreams tears down every manager (module teardown seam)", async (t) => {
  t.after(() => closeEventStreams());
  const hub = await spawnHub();
  closeEventStreams();
  const stream = openEventStream({
    url: `http://127.0.0.1:${hub.port}`,
    identityId: "did_1",
    getAuth: () => ({ networkId: "net_family", token: "t1" }),
  });
  while (!stream.state()) await new Promise((resolve) => setTimeout(resolve, 25));
  closeEventStreams();
  assert.ok(true, "teardown does not throw");
  await hub.close();
});