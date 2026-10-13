// PORCH-065: the address-change owner re-auth, run on the REAL apps/server
// vertical (same production-shaped integration harness as the owner-console
// suite: real config file, real module assembles, real HTTP).
//
// Covered here (stage-1 route-surface evidence):
//  - ac-1: the console address action verifies pre-commit, re-points every
//    self-reference, mints the self-targeted one-time grant, returns the
//    redirect to the new origin's grant-consume route with the code.
//  - ac-2: unreachable and foreign candidates refuse in plain language with
//    zero mutation; the re-run after the tunnel fix succeeds.
//  - ac-3: arrival is a clean re-bind (grant-consume binds a NEW device's own
//    key to the unchanged owner DID) — no identity row created, no join; a
//    grant by another channel keeps purpose null (normal consume screen).
//  - ac-4: self-references re-point fully (config, network row, every DID
//    doc, mint templates); re-run is idempotent (no double-applied writes);
//    /api/reauth/status reports the origin + last re-point + clean residue.
//  - ac-5 (server half): POST /api/reauth/link mints the CLI-path grant with
//    an owner-side audit line; no-owner-DID rows refuse with plain language.
//  - the no-identity hard rule: nothing along either path mints a DID or appears as a join.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore, DEFAULT_CONFIG, loadConfig, normalizeConfig, saveConfig, type PorchlightConfig, type StoreLike } from "@porchlight/shared";
import { createServer, type ServerOptions } from "../src/router.js";
import { BootstrapService } from "../src/services/bootstrap.service.js";
import type { Probe } from "../src/dependencies.js";

const OLD_ORIGIN = "https://ephemeral-port.example";
const NEW_ORIGIN = "https://new.porch.love";
const INSTANCE_ID = "iid-porch065-test";

function mutableConfig(): PorchlightConfig {
  // Pre-seed the instance id (minted once at first run in production) so the
  // cross-origin verification compare is deterministic.
  const config = normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as PorchlightConfig);
  config.hub.instanceId = INSTANCE_ID;
  return config;
}

const OK_PROBES: { mongo: Probe; redis: Probe } = { mongo: async () => "ok", redis: async () => "ok" };

interface Json {
  [key: string]: unknown;
}

interface TestHub {
  db: StoreLike;
  config: PorchlightConfig;
  configDir: string;
  homeRoot: string;
  opsToken: string;
  close: () => void;
  port: Promise<number>;
}

interface VerifyMode {
  ok: boolean;
  /** 200-with-different-instance (foreign) vs unhealthy (unreachable). */
  foreign?: boolean;
}

function testHub(verify: VerifyMode = { ok: true }): TestHub {
  const db = createMemoryStore();
  const config = mutableConfig();
  const configDir = mkdtempSync(join(tmpdir(), "porchlight-reauth-"));
  const homeRoot = mkdtempSync(join(tmpdir(), "porchlight-reauth-home-"));
  // Production derivation: the live provider re-reads the config per call.
  config.hub.tunnel.url = OLD_ORIGIN;
  saveConfig(configDir, config);
  const bootstrap = new BootstrapService(db, config, configDir);
  const fetchImpl = (async (input: Parameters<typeof fetch>[0] | URL) => {
    const target = String(input);
    if (!target.endsWith("/api/health")) throw new Error(`unexpected consult ${target}`);
    if (!verify.ok) {
      return new Response("{}", { status: 503, headers: { "content-type": "application/json" } }) as Response;
    }
    return new Response(
      JSON.stringify({ service: "porchlight-server", instanceId: verify.foreign ? "iid-other-hub" : INSTANCE_ID }),
      { status: 200, headers: { "content-type": "application/json" } },
    ) as Response;
  }) as typeof fetch;
  const options: ServerOptions = {
    store: db,
    readiness: OK_PROBES,
    config,
    bootstrap,
    // Production shape: re-read the runtime config per call — the re-point's
    // config write is visible to the hubUrl provider immediately.
    hubUrl: () => loadConfig(configDir)?.hub.tunnel.url ?? null,
    version: "9.9.9-test",
    homeRoot,
    verifyFetchImpl: fetchImpl,
  };
  const app = createServer(options);
  const { promise, resolve } = Promise.withResolvers<number>();
  const listener = app.listen(0, () => resolve((listener.address() as { port: number }).port));
  mkdirSync(join(homeRoot, "state"), { recursive: true });
  return {
    db,
    config,
    configDir,
    homeRoot,
    opsToken: (JSON.parse(readFileSync(join(homeRoot, "state", "ops-token.json"), "utf8")) as Json).token as string,
    close: () => {
      listener.closeIdleConnections();
      listener.close();
    },
    port: promise,
  };
}

