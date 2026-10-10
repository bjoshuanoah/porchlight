import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { KeyObject } from "node:crypto";
import { sign, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { DEFAULT_CONFIG, createMemoryStore, normalizeConfig } from "@porchlight/shared";
import type { PorchlightConfig, StoreLike } from "@porchlight/shared";
import { createMemoryEventPlane, canonicalJson } from "@porchlight/social";
import { io as ioClient, type Socket } from "socket.io-client";
import { BootstrapService } from "../src/services/bootstrap.service.js";
import { createServer, type ExpressWithRealtime } from "../src/router.js";
import { attachRealtimeGateway } from "../src/realtime-gateway.js";
import type { Probe } from "../src/dependencies.js";

function mutableConfig(): PorchlightConfig {
  return normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as PorchlightConfig);
}

const OK_PROBES: { mongo: Probe; redis: Probe } = { mongo: async () => "ok", redis: async () => "ok" };

interface Json {
  [key: string]: unknown;
}

async function call(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: Json }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return { status: res.status, body: (await res.json()) as Json };
}

interface RealtimeTestHub {
  db: StoreLike;
  plane: ReturnType<typeof createMemoryEventPlane>;
  close: () => void;
  port: Promise<number>;
}

/** A single-hub instance: in-memory store + in-memory event plane + the REAL
 * socket.io gateway over the hub's own HTTP server (PORCH-047 transport). */
function realtimeTestHub(hubOptions: { maxLength?: number } = {}): RealtimeTestHub {
  const plane = createMemoryEventPlane(hubOptions.maxLength ? { maxEntries: hubOptions.maxLength } : {});
  const db = createMemoryStore();
  const config = mutableConfig();
  const bootstrap = new BootstrapService(db, config, "/tmp/porchlight-test-home");
  const app = createServer({ store: db, readiness: OK_PROBES, config, bootstrap, hubUrl: () => null, eventPlane: plane }) as ExpressWithRealtime;
  const httpServer = http.createServer(app);
  const gateway = app.realtime ? attachRealtimeGateway(httpServer, { realtime: app.realtime }) : null;
  const listen = Promise.withResolvers<number>();
  httpServer.listen(0, () => {
    listen.resolve((httpServer.address() as { port: number }).port);
  });
  return {
    db,
    plane,
    close: () => {
      gateway?.disconnectSockets(true);
      app.realtime?.close();
      // Destroys every open TCP connection (socket.io long-poll requests are
      // never "idle") so the server close settles deterministically.
      httpServer.closeAllConnections?.();
      httpServer.close();
    },
    port: listen.promise,
  };
}

interface DeviceKey {
  privateKey: KeyObject;
  publicKeyJwk: Record<string, unknown>;
}

interface Member {
  did: string;
  token: string;
  refreshToken: string;
  device: DeviceKey;
  deviceId: string;
}

interface HubSetup {
  hub: RealtimeTestHub;
  port: number;
  owner: Member;
  networkId: string;
}

/** Owner identity + identity session + bootstrap network + founder admission. */
async function admitFounder(hub: RealtimeTestHub, port: number): Promise<HubSetup> {
  const keyPair = generateKeyPairSync("ed25519");
  const device: DeviceKey = { privateKey: keyPair.privateKey, publicKeyJwk: keyPair.publicKey.export({ format: "jwk" }) as Record<string, unknown> };
  const publicKeyJwk = device.publicKeyJwk;
  const account = await call(port, "/api/identity/bootstrap/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ firstName: "Brian", lastName: "Noah", device: { deviceId: "dev_owner", publicKeyJwk } }),
  });
  assert.equal(account.status, 201);
  const did = (account.body.account as Json).did as string;
  const challenge = await call(port, "/api/identity/session/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did }),
  });
  const session = await call(port, "/api/identity/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      did,
      deviceId: "dev_owner",
      nonce: challenge.body.nonce,
      signature: sign(null, Buffer.from(challenge.body.nonce as string, "utf8"), device.privateKey).toString("base64url"),
    }),
  });
  assert.equal(session.status, 201);
  const network = await call(port, "/api/social/bootstrap/network", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Brian's Family", ownerDid: did }),
  });
  assert.equal(network.status, 201);
  const invite = await call(port, "/api/social/bootstrap/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "owner", maxUses: 1 }),
  });
  assert.equal(invite.status, 201);
  const code = (invite.body.joinUrl as string).split("/join/")[1];
  const admit = await call(port, "/api/social/join/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      identityAccessToken: (session.body as Json).accessToken,
      deviceId: "dev_owner",
      devicePublicKeyJwk: publicKeyJwk,
      signature: sign(null, Buffer.from(`porchlight-join:${code}`, "utf8"), device.privateKey).toString("base64url"),
    }),
  });
  assert.equal(admit.status, 201);
  return {
    hub,
    port,
    owner: {
      did,
      token: (admit.body as Json).accessToken as string,
      refreshToken: (admit.body as Json).refreshToken as string,
      device,
      deviceId: "dev_owner",
    },
    networkId: (admit.body.membership as Json).networkId as string,
  };
}

