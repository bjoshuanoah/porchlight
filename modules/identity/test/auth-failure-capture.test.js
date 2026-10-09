import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "@porchlight/shared";
import { AuthService } from "../src/services/auth.service.js";
import { AuthController } from "../src/controllers/auth.controller.js";
import { AccountController } from "../src/controllers/account.controller.js";
import { newEd25519Jwks } from "../src/util/jwt.js";
import { sha256 } from "../src/services/signing.service.js";
import { requireSessionOr401, bearerToken, endpointLabel } from "../src/util/session-guard.js";
import { insertRegistration, signNonce } from "./helpers/capture.fixture.js";

function fixture() {
  const db = createMemoryStore();
  const auth = new AuthService({
    challenges: db.collection("challenges"),
    sessions: db.collection("sessions"),
    deviceRegistrations: db.collection("device_registrations"),
    hash: sha256,
  });
  return { db, auth };
}

/**
 * PORCH-019 ac-1: auth-failure capture on the identity plane. Every captured
 * 401 must carry the failing step (reason) plus session/device identity
 * state, and never token material.
 */

test("auth-failure capture: identity diagnosis names the failing step with session/device state", async () => {
  const { db, auth } = fixture();
  const jwks = newEd25519Jwks();
  await insertRegistration(db, { did: "did:porchlight:brian", deviceId: "dev_1", jwks });

  const missing = await auth.diagnoseAccessToken("");
  assert.equal(missing.reason, "missing_token");
  assert.equal((await auth.diagnoseAccessToken()).reason, "missing_token");

  const unknown = await auth.diagnoseAccessToken("not-a-token");
  assert.equal(unknown.reason, "unknown_token");

  // Open a live session, then supersede it the way the client's renewal
  // re-open does — the second open supersedes the first (PORCH-005 rule).
  const { nonce } = await auth.createChallenge({ did: "did:porchlight:brian" });
  const opened = await auth.openSession({
    did: "did:porchlight:brian",
    deviceId: "dev_1",
    nonce,
    signature: signNonce(jwks.privateKeyJwk, nonce),
  });
  assert.deepEqual(await auth.diagnoseAccessToken(opened.accessToken), null);

  const { nonce: nonce2 } = await auth.createChallenge({ did: "did:porchlight:brian" });
  await auth.openSession({
    did: "did:porchlight:brian",
    deviceId: "dev_1",
    nonce: nonce2,
    signature: signNonce(jwks.privateKeyJwk, nonce2),
  });
  const superseded = await auth.diagnoseAccessToken(opened.accessToken);
  assert.equal(superseded.reason, "session_superseded");
  assert.equal(superseded.did, "did:porchlight:brian");
  assert.equal(superseded.deviceId, "dev_1");
  assert.equal(superseded.sessionId, opened.sessionId);
  assert.equal(superseded.sessionStatus, "superseded");
  assert.equal(superseded.registrationStatus, "active");
  assert.ok(superseded.accessExpiresAt);
  assert.ok(!JSON.stringify(superseded).includes(opened.accessToken));

  // Expired step: TTL passes on the LIVE session.
  const { nonce: nonce3 } = await auth.createChallenge({ did: "did:porchlight:brian" });
  const secondOpen = await auth.openSession({
    did: "did:porchlight:brian",
    deviceId: "dev_1",
    nonce: nonce3,
    signature: signNonce(jwks.privateKeyJwk, nonce3),
  });
  const liveRow = (await db.collection("sessions").find({ status: "active" }))[0];
  await db.collection("sessions").updateOne(
    { _id: liveRow._id },
    { $set: { accessExpiresAt: new Date(Date.now() - 1000).toISOString() } },
  );
  const expired = await auth.diagnoseAccessToken(secondOpen.accessToken);
  assert.equal(expired.reason, "expired_access_token");
  assert.equal(expired.sessionStatus, "active");
  assert.equal(expired.registrationStatus, "active");
});