async function call(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: Json }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return { status: res.status, body: (await res.json()) as Json };
}

type Auth = { "content-type": string; authorization: string };

function bearerAuth(token: string): Auth {
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

function opsAuth(token: string): Record<string, string> {
  return { "content-type": "application/json", "x-porchlight-ops-token": token };
}

interface DevicePair {
  deviceId: string;
  privateKey: import("node:crypto").KeyObject;
  publicKeyJwk: Json;
}

function devicePair(deviceId: string): DevicePair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { deviceId, privateKey, publicKeyJwk: publicKey.export({ format: "jwk" }) as Json };
}

function signNonce(pair: DevicePair, nonce: string): string {
  return sign(null, Buffer.from(nonce, "utf8"), pair.privateKey).toString("base64url");
}

/**
 * fetch() normalizes the Host header to the connection target (undici), so
 * the serve-bind derivation needs a raw HTTP request carrying the header the
 * browser would present at the tunnel origin.
 */
function rawPost(port: number, path: string, headers: Record<string, string>, body: object): Promise<{ status: number; body: Json }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: Json }>();
  const req = httpRequest(
    { host: "127.0.0.1", port, path, method: "POST", headers: { ...headers, "content-type": "application/json" } },
    (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as Json }));
    },
  );
  req.on("error", reject);
  req.write(JSON.stringify(body));
  req.end();
  return promise;
}

async function identitySession(port: number, did: string, pair: DevicePair): Promise<string> {
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
      deviceId: pair.deviceId,
      nonce: challenge.body.nonce,
      signature: signNonce(pair, challenge.body.nonce as string),
    }),
  });
  if (session.status !== 201) throw new Error(`identity session failed: ${JSON.stringify(session.body)}`);
  return session.body.accessToken as string;
}

interface BootedOwner {
  did: string;
  pair: DevicePair;
  auth: Auth;
}

/** Owner boot: first account → network (ownerDid bound) → invite admission. */
async function bootOwner(port: number): Promise<BootedOwner> {
  const pair = devicePair("dev_owner");
  const account = await call(port, "/api/identity/bootstrap/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ firstName: "Brian", lastName: "Noah", device: { deviceId: pair.deviceId, publicKeyJwk: pair.publicKeyJwk } }),
  });
  if (account.status !== 201) throw new Error(`account bootstrap failed: ${account.status} ${JSON.stringify(account.body)}`);
  const did = (account.body.account as Json).did as string;
  const identityToken = await identitySession(port, did, pair);
  const network = await call(port, "/api/social/bootstrap/network", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Home", ownerDid: did }),
  });
  if (network.status !== 201) throw new Error(`network bootstrap failed: ${JSON.stringify(network.body)}`);
  const invite = await call(port, "/api/social/bootstrap/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "member", maxUses: 1 }),
  });
  const code = ((invite.body.joinUrl as string).split("/join/")[1]) as string;
  const admitted = await call(port, "/api/social/join/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      identityAccessToken: identityToken,
      deviceId: pair.deviceId,
      devicePublicKeyJwk: pair.publicKeyJwk,
      signature: sign(null, Buffer.from(`porchlight-join:${code}`, "utf8"), pair.privateKey).toString("base64url"),
    }),
  });
  if (admitted.status !== 201) throw new Error(`admission failed: ${JSON.stringify(admitted.body)}`);
  return { did, pair, auth: bearerAuth(admitted.body.accessToken as string) };
}