/** A second member on the setup's origin: seeded identity + identity session + console invite. */
async function admitSecondMember(setup: HubSetup, deviceId: string, name: string): Promise<Member> {
  const keyPair = generateKeyPairSync("ed25519");
  const device: DeviceKey = { privateKey: keyPair.privateKey, publicKeyJwk: keyPair.publicKey.export({ format: "jwk" }) as Record<string, unknown> };
  const publicKeyJwk = device.publicKeyJwk;
  const did = `did:porch:${randomBytes(20).toString("hex")}`;
  await setup.hub.db.collection("identities").insertOne({
    _id: `ident_${randomUUID()}`,
    did,
    actorType: "human",
    displayName: name,
    email: null,
    handle: null,
    profile: {},
    homingStatus: "home",
    migratedToIssuer: null,
    createdAt: new Date().toISOString(),
  });
  await setup.hub.db.collection("device_registrations").insertOne({
    _id: `reg_${randomUUID()}`,
    did,
    deviceId,
    label: null,
    publicKeyJwk,
    createdBy: "agent",
    status: "active",
    revokedAt: null,
    createdAt: new Date().toISOString(),
  });
  const challenge = await call(setup.port, "/api/identity/session/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did }),
  });
  const session = await call(setup.port, "/api/identity/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      did,
      deviceId,
      nonce: challenge.body.nonce,
      signature: sign(null, Buffer.from(challenge.body.nonce as string, "utf8"), device.privateKey).toString("base64url"),
    }),
  });
  assert.equal(session.status, 201);
  const invite = await call(setup.port, "/api/social/console/invites", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${setup.owner.token}` },
    body: JSON.stringify({ role: "member", maxUses: 1 }),
  });
  assert.equal(invite.status, 201);
  const code = (invite.body.invite as Json).token as string;
  const admit = await call(setup.port, "/api/social/join/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      identityAccessToken: (session.body as Json).accessToken,
      deviceId,
      devicePublicKeyJwk: publicKeyJwk,
      signature: sign(null, Buffer.from(`porchlight-join:${code}`, "utf8"), device.privateKey).toString("base64url"),
    }),
  });
  assert.equal(admit.status, 201);
  return {
    did,
    token: (admit.body as Json).accessToken as string,
    refreshToken: (admit.body as Json).refreshToken as string,
    device,
    deviceId,
  };
}

/** A second ORIGIN network (its own membership perimeter) seeded directly: the isolation e2e premise. */
async function seedOtherOrigin(hub: RealtimeTestHub, port: number, joinCode: string): Promise<{ networkId: string; member: Member }> {
  const networkId = `net_${randomBytes(6).toString("hex")}`;
  await hub.db.collection("networks").insertOne({
    _id: networkId,
    name: "Other Family",
    ownerAccountId: null,
    ownerDid: null,
    quota: { storageCeilingMb: null, retentionDays: null },
    createdAt: new Date().toISOString(),
  });
  await hub.db.collection("invites").insertOne({
    _id: `inv_${randomUUID()}`,
    token: joinCode,
    networkId,
    role: "member",
    maxUses: 1,
    useCount: 0,
    state: "active",
    hubUrl: null,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  });
  const keyPair = generateKeyPairSync("ed25519");
  const device: DeviceKey = { privateKey: keyPair.privateKey, publicKeyJwk: keyPair.publicKey.export({ format: "jwk" }) as Record<string, unknown> };
  const publicKeyJwk = device.publicKeyJwk;
  const did = `did:porch:${randomBytes(20).toString("hex")}`;
  await hub.db.collection("identities").insertOne({
    _id: `ident_${randomUUID()}`,
    did,
    actorType: "human",
    displayName: "Other Member",
    email: null,
    handle: null,
    profile: {},
    homingStatus: "home",
    migratedToIssuer: null,
    createdAt: new Date().toISOString(),
  });
  await hub.db.collection("device_registrations").insertOne({
    _id: `reg_${randomUUID()}`,
    did,
    deviceId: "dev_other",
    label: null,
    publicKeyJwk,
    createdBy: "agent",
    status: "active",
    revokedAt: null,
    createdAt: new Date().toISOString(),
  });
  const challenge = await call(port, "/api/identity/session/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did }),
  });
  const session = await call(port, "/api/identity/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      did,
      deviceId: "dev_other",
      nonce: challenge.body.nonce,
      signature: sign(null, Buffer.from(challenge.body.nonce as string, "utf8"), device.privateKey).toString("base64url"),
    }),
  });
  const admit = await call(port, "/api/social/join/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: joinCode,
      identityAccessToken: (session.body as Json).accessToken,
      deviceId: "dev_other",
      devicePublicKeyJwk: publicKeyJwk,
      signature: sign(null, Buffer.from(`porchlight-join:${joinCode}`, "utf8"), device.privateKey).toString("base64url"),
    }),
  });
  assert.equal(admit.status, 201);
  return {
    networkId,
    member: {
      did,
      token: (admit.body as Json).accessToken as string,
      refreshToken: (admit.body as Json).refreshToken as string,
      device,
      deviceId: "dev_other",
    },
  };
}

/** Signed canonical payload helper for member writes. */
function signPayload(device: { privateKey: KeyObject }, payload: unknown): string {
  return sign(null, Buffer.from(canonicalJson(payload as object), "utf8"), device.privateKey).toString("base64url");
}

interface SocketChannel {
  socket: Socket;
  events: Json[];
  /** Resolves when the channel has received at least `count` envelopes. */
  waitEvents: (count: number) => Promise<Json>;
  connectError: () => Promise<Error>;
  closed: () => Promise<string>;
  connected: () => Promise<void>;
}

/** A socket.io client over the wire, recording the `event` envelopes it receives. */
function connectSocket(port: number, auth: { networkId: string; token?: string }): SocketChannel {
  const events: Json[] = [];
  const waiting: Array<{ count: number; resolve: (value: Json) => void }> = [];
  const connectError = Promise.withResolvers<Error>();
  const connected = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<string>();
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    auth: { networkId: auth.networkId, token: auth.token ?? null },
  });
  const releaseReady = () => {
    for (const item of [...waiting]) {
      if (events.length >= item.count) {
        item.resolve(events[item.count - 1]);
        waiting.splice(waiting.indexOf(item), 1);
      }
    }
  };
  socket.on("event", (raw: unknown) => {
    events.push(raw as Json);
    releaseReady();
  });
  socket.on("connect_error", (error: Error) => {
    connectError.resolve(error);
  });
  socket.on("connect", () => connected.resolve());
  socket.on("disconnect", (reason: string) => closed.resolve(reason));
  return {
    socket,
    events,
    waitEvents: (count: number) => {
      if (events.length >= count) {
        return Promise.resolve(events[count - 1]);
      }
      const awaited = Promise.withResolvers<Json>();
      waiting.push({ count, resolve: awaited.resolve });
      return awaited.promise;
    },
    connectError: () => connectError.promise,
    closed: () => closed.promise,
    connected: () => connected.promise,
  };
}

/** Explicit subscribe message; resolves the verification ack. */
function explicitSubscribe(channel: SocketChannel, token: string, networkId: string): Promise<Json> {
  return new Promise((resolve) => {
    channel.socket.emit("events:subscribe", { token, networkId }, (result: Json) => resolve(result));
  });
}

/** Signed text post through the REST write path. */
async function createPost(setup: HubSetup, member: Member, body: string): Promise<string> {
  const payload = { type: "text", body };
  const res = await call(setup.port, "/api/social/posts", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${member.token}` },
    body: JSON.stringify({ payload, signature: signPayload(member.device, payload) }),
  });
  assert.equal(res.status, 200);
  return (res.body.post as Json)._id as string;
}

