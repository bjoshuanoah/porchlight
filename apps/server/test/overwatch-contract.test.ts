import { test } from "node:test";
import assert from "node:assert/strict";
import { sign, generateKeyPairSync } from "node:crypto";
import fsDefault from "node:fs";
import osDefault from "node:os";
import pathDefault from "node:path";
import type { KeyObject } from "node:crypto";
import { DEFAULT_CONFIG, createMemoryStore, normalizeConfig, canonicalJson } from "@porchlight/shared";
import type { PorchlightConfig, StoreLike } from "@porchlight/shared";
import { BootstrapService } from "../src/services/bootstrap.service.js";
import { createServer } from "../src/router.js";
import type { Probe } from "../src/dependencies.js";

/**
 * PORCH-140 transport contract: the overwatch REST plane rides the running
 * hub under /api/overwatch — gated on `overwatchServingEnabled`, riding the
 * SAME identity + home perimeter as the home module (access token → did →
 * the home module's own authorization: members read, the home's owner
 * mutates). Zones persist under the hub root's config/overwatch/ path. The
 * plane's content seams (chains/clips/outages) are injected as the engine
 * pipeline would — the adapter itself carries no domain logic.
 */

interface Json { [key: string]: unknown }

const OK_PROBES: { mongo: Probe; redis: Probe } = { mongo: async () => "ok", redis: async () => "ok" };

function mutableConfig(): PorchlightConfig {
  return normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as PorchlightConfig);
}

type DevicePair = { deviceId: string; privateKey: KeyObject; publicKeyJwk: Json };

function homePair(deviceId: string): DevicePair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { deviceId, privateKey, publicKeyJwk: publicKey.export({ format: "jwk" }) as Json };
}

/** Device signature over canonicalJson(payload), base64url — the home write law. */
function homeSign(pair: DevicePair, payload: object): string {
  return sign(null, Buffer.from(canonicalJson(payload), "utf8"), pair.privateKey).toString("base64url");
}

/** The real identity flow: account birth → challenge proof → session token. */
async function homeSession(hub: { port: Promise<number> }, device: { deviceId: string; publicKeyJwk: Json; privateKey: KeyObject }, name = "Porch Tester"): Promise<{ token: string; did: string }> {
  const [firstName, lastName] = name.split(" ");
  const port = await hub.port;
  const created = await fetch(`http://127.0.0.1:${port}/api/identity/bootstrap/account`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ firstName, lastName, device: { deviceId: device.deviceId, publicKeyJwk: device.publicKeyJwk } }),
  });
  assert.equal(created.status, 201);
  interface CreatedAccountBody { account: { did: string } }
  const did = ((await created.json()) as CreatedAccountBody).account.did;

  const challenge = await fetch(`http://127.0.0.1:${port}/api/identity/session/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did }),
  });
  assert.equal(challenge.status, 200);
  const nonce = ((await challenge.json()) as Json).nonce as string;
  const session = await fetch(`http://127.0.0.1:${port}/api/identity/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      did,
      deviceId: device.deviceId,
      nonce,
      signature: sign(null, Buffer.from(nonce, "utf8"), device.privateKey).toString("base64url"),
    }),
  });
  assert.equal(session.status, 201);
  return { token: ((await session.json()) as Json).accessToken as string, did };
}

async function createHome(hub: { port: Promise<number> }, device: DevicePair, token: string, name: string): Promise<string> {
  const port = await hub.port;
  const created = await fetch(`http://127.0.0.1:${port}/api/home/homes`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ payload: { name }, signature: homeSign(device, { name }) }),
  });
  assert.equal(created.status, 200);
  return (((await created.json()) as Json).home as Json)._id as string;
}

/**
 * A mid-walk person across two cameras (active against the host clock: the
 * FSM reads MOVING because the sighting gap stays inside the movement law).
 */
function personChain(entityId: string, base: number, cameraA: string, cameraB: string): Record<string, unknown> {
  const sighting = (camera: string, trackId: string, t0: number, t1: number) => ({
    camera, trackId, t0, t1,
    sampleCount: 2,
    cls: "person",
    samples: [[0.2, 0.4, 0.1, 0.4], [0.7, 0.4, 0.1, 0.4]],
  });
  return {
    entityId,
    cls: "person",
    t0: base - 60,
    t1: base,
    sightings: [
      sighting(cameraA, "p1", base - 60, base - 50),
      sighting(cameraB, "p2", base - 42, base),
    ],
  };
}