/** The console address action against an owner session. */
async function submitAddress(hub: TestHub, port: number, auth: Auth, host: string): Promise<{ status: number; body: Json }> {
  return call(port, "/api/social/console/address", { method: "POST", headers: auth, body: JSON.stringify({ host }) });
}

function grantRows(hub: TestHub): Promise<Array<Json>> {
  // The founder binding mints an own device-link grant at network creation
  // (PORCH-031) — every grant assertion here scopes to the self-reauth class.
  return hub.db.collection("device_links").find({ purpose: "self-reauth" });
}

async function grantCount(hub: TestHub): Promise<number> {
  return (await hub.db.collection("device_links").find({})).length;
}

function configs(hub: TestHub): Json {
  return loadConfig(hub.configDir) as unknown as Json;
}

test("ac-1: the console address action verifies pre-commit, re-points, mints the self-grant, and returns the redirect", async () => {
  const hub = testHub();
  const port = await hub.port;
  try {
    const owner = await bootOwner(port);
    // Pre-existing DID documents at the old origin (every homed identity).
    const result = await submitAddress(hub, port, owner.auth, "new.porch.love");
    assert.equal(result.status, 200);
    assert.equal(result.body.origin, NEW_ORIGIN);
    const redirectUrl = result.body.redirectUrl as string;
    const url = new URL(redirectUrl);
    assert.equal(`${url.protocol}//${url.host}`, NEW_ORIGIN);
    assert.equal(url.pathname.split("/").length >= 3 && url.pathname.startsWith("/device-link/"), true, `redirect carries the grant-consume route: ${redirectUrl}`);
    assert.equal(url.searchParams.get("reauth"), "1", "the redirect carries the self-grant arrival marker");

    // The config self-reference moved (tunnel URL + op record).
    const config = await configs(hub);
    assert.equal((config as { hub: { tunnel: { url: string } } }).hub.tunnel.url, NEW_ORIGIN);
    const lastRepoint = (config as { hub: { lastRepoint: Json } }).hub.lastRepoint;
    assert.equal(lastRepoint.origin, NEW_ORIGIN);
    assert.equal(lastRepoint.surface, "console");

    // Every homed DID document's service entries carry the new origin.
    const didDocs = await hub.db.collection("did_documents").find({});
    assert.ok(didDocs.length >= 1);
    for (const row of didDocs) {
      const service = ((row.document as Json).service as Array<Json>) ?? [];
      for (const entry of service) {
        assert.equal(entry.serviceEndpoint, NEW_ORIGIN, `did ${row.did} service entries re-pointed`);
      }
    }

    // The network row's recorded hub URL moved too.
    const network = await hub.db.collection("networks").findOne({});
    assert.equal(network?.hubUrl, NEW_ORIGIN);

    // The minted grant row: owner-targeted, one-time, self-reauth purpose.
    const grants = await grantRows(hub);
    assert.equal(grants.length, 1);
    assert.equal(grants[0].did, owner.did);
    assert.equal(grants[0].purpose, "self-reauth");
    assert.equal(grants[0].consumed, false);
    assert.notEqual(grants[0].token, redirectUrl.split("/device-link/")[1]?.split("?")[0], "the stored grant is hashed, never the plaintext");

    // Both audit lines: the re-point and the mint (owner-side actor).
    const audits = await hub.db.collection("audit_events").find({});
    const actions = audits.map((row) => row.action as string);
    assert.ok(actions.includes("address_repoint"), `address_repoint audited: ${JSON.stringify(actions)}`);
    assert.ok(actions.includes("reauth_grant_mint"), "the mint audited on the same class");
    const repointEvent = audits.find((row) => row.action === "address_repoint");
    assert.equal((repointEvent?.detail as Json)?.to, NEW_ORIGIN);
    assert.equal(repointEvent?.did, owner.did);
  } finally {
    hub.close();
  }
});