/** Real-time delivery races the event loop and the wire, not test time; a
 * short settle is the only honest negative-signal window here (documented
 * exception: no deterministic control over socket arrival). */
function settle(ms = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectAll(channels: SocketChannel[], t: import("node:test").TestContext): Promise<void> {
  const promises = channels.map((channel) => {
    const opened = Promise.withResolvers<void>();
    channel.socket.on("connect", () => opened.resolve());
    channel.socket.on("connect_error", () => opened.resolve());
    t.after(() => channel.socket.disconnect());
    return opened.promise;
  });
  await Promise.all(promises);
}

test("ac-1 isolation + ac-2 payload privacy over the wire: origin A's events reach only A's subscribers; payloads carry content only; votes emit nothing", async (t) => {
  const hub = realtimeTestHub();
  t.after(hub.close);
  const port = await hub.port;
  const setup = await admitFounder(hub, port);
  const a2 = await admitSecondMember(setup, "dev_a2", "Susan");
  const other = await seedOtherOrigin(hub, port, "other-family-join");

  const ownerC = connectSocket(port, { networkId: setup.networkId, token: setup.owner.token });
  const a2C = connectSocket(port, { networkId: setup.networkId, token: a2.token });
  const otherC = connectSocket(port, { networkId: other.networkId, token: other.member.token });
  await connectAll([ownerC, a2C, otherC], t);
  assert.ok(ownerC.socket.connected);

  // The write: a real signed post at origin A.
  const postId = await createPost(setup, setup.owner, "Live feed arrives");

  // Both origin-A subscribers received the envelope; origin B received NOTHING.
  assert.equal(((await ownerC.waitEvents(1)) as Json).type, "post.created");
  assert.equal(((await a2C.waitEvents(1)) as Json).type, "post.created");
  assert.equal((ownerC.events.at(-1) as Json)?.postId, postId);
  assert.equal(((ownerC.events.at(-1) as Json)?.content as Json)?.body, "Live feed arrives");
  await settle();
  assert.equal(otherC.events.length, 0, "an origin-B subscriber received an origin-A event — isolation violation");

  // Payload audit (ac-2): the envelope carries content only.
  const envelope = ownerC.events.at(-1) as Json;
  assert.ok(!("interactionCounters" in envelope));
  assert.ok(!("deviceSignature" in envelope));
  assert.ok(!("interactionCounters" in (envelope.content as Json)));
  assert.ok(!("deviceSignature" in (envelope.content as Json)));
  assert.equal(envelope.networkId, setup.networkId);

  // A vote write emits NO event to anyone (vote privacy extends to transport).
  const votePayload = { postId, value: "up" };
  await call(setup.port, `/api/social/posts/${postId}/votes`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${a2.token}` },
    body: JSON.stringify({ payload: votePayload, signature: signPayload(a2.device, votePayload) }),
  });
  await settle();
  assert.equal(ownerC.events.length, 1, "a vote write delivered an event — vote privacy violation");
  assert.equal(a2C.events.length, 1, "a vote write delivered an event — vote privacy violation");
  assert.equal(otherC.events.length, 0);

  // A reaction write delivers exactly the reaction event with the
  // as-authored emoji — content, never a count.
  const reactPayload = { postId, emoji: "❤️" };
  const reactRes = await call(setup.port, `/api/social/posts/${postId}/reactions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${a2.token}` },
    body: JSON.stringify({ payload: reactPayload, signature: signPayload(a2.device, reactPayload) }),
  });
  assert.equal(reactRes.status, 200);
  assert.equal(((await a2C.waitEvents(2)) as Json).type, "reaction.applied");
  assert.equal(((ownerC.events.at(-1) as Json)?.content as Json)?.emoji, "❤️");
  await settle();
  assert.equal(otherC.events.length, 0);
});

test("ac-4 enforcement over the wire: cross-origin subscribe refused, missing token refused, revocation closes the live subscription immediately", async (t) => {
  const hub = realtimeTestHub();
  t.after(hub.close);
  const port = await hub.port;
  const setup = await admitFounder(hub, port);
  const a2 = await admitSecondMember(setup, "dev_a2", "Dana");
  const other = await seedOtherOrigin(hub, port, "other-family-join");

  // A live membership token for ANOTHER origin never opens this room —
  // refused server-side at subscribe/handshake time.
  const refused = connectSocket(port, { networkId: setup.networkId, token: other.member.token });
  const refusal = await refused.connectError();
  t.after(() => refused.socket.disconnect());
  assert.ok(refusal instanceof Error, "cross-origin subscribe opened the room — perimeter violation");

  // Explicit subscribe acks carry the plain-language refusals.
  const legit = connectSocket(port, { networkId: setup.networkId, token: setup.owner.token });
  await legit.connected();
  t.after(() => legit.socket.disconnect());
  const badAck = await explicitSubscribe(legit, other.member.token, setup.networkId);
  assert.equal(badAck.ok, false);
  assert.equal(badAck.code, "E_NOT_PERMITTED");
  const noTokenAck = await explicitSubscribe(legit, "", "");
  assert.equal(noTokenAck.ok, false);
  assert.equal(typeof noTokenAck.message === "string" && (noTokenAck.message as string).length > 0, true, "the refusal is plain language, never raw internals");
  const goodAck = await explicitSubscribe(legit, setup.owner.token, setup.networkId);
  assert.equal(goodAck.ok, true);

  // Revocation (ac-4): the revoked member's live socket closes the moment
  // the owner console acts — not at the member's next request.
  const revokedChannel = connectSocket(port, { networkId: setup.networkId, token: a2.token });
  await revokedChannel.connected();
  t.after(() => revokedChannel.socket.disconnect());
  const revoke = await call(port, "/api/social/console/members/revoke", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${setup.owner.token}` },
    body: JSON.stringify({ did: a2.did }),
  });
  assert.equal(revoke.status, 200);
  const reason = await revokedChannel.closed();
  assert.ok(
    reason.includes("io server disconnect") || reason.includes("server namespace disconnect"),
    `unexpected disconnect reason: ${reason}`,
  );

  // The revoked membership is dead: re-subscription can never verify.
  const regen = connectSocket(port, { networkId: setup.networkId, token: a2.token });
  t.after(() => regen.socket.disconnect());
  assert.ok((await regen.connectError()) instanceof Error);
});

