import { test } from "node:test";
import assert from "node:assert/strict";
import { sign, generateKeyPairSync } from "node:crypto";
import { DEFAULT_CONFIG, createMemoryStore, normalizeConfig } from "@porchlight/shared";
import type { PorchlightConfig, StoreLike } from "@porchlight/shared";
import { BootstrapService } from "../src/services/bootstrap.service.js";
import { createServer } from "../src/router.js";
import type { Probe } from "../src/dependencies.js";

/**
 * PORCH-019: end-to-end 401 capture (ac-1). Under normal member usage the
 * renewal/burst pattern that 401s on hub access — a re-credential superseding
 * the session another tab still holds, an access TTL expiry, and the stale
 * console fan-out — every 401 lands in ONE captured line per request: the
 * endpoint, the failing step (reason), and the session/device identity
 * state. Token material never rides a capture line.
 */

const OK_PROBES: { mongo: Probe; redis: Probe } = { mongo: async () => "ok", redis: async () => "ok" };

function mutableConfig(): PorchlightConfig {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as PorchlightConfig;
  return normalizeConfig(config);
}

interface HttpReply { status: number; json: Record<string, unknown> }

test("401s on hub access are captured with endpoint, failing step, and session/device state (ac-1)", async (t) => {
  const captured: string[] = [];
  const db = createMemoryStore() as StoreLike;
  const config = mutableConfig();
  const bootstrap = new BootstrapService(db, config, "/tmp/porchlight-019-contract-home");
  const { promise: port, resolve: resolvePort } = Promise.withResolvers<number>();
  const app = createServer({ store: db, readiness: OK_PROBES, config, bootstrap, hubUrl: () => null, log: (line) => captured.push(line) });
  const listener = app.listen(0, () => {
    const address = listener.address();
    resolvePort(typeof address === "object" && address ? address.port : 0);
  });
  t.after(() => { listener.closeIdleConnections(); listener.close(); });
  const p = await port;
  const hub = `http://127.0.0.1:${p}`;

  const device = generateKeyPairSync("ed25519");
  const publicKeyJwk = device.publicKey.export({ format: "jwk" });
  const signBase64 = (message: Buffer) => sign(null, message, device.privateKey).toString("base64url");
  const call = async (path: string, init?: RequestInit): Promise<HttpReply> => {
    const res = await fetch(`${hub}${path}`, init);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  // Member: account → session (tab A) → network → membership tokens.
  const account = await call("/api/identity/bootstrap/account", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ firstName: "Brian", lastName: "Noah", device: { deviceId: "dev_1", publicKeyJwk } }),
  });
  const accountInfo = account.json.account as Record<string, unknown>;
  const did = accountInfo.did as string;
  const openSession = async (): Promise<Record<string, string>> => {
    const ch = await call("/api/identity/session/challenge", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ did }),
    });
    const s = await call("/api/identity/session", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ did, deviceId: "dev_1", nonce: ch.json.nonce, signature: signBase64(Buffer.from(ch.json.nonce as string, "utf8")) }),
    });
    return s.json as Record<string, string>;
  };
  const tabA = await openSession();
  const liveDevices = await call("/api/identity/devices", { headers: { authorization: `Bearer ${tabA.accessToken}` } });
  assert.equal(liveDevices.status, 200);

  await call("/api/social/bootstrap/network", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Family" }) });
  const invite = await call("/api/social/bootstrap/invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
  const code = (invite.json.joinUrl as string).split("/join/")[1];
  const admitted = await call("/api/social/join/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, identityAccessToken: tabA.accessToken, deviceId: "dev_1", devicePublicKeyJwk: publicKeyJwk, signature: signBase64(Buffer.from(`porchlight-join:${code}`, "utf8")) }),
  });
  const membershipToken = admitted.json.accessToken as string;
  const networkId = admitted.json.networkId as string;

  // 1) The renewal re-open (tab B / next forced renew) SUPERSEDES tab A's
  //    identity session; the 15s device poll keeps presenting the dead token.
  const tabB = await openSession();
  const superseded = await call("/api/identity/devices", { headers: { authorization: `Bearer ${tabA.accessToken}` } });
  assert.equal(superseded.status, 401);

  // 2) Access TTL expiry on the renewed session (throttled background tab).
  const rows = (await db.collection("sessions").find({})) as Array<Record<string, unknown>>;
  const live = rows[rows.length - 1];
  await db.collection("sessions").updateOne(
    { _id: live._id },
    { $set: { accessExpiresAt: new Date(Date.now() - 1000).toISOString() } },
  );
  const expired = await call("/api/identity/devices", { headers: { authorization: `Bearer ${tabB.accessToken}` } });
  assert.equal(expired.status, 401);

  // 3) Membership expiry: one stale reload fan-out, owner-console reads.
  const mrows = (await db.collection("membership_sessions").find({})) as Array<Record<string, unknown>>;
  await db.collection("membership_sessions").updateOne(
    { _id: mrows[0]._id },
    { $set: { accessExpiresAt: new Date(Date.now() - 1000).toISOString() } },
  );
  for (const surface of ["/api/social/console/groups", "/api/social/console/members"]) {
    const stale = await call(surface, { headers: { authorization: `Bearer ${membershipToken}` } });
    assert.equal(stale.status, 401);
  }

  // 4) The auth surface's own failures are captured too (session-open 401s).
  const bogus = await call("/api/identity/session", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ did, deviceId: "dev_1", nonce: "gone", signature: "forged" }),
  });
  assert.equal(bogus.status, 401);

  // Every 401 above produced exactly one captured line with full context.
  assert.equal(captured.length, 5);
  const events = captured.map((line) => JSON.parse(line.split("hub: auth-failure ")[1]) as Record<string, unknown>);
  const byEndpoint = (endpoint: string) => events.filter((e) => e.endpoint === endpoint);

  const devicePolls = byEndpoint("GET /api/identity/devices") as Array<Record<string, unknown>>;
  assert.deepEqual(devicePolls.map((e) => e.reason), ["session_superseded", "expired_access_token"]);
  assert.equal(devicePolls[0].did, did);
  assert.equal(devicePolls[0].deviceId, "dev_1");
  assert.equal(devicePolls[0].registrationStatus, "active");
  assert.ok(devicePolls[0].sessionId);

  const consoleReads = byEndpoint("GET /api/social/console/groups") as Array<Record<string, unknown>>;
  assert.deepEqual(consoleReads.map((e) => e.reason), ["expired_access_token"]);
  assert.equal(consoleReads[0].networkId, networkId);
  assert.equal(consoleReads[0].did, did);

  const sessionOpen = byEndpoint("POST /api/identity/session") as Array<Record<string, unknown>>;
  assert.equal(sessionOpen.length, 1);
  assert.equal(sessionOpen[0].reason, "E_CHALLENGE_REQUIRED");
  assert.equal(sessionOpen[0].claimedDeviceId, "dev_1");
  assert.equal(sessionOpen[0].claimedDid, did);

  // The capture never carries token material.
  for (const line of captured) {
    for (const token of [tabA.accessToken, tabB.accessToken, membershipToken]) {
      assert.ok(!line.includes(token), "token material must never appear in a capture line");
    }
  }
});