/** A tracked-scope but non-followable chain (follow is person/vehicle only). */
function packageChain(base: number): Record<string, unknown> {
  return {
    entityId: "pe_parcel",
    cls: "package",
    t0: base,
    t1: base + 10,
    sightings: [{ camera: "front-cam", trackId: "k1", t0: base, t1: base + 10, sampleCount: 1, cls: "package", samples: [[0.5, 0.5, 0.05, 0.05]] }],
  };
}

function testHub(chains?: () => unknown[]): { close: () => void; port: Promise<number>; homeRoot: string } {
  const db = createMemoryStore() as StoreLike;
  const config = mutableConfig();
  const homeRoot = fsDefault.mkdtempSync(pathDefault.join(osDefault.tmpdir(), "porchlight-overwatch-hub-"));
  const bootstrap = new BootstrapService(db, config, pathDefault.join(homeRoot, "state"));
  const app = createServer({
    store: db,
    readiness: OK_PROBES,
    config,
    bootstrap,
    homeRoot,
    overwatch: {
      chainsProvider: chains ?? (() => []),
      clipsProvider: (chain: unknown) =>
        ((chain as { entityId?: string; sightings?: Array<Record<string, unknown>> }).sightings ?? []).map((ref) => ({
          cameraId: String(ref.camera),
          path: `clips/${String((chain as { entityId?: string }).entityId)}/${String(ref.camera)}-${String(ref.trackId)}.mp4`,
          from: Number(ref.t0),
          to: Number(ref.t1),
        })),
    },
  });
  const { promise, resolve } = Promise.withResolvers<number>();
  const listener = app.listen(0, () => resolve((listener.address() as { port: number }).port));
  return {
    homeRoot,
    close: () => { listener.closeIdleConnections(); listener.close(); fsDefault.rmSync(homeRoot, { recursive: true, force: true }); },
    port: promise,
  };
}

function storeDocOf(root: string): Json {
  return JSON.parse(fsDefault.readFileSync(pathDefault.join(root, "config", "overwatch", "config.json"), "utf8")) as Json;
}

test("overwatch vertical: zone save through the hub lands in state GET, files under the hub root (contract)", async (t) => {
  const hub = testHub();
  t.after(hub.close);
  const port = await hub.port;
  const pair = homePair("overwatch-dev-1");
  const { token } = await homeSession(hub, pair);
  const homeId = await createHome(hub, pair, token, "Fieldstone");
  const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };

  // Zone save rides the hub: owner + homeId scope.
  const saved = await fetch(`http://127.0.0.1:${port}/api/overwatch/zones/front-gate?homeId=${homeId}`, {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({ polygon: [[0, 0], [12, 0], [12, 9]] }),
  });
  assert.equal(saved.status, 200);
  assert.equal((((await saved.json()) as Json).zone as Json).cameraId, "front-gate");

  // State GET shows the authored zone; the map view IS the state read.
  const state = await fetch(`http://127.0.0.1:${port}/api/overwatch/state?homeId=${homeId}`, { headers: auth });
  assert.equal(state.status, 200);
  const stateBody = (await state.json()) as Json;
  const camera = (stateBody.cameras as Json[]).find((entry) => entry.cameraId === "front-gate") as Json;
  assert.deepEqual(camera.zone, [[0, 0], [12, 0], [12, 9]]);
  assert.equal(camera.uncovered, false);

  // The durable of record lives under the hub root's config/overwatch path.
  assert.ok((storeDocOf(hub.homeRoot).coverageZones as Json[]).some((zone) => zone.cameraId === "front-gate"));

  // Anonymous: no token, no perimeter — 401 like every home surface.
  const anonymous = await fetch(`http://127.0.0.1:${port}/api/overwatch/state?homeId=${homeId}`);
  assert.equal(anonymous.status, 401);

  // A hub member (valid token) reaching for a home they hold no membership
  // in and no live grant for: the home seam refuses — reads and writes
  // alike, 403 E_NOT_PERMITTED (the same law as the home routes' cross-home
  // scope read).
  const unknownHome = "6a0000000000000000000f0f";
  const otherWrite = await fetch(`http://127.0.0.1:${port}/api/overwatch/zones/driveway?homeId=${unknownHome}`, {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({ polygon: [[1, 1], [5, 1], [5, 5]] }),
  });
  assert.equal(otherWrite.status, 403);
  assert.equal(((await otherWrite.json()) as Json).code, "E_NOT_PERMITTED");
  const otherRead = await fetch(`http://127.0.0.1:${port}/api/overwatch/state?homeId=${unknownHome}`, { headers: auth });
  assert.equal(otherRead.status, 403);

  // The refused write never landed in the durable store.
  assert.ok(!(storeDocOf(hub.homeRoot).coverageZones as Json[]).some((zone) => zone.cameraId === "driveway"));

  // A homeId-less request resolves no home: refuse plainly (403), never
  // serve hub-global state.
  const noHome = await fetch(`http://127.0.0.1:${port}/api/overwatch/state`, { headers: auth });
  assert.equal(noHome.status, 403);
});

