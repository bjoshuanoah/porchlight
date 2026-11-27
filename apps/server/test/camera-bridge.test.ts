import { test } from "node:test";
import assert from "node:assert/strict";
import { sign, generateKeyPairSync } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { Server } from "node:http";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { canonicalJson, DEFAULT_CONFIG, createMemoryStore, normalizeConfig } from "@porchlight/shared";
import type { PorchlightConfig, StoreLike } from "@porchlight/shared";
import { BootstrapService } from "../src/services/bootstrap.service.js";
import { createServer } from "../src/router.js";
import type { Probe } from "../src/dependencies.js";

/**
 * PORCH-139 transport contract: the camera bridge's vertical slice rides the
 * running hub under /api/home — the engine seam builds from the runtime
 * config of record, camera authorization is its own scope class, the view
 * session mints a scoped engine token, and the media proxy streams the
 * engine's standing re-stream through the hub origin. Unwired config fails
 * closed with plain language.
 */

interface Json { [key: string]: unknown }

const OK_PROBES: { mongo: Probe; redis: Probe } = { mongo: async () => "ok", redis: async () => "ok" };

function mutableConfig(): PorchlightConfig {
  return normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as PorchlightConfig);
}

function testHub(config: PorchlightConfig) {
  const db = createMemoryStore() as StoreLike;
  const bootstrap = new BootstrapService(db, config, "/tmp/porchlight-camera-test");
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


function deviceSign(pair: DevicePair, payload: object): string {
  return sign(null, Buffer.from(canonicalJson(payload), "utf8"), pair.privateKey).toString("base64url");
}

/** The real identity flow: account birth → challenge proof → session token. */
async function homeSession(hub: { port: Promise<number> }, device: DevicePair, name = "Porch Cam"): Promise<{ token: string; did: string }> {
  const port = await hub.port;
  const created = await fetch(`http://127.0.0.1:${port}/api/identity/bootstrap/account`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ firstName: name.split(" ")[0], lastName: name.split(" ")[1] ?? "", device: { deviceId: device.deviceId, publicKeyJwk: device.publicKeyJwk } }),
  });
  // Account birth answers 201 fresh and 200 on the idempotent re-birth.
  assert.ok([200, 201].includes(created.status), `account birth answered ${created.status}`);
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
  // The identity birth answers 201 fresh and 200 when the account/device
  // already exists (idempotent bootstrap) — both are a session of record.
  const sessionBody = await session.text();
  assert.ok([200, 201].includes(session.status), `session birth answered ${session.status}: ${sessionBody}`);
  assert.match(sessionBody, /accessToken/);
  return { token: ((JSON.parse(sessionBody) as Json)).accessToken as string, did };
}

async function createHome(hub: { port: Promise<number> }, token: string, pair: DevicePair, name = "Fieldstone"): Promise<string> {
  const port = await hub.port;
  const res = await fetch(`http://127.0.0.1:${port}/api/home/homes`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ payload: { name }, signature: deviceSign(pair, { name }) }),
  });
  assert.equal(res.status, 200);
  return (((await res.json()) as Json).home as Json)._id as string;
}

/**
 * The fake engine HTTP surface (the contract the bridge consumes): camera
 * validation, standing feeds, health planes, and evidence. `calls` records
 * the seam traffic the bridge makes.
 */
async function fakeEngine(): Promise<{ server: Server; url: string; calls: string[] }> {
  const calls: string[] = [];
  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://engine");
    calls.push(`${req.method} ${url.pathname}`);
    if (req.method === "POST" && url.pathname === "/cameras") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, cameraId: "eng_cam1", aspect: { width: 9, height: 16 }, audio: true }));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/live/")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ upstreamId: "up_1", path: "/media/eng_cam1.fmp4", audio: true }));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/media/")) {
      res.setHeader("content-type", "video/mp4");
      res.end(Buffer.from("engine-media-bytes"));
      return;
    }
    if (req.method === "GET" && url.pathname === "/cameras/eng_cam1/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ recording: { state: "recording" }, playback: { state: "live" }, detection: { state: "ok" } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "engine route not on the contract" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}`, calls };
}

