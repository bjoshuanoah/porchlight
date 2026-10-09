import { test } from "node:test";
import assert from "node:assert/strict";
import { sign, createPrivateKey } from "node:crypto";
import { createMemoryStore } from "@porchlight/shared";
import { DeviceService } from "../src/services/device.service.js";
import { AuthService } from "../src/services/auth.service.js";
import { newEd25519Jwks } from "../src/util/jwt.js";
import { sha256 } from "../src/services/signing.service.js";

function fixture() {
  const db = createMemoryStore();
  const collections = {
    challenges: db.collection("challenges"),
    deviceRegistrations: db.collection("device_registrations"),
    pairingCodes: db.collection("pairing_codes"),
    deviceLinks: db.collection("device_links"),
    sessions: db.collection("sessions"),
  };
  const devices = new DeviceService({ ...collections, hash: sha256 });
  const auth = new AuthService({ ...collections, hash: sha256 });
  return { db, collections, devices, auth };
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

function goodJwk(jwks = newEd25519Jwks()) {
  return jwks.publicKeyJwk;
}

test("createRegistration stores the public JWK only and rejects private key material", async () => {
  const { db, devices } = fixture();
  const jwk = goodJwk();
  const row = await devices.createRegistration({
    did: "did:porch:aaa",
    deviceId: "dev-1",
    publicKeyJwk: jwk,
    label: "Kitchen hub",
    createdBy: "first-account",
  });
  assert.ok(row._id.startsWith("reg_"));
  assert.equal(row.status, "active");
  assert.equal(row.revokedAt, null);
  assert.equal(row.createdBy, "first-account");
  assert.deepEqual(row.publicKeyJwk, jwk); // structured copy, never the caller's reference
  assert.notEqual(row.publicKeyJwk, jwk);
  assert.ok(!("d" in row.publicKeyJwk));
  // A JWK carrying `d` is private key material: rejected, nothing stored.
  const withPrivate = newEd25519Jwks();
  await assert.rejects(
    () =>
      devices.createRegistration({
        did: "did:porch:aaa",
        deviceId: "dev-1",
        publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: withPrivate.publicKeyJwk.x, d: withPrivate.privateKeyJwk.d },
      }),
    { code: "E_PRIVATE_KEY_REJECTED" },
  );
  assert.equal((await db.collection("device_registrations").find({})).length, 1);
  assert.ok(!JSON.stringify(await db.collection("device_registrations").find({})).includes('"d"'));
});

test("createRegistration rejects non-OKP / non-Ed25519 key types", async () => {
  const { devices } = fixture();
  const rsaJwk = { kty: "RSA", n: "aa", e: "AQAB" };
  await assert.rejects(() => devices.createRegistration({ did: "did:porch:aaa", deviceId: "d", publicKeyJwk: rsaJwk }), {
    code: "E_KEY_TYPE_REJECTED",
  });
  await assert.rejects(
    () =>
      devices.createRegistration({
        did: "did:porch:aaa",
        deviceId: "d",
        publicKeyJwk: { kty: "EC", crv: "P-256", x: "aa", y: "bb" },
      }),
    { code: "E_KEY_TYPE_REJECTED" },
  );
  await assert.rejects(
    () => devices.createRegistration({ did: "did:porch:aaa", deviceId: "d", publicKeyJwk: null }),
    { code: "E_KEY_TYPE_REJECTED" },
  );
});

test("getRegistration returns any-status row or null", async () => {
  const { devices } = fixture();
  const row = await devices.createRegistration({
    did: "did:porch:aaa",
    deviceId: "dev-1",
    publicKeyJwk: goodJwk(),
  });
  assert.deepEqual(await devices.getRegistration({ registrationId: row._id }), row);
  assert.equal(await devices.getRegistration({ registrationId: "reg_missing" }), null);
  assert.equal(await devices.getRegistration({}), null);
});

test("listRegistrations keeps revoked rows visible in the owner view", async () => {
  const { devices } = fixture();
  const keep = await devices.createRegistration({ did: "did:porch:aaa", deviceId: "dev-1", publicKeyJwk: goodJwk() });
  const kill = await devices.createRegistration({ did: "did:porch:aaa", deviceId: "dev-2", publicKeyJwk: goodJwk() });
  await devices.revokeRegistration({ registrationId: kill._id });
  const rows = await devices.listRegistrations({ did: "did:porch:aaa" });
  assert.equal(rows.length, 2);
  const byId = new Map(rows.map((r) => [r._id, r]));
  assert.equal(byId.get(keep._id).status, "active");
  assert.equal(byId.get(kill._id).status, "revoked");
  assert.ok(byId.get(kill._id).revokedAt);
  // No cross-identity leakage: shared hardware is never deduped or exposed.
  assert.deepEqual(await devices.listRegistrations({ did: "did:porch:bbb" }), []);
});

