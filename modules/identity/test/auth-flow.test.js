import { test } from "node:test";
import assert from "node:assert/strict";
import { sign, createPrivateKey } from "node:crypto";
import { createMemoryStore } from "@porchlight/shared";
import { AuthService } from "../src/services/auth.service.js";
import { newEd25519Jwks } from "../src/util/jwt.js";
import { sha256 } from "../src/services/signing.service.js";

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

/** Insert a registration row directly (same shape slice A mints). */
function insertRegistration(db, { did, deviceId, jwks, createdBy = "first-account", status = "active" }) {
  return db.collection("device_registrations").insertOne({
    _id: `reg_${deviceId}`,
    did,
    deviceId,
    label: null,
    publicKeyJwk: jwks.publicKeyJwk,
    createdBy,
    status,
    revokedAt: null,
    createdAt: new Date().toISOString(),
  });
}

function signNonce(privateKeyJwk, nonce) {
  return sign(null, Buffer.from(nonce, "utf8"), createPrivateKey({ key: privateKeyJwk, format: "jwk" })).toString("base64url");
}

/** Mutable clock for TTL tests. */
function clock(base = new Date("2026-01-01T00:00:00Z")) {
  let driftMs = 0;
  return {
    now: () => new Date(base.getTime() + driftMs),
    advance(seconds) {
      driftMs += seconds * 1000;
    },
  };
}

async function openVerifiedSession(auth, { did, deviceId, jwks, now }) {
  const { nonce } = await auth.createChallenge({ did });
  return auth.openSession({
    did,
    deviceId,
    nonce,
    signature: signNonce(jwks.privateKeyJwk, nonce),
    now,
  });
}

test("createChallenge mints a 120s one-time challenge with a fresh nonce", async () => {
  const { db, auth } = fixture();
  const jwks = newEd25519Jwks();
  insertRegistration(db, { did: "did:porch:aaa", deviceId: "dev-1", jwks });
  const challenge = await auth.createChallenge({ did: "did:porch:aaa" });
  assert.equal(challenge.did, "did:porch:aaa");
  assert.ok(challenge.challengeId.startsWith("chl_"));
  assert.ok(challenge.nonce.length >= 32);
  assert.equal(
    new Date(challenge.expiresAt).getTime() -
      new Date((await db.collection("challenges").findOne({ did: "did:porch:aaa" })).createdAt).getTime(),
    120_000,
  );
  const stored = await db.collection("challenges").findOne({ did: "did:porch:aaa" });
  assert.equal(stored.consumed, false);
  // Refuses an identity with no registrations at all.
  await assert.rejects(() => auth.createChallenge({ did: "did:porch:ghost" }), { code: "E_IDENTITY_NOT_FOUND" });
});

test("createChallenge nonces are unique per mint and challenges default to the real clock", async () => {
  const { db, auth } = fixture();
  const jwks = newEd25519Jwks();
  insertRegistration(db, { did: "did:porch:aaa", deviceId: "dev-1", jwks });
  const first = await auth.createChallenge({ did: "did:porch:aaa" });
  const second = await auth.createChallenge({ did: "did:porch:aaa" });
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.challengeId, second.challengeId);
  const stored = await db.collection("challenges").findOne({ nonce: first.nonce });
  assert.equal(stored.consumed, false);
});

test("openSession rejects a wrong signature and the burned challenge cannot be reused ", async () => {
  const { db, auth } = fixture();
  const jwks = newEd25519Jwks();
  insertRegistration(db, { did: "did:porch:aaa", deviceId: "dev-1", jwks });
  const { nonce } = await auth.createChallenge({ did: "did:porch:aaa" });
  await assert.rejects(
    () =>
      auth.openSession({
        did: "did:porch:aaa",
        deviceId: "dev-1",
        nonce,
        signature: signNonce(jwks.privateKeyJwk, `not-the-nonce:${nonce}:x`),
      }),
    { code: "E_SIGNATURE_INVALID" },
  );
  // Challenge is consumed before signature checks (fixed contract order):
  // a correct signature on the same nonce can no longer open a session.
  await assert.rejects(
    () =>
      auth.openSession({
        did: "did:porch:aaa",
        deviceId: "dev-1",
        nonce,
        signature: signNonce(jwks.privateKeyJwk, nonce),
      }),
    { code: "E_CHALLENGE_REQUIRED" },
  );
});

test("openSession rejects an unknown nonce and an expired challenge (TTL enforced)", async () => {
  const { db, auth } = fixture();
  const jwks = newEd25519Jwks();
  insertRegistration(db, { did: "did:porch:aaa", deviceId: "dev-1", jwks });
  await assert.rejects(
    () => auth.openSession({ did: "did:porch:aaa", deviceId: "dev-1", nonce: "no-such-nonce", signature: "zz" }),
    { code: "E_CHALLENGE_REQUIRED" },
  );
  const { nonce, expiresAt } = await auth.createChallenge({ did: "did:porch:aaa" });
  const late = clock(new Date(expiresAt));
  late.advance(121);
  await assert.rejects(
    () =>
      auth.openSession({
        did: "did:porch:aaa",
        deviceId: "dev-1",
        nonce,
        signature: signNonce(jwks.privateKeyJwk, nonce),
        now: late.now,
      }),
    { code: "E_CHALLENGE_REQUIRED" },
  );
});