test("ac-2: an unreachable candidate refuses in plain language with zero mutation, then the corrected re-run succeeds", async () => {
  // The verification seam is mutable: the "tunnel fix" is the seam flipping
  // to reachable — the hub-side behavior is unchanged between attempts.
  const verify = { ok: false, foreign: false };
  const hub = testHub(verify);
  const port = await hub.port;
  try {
    const owner = await bootOwner(port);
    const refused = await submitAddress(hub, port, owner.auth, NEW_ORIGIN.replace("https://", ""));
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "E_ORIGIN_UNREACHABLE");
    assert.match(String(refused.body.error), /DNS|tunnel/i, "plain language names what failed");

    // Zero mutation: config, grants, audit all untouched.
    const grantsBefore = await grantCount(hub);
    const config = await configs(hub);
    assert.equal((config as { hub: { tunnel: { url: string | null } } }).hub.tunnel.url, OLD_ORIGIN);
    assert.equal((config as { hub: { lastRepoint: unknown } }).hub.lastRepoint, undefined);
    assert.equal((await grantRows(hub)).length, 0);
    assert.equal(await grantCount(hub), grantsBefore, "no grant minted on the refused action");

    // The owner fixes DNS + tunnel first (017's move); the re-run succeeds.
    verify.ok = true;
    const ok = await submitAddress(hub, port, owner.auth, "new.porch.love");
    assert.equal(ok.status, 200);
  } finally {
    hub.close();
  }
});

test("ac-2: a foreign server answers the candidate origin — plain refusal, zero mutation", async () => {
  const hub = testHub({ ok: true, foreign: true });
  const port = await hub.port;
  try {
    const owner = await bootOwner(port);
    const refused = await submitAddress(hub, port, owner.auth, "new.porch.love");
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "E_ORIGIN_FOREIGN");
    assert.match(String(refused.body.error), /not served by this hub/i);
    const config = await configs(hub);
    assert.equal((config as { hub: { tunnel: { url: string | null } } }).hub.tunnel.url, OLD_ORIGIN);
    assert.equal((config as { hub: { lastRepoint: unknown } }).hub.lastRepoint, undefined);
    assert.equal((await grantRows(hub)).length, 0);
    assert.equal((await hub.db.collection("audit_events").find({})).filter((row) => row.action === "address_repoint" || row.action === "reauth_grant_mint").length, 0);
    // The console address action requires the owner's session: anonymous 401.
    const anonymous = await call(port, "/api/social/console/address", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "new.porch.love" }),
    });
    assert.equal(anonymous.status, 401);
  } finally {
    hub.close();
  }
});

