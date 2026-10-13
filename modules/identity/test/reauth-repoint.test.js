// Co-located unit tests for the PORCH-065 additions in the identity plane:
// the self-reauth grant purpose marker (stored on the grant row, surfaced on
// consume), the consumed-grant observer (the CLI path's re-point trigger),
// and the DID half of the self-reference re-point (bulk re-point + residue
// scan for the status surface).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "@porchlight/shared";
import { DeviceService } from "../src/services/device.service.js";
import { DidService } from "../src/services/did.service.js";
import { HubSigningService } from "../src/services/signing.service.js";
import { sha256 } from "../src/services/signing.service.js";
import { newEd25519Jwks } from "../src/util/jwt.js";

function devicesFixture({ onDeviceLinkConsumed = null } = {}) {
  const db = createMemoryStore();
  const devices = new DeviceService({
    deviceRegistrations: db.collection("device_registrations"),
    pairingCodes: db.collection("pairing_codes"),
    deviceLinks: db.collection("device_links"),
    sessions: db.collection("sessions"),
    hash: sha256,
    onDeviceLinkConsumed,
  });
  return { db, devices };
}

function didFixture() {
  const db = createMemoryStore();
  const signing = new HubSigningService(db.collection("issuer_keys"));
  const dids = new DidService({ identities: db.collection("identities"), didDocuments: db.collection("did_documents"), signing });
  return { db, dids };
}

function goodJwk(jwks = newEd25519Jwks()) {
  return jwks.publicKeyJwk;
}

test("self-reauth grant: purpose is stored on the row, rides the consume response, and a null-purpose link flows unchanged", async () => {
  const { db, devices } = devicesFixture();
  const did = "did:porch:reauth1";
  const reauthGrant = await devices.mintDeviceLink({ did, purpose: "self-reauth" });
  const ordinary = await devices.mintDeviceLink({ did: "did:porch:member1" });

  const consumedReauth = await devices.consumeDeviceLink({
    token: reauthGrant.token,
    deviceId: "dev-a",
    publicKeyJwk: goodJwk(),
  });
  assert.equal(consumedReauth.did, did);
  assert.equal(consumedReauth.purpose, "self-reauth");

  const consumedOrdinary = await devices.consumeDeviceLink({
    token: ordinary.token,
    deviceId: "dev-b",
    publicKeyJwk: goodJwk(),
  });
  assert.equal(consumedOrdinary.purpose, null);

  // The marker rides the response copy only — the stored registration row is untouched.
  const stored = await db.collection("device_registrations").findOne({ did, deviceId: "dev-a" });
  assert.equal(stored.purpose, undefined);
});

test("self-reauth grant replay and revocation ride the existing device-link mechanics", async () => {
  const { devices } = devicesFixture();
  const { token } = await devices.mintDeviceLink({ did: "did:porch:reauth2", purpose: "self-reauth" });
  const jwk = goodJwk();

  await devices.consumeDeviceLink({ token, deviceId: "dev-a2", publicKeyJwk: jwk });
  // Single-use: the replayed code is refused exactly like any device link.
  await assert.rejects(
    () => devices.consumeDeviceLink({ token, deviceId: "dev-x2", publicKeyJwk: jwk }),
    { code: "E_DEVICE_LINK_CONSUMED" },
  );

  const revocable = await devices.mintDeviceLink({ did: "did:porch:reauth3", purpose: "self-reauth" });
  await devices.revokeDeviceLink({ grantId: revocable.grantId });
  await assert.rejects(
    () => devices.consumeDeviceLink({ token: revocable.token, deviceId: "dev-x6", publicKeyJwk: goodJwk() }),
    (error) => error.code === "E_DEVICE_LINK_REVOKED",
  );
});

test("a consumed self-reauth grant fires the observer with the purpose; ordinary links carry null", async () => {
  const observed = [];
  const { devices } = devicesFixture({
    onDeviceLinkConsumed: (event) => {
      observed.push(event);
    },
  });
  const selfGrant = await devices.mintDeviceLink({ did: "did:porch:reauth4", purpose: "self-reauth" });
  const memberGrant = await devices.mintDeviceLink({ did: "did:porch:member2" });
  await devices.consumeDeviceLink({ token: selfGrant.token, deviceId: "dev-1", publicKeyJwk: goodJwk() });
  await devices.consumeDeviceLink({ token: memberGrant.token, deviceId: "dev-2", publicKeyJwk: goodJwk() });

  assert.deepEqual(observed, [
    { grantId: selfGrant.grantId, did: "did:porch:reauth4", purpose: "self-reauth", serveOrigin: null },
    { grantId: memberGrant.grantId, did: "did:porch:member2", purpose: null, serveOrigin: null },
  ]);
});

test("an observer failure never fails the consume (the rebind is complete either way)", async () => {
  const { devices } = devicesFixture({
    onDeviceLinkConsumed: () => {
      throw new Error("observer blew up");
    },
  });
  const { token } = await devices.mintDeviceLink({ did: "did:porch:reauth5", purpose: "self-reauth" });
  const registration = await devices.consumeDeviceLink({ token, deviceId: "dev-1", publicKeyJwk: goodJwk() });
  assert.equal(registration.did, "did:porch:reauth5");
});

test("repointAllDocuments re-points every homed DID document (real pass)", async () => {
  const { dids } = didFixture();
  const planted = [];
  for (let i = 0; i < 3; i += 1) {
    const row = await dids.createIdentity({ actorType: "human", displayName: `Member ${i}` });
    await dids.putDocument(row.did, { hubUrlFn: () => "https://old.porch.love" });
    planted.push(row.did);
  }

  const staleBefore = await dids.staleServiceEntries({ hubUrl: "https://new.porch.love" });
  assert.equal(staleBefore.length, 3);

  await dids.repointAllDocuments({ hubUrl: "https://new.porch.love" });

  for (const [i, did] of planted.entries()) {
    const document = await dids.getDocument(did);
    const home = document.service.find((entry) => entry.id === `${did}#porchlight-home`);
    assert.equal(home.serviceEndpoint, "https://new.porch.love", `did ${i} re-pointed`);
  }
  assert.deepEqual(await dids.staleServiceEntries({ hubUrl: "https://new.porch.love" }), []);
  // A second pass is an idempotent no-op (same write).
  await dids.repointAllDocuments({ hubUrl: "https://new.porch.love" });
  assert.deepEqual(await dids.staleServiceEntries({ hubUrl: "https://new.porch.love" }), []);
});

test("staleServiceEntries carries each stale DID's recorded endpoint for the status surface", async () => {
  const { dids } = didFixture();
  const row = await dids.createIdentity({ actorType: "human", displayName: "Owner" });
  await dids.putDocument(row.did, { hubUrlFn: () => null });
  const stale = await dids.staleServiceEntries({ hubUrl: "https://new.porch.love" });
  assert.deepEqual(stale, [{ kind: "did_document", ref: row.did, endpoint: null }]);
});