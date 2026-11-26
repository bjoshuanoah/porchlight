import { test } from "node:test";
import assert from "node:assert/strict";
import { sign, generateKeyPairSync } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { DEFAULT_CONFIG, createMemoryStore, normalizeConfig, canonicalJson } from "@porchlight/shared";
import type { PorchlightConfig, StoreLike } from "@porchlight/shared";
import { BootstrapService } from "../src/services/bootstrap.service.js";
import { createServer } from "../src/router.js";
import type { Probe } from "../src/dependencies.js";

/**
 * PORCH-137 transport contract: the home module's vertical slice rides the
 * running hub under /api/home — the device-bound identity plane is the only
 * auth surface, member writes are device-signed, and home scope is enforced
 * hub-side. The REAL identity module serves (no identity mocks).
 */

interface Json { [key: string]: unknown }

const OK_PROBES: { mongo: Probe; redis: Probe } = { mongo: async () => "ok", redis: async () => "ok" };

function mutableConfig(): PorchlightConfig {
  return normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as PorchlightConfig);
}

function testHub() {
  const db = createMemoryStore() as StoreLike;
  const config = mutableConfig();
  const bootstrap = new BootstrapService(db, config, "/tmp/porchlight-home-test");
  const app = createServer({ store: db, readiness: OK_PROBES, config, bootstrap });
  const { promise, resolve } = Promise.withResolvers<number>();
  const listener = app.listen(0, () => {
    const address = listener.address();
    const port = typeof address === "object" && address ? address.port : 0;
    resolve(port);
  });
  return { db, close: () => { listener.closeIdleConnections(); listener.close(); }, port: promise };
}

type DevicePair = { deviceId: string; privateKey: KeyObject; publicKeyJwk: Json };

function homePair(deviceId: string): DevicePair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { deviceId, privateKey, publicKeyJwk: publicKey.export({ format: "jwk" }) as Json };
}

/** Signature over canonicalJson(payload), base64url — the device-credential law. */
function homeSign(pair: DevicePair, payload: object): string {
  return sign(null, Buffer.from(canonicalJson(payload), "utf8"), pair.privateKey).toString("base64url");
}

/** The real identity flow: account birth → challenge proof → session token. */
async function homeSession(hub: { port: Promise<number> }, device: { deviceId: string; publicKeyJwk: Json; privateKey: KeyObject }): Promise<{ token: string; did: string }> {
  const port = await hub.port;
  const created = await fetch(`http://127.0.0.1:${port}/api/identity/bootstrap/account`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ firstName: "Porch", lastName: "Tester", device: { deviceId: device.deviceId, publicKeyJwk: device.publicKeyJwk } }),
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

test("home vertical: create, list, rename homes on the running hub (contract)", async (t) => {
  const hub = testHub();
  t.after(hub.close);
  const port = await hub.port;
  const pair = homePair("home-dev-1");
  const { token } = await homeSession(hub, pair);
  const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };

  // Signed home creation.
  const created = await fetch(`http://127.0.0.1:${port}/api/home/homes`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ payload: { name: "Fieldstone" }, signature: homeSign(pair, { name: "Fieldstone" }) }),
  });
  assert.equal(created.status, 200);
  const createdHome = ((await created.json()) as Json).home as Json;
  assert.equal(createdHome.name, "Fieldstone");
  assert.equal(createdHome.role, "owner");
  const homeId = createdHome._id as string;

  // Tokenless writes never resolve a perimeter.
  const tokenless = await fetch(`http://127.0.0.1:${port}/api/home/homes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload: { name: "No token" }, signature: "AAAA" }),
  });
  assert.equal(tokenless.status, 401);

  // A write with a signature that doesn't verify is refused.
  const badSignature = await fetch(`http://127.0.0.1:${port}/api/home/homes`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ payload: { name: "Bad" }, signature: "AAAA" }),
  });
  assert.equal(badSignature.status, 403);

  // Rename rides the same signed path.
  const renamed = await fetch(`http://127.0.0.1:${port}/api/home/homes/${homeId}`, {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({ payload: { name: "Fieldstone House" }, signature: homeSign(pair, { name: "Fieldstone House" }) }),
  });
  assert.equal(renamed.status, 200);
  assert.equal((((await renamed.json()) as Json).home as Json).name, "Fieldstone House");

  // The member's homes list answers one installation, N homes.
  const list = await fetch(`http://127.0.0.1:${port}/api/home/homes`, { headers: auth });
  assert.equal((((await list.json()) as Json).homes as Json[]).length, 1);
});

test("home vertical: areas/devices register and scope enforcement refuses cross-home reads (contract)", async (t) => {
  const hub = testHub();
  t.after(hub.close);
  const port = await hub.port;
  const pair = homePair("home-dev-2");
  const session = await homeSession(hub, pair);
  const token = session.token;
  const ownerId = session.did;
  const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const home = async (name: string) => {
    const created = await fetch(`http://127.0.0.1:${port}/api/home/homes`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ payload: { name }, signature: homeSign(pair, { name }) }),
    });
    return (((await created.json()) as Json).home as Json)._id as string;
  };
  const homeA = await home("Fieldstone");
  const homeB = await home("Lakeside");

  const area = await fetch(`http://127.0.0.1:${port}/api/home/homes/${homeA}/areas`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ payload: { name: "Living room", kind: "room" }, signature: homeSign(pair, { name: "Living room", kind: "room" }) }),
  });
  assert.equal(area.status, 200);
  const areaId = (((await area.json()) as Json).area as Json)._id as string;

  const devicePayload = { name: "Living lamp", areaId, capabilities: ["switch", "light"], adapter: { name: "unbound", binding: null } };
  const device = await fetch(`http://127.0.0.1:${port}/api/home/homes/${homeA}/devices`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ payload: devicePayload, signature: homeSign(pair, devicePayload) }),
  });
  assert.equal(device.status, 200);
  const deviceId = (((await device.json()) as Json).device as Json)._id as string;

  // The home-in-view read serves the surfaces, grouped-collections intact.
  const detail = await fetch(`http://127.0.0.1:${port}/api/home/homes/${homeA}`, { headers: auth });
  assert.equal(detail.status, 200);
  const surfaces = (await detail.json()) as Json;
  assert.equal((surfaces.devices as Json[])[0].name, "Living lamp");
  assert.equal((surfaces.areas as Json[])[0].kind, "room");

  // No adapter is connected for this device: an honest E_NO_ADAPTER refusal,
  // never a silent no-op — the command machinery fails with an explanation.
  const refused = await fetch(`http://127.0.0.1:${port}/api/home/devices/${deviceId}/command`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ payload: { command: "turnOn" }, signature: homeSign(pair, { command: "turnOn" }) }),
  });
  assert.equal(refused.status, 409);
  assert.equal(((await refused.json()) as Json).code, "E_NO_ADAPTER");

  // A device read scoped under the other home refuses as cross-home scope.
  const crossRead = await fetch(`http://127.0.0.1:${port}/api/home/homes/${homeB}/devices/${deviceId}/state`, { headers: auth });
  assert.equal(crossRead.status, 403);

  // The audit trail answers on the transport: actor + outcome of record.
  const audit = await fetch(`http://127.0.0.1:${port}/api/home/homes/${homeA}/audit`, { headers: auth });
  assert.equal(audit.status, 200);
  const auditBody = (await audit.json()) as Json;
  const commandRow = (auditBody.events as Json[]).find((event) => event.type === "command");
  assert.ok(commandRow);
  assert.equal(commandRow.actorIdentityRef, ownerId);
});