test("openSession without an active registration for (did, deviceId) → E_NO_REGISTRATION", async () => {
  const { db, auth } = fixture();
  const jwks = newEd25519Jwks();
  insertRegistration(db, { did: "did:porch:aaa", deviceId: "dev-1", jwks });
  const { nonce } = await auth.createChallenge({ did: "did:porch:aaa" });
  await assert.rejects(
    () =>
      auth.openSession({
        did: "did:porch:aaa",
        deviceId: "dev-other",
        nonce,
        signature: signNonce(jwks.privateKeyJwk, nonce),
      }),
    { code: "E_NO_REGISTRATION" },
  );
});

test("openSession issues hashed-token sessions with 600s access and 45d refresh", async () => {
  const { db, auth } = fixture();
  const jwks = newEd25519Jwks();
  const now = clock();
  insertRegistration(db, { did: "did:porch:aaa", deviceId: "dev-1", jwks });
  const session = await openVerifiedSession(auth, { did: "did:porch:aaa", deviceId: "dev-1", jwks, now: now.now });
  assert.equal(session.expiresInSeconds, 600);
  assert.ok(session.sessionId.startsWith("sess_"));
  const stored = await db.collection("sessions").findOne({ _id: session.sessionId });
  // Plaintext tokens are never persisted — hashes only.
  assert.equal(stored.accessTokenHash, sha256(session.accessToken));
  assert.equal(stored.refreshTokenHash, sha256(session.refreshToken));
  assert.ok(!JSON.stringify(stored).includes(session.accessToken));
  assert.ok(!JSON.stringify(stored).includes(session.refreshToken));
  assert.equal(new Date(stored.accessExpiresAt).getTime() - new Date(stored.createdAt).getTime(), 600_000);
  assert.equal(new Date(stored.refreshExpiresAt).getTime() - new Date(stored.createdAt).getTime(), 45 * 24 * 3600 * 1000);
});

test("openSession supersedes prior active sessions for the same (did, deviceId) only", async () => {
  const { db, auth } = fixture();
  const jwks = newEd25519Jwks();
  insertRegistration(db, { did: "did:porch:aaa", deviceId: "dev-1", jwks });
  const jwks2 = newEd25519Jwks();
  insertRegistration(db, { did: "did:porch:aaa", deviceId: "dev-2", jwks: jwks2 });
  const first = await openVerifiedSession(auth, { did: "did:porch:aaa", deviceId: "dev-1", jwks });
  const otherDevice = await openVerifiedSession(auth, { did: "did:porch:aaa", deviceId: "dev-2", jwks: jwks2 });
  assert.ok(await auth.verifyAccessToken(first.accessToken));
  // A fresh session on dev-1 supersedes `first` but not dev-2's.
  const second = await openVerifiedSession(auth, { did: "did:porch:aaa", deviceId: "dev-1", jwks });
  assert.equal(await auth.verifyAccessToken(first.accessToken), null);
  assert.deepEqual(await auth.verifyAccessToken(second.accessToken), { did: "did:porch:aaa", sessionId: second.sessionId });
  assert.deepEqual(await auth.verifyAccessToken(otherDevice.accessToken), {
    did: "did:porch:aaa",
    sessionId: otherDevice.sessionId,
  });
  const superseded = await db.collection("sessions").findOne({ _id: first.sessionId });
  assert.equal(superseded.status, "superseded");
});

test("verifyAccessToken returns null after the ~10 minute access TTL (injected now)", async () => {
  const { db, auth } = fixture();
  const jwks = newEd25519Jwks();
  const now = clock();
  insertRegistration(db, { did: "did:porch:aaa", deviceId: "dev-1", jwks });
  const session = await openVerifiedSession(auth, { did: "did:porch:aaa", deviceId: "dev-1", jwks, now: now.now });
  assert.ok(await auth.verifyAccessToken(session.accessToken, now.now));
  now.advance(599);
  assert.ok(await auth.verifyAccessToken(session.accessToken, now.now));
  now.advance(1);
  assert.equal(await auth.verifyAccessToken(session.accessToken, now.now), null);
  assert.equal(await auth.verifyAccessToken("unknown-token", now.now), null);
  // Superseded → null even before expiry.
  const second = await openVerifiedSession(auth, { did: "did:porch:aaa", deviceId: "dev-1", jwks, now: now.now });
  assert.equal(await auth.verifyAccessToken(session.accessToken, now.now), null);
  assert.ok(await auth.verifyAccessToken(second.accessToken, now.now));
});

