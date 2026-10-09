/**
 * Session-bound identity writes (perimeter remediation): /handle,
 * /account/profile, /oidc/authorize and /migration/handoff MUST fail closed
 * for anonymous callers (401 E_SESSION_REQUIRED — these surfaces previously
 * accepted anonymous writes with 200/201) and are bound to the session's own
 * did: a session acting on another did is refused with 403 E_FORBIDDEN.
 * Real HTTP: the assembled router rides an express app exercised with fetch,
 * matching the apps/server contract-test pattern.
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { sign, createHash, createPrivateKey } from "node:crypto";
import { createMemoryStore } from "@porchlight/shared";
import { assembleIdentityModule } from "../src/assemble.js";
import { newEd25519Jwks } from "../src/util/jwt.js";

const HUB_A = "https://hub-a.test";
const HUB_B = "https://hub-b.test";

async function call(base, path, { body, token } = {}) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

function signNonce(privateKeyJwk, nonce) {
  return sign(null, Buffer.from(nonce, "utf8"), createPrivateKey({ key: privateKeyJwk, format: "jwk" })).toString("base64url");
}

/** Insert a registration row directly (same shape slice A mints) for a second identity. */
function insertRegistration(store, { did, deviceId, jwks }) {
  return store.collection("device_registrations").insertOne({
    _id: `reg_${deviceId}`,
    did,
    deviceId,
    label: null,
    publicKeyJwk: jwks.publicKeyJwk,
    createdBy: "first-account",
    status: "active",
    revokedAt: null,
    createdAt: new Date().toISOString(),
  });
}

/**
 * A hub with a provisioned owner account (did A, dev_1) and a second device
 * registration for a foreign did B. Returns access tokens for both sessions.
 */
async function hub() {
  const store = createMemoryStore();
  const identity = assembleIdentityModule(store, { hubUrl: () => HUB_A });
  const app = express();
  app.use(express.json());
  app.use(identity.api);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const jwksA = newEd25519Jwks();
  const created = await call(base, "/bootstrap/account", {
    body: { firstName: "Brian", lastName: "Noah", device: { deviceId: "dev_1", publicKeyJwk: jwksA.publicKeyJwk } },
  });
  assert.equal(created.status, 201);
  const didA = created.body.account.did;

  const jwksB = newEd25519Jwks();
  const didB = "did:porch:" + "b".repeat(40);
  insertRegistration(store, { did: didB, deviceId: "dev_2", jwks: jwksB });

  const tokenFor = async (did, deviceId, jwks) => {
    const challenge = await call(base, "/session/challenge", { body: { did } });
    assert.equal(challenge.status, 200);
    const session = await call(base, "/session", {
      body: { did, deviceId, nonce: challenge.body.nonce, signature: signNonce(jwks.privateKeyJwk, challenge.body.nonce) },
    });
    assert.equal(session.status, 201);
    return session.body.accessToken;
  };

  return {
    store,
    base,
    didA,
    didB,
    tokenA: await tokenFor(didA, "dev_1", jwksA),
    tokenB: await tokenFor(didB, "dev_2", jwksB),
    close: () => {
      server.closeIdleConnections();
      server.close();
    },
  };
}

// --- Anonymous callers: fail closed (401), valid fields everywhere ----------

test("anonymous /handle fails closed with 401 E_SESSION_REQUIRED (previously a 200 write)", async (t) => {
  const hubF = await hub();
  t.after(hubF.close);
  const res = await call(hubF.base, "/handle", { body: { did: hubF.didA, handle: "brian" } });
  assert.equal(res.status, 401);
  assert.deepEqual(
    { error: res.body.error, code: res.body.code },
    { error: "active session required", code: "E_SESSION_REQUIRED" },
  );
});

test("anonymous /account/profile fails closed with 401 E_SESSION_REQUIRED (previously a 200 write)", async (t) => {
  const hubF = await hub();
  t.after(hubF.close);
  const res = await call(hubF.base, "/account/profile", { body: { did: hubF.didA, displayName: "Bri" } });
  assert.equal(res.status, 401);
  assert.deepEqual(
    { error: res.body.error, code: res.body.code },
    { error: "active session required", code: "E_SESSION_REQUIRED" },
  );
});

test("anonymous /oidc/authorize fails closed with 401 E_SESSION_REQUIRED (previously a 201 code)", async (t) => {
  const hubF = await hub();
  t.after(hubF.close);
  const res = await call(hubF.base, "/oidc/authorize", {
    body: {
      did: hubF.didA,
      clientId: "app-1",
      nonce: "n-1",
      codeChallenge: "pkce-challenge",
      codeChallengeMethod: "S256",
    },
  });
  assert.equal(res.status, 401);
  assert.deepEqual(
    { error: res.body.error, code: res.body.code },
    { error: "active session required", code: "E_SESSION_REQUIRED" },
  );
});

test("anonymous /migration/handoff fails closed with 401 E_SESSION_REQUIRED (previously a 201 token)", async (t) => {
  const hubF = await hub();
  t.after(hubF.close);
  const res = await call(hubF.base, "/migration/handoff", { body: { did: hubF.didA, newIssuer: HUB_B } });
  assert.equal(res.status, 401);
  assert.deepEqual(
    { error: res.body.error, code: res.body.code },
    { error: "active session required", code: "E_SESSION_REQUIRED" },
  );
  const moved = await hubF.store.collection("identities").findOne({ did: hubF.didA });
  assert.notEqual(moved.homingStatus, "moved", "anonymous handoff must never re-point the identity");
});