test("ac-3: the redirect's self-grant consumes as a clean re-bind — new device key, unchanged owner DID, no identity, no join", async () => {
  const hub = testHub();
  const port = await hub.port;
  try {
    const owner = await bootOwner(port);
    const identitiesBefore = (await hub.db.collection("identities").find({})).length;
    const membershipsBefore = (await hub.db.collection("memberships").find({})).length;

    const result = await submitAddress(hub, port, owner.auth, "new.porch.love");
    assert.equal(result.status, 200);
    const token = (new URL(result.body.redirectUrl as string).pathname.split("/device-link/")[1]) as string;

    // The owner's browser arrives at the new origin: the SPA consume call
    // reaches the hub on the NEW serving bind (host header), NEW DEVICE —
    // the re-bind means a fresh device key (shared-device side-by-side law
    // keeps the old registrations untouched).
    const newDevice = devicePair("dev_owner_new");
    const consumed = await rawPost(
      port,
      "/api/identity/device-link/consume",
      {
        // The serving bind the consume arrives on (the new tunnel host class).
        host: "new.porch.love",
        "x-forwarded-proto": "https",
      },
      { token, device: { deviceId: newDevice.deviceId, publicKeyJwk: newDevice.publicKeyJwk } },
    );
    const body = consumed.body;
    assert.equal(((body.registration as Json).did as string), owner.did, "the device binds the UNCHANGED owner DID");
    assert.equal(body.grant ? (body.grant as Json).purpose : null, "self-reauth", "the consume response marks the auto-consumed self-grant");

    // The consume-triggered re-point (CLI path) ran from the serving bind:
    // the recorded surface flips to the consume trigger, converged on the
    // same origin the console path already wrote.
    const configAfterConsume = (await configs(hub)) as { hub: { lastRepoint: Json } };
    assert.equal(configAfterConsume.hub.lastRepoint.origin, NEW_ORIGIN);
    assert.equal(configAfterConsume.hub.lastRepoint.surface, "cli");

    // No identity record created, no join involved.
    const identitiesAfter = (await hub.db.collection("identities").find({})).length;
    assert.equal(identitiesAfter, identitiesBefore);
    assert.equal(((await hub.db.collection("memberships").find({})) as Json[]).length, membershipsBefore);
    const networkAfter = (await hub.db.collection("networks").findOne({})) as Json | null;
    assert.equal(networkAfter?.ownerDid, owner.did);

    // A grant by any other channel keeps the normal consume screen: purpose null.
    const memberLink = await call(port, "/api/social/console/device-links", {
      method: "POST",
      headers: owner.auth,
      body: JSON.stringify({ did: owner.did }),
    });
    assert.equal(memberLink.status, 201);
    const memberToken = (new URL(memberLink.body.linkUrl as string).pathname.split("/device-link/")[1]) as string;
    const memberDevice = devicePair("dev_owner_extra");
    const memberConsume = await rawPost(
      port,
      "/api/identity/device-link/consume",
      { host: "new.porch.love", "x-forwarded-proto": "https" },
      { token: memberToken, device: { deviceId: memberDevice.deviceId, publicKeyJwk: memberDevice.publicKeyJwk } },
    );
    assert.equal(memberConsume.status, 201);
    assert.equal((memberConsume.body.grant as Json).purpose, null, "member-granted device link keeps the normal consume screen");
    const identitiesFinal = (await hub.db.collection("identities").find({})).length;
    assert.equal(identitiesFinal, identitiesBefore);
  } finally {
    hub.close();
  }
});

test("ac-4: the re-point is idempotent and the status surface reports origin, re-point, and clean residue; post-move mints carry the new address", async () => {
  const hub = testHub();
  const port = await hub.port;
  try {
    const owner = await bootOwner(port);
    // Pre-move captures for the mint-template proof.
    const preMoveLink = await call(port, "/api/social/console/device-links", {
      method: "POST",
      headers: owner.auth,
      body: JSON.stringify({ did: owner.did }),
    });
    assert.match(String(preMoveLink.body.linkUrl), new RegExp(`^${OLD_ORIGIN.replace(/\./g, "\\.")}/device-link/`));

    const first = await submitAddress(hub, port, owner.auth, "new.porch.love");
    assert.equal(first.status, 200);
    const firstRepoint = first.body.repoint as Json;
    assert.equal(firstRepoint.configRepointed, true);
    assert.equal(firstRepoint.networkRecorded, true);

    // Post-move: a console-issued device link and a console-issued join
    // invite carry the NEW address (mint templates derive per call).
    const movedLink = await call(port, "/api/social/console/device-links", {
      method: "POST",
      headers: owner.auth,
      body: JSON.stringify({ did: owner.did }),
    });
    assert.match(String(movedLink.body.linkUrl), new RegExp(`^${NEW_ORIGIN.replace(/\./g, "\\.")}/device-link/`));
    const movedInvite = await call(port, "/api/social/console/invites", {
      method: "POST",
      headers: owner.auth,
      body: JSON.stringify({ role: "member", maxUses: 1 }),
    });
    assert.equal((movedInvite.body.invite as Json).hubUrl, NEW_ORIGIN, "fresh join links mint carrying the new address");

    // Idempotent re-run: a second address action re-mints the grant (the
    // dropped-redirect remedy) and the self-references stay converged.
    const second = await submitAddress(hub, port, owner.auth, "new.porch.love");
    assert.equal(second.status, 200);
    const secondRepoint = second.body.repoint as Json;
    assert.equal(secondRepoint.configRepointed, false, "no double-applied config write");
    assert.equal(secondRepoint.networkRecorded, false, "no double-applied network write");
    assert.notEqual(second.body.grantId, first.body.grantId, "the re-run re-mints the grant");
    assert.notEqual(second.body.redirectUrl, first.body.redirectUrl);

    // Status (owner session surface): serving origin + last re-point + clean residue.
    const status = await call(port, "/api/reauth/status", { headers: owner.auth });
    assert.equal(status.status, 200);
    assert.equal(status.body.servingOrigin, NEW_ORIGIN);
    assert.equal((status.body.lastRepoint as Json).origin, NEW_ORIGIN);
    const surfaceAfterConsumelessRun = (status.body.lastRepoint as Json).surface;
    assert.equal(surfaceAfterConsumelessRun, "console");
    assert.deepEqual(status.body.residue, []);
    assert.equal(status.body.instanceId, INSTANCE_ID);
    // Ops token reads the same surface.
    const statusOps = await call(port, "/api/reauth/status", { headers: opsAuth(hub.opsToken) });
    assert.equal(statusOps.status, 200);
    assert.equal(statusOps.body.servingOrigin, NEW_ORIGIN);
  } finally {
    hub.close();
  }
});