test("pairing codes are one-time with a 10 minute TTL (injected now)", async () => {
  const { devices } = fixture();
  const now = clock();
  const did = "did:porch:aaa";
  await devices.createRegistration({ did, deviceId: "dev-1", publicKeyJwk: goodJwk() });
  const { code, expiresAt } = await devices.mintPairingCode({ did, now: now.now });
  assert.equal(new Date(expiresAt).getTime() - now.now().getTime(), 600_000);
  const stored = await devices.pairingCodes.findOne({ did });
  assert.equal(stored.code, sha256(code)); // stored hashed, plaintext returned once
  const newDeviceJwk = goodJwk();
  const registration = await devices.consumePairingCode({
    code,
    deviceId: "dev-2",
    publicKeyJwk: newDeviceJwk,
    label: "Second device",
    now: now.now,
  });
  assert.equal(registration.did, did, "pairs onto the SAME did");
  assert.equal(registration.createdBy, "pairing");
  assert.notEqual(registration.publicKeyJwk, newDeviceJwk);
  // One-time: second consume → consumed.
  await assert.rejects(() => devices.consumePairingCode({ code, deviceId: "dev-3", publicKeyJwk: goodJwk(), now: now.now }), {
    code: "E_PAIRING_CODE_CONSUMED",
  });
  // Expiry: a fresh code used after 10 minutes → expired.
  const { code: code2 } = await devices.mintPairingCode({ did, now: now.now });
  now.advance(601);
  await assert.rejects(() => devices.consumePairingCode({ code: code2, deviceId: "dev-4", publicKeyJwk: goodJwk(), now: now.now }), {
    code: "E_PAIRING_CODE_EXPIRED",
  });
  // Unknown code.
  await assert.rejects(() => devices.consumePairingCode({ code: "nope", deviceId: "dev-5", publicKeyJwk: goodJwk(), now: now.now }), {
    code: "E_PAIRING_CODE_UNKNOWN",
  });
});

test("pairing never transports or stores private key material", async () => {
  const { db, devices } = fixture();
  const did = "did:porch:aaa";
  const { code } = await devices.mintPairingCode({ did });
  const jwks = newEd25519Jwks();
  const tainted = { kty: "OKP", crv: "Ed25519", x: jwks.publicKeyJwk.x, d: jwks.privateKeyJwk.d };
  await assert.rejects(() => devices.consumePairingCode({ code, deviceId: "dev-2", publicKeyJwk: tainted }), {
    code: "E_PRIVATE_KEY_REJECTED",
  });
  // Nothing was stored, and the code stays unconsumed for an honest retry.
  assert.deepEqual(await db.collection("device_registrations").find({}), []);
  assert.equal((await db.collection("pairing_codes").findOne({ did })).consumed, false);
  const ok = await devices.consumePairingCode({ code, deviceId: "dev-2", publicKeyJwk: jwks.publicKeyJwk });
  assert.equal(ok.publicKeyJwk.kty, "OKP");
  assert.ok(!JSON.stringify(await db.collection("device_registrations").find({})).includes('"d"'));
});

test("device links bind the new device to the UNCHANGED did and never mint identities", async () => {
  const { db, devices } = fixture();
  const now = clock();
  const did = "did:porch:migrated-one";
  await devices.createRegistration({ did, deviceId: "dev-1", publicKeyJwk: goodJwk() });
  const { token, expiresAt } = await devices.mintDeviceLink({ did, now: now.now });
  assert.equal(new Date(expiresAt).getTime() - now.now().getTime(), 24 * 3600 * 1000);
  const stored = await db.collection("device_links").findOne({ did });
  assert.equal(stored.token, sha256(token));
  const registration = await devices.consumeDeviceLink({
    token,
    deviceId: "dev-2",
    publicKeyJwk: goodJwk(),
    label: "Rebound",
    now: now.now,
  });
  assert.equal(registration.did, did, "the link is bound to the existing DID, no new identity");
  // No identit(y) record is synthesized by this path — only the registration exists.
  assert.equal((await db.collection("device_registrations").find({ did })).length, 2);
  await assert.rejects(() => devices.consumeDeviceLink({ token, deviceId: "dev-3", publicKeyJwk: goodJwk(), now: now.now }), {
    code: "E_DEVICE_LINK_CONSUMED",
  });
  const { token: token2 } = await devices.mintDeviceLink({ did, now: now.now });
  now.advance(24 * 3600 + 1);
  await assert.rejects(() => devices.consumeDeviceLink({ token: token2, deviceId: "dev-4", publicKeyJwk: goodJwk(), now: now.now }), {
    code: "E_DEVICE_LINK_EXPIRED",
  });
  await assert.rejects(() => devices.consumeDeviceLink({ token: "nope", deviceId: "dev-5", publicKeyJwk: goodJwk(), now: now.now }), {
    code: "E_DEVICE_LINK_UNKNOWN",
  });
});