test("ac-3 catch-up over the wire: reconnect replays exactly the missed deltas inside the window; beyond the window the REST fallback resolves stale", async (t) => {
  const hub = realtimeTestHub();
  t.after(hub.close);
  const port = await hub.port;
  const setup = await admitFounder(hub, port);

  // Baseline: the device is live, sees one event, stores its cursor.
  const device1 = connectSocket(port, { networkId: setup.networkId, token: setup.owner.token });
  t.after(() => device1.socket.disconnect());
  const device1Ready = Promise.withResolvers<void>();
  device1.socket.on("connect", () => device1Ready.resolve());
  device1.socket.on("connect_error", () => device1Ready.resolve());
  await device1Ready.promise;
  await createPost(setup, setup.owner, "baseline post");
  const baseline = ((await device1.waitEvents(1)) as Json).seq as string;

  // The device goes offline; two events land during the absence.
  device1.socket.disconnect();
  await createPost(setup, setup.owner, "missed one");
  await createPost(setup, setup.owner, "missed two");

  // Reconnect catch-up (REST, ac-3): exactly the two missed deltas, without
  // a manual refresh; the cursor advances for the next window.
  const replay = await call(port, `/api/social/events?since=${encodeURIComponent(baseline)}`, {
    headers: { "content-type": "application/json", authorization: `Bearer ${setup.owner.token}` },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.stale, false);
  const replayed = replay.body.events as Json[];
  assert.deepEqual(
    replayed.map((row) => (row.content as Json).body),
    ["missed one", "missed two"],
  );
  assert.ok(typeof replay.body.cursor === "string");

  // Anonymous and non-member reads refuse — the replay is member-scoped.
  const anon = await call(port, "/api/social/events");
  assert.equal(anon.status, 401);

  // Beyond the window: a plane retaining ONE entry consumes the cursor's
  // neighborhood on the next write — the old cursor cannot resolve the gap
  // → stale:true + empty events → the client falls back to the REST reads
  // with the freshness note.
  const thinHub = realtimeTestHub({ maxLength: 1 });
  t.after(thinHub.close);
  const thinPort = await thinHub.port;
  const thinSetup = await admitFounder(thinHub, thinPort);
  const thinDevice = connectSocket(thinPort, { networkId: thinSetup.networkId, token: thinSetup.owner.token });
  t.after(() => thinDevice.socket.disconnect());
  const thinReady = Promise.withResolvers<void>();
  thinDevice.socket.on("connect", () => thinReady.resolve());
  thinDevice.socket.on("connect_error", () => thinReady.resolve());
  await thinReady.promise;
  await createPost(thinSetup, thinSetup.owner, "thin baseline");
  const thinBaseline = ((await thinDevice.waitEvents(1)) as Json).seq as string;
  thinDevice.socket.disconnect();
  await createPost(thinSetup, thinSetup.owner, "trimmer");
  await createPost(thinSetup, thinSetup.owner, "after trim");
  const beyond = await call(thinPort, `/api/social/events?since=${encodeURIComponent(thinBaseline)}`, {
    headers: { "content-type": "application/json", authorization: `Bearer ${thinSetup.owner.token}` },
  });
  assert.equal(beyond.status, 200);
  assert.equal(beyond.body.stale, true);
  assert.deepEqual(beyond.body.events, []);
  // Fresh device (no cursor): the retained window replays with its cursor.
  const freshThin = await call(thinPort, "/api/social/events", {
    headers: { "content-type": "application/json", authorization: `Bearer ${thinSetup.owner.token}` },
  });
  assert.equal(freshThin.body.stale, false);
  const thinLast = (freshThin.body.events as Json[]).at(-1) as Json;
  assert.equal(thinLast?.type, "post.created");
  assert.equal((thinLast?.content as Json)?.body, "after trim");
});