test("refresh issues a new access token, keeps the refresh token, rejects invalid refresh", async () => {
  const { db, auth } = fixture();
  const jwks = newEd25519Jwks();
  const now = clock();
  insertRegistration(db, { did: "did:porch:aaa", deviceId: "dev-1", jwks });
  const session = await openVerifiedSession(auth, { did: "did:porch:aaa", deviceId: "dev-1", jwks, now: now.now });
  now.advance(700); // access long expired; refresh still valid
  const refreshed = await auth.refresh({ refreshToken: session.refreshToken, now: now.now });
  assert.equal(refreshed.refreshToken, session.refreshToken);
  assert.equal(refreshed.expiresInSeconds, 600);
  assert.notEqual(refreshed.accessToken, session.accessToken);
  assert.ok(await auth.verifyAccessToken(refreshed.accessToken, now.now));
  assert.equal(await auth.verifyAccessToken(session.accessToken, now.now), null);
  // Unknown refresh.
  await assert.rejects(() => auth.refresh({ refreshToken: "junk" }), { code: "E_REFRESH_INVALID" });
  // Refresh expiry at 45d — same refresh cannot rotate forever.
  now.advance(45 * 24 * 3600);
  await assert.rejects(() => auth.refresh({ refreshToken: session.refreshToken, now: now.now }), {
    code: "E_REFRESH_INVALID",
  });
  // A superseded session's refresh token no longer rotates.
  const secondSession = await openVerifiedSession(auth, { did: "did:porch:aaa", deviceId: "dev-1", jwks, now: now.now });
  await openVerifiedSession(auth, { did: "did:porch:aaa", deviceId: "dev-1", jwks, now: now.now });
  await assert.rejects(() => auth.refresh({ refreshToken: secondSession.refreshToken, now: now.now }), {
    code: "E_REFRESH_INVALID",
  });
});

test("revokeSessionsForIdentity revokes every session for the DID only (kill switch)", async () => {
  const { db, auth } = fixture();
  const jwks = newEd25519Jwks();
  insertRegistration(db, { did: "did:porch:aaa", deviceId: "dev-1", jwks });
  const jwks2 = newEd25519Jwks();
  insertRegistration(db, { did: "did:porch:aaa", deviceId: "dev-2", jwks: jwks2 });
  const jwks3 = newEd25519Jwks();
  insertRegistration(db, { did: "did:porch:bbb", deviceId: "dev-1", jwks: jwks3 });
  const dev1 = await openVerifiedSession(auth, { did: "did:porch:aaa", deviceId: "dev-1", jwks });
  const dev2 = await openVerifiedSession(auth, { did: "did:porch:aaa", deviceId: "dev-2", jwks: jwks2 });
  const otherDid = await openVerifiedSession(auth, { did: "did:porch:bbb", deviceId: "dev-1", jwks: jwks3 });
  const { revoked } = await auth.revokeSessionsForIdentity({ did: "did:porch:aaa" });
  assert.equal(revoked, 2);
  assert.equal(await auth.verifyAccessToken(dev1.accessToken), null);
  assert.equal(await auth.verifyAccessToken(dev2.accessToken), null);
  assert.ok(await auth.verifyAccessToken(otherDid.accessToken));
  // Second pass revokes nothing new.
  const again = await auth.revokeSessionsForIdentity({ did: "did:porch:aaa" });
  assert.equal(again.revoked, 0);
});

test("agents verify identically to humans through the shared signature path (ac-2)", async () => {
  const { db, auth } = fixture();
  // Agents are the same account records: an agent DID with its own device registration.
  const jwks = newEd25519Jwks();
  insertRegistration(db, { did: "did:porch:agent1", deviceId: "host-1", jwks, createdBy: "first-account" });
  const session = await openVerifiedSession(auth, { did: "did:porch:agent1", deviceId: "host-1", jwks });
  assert.equal(session.did, "did:porch:agent1");
  assert.ok(await auth.verifyAccessToken(session.accessToken));
  // openSessionForAgent delegates: same challenge → signature → session path.
  const { nonce } = await auth.createChallenge({ did: "did:porch:agent1" });
  await assert.rejects(
    () => auth.openSessionForAgent({ did: "did:porch:agent1", deviceId: "host-1", nonce, signature: "junk" }),
    { code: "E_SIGNATURE_INVALID" },
  );
  // The shared write-verification path verifies agent writes over arbitrary messages.
  const registration = await db.collection("device_registrations").findOne({ did: "did:porch:agent1" });
  const message = "device.write:thermostat=21";
  const good = sign(null, Buffer.from(message, "utf8"), createPrivateKey({ key: jwks.privateKeyJwk, format: "jwk" })).toString("base64url");
  assert.equal(await auth.verifyDeviceSignature({ registration, message, signature: good }), true);
  assert.equal(await auth.verifyDeviceSignature({ registration, message, signature: good.slice(0, -4) + "AAAA" }), false);
  assert.equal(await auth.verifyDeviceSignature({ registration: null, message, signature: good }), false);
});