test("device links reject private key material too", async () => {
  const { db, devices } = fixture();
  const did = "did:porch:aaa";
  const { token } = await devices.mintDeviceLink({ did });
  const jwks = newEd25519Jwks();
  await assert.rejects(
    () => devices.consumeDeviceLink({ token, deviceId: "dev-2", publicKeyJwk: { ...jwks.publicKeyJwk, d: jwks.privateKeyJwk.d } }),
    { code: "E_PRIVATE_KEY_REJECTED" },
  );
  assert.deepEqual(await db.collection("device_registrations").find({}), []);
  assert.equal((await db.collection("device_links").findOne({ did })).consumed, false);
});

test("revokeRegistration revokes the registration AND supersedes its active sessions", async () => {
  const { devices } = fixture();
  const did = "did:porch:aaa";
  const registration = await devices.createRegistration({ did, deviceId: "dev-1", publicKeyJwk: goodJwk() });
  const at = new Date("2026-02-01T00:00:00Z").toISOString();
  await devices.sessions.insertOne({
    _id: "sess_live",
    did,
    deviceId: "dev-1",
    accessTokenHash: sha256("a"),
    refreshTokenHash: sha256("r"),
    accessExpiresAt: at,
    refreshExpiresAt: at,
    status: "active",
    createdAt: at,
  });
  const { revoked, supersededSessions } = await devices.revokeRegistration({ registrationId: registration._id });
  assert.equal(revoked, registration._id);
  assert.equal(supersededSessions, 1);
  assert.equal((await devices.getRegistration({ registrationId: registration._id })).status, "revoked");
  assert.equal((await devices.sessions.findOne({ _id: "sess_live" })).status, "superseded");
  await assert.rejects(() => devices.revokeRegistration({ registrationId: "reg_missing" }), {
    code: "E_REGISTRATION_UNKNOWN",
  });
});

test("shared physical device: three identities on one deviceId hold independent registrations and sessions", async () => {
  const { db, devices, auth } = fixture();
  const now = clock();
  const deviceId = "family-tablet";
  const identities = ["did:porch:susan", "did:porch:brian", "did:porch:kid"];
  const sessions = [];
  const registrations = [];
  for (const did of identities) {
    const jwks = newEd25519Jwks();
    registrations.push(await devices.createRegistration({ did, deviceId, publicKeyJwk: jwks.publicKeyJwk }));
    const { nonce } = await auth.createChallenge({ did });
    sessions.push(
      await auth.openSession({ did, deviceId, nonce, signature: signNonce(jwks, nonce), now: now.now }),
    );
  }
  // Three registrations on one deviceId — never deduped, one per identity.
  assert.equal((await db.collection("device_registrations").find({ deviceId })).length, 3);
  // Each identity sees exactly its own row.
  for (const did of identities) {
    assert.equal((await devices.listRegistrations({ did })).length, 1);
  }
  // Independent sessions: each access token verifies to its own identity.
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await auth.verifyAccessToken(sessions[i].accessToken, now.now), {
      did: identities[i],
      sessionId: sessions[i].sessionId,
    });
  }
  // Revoking the family tablet for ONE identity touches only its own scope.
  await devices.revokeRegistration({ registrationId: registrations[1]._id });
  assert.deepEqual(await auth.verifyAccessToken(sessions[0].accessToken, now.now), {
    did: identities[0],
    sessionId: sessions[0].sessionId,
  });
  assert.equal(await auth.verifyAccessToken(sessions[1].accessToken, now.now), null);
  assert.deepEqual(await auth.verifyAccessToken(sessions[2].accessToken, now.now), {
    did: identities[2],
    sessionId: sessions[2].sessionId,
  });
});