// --- A session acting on ANOTHER did: 403 E_FORBIDDEN -----------------------

test("session B reassigning A's handle → 403 E_FORBIDDEN", async (t) => {
  const hubF = await hub();
  t.after(hubF.close);
  const res = await call(hubF.base, "/handle", { body: { did: hubF.didA, handle: "hijacked" }, token: hubF.tokenB });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "E_FORBIDDEN");
  const row = await hubF.store.collection("identities").findOne({ did: hubF.didA });
  assert.notEqual(row.handle, "hijacked", "the handle must be untouched");
});

test("session B writing A's profile → 403 E_FORBIDDEN", async (t) => {
  const hubF = await hub();
  t.after(hubF.close);
  const res = await call(hubF.base, "/account/profile", {
    body: { did: hubF.didA, displayName: "Hijacked", profile: { bio: "hijack" } },
    token: hubF.tokenB,
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "E_FORBIDDEN");
  const row = await hubF.store.collection("identities").findOne({ did: hubF.didA });
  assert.notEqual(row.displayName, "Hijacked", "profile fields must be untouched");
});

test("session B minting an authorization code for A → 403 E_FORBIDDEN", async (t) => {
  const hubF = await hub();
  t.after(hubF.close);
  const res = await call(hubF.base, "/oidc/authorize", {
    body: { did: hubF.didA, clientId: "app-1", nonce: "n-1", codeChallenge: "pkce-challenge", codeChallengeMethod: "S256" },
    token: hubF.tokenB,
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "E_FORBIDDEN");
  assert.equal(await hubF.store.collection("auth_codes").findOne({ did: hubF.didA }), null, "no code is stored");
});

test("session B issuing A's migration handoff → 403 E_FORBIDDEN", async (t) => {
  const hubF = await hub();
  t.after(hubF.close);
  const res = await call(hubF.base, "/migration/handoff", { body: { did: hubF.didA, newIssuer: HUB_B }, token: hubF.tokenB });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "E_FORBIDDEN");
  const moved = await hubF.store.collection("identities").findOne({ did: hubF.didA });
  assert.notEqual(moved.homingStatus, "moved", "the homing pointer must be untouched");
});

// --- A session on its OWN did: these writes still work ----------------------

test("own-did write set: handle set, profile recorded, auth code issued, handoff issued (201)", async (t) => {
  const hubF = await hub();
  t.after(hubF.close);

  const handle = await call(hubF.base, "/handle", { body: { did: hubF.didA, handle: "brian" }, token: hubF.tokenA });
  assert.equal(handle.status, 200);
  assert.deepEqual(handle.body, { handle: "brian", did: hubF.didA });

  const profile = await call(hubF.base, "/account/profile", {
    body: { did: hubF.didA, displayName: "Bri", profile: { pronouns: "they/them" } },
    token: hubF.tokenA,
  });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.displayName, "Bri");
  assert.deepEqual(profile.body.profile, { pronouns: "they/them" });

  const verifier = "pkce-verifier-1";
  const codeChallenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const authorize = await call(hubF.base, "/oidc/authorize", {
    body: { did: hubF.didA, clientId: "app-1", nonce: "n-1", codeChallenge, codeChallengeMethod: "S256" },
    token: hubF.tokenA,
  });
  assert.equal(authorize.status, 201);
  assert.ok(authorize.body.code, "auth code issued");

  const handoff = await call(hubF.base, "/migration/handoff", { body: { did: hubF.didA, newIssuer: HUB_B }, token: hubF.tokenA });
  assert.equal(handoff.status, 201);
  assert.ok(handoff.body.handoffToken, "handoff token issued");
  assert.equal(handoff.body.did, hubF.didA);
  assert.equal(handoff.body.newIssuer, HUB_B);
});

test("a member reissuing their own handoff after the first still works the same as the service allows", async (t) => {
  const hubF = await hub();
  t.after(hubF.close);
  const first = await call(hubF.base, "/migration/handoff", { body: { did: hubF.didA, newIssuer: HUB_B }, token: hubF.tokenA });
  assert.equal(first.status, 201);
  const again = await call(hubF.base, "/migration/handoff", { body: { did: hubF.didA, newIssuer: HUB_B }, token: hubF.tokenA });
  assert.equal(again.status, 201, "re-handoff to the same issuer stays service-permitted");
});

test("the four surfaces keep their field validation after the session guard", async () => {
  const hubF = await hub();
  const tests = [
    ["/handle", { handle: "brian" }, "did and handle required"],
    ["/account/profile", {}, "did required"],
    ["/oidc/authorize", { did: hubF.didA }, "did, clientId, nonce and codeChallenge required"],
    ["/migration/handoff", { did: hubF.didA }, "did and newIssuer required"],
  ];
  for (const [path, body, expectedError] of tests) {
    const res = await call(hubF.base, path, { body, token: hubF.tokenA });
    assert.equal(res.status, 400, path);
    assert.equal(res.body.code, "E_FIELDS_REQUIRED", path);
    assert.equal(res.body.error, expectedError, path);
  }
  hubF.close();
});