test("camera bridge: unwired config refuses closed with plain language (contract)", async (t) => {
  const hub = testHub(mutableConfig());
  t.after(hub.close);
  const pair = homePair("cam-dev-0");
  const { token } = await homeSession(hub, pair);
  const homeId = await createHome(hub, token, pair);
  const res = await fetch(`http://127.0.0.1:${await hub.port}/api/home/homes/${homeId}/cameras`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 503);
  const body = (await res.json()) as Json;
  assert.equal(body.code, "E_ENGINE_NOT_CONNECTED");
  assert.match(String(body.error), /engine isn't connected/);
});

test("camera bridge: add a camera through the engine onboarding, read feeds, mint the scoped token, and stream one media path (contract)", async (t) => {
  const engine = await fakeEngine();
  t.after(() => new Promise<void>((resolve) => engine.server.close(() => resolve())));
  const config = mutableConfig();
  (config as unknown as Json).engine = { baseUrl: engine.url, busUrl: null, secret: "engine-secret-of-record" };
  const hub = testHub(config);
  t.after(hub.close);
  const port = await hub.port;
  const pair = homePair("cam-dev-1");
  const { token, did } = await homeSession(hub, pair);
  const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const homeId = await createHome(hub, token, pair);

  // The owner adds a camera: the engine's onboarding validates the RTSP.
  const added = await fetch(`http://127.0.0.1:${port}/api/home/homes/${homeId}/cameras`, {
    method: "POST", headers: auth,
    body: JSON.stringify({
      payload: { name: "Front door", rtsp: "rtsp://doorbell/stream", areaId: null },
      signature: deviceSign(pair, { name: "Front door", rtsp: "rtsp://doorbell/stream", areaId: null }),
    }),
  });
  assert.equal(added.status, 200);
  const camera = (((await added.json()) as Json).camera as Json);
  assert.equal(camera.recordingEnabled, true);
  assert.match(String((camera.aspect as Json).width), /^9$/);

  // The camera list serves health planes from the engine (recording but
  // detection-dead would read its own state; here the planes answer live).
  const list = await fetch(`http://127.0.0.1:${port}/api/home/homes/${homeId}/cameras`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(list.status, 200);
  const listed = ((await list.json()) as Json).cameras as Json[];
  assert.equal(listed.length, 1);
  // The audio plane joins the health contract (PORCH-153); the stub engine
  // answers no audio plane, so the hub renders the explained unavailable row.
  assert.deepEqual(listed[0].health, { recording: { state: "recording" }, playback: { state: "live" }, detection: { state: "ok" }, audio: { state: "unavailable", detail: null } });

  // The scoped view session mints the engine token and the feed descriptor
  // (portrait doorbell, per-camera audio).
  const sessionRes = await fetch(`http://127.0.0.1:${port}/api/home/homes/${homeId}/cameras/view`, {
    method: "POST", headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(sessionRes.status, 200);
  const viewSession = (await sessionRes.json()) as Json;
  assert.match(String(viewSession.token), /^peng1\./);
  const descriptor = (viewSession.cameras as Json[])[0];
  assert.equal(descriptor.portrait, true);
  assert.equal(descriptor.audio, true);

  // The refusal cases that need a second identity on the hub (stranger,
  // visit grantee) verify at the module level over the same authorization
  // seam the hub mounts; here the anonymous case proves the transport gate.
  const anonymous = await fetch(`http://127.0.0.1:${port}/api/home/homes/${homeId}/cameras`);
  assert.equal(anonymous.status, 401);

  // The media proxy streams the engine's standing re-stream behind the
  // scoped token — bearer-session auth resolves the same surface.
  const media = await fetch(
    `http://127.0.0.1:${port}/api/home/homes/${homeId}/cameras/${camera._id as string}/media?path=${encodeURIComponent("/media/eng_cam1.fmp4")}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  assert.equal(media.status, 200);
  assert.equal(media.headers.get("content-type"), "video/mp4");
  assert.equal(await media.text(), "engine-media-bytes");

  // The token path resolves media for <video> tags — invalid tokens refuse.
  const badToken = await fetch(
    `http://127.0.0.1:${port}/api/home/homes/${homeId}/cameras/${camera._id as string}/media?path=${encodeURIComponent("/media/eng_cam1.fmp4")}&token=peng1.${Buffer.from('{"v":1,"exp":1}').toString("base64url")}.AAAA`,
  );
  assert.equal(badToken.status, 401);
  void did;
});