/** Sign the nonce utf8 bytes with the device-held Ed25519 private key (base64url). */
function signNonce(jwks, nonce) {
  return sign(null, Buffer.from(nonce, "utf8"), createPrivateKey({ key: jwks.privateKeyJwk, format: "jwk" })).toString(
    "base64url",
  );
}
test("after pairing the new device re-credentials silently — no login wall (ac-12)", async () => {
  const { devices, auth } = fixture();
  const did = "did:porch:pair1";
  // A working device mints a one-time code; the new device consumes it.
  await devices.createRegistration({ did, deviceId: "dev-1", publicKeyJwk: goodJwk() });
  const { code } = await devices.mintPairingCode({ did });
  const fresh = newEd25519Jwks();
  await devices.consumePairingCode({ code, deviceId: "dev-2", publicKeyJwk: fresh.publicKeyJwk });

  // Silent re-credentialing: the new device signs its own fresh challenge with
  // its own key — a session opens without any login step.
  const challenge = await auth.createChallenge({ did });
  const nonce = challenge.nonce;
  const signature = sign(null, Buffer.from(nonce, "utf8"), createPrivateKey({ key: fresh.privateKeyJwk, format: "jwk" })).toString("base64url");
  const session = await auth.openSession({ did, deviceId: "dev-2", nonce, signature });
  assert.equal(session.did, did);
  assert.ok(session.accessToken.length >= 32);
});

test("forgotten PIN unblocks via the owner-routed link on the same device (ac-13)", async () => {
  const { devices, auth } = fixture();
  const did = "did:porch:pin1";
  const old = newEd25519Jwks();
  await devices.createRegistration({ did, deviceId: "tablet", publicKeyJwk: old.publicKeyJwk });
  // Stuck session on the shared device (PIN forgotten; the app-level lock stays).
  const stuck = await auth.createChallenge({ did });
  await auth.openSession({ did, deviceId: "tablet", nonce: stuck.nonce, signature: signNonce(old, stuck.nonce) });

  // The owner routes a fresh device link; the SAME device consumes it — a
  // fresh registration takes over and supersedes the stuck session.
  const { token } = await devices.mintDeviceLink({ did });
  const fresh = newEd25519Jwks();
  const registration = await devices.consumeDeviceLink({ token, deviceId: "tablet", publicKeyJwk: fresh.publicKeyJwk });
  assert.equal(registration.did, did);

  const challenge = await auth.createChallenge({ did });
  const session = await auth.openSession({ did, deviceId: "tablet", nonce: challenge.nonce, signature: signNonce(fresh, challenge.nonce) });
  assert.equal(session.deviceId, "tablet");

  const rows = (await auth.sessions.find({ did, deviceId: "tablet" })).filter((row) => row.status === "active");
  assert.equal(rows.length, 1, "the fresh registration supersedes the stuck session");
  assert.equal(rows[0].status, "active");
});

test("device-link grants show console states, revoke instantly, and refuse revoked consumption (PORCH-010)", async () => {
  const { devices } = fixture();
  const minted = await devices.mintDeviceLink({ did: "did:porch:linkmember" });
  assert.ok(minted.grantId.startsWith("dl_"));
  assert.ok(minted.token);
  let links = await devices.listDeviceLinks();
  assert.equal(links.length, 1);
  assert.equal(links[0].status, "unused");

  const revoked = await devices.revokeDeviceLink({ grantId: minted.grantId });
  assert.equal(revoked.revoked, true);
  links = await devices.listDeviceLinks();
  assert.equal(links[0].status, "revoked");

  // Owner-revoked grants never authenticate; the member copy names it.
  await assert.rejects(
    () => devices.consumeDeviceLink({ token: minted.token, deviceId: "dev-1", publicKeyJwk: goodJwk() }),
    (error) => error.code === "E_DEVICE_LINK_REVOKED",
  );

  // A consumed grant leaves the console state machine at "used".
  const fresh = await devices.mintDeviceLink({ did: "did:porch:linkmember2" });
  await devices.consumeDeviceLink({ token: fresh.token, deviceId: "dev-2", publicKeyJwk: goodJwk() });
  const rows = await devices.listDeviceLinks();
  assert.equal(rows.find((row) => row._id === fresh.grantId).status, "used");
});