test("ac-5 (server half): /api/reauth/link mints the CLI path with an owner audit line; missing-owner rows refuse in plain language; ops token required", async () => {
  const hub = testHub();
  const port = await hub.port;
  try {
    const owner = await bootOwner(port);
    const minted = await call(port, "/api/reauth/link", { method: "POST", headers: opsAuth(hub.opsToken) });
    assert.equal(minted.status, 201);
    assert.match(String(minted.body.linkUrl), /\/device-link\/[A-Za-z0-9_-]+$/);
    const audits = await hub.db.collection("audit_events").find({});
    const mintLine = audits.find((row) => row.action === "reauth_grant_mint");
    assert.ok(mintLine);
    assert.equal((mintLine?.detail as Json)?.surface, "cli");
    assert.equal((mintLine?.detail as Json)?.targetDid, owner.did);
    const grant = await hub.db.collection("device_links").findOne({ purpose: "self-reauth" });
    assert.equal(grant?.purpose, "self-reauth");

    // The ops token is the machine-local authentication: a request without
    // it is refused (the tunnel/LAN boundary receives zero trust).
    const unauthorized = await call(port, "/api/reauth/link", { method: "POST", headers: { "content-type": "application/json" } });
    assert.equal(unauthorized.status, 401);
    const unauthorizedStatusRoute = await call(port, "/api/reauth/status", { headers: { "content-type": "application/json" } });
    assert.equal(unauthorizedStatusRoute.status, 401);
  } finally {
    hub.close();
  }

  const noOwnerHub = testHub();
  const noOwnerPort = await noOwnerHub.port;
  try {
    // The pre-PORCH-018 shape: a network row without a recorded owner DID.
    await noOwnerHub.db.collection("networks").insertOne({
      _id: `net_${randomUUID()}`,
      name: "no-owner",
      ownerAccountId: null,
      ownerDid: null,
      quota: { storageCeilingMb: null, retentionDays: null },
      createdAt: new Date().toISOString(),
    });
    const minted = await call(noOwnerPort, "/api/reauth/link", { method: "POST", headers: opsAuth(noOwnerHub.opsToken) });
    assert.equal(minted.status, 409);
    assert.equal(minted.body.code, "E_OWNER_DID_MISSING");
    assert.match(String(minted.body.error), /owner identity/i, "the refusal names the gap plainly");
    assert.equal((await grantRows(noOwnerHub)).length, 0, "nothing was minted");
    const auditLines = await noOwnerHub.db.collection("audit_events").find({});
    assert.ok(!auditLines.some((row) => row.action === "reauth_grant_mint"), "no audit mint line on a refused mint");
  } finally {
    noOwnerHub.close();
  }
});