test("overwatch vertical: tracked/follow/stream + association flag persist through the hub (contract)", async (t) => {
  const base = Date.now() / 1000;
  const chains = () => [
    personChain("pe_front_walker", base, "front-cam", "back-cam"),
    personChain("pe_back_walker", base + 120, "left-cam", "right-cam"),
    packageChain(base),
  ];
  const hub = testHub(chains);
  t.after(hub.close);
  const port = await hub.port;
  const pair = homePair("overwatch-dev-3");
  const { token, did } = await homeSession(hub, pair);
  const homeId = await createHome(hub, pair, token, "Fieldstone");
  const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };

  // The tracked-objects surface answers the injected entity chains,
  // ordered by lastSeenAt desc; the parcel is tracked but not followable.
  const tracked = await fetch(`http://127.0.0.1:${port}/api/overwatch/tracked?homeId=${homeId}`, { headers: auth });
  assert.equal(tracked.status, 200);
  const list = ((await tracked.json()) as Json).tracked as Json[];
  assert.deepEqual(
    list.map((entry) => entry.entityId),
    ["pe_back_walker", "pe_parcel", "pe_front_walker"],
  );
  assert.equal(list.find((entry) => entry.entityId === "pe_back_walker")?.followed, false);

  // Follow + stream: the followed entity's state + ordered clips.
  const followed = await fetch(`http://127.0.0.1:${port}/api/overwatch/tracked/pe_front_walker/follow?homeId=${homeId}`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ activeCameraId: "front-cam", actorIdentityRef: did }),
  });
  assert.equal(followed.status, 200);
  assert.equal((((await followed.json()) as Json).subscription as Json).engaged, true);

  const stream = await fetch(`http://127.0.0.1:${port}/api/overwatch/tracked/pe_front_walker/stream?homeId=${homeId}`, { headers: auth });
  assert.equal(stream.status, 200);
  const streamBody = (await stream.json()) as Json;
  assert.equal(typeof streamBody.state, "string");
  assert.deepEqual(streamBody.clips, [
    { cameraId: "front-cam", path: "clips/pe_front_walker/front-cam-p1.mp4", from: base - 60, to: base - 50 },
    { cameraId: "back-cam", path: "clips/pe_front_walker/back-cam-p2.mp4", from: base - 42, to: base },
  ]);

  // The follow flag answers on the tracked list after the subscription.
  const refetch = await fetch(`http://127.0.0.1:${port}/api/overwatch/tracked?homeId=${homeId}`, { headers: auth });
  assert.equal(
    (((await refetch.json()) as Json).tracked as Json[]).find((entry) => entry.entityId === "pe_front_walker")?.followed,
    true,
  );

  // The association flag persists its occurrence signatures into the store
  // doc of record and lands an audit row on the plane's own audit surface.
  const flagged = await fetch(`http://127.0.0.1:${port}/api/overwatch/association/flag?homeId=${homeId}`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ fromEntityId: "pe_front_walker", toEntityId: "pe_back_walker", actorIdentityRef: did }),
  });
  assert.equal(flagged.status, 200);
  assert.deepEqual(((await flagged.json()) as Json).added, [
    // The pairKey of every cross-camera sighting pair under the occurrence
    // signature rule the merger consults (insertion order, front chain out).
    "front-cam:p1|left-cam:p1",
    "front-cam:p1|right-cam:p2",
    "back-cam:p2|left-cam:p1",
    "back-cam:p2|right-cam:p2",
  ]);

  const pairs = ((storeDocOf(hub.homeRoot).correlation as Json).separatePairs as string[]);
  assert.ok(pairs.includes("front-cam:p1|left-cam:p1"));

  const audits = await fetch(`http://127.0.0.1:${port}/api/overwatch/audit?homeId=${homeId}&type=association-flag`, { headers: auth });
  assert.equal(audits.status, 200);
  assert.equal((((await audits.json()) as Json).records as Json[]).length, 1);

  // Follow is person/vehicle only — the parcel refuses with the plain law.
  const refused = await fetch(`http://127.0.0.1:${port}/api/overwatch/tracked/pe_parcel/follow?homeId=${homeId}`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({}),
  });
  assert.equal(refused.status, 422);
  assert.equal(((await refused.json()) as Json).error, "Only a person or a vehicle can be followed");
});