test("auth-failure capture: guard 401 body unchanged, capture line carries endpoint + state", async () => {
  const { db, auth } = fixture();
  const jwks = newEd25519Jwks();
  await insertRegistration(db, { did: "did:porchlight:brian", deviceId: "dev_1", jwks });
  const { nonce } = await auth.createChallenge({ did: "did:porchlight:brian" });
  const opened = await auth.openSession({
    did: "did:porchlight:brian",
    deviceId: "dev_1",
    nonce,
    signature: signNonce(jwks.privateKeyJwk, nonce),
  });
  // Second open supersedes the session the browser still holds.
  const { nonce: nonce2 } = await auth.createChallenge({ did: "did:porchlight:brian" });
  await auth.openSession({
    did: "did:porchlight:brian",
    deviceId: "dev_1",
    nonce: nonce2,
    signature: signNonce(jwks.privateKeyJwk, nonce2),
  });

  const captured = [];
  const req = {
    method: "GET",
    originalUrl: "/api/identity/devices",
    headers: { authorization: `Bearer ${opened.accessToken}` },
  };
  const calls = [];
  const json = (body) => { calls.push(["json", body]); return body; };
  const res = { status: (n) => { calls.push(["status", n]); return { json }; } };

  const identity = await requireSessionOr401({ req, res, authService: auth, log: (line) => captured.push(line) });
  assert.equal(identity, null);
  assert.deepEqual(calls[0], ["status", 401]);
  assert.deepEqual(calls[1][1].code, "E_SESSION_REQUIRED");
  assert.equal(captured.length, 1);
  const line = JSON.parse(captured[0].split("hub: auth-failure ")[1]);
  assert.equal(line.endpoint, "GET /api/identity/devices");
  assert.equal(line.code, "E_SESSION_REQUIRED");
  assert.equal(line.reason, "session_superseded");
  assert.equal(line.did, "did:porchlight:brian");
  assert.equal(line.deviceId, "dev_1");
  assert.equal(line.sessionId, opened.sessionId);
  assert.equal(line.registrationStatus, "active");
  // Token material never rides the capture.
  assert.ok(!captured[0].includes(opened.accessToken));
  assert.ok(!captured[0].includes(sha256(opened.accessToken)));
});

test("auth-failure capture: bearer + endpoint helpers", () => {
  assert.equal(bearerToken({ headers: { authorization: "Bearer abc" } }), "abc");
  assert.equal(bearerToken({ headers: {} }), null);
  assert.equal(endpointLabel({ method: "GET", originalUrl: "/api/identity/devices" }), "GET /api/identity/devices");
  assert.equal(endpointLabel({}), "UNKNOWN unknown");
});

test("auth-failure capture: session-open failure logs the rejected step with claimed ids", async () => {
  const { db, auth } = fixture();
  const jwks = newEd25519Jwks();
  await insertRegistration(db, { did: "did:porchlight:brian", deviceId: "dev_1", jwks });
  const { nonce } = await auth.createChallenge({ did: "did:porchlight:brian" });

  const captured = [];
  const controller = new AuthController(auth, null, (line) => captured.push(line));
  const calls = [];
  const json = (body) => { calls.push(["json", body]); return body; };
  const res = { status: (n) => { calls.push(["status", n]); return { json }; } };

  await controller.createSession(
    { method: "POST", originalUrl: "/api/identity/session", body: { did: "did:porchlight:brian", deviceId: "dev_1", nonce, signature: "forged" } },
    res,
  );
  assert.deepEqual(calls[0], ["status", 401]);
  assert.equal(calls[1][1].code, "E_SIGNATURE_INVALID");
  assert.equal(captured.length, 1);
  const line = JSON.parse(captured[0].split("hub: auth-failure ")[1]);
  assert.equal(line.endpoint, "POST /api/identity/session");
  assert.equal(line.reason, "E_SIGNATURE_INVALID");
  assert.equal(line.claimedDid, "did:porchlight:brian");
  assert.equal(line.claimedDeviceId, "dev_1");
  assert.ok(!JSON.stringify(line).includes("forged"));
});

test("auth-failure capture: account controller keeps its guard wiring", async () => {
  const { db: _db, auth } = fixture();
  const captured = [];
  const accountController = new AccountController({}, auth, { record: async () => {} }, (line) => captured.push(line));
  const req = { method: "POST", originalUrl: "/api/identity/handle", headers: {} };
  const calls = [];
  const json = (body) => { calls.push(["json", body]); return body; };
  const res = { status: (n) => { calls.push(["status", n]); return { json }; } };
  const outcome = await accountController.requireSession(req, res);
  assert.equal(outcome, null);
  assert.deepEqual(calls[0], ["status", 401]);
  assert.equal(captured.length, 1);
  const line = JSON.parse(captured[0].split("hub: auth-failure ")[1]);
  assert.equal(line.endpoint, "POST /api/identity/handle");
  assert.equal(line.reason, "missing_token");
});