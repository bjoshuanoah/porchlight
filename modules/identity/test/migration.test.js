/**
 * MigrationService two-hub migration tests (slice C, ac-4/ac-9). No network:
 * hub B fetches hub A's published did-doc-plane key set and DID document via
 * injected transports that also assert the redirect:"error" discipline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createMemoryStore } from "@porchlight/shared";
import { decodeJwt } from "../src/util/jwt.js";
import { HubSigningService } from "../src/services/signing.service.js";
import { TrustService } from "../src/services/trust.service.js";
import { MigrationService } from "../src/services/migration.service.js";

const HUB_A = "https://hub-a.test";
const HUB_B = "https://hub-b.test";

/**
 * Minimal slice-B-contract DidService stand-in: same constructor surface and
 * method signatures the integrator wires, implemented against the same store
 * handles. Migration tests exercise re-pointing/rebuilding documents with it.
 */
class DidServiceFixture {
  constructor({ identities, didDocuments, signing, hubUrlFn }) {
    this.identities = identities;
    this.didDocuments = didDocuments;
    this.signing = signing;
    this.hubUrlFn = hubUrlFn;
  }

  mintDid() {
    return `did:porch:${randomBytes(20).toString("hex")}`;
  }

  async createIdentity({ actorType = "human", displayName, email = null, handle = null, profile = {} } = {}) {
    const row = {
      _id: `ident_${randomUUID()}`,
      did: this.mintDid(),
      actorType,
      displayName,
      email,
      handle,
      profile,
      homingStatus: "home",
      migratedToIssuer: null,
      createdAt: new Date().toISOString(),
    };
    await this.identities.insertOne(row);
    return row;
  }

  /** Slice B contract shape: W3C DID Core document on the did-doc plane. */
  async putDocument(did, { hubUrlFn } = {}) {
    const { publicKeyJwk } = await this.signing.didDocKey();
    const document = {
      "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/jws-2020/v1"],
      id: did,
      verificationMethod: [
        {
          id: `${did}#identity-plane-key`,
          type: "JsonWebKey2020",
          controller: did,
          publicKeyJwk,
        },
      ],
      authentication: [`${did}#identity-plane-key`],
      service: [
        { id: `${did}#porchlight-home`, type: "PorchlightHome", serviceEndpoint: hubUrlFn() },
        { id: `${did}#identity-auth`, type: "IdentityAuth", serviceEndpoint: hubUrlFn() },
      ],
    };
    await this.didDocuments.updateOne(
      { did },
      { $set: { document, updatedAt: new Date().toISOString() }, upsert: true },
    );
    return document;
  }

  async getDocument(did) {
    const row = await this.didDocuments.findOne({ did });
    return row ? row.document : null;
  }

  /** Re-place ONLY the service entries (endpoint pointer); DID + keys stay. */
  async repointDocument(did, { hubUrlFn } = {}) {
    const row = await this.didDocuments.findOne({ did });
    if (!row) {
      return this.putDocument(did, { hubUrlFn });
    }
    const { document } = row;
    document.service = [
      { id: `${did}#porchlight-home`, type: "PorchlightHome", serviceEndpoint: hubUrlFn() },
      { id: `${did}#identity-auth`, type: "IdentityAuth", serviceEndpoint: hubUrlFn() },
    ];
    await this.didDocuments.updateOne(
      { did },
      { $set: { document, updatedAt: new Date().toISOString() } },
    );
    return document;
  }
}

function hubFixture({ issuer }) {
  const store = createMemoryStore();
  const collections = {
    identities: store.collection("identities"),
    didDocuments: store.collection("did_documents"),
    deviceRegistrations: store.collection("device_registrations"),
    issuerKeys: store.collection("issuer_keys"),
  };
  const signing = new HubSigningService(collections.issuerKeys);
  const didService = new DidServiceFixture({
    identities: collections.identities,
    didDocuments: collections.didDocuments,
    signing,
    hubUrlFn: () => issuer,
  });
  const trust = new TrustService({
    authCodes: store.collection("auth_codes"),
    sessions: store.collection("sessions"),
    signing,
    hubUrlFn: () => issuer,
  });
  const migration = new MigrationService({
    identities: collections.identities,
    didDocuments: collections.didDocuments,
    deviceRegistrations: collections.deviceRegistrations,
    signing,
    didService,
    hubUrlFn: () => issuer,
    trust,
  });
  return { store, collections, signing, didService, trust, migration, issuer };
}

function transportFor(map) {
  return async (url, options) => {
    assert.ok(options?.redirect === "error", "every trust-plane fetch must use redirect:'error'");
    const entry = map[url];
    if (!entry) return { ok: false, status: 404, json: async () => ({}) };
    const body = typeof entry === "function" ? await entry() : entry;
    return { ok: true, status: 200, json: async () => body };
  };
}

/** Hub A's published endpoints, live against its keystore. */
function hubAWire(hubA) {
  return transportFor({
    [`${HUB_A}/.well-known/jwks.json`]: () => hubA.signing.jwks(),
    [`${HUB_A}/.well-known/identity-keys.json`]: () => hubA.signing.didDocPublicKeys(),
    [HUB_A]: { ok: true, status: 200, json: async () => ({}) },
  });
  // (the bare-key entry keeps transports 404-free for stray paths)
}

async function seedHostedIdentity(hubA, overrides = {}) {
  const identity = await hubA.didService.createIdentity({
    actorType: overrides.actorType ?? "human",
    displayName: overrides.displayName ?? "Susan",
    email: overrides.email ?? "susan@example.test",
    handle: overrides.handle ?? "susan",
    profile: overrides.profile ?? { flavor: "vanilla" },
  });
  await hubA.didService.putDocument(identity.did, { hubUrlFn: hubA.hubUrlFn ?? (() => HUB_A) });
  const regs = overrides.registrations ?? [
    {
      deviceId: "dev-1",
      label: "Susan's laptop",
      publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "O2onvM62pJ3ooB3qMKnsGkgmF7h1uqkbkBLnBgYt3sY", kid: "k_dev1" },
      createdBy: "first-account",
    },
    {
      deviceId: "dev-2",
      label: "Susan's phone",
      publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "MKBCTNIcKUSDii11ySvs35YhmmbEgWAmxKuJyz2W0K8", kid: "k_dev2" },
      createdBy: "pairing",
    },
  ];
  const now = new Date().toISOString();
  for (const reg of regs) {
    await hubA.collections.deviceRegistrations.insertOne({
      _id: `reg_${randomUUID()}`,
      did: identity.did,
      deviceId: reg.deviceId,
      label: reg.label ?? null,
      publicKeyJwk: reg.publicKeyJwk,
      createdBy: reg.createdBy ?? "first-account",
      status: reg.status ?? "active",
      revokedAt: reg.revokedAt ?? null,
      createdAt: now,
    });
  }
  return identity;
}

function buildEnvelope(hubA, identity) {
  return hubA.collections.deviceRegistrations.find({ did: identity.did }).then((rows) => ({
    displayName: "Susan",
    actorType: identity.actorType,
    email: identity.email,
    handle: identity.handle,
    profile: identity.profile,
    deviceRegistrations: rows.map(({ deviceId, label, publicKeyJwk, createdBy, status, revokedAt }) => ({
      deviceId,
      label,
      publicKeyJwk,
      createdBy,
      status,
      revokedAt,
    })),
  }));
}

test("issueHandoff marks the outgoing identity moved, re-points its DID document, and signs the handoff token", async () => {
  const hubA = hubFixture({ issuer: HUB_A });
  const identity = await seedHostedIdentity(hubA);

  const handoff = await hubA.migration.issueHandoff({ did: identity.did, newIssuer: HUB_B });
  assert.deepEqual(
    { did: handoff.did, newIssuer: handoff.newIssuer, oldIssuer: handoff.oldIssuer },
    { did: identity.did, newIssuer: HUB_B, oldIssuer: HUB_A },
  );
  assert.match(handoff.handoffToken, /^[\w-]+\.[\w-]+\.[\w-]+$/);

  const row = await hubA.collections.identities.findOne({ did: identity.did });
  assert.equal(row.homingStatus, "moved");
  assert.equal(row.migratedToIssuer, HUB_B);

  // DID document re-pointed to the new hub — DID and key reference unchanged.
  const document = await hubA.didService.getDocument(identity.did);
  assert.equal(document.id, identity.did);
  assert.deepEqual(
    document.service.map((svc) => svc.serviceEndpoint).sort(),
    [HUB_B, HUB_B],
  );
  assert.deepEqual(document.verificationMethod.map((vm) => vm.id), [`${identity.did}#identity-plane-key`]);

  // The handoff token did-doc attestation carries the expected claims.
  const claims = decodeJwt(handoff.handoffToken).payload;
  assert.equal(claims.typ, "porchlight-handoff");
  assert.equal(claims.did, identity.did);
  assert.equal(claims.oldIssuer, HUB_A);
  assert.equal(claims.newIssuer, HUB_B);
});

test("issueHandoff refuses a did this hub does not host (E_IDENTITY_NOT_FOUND)", async () => {
  const hubA = hubFixture({ issuer: HUB_A });
  await assert.rejects(hubA.migration.issueHandoff({ did: "did:porch:ghost", newIssuer: HUB_B }), {
    code: "E_IDENTITY_NOT_FOUND",
  });
});

test("receiveMigration ingests the identity with the SAME DID, rebuilds the DID doc on the new hub, and carries public-only device rows (ac-4, ac-9)", async () => {
  const hubA = hubFixture({ issuer: HUB_A });
  const hubB = hubFixture({ issuer: HUB_B });
  const identity = await seedHostedIdentity(hubA);
  const envelope = await buildEnvelope(hubA, identity);
  const handoff = await hubA.migration.issueHandoff({ did: identity.did, newIssuer: HUB_B });

  const result = await hubB.migration.receiveMigration({
    handoffToken: handoff.handoffToken,
    did: identity.did,
    envelope,
    oldIssuer: HUB_A,
    transport: hubAWire(hubA),
  });
  assert.equal(result.adopted, "migrated");
  assert.equal(result.did, identity.did, "the DID is hub-independent and must never change (ac-4, ac-9)");
  assert.notEqual(result.identity._id, identity._id, "a fresh row on the receiving hub");
  assert.equal(result.identity.kind, "migrated");
  assert.equal(result.identity.homingStatus, "home");
  assert.equal(result.identity.migratedToIssuer, null);
  assert.equal(result.identity.displayName, "Susan");
  assert.deepEqual(result.identity.profile, identity.profile);

  const docB = await hubB.didService.getDocument(identity.did);
  assert.equal(docB.id, identity.did);
  assert.ok(docB.verificationMethod[0].id.startsWith(identity.did));
  assert.deepEqual(docB.service.map((svc) => svc.serviceEndpoint), [HUB_B, HUB_B]);

  // Verification Method is the NEW hub's did-doc key (hub-adjacent, not the old hub's).
  const oldDocKey = await hubA.signing.didDocKey();
  const newDocKey = await hubB.signing.didDocKey();
  assert.ok(!docB.verificationMethod[0].publicKeyJwk.d, "did-doc public JWK carries no private field");
  assert.equal(docB.verificationMethod[0].publicKeyJwk.x !== oldDocKey.publicKeyJwk.x, true);
  assert.equal(docB.verificationMethod[0].publicKeyJwk.x, newDocKey.publicKeyJwk.x);

  // Device rows: public key material only, no ids, same keys + device ids.
  const rows = await hubB.collections.deviceRegistrations.find({ did: identity.did });
  assert.equal(rows.length, 2);
  const deviceIds = rows.map((row) => row.deviceId).sort();
  assert.deepEqual(deviceIds, ["dev-1", "dev-2"]);
  for (const row of rows) {
    assert.match(row._id, /^reg_/);
    assert.ok(!row.publicKeyJwk.d, "device public JWK must never carry a private field");
    assert.ok(!("privateKeyJwk" in row));
    assert.match(row.publicKeyJwk.kid, /^k_dev/);
  }

  // The old hub's copy stays marked moved — exactly one hub asserts "home".
  const oldRow = await hubA.collections.identities.findOne({ did: identity.did });
  assert.equal(oldRow.homingStatus, "moved");
  assert.equal(oldRow.migratedToIssuer, HUB_B);
});

test("receiveMigration is idempotent: re-receive returns the existing row (adopted: 'existing') without re-ingesting", async () => {
  const hubA = hubFixture({ issuer: HUB_A });
  const hubB = hubFixture({ issuer: HUB_B });
  const identity = await seedHostedIdentity(hubA);
  const envelope = await buildEnvelope(hubA, identity);
  const handoff = await hubA.migration.issueHandoff({ did: identity.did, newIssuer: HUB_B });

  const first = await hubB.migration.receiveMigration({
    handoffToken: handoff.handoffToken,
    did: identity.did,
    envelope,
    oldIssuer: HUB_A,
    transport: hubAWire(hubA),
  });
  assert.equal(first.adopted, "migrated");

  const again = await hubB.migration.receiveMigration({
    handoffToken: handoff.handoffToken,
    did: identity.did,
    envelope,
    oldIssuer: HUB_A,
    transport: hubAWire(hubA),
  });
  assert.equal(again.adopted, "existing");
  assert.equal(again.identity._id, first.identity._id);
  assert.equal((await hubB.collections.deviceRegistrations.find({ did: identity.did })).length, 2);
  assert.equal((await hubB.collections.identities.find({ did: identity.did })).length, 1);
});

test("handoff verified against the OLD hub's did-doc plane key set; a foreign key set fails closed (E_OLD_HUB_KEYSET_MISMATCH)", async () => {
  const hubA = hubFixture({ issuer: HUB_A });
  const hubB = hubFixture({ issuer: HUB_B });
  const identity = await seedHostedIdentity(hubA);
  const envelope = await buildEnvelope(hubA, identity);
  const handoff = await hubA.migration.issueHandoff({ did: identity.did, newIssuer: HUB_B });

  // Hub B's OWN did-doc plane keys — wrong hub, wrong plane.
  await assert.rejects(
    hubB.migration.receiveMigration({
      handoffToken: handoff.handoffToken,
      did: identity.did,
      envelope,
      oldIssuer: HUB_A,
      transport: transportFor({
        [`${HUB_A}/.well-known/identity-keys.json`]: () => hubB.signing.didDocPublicKeys(),
      }),
    }),
    { code: "E_OLD_HUB_KEYSET_MISMATCH" },
  );
  // Nothing was ingested by the failed attempt.
  assert.equal((await hubB.collections.identities.find({ did: identity.did })).length, 0);

  // Old hub's MEMBER-AUTH plane instead of its did-doc plane — still refused.
  await assert.rejects(
    hubB.migration.receiveMigration({
      handoffToken: handoff.handoffToken,
      did: identity.did,
      envelope,
      oldIssuer: HUB_A,
      transport: transportFor({
        [`${HUB_A}/.well-known/identity-keys.json`]: () => hubA.signing.jwks(),
      }),
    }),
    { code: "E_OLD_HUB_KEYSET_MISMATCH" },
  );

  // The correct transport verifies and ingests.
  const result = await hubB.migration.receiveMigration({
    handoffToken: handoff.handoffToken,
    did: identity.did,
    envelope,
    oldIssuer: HUB_A,
    transport: hubAWire(hubA),
  });
  assert.equal(result.adopted, "migrated");
});

test("tampered handoff token rejected (E_SIGNATURE_INVALID); missing key endpoint fails closed (E_JWKS_UNAVAILABLE)", async () => {
  const hubA = hubFixture({ issuer: HUB_A });
  const hubB = hubFixture({ issuer: HUB_B });
  const identity = await seedHostedIdentity(hubA);
  const envelope = await buildEnvelope(hubA, identity);
  const handoff = await hubA.migration.issueHandoff({ did: identity.did, newIssuer: HUB_B });
  const options = {
    did: identity.did,
    envelope,
    oldIssuer: HUB_A,
    transport: hubAWire(hubA),
  };

  const [h, p, sig] = handoff.handoffToken.split(".");
  const flipped = sig[0] === "A" ? "B" + sig.slice(1) : "A" + sig.slice(1);
  await assert.rejects(hubB.migration.receiveMigration({ ...options, handoffToken: `${h}.${p}.${flipped}` }), {
    code: "E_SIGNATURE_INVALID",
  });
  await assert.rejects(hubB.migration.receiveMigration({ ...options, handoffToken: handoff.handoffToken, transport: transportFor({}) }), {
    code: "E_JWKS_UNAVAILABLE",
  });
});

test("handoff attestation must match the did being migrated (E_HANDOFF_MISMATCH)", async () => {
  const hubA = hubFixture({ issuer: HUB_A });
  const hubB = hubFixture({ issuer: HUB_B });
  const identity = await seedHostedIdentity(hubA);
  const envelope = await buildEnvelope(hubA, identity);
  const handoff = await hubA.migration.issueHandoff({ did: identity.did, newIssuer: HUB_B });
  const wire = transportFor({
    [`${HUB_A}/.well-known/identity-keys.json`]: () => hubA.signing.didDocPublicKeys(),
    [`${HUB_B}/.well-known/identity-keys.json`]: () => hubA.signing.didDocPublicKeys(),
  });

  await assert.rejects(
    hubB.migration.receiveMigration({
      handoffToken: handoff.handoffToken,
      did: "did:porch:someone-else",
      envelope,
      oldIssuer: HUB_A,
      transport: wire,
    }),
    { code: "E_HANDOFF_MISMATCH" },
  );
  // Attested oldIssuer (hub-a) vs a pinned claim of a different old hub.
  await assert.rejects(
    hubB.migration.receiveMigration({
      handoffToken: handoff.handoffToken,
      did: identity.did,
      envelope,
      oldIssuer: HUB_B,
      transport: wire,
    }),
    { code: "E_HANDOFF_MISMATCH" },
  );
  // Still nothing ingested.
  assert.equal((await hubB.collections.identities.find({ did: identity.did })).length, 0);
});

test("expired handoff token rejected (E_HANDOFF_EXPIRED)", async () => {
  const hubA = hubFixture({ issuer: HUB_A });
  const hubB = hubFixture({ issuer: HUB_B });
  const identity = await seedHostedIdentity(hubA);
  const envelope = await buildEnvelope(hubA, identity);
  // Handoff attestation already fully spent: exp == iat.
  const expiredToken = await hubA.signing.signHandoffToken({
    did: identity.did,
    oldIssuer: HUB_A,
    newIssuer: HUB_B,
    ttlSeconds: 0,
  });
  await assert.rejects(
    hubB.migration.receiveMigration({
      handoffToken: expiredToken,
      did: identity.did,
      envelope,
      oldIssuer: HUB_A,
      transport: hubAWire(hubA),
    }),
    { code: "E_HANDOFF_EXPIRED" },
  );
});

test("an envelope device row carrying private key material refuses to migrate (E_PRIVATE_KEY_REJECTED) — nothing ingested", async () => {
  const hubA = hubFixture({ issuer: HUB_A });
  const hubB = hubFixture({ issuer: HUB_B });
  const identity = await seedHostedIdentity(hubA);
  const envelope = await buildEnvelope(hubA, identity);
  envelope.deviceRegistrations = [
    {
      ...envelope.deviceRegistrations[0],
      publicKeyJwk: { ...envelope.deviceRegistrations[0].publicKeyJwk, d: "sneaky-private-half" },
    },
  ];
  const handoff = await hubA.migration.issueHandoff({ did: identity.did, newIssuer: HUB_B });

  await assert.rejects(
    hubB.migration.receiveMigration({
      handoffToken: handoff.handoffToken,
      did: identity.did,
      envelope,
      oldIssuer: HUB_A,
      transport: hubAWire(hubA),
    }),
    { code: "E_PRIVATE_KEY_REJECTED" },
  );
  assert.equal((await hubB.collections.identities.find({ did: identity.did })).length, 0);
  assert.equal((await hubB.collections.deviceRegistrations.find({ did: identity.did })).length, 0);
  assert.equal(await hubB.didService.getDocument(identity.did) !== null, false);
});

test("revoked registrations migrate as revoked rows; revoked state is preserved end to end", async () => {
  const hubA = hubFixture({ issuer: HUB_A });
  const hubB = hubFixture({ issuer: HUB_B });
  const revokedAt = "2026-10-01T00:00:00.000Z";
  const identity = await seedHostedIdentity(hubA, {
    registrations: [
      { deviceId: "dev-keep", publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "O2onvM62pJ3ooB3qMKnsGkgmF7h1uqkbkBLnBgYt3sY" }, createdBy: "first-account" },
      { deviceId: "dev-gone", publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "MKBCTNIcKUSDii11ySvs35YhmmbEgWAmxKuJyz2W0K8" }, createdBy: "pairing", status: "revoked", revokedAt },
    ],
  });
  const envelope = await buildEnvelope(hubA, identity);
  const handoff = await hubA.migration.issueHandoff({ did: identity.did, newIssuer: HUB_B });

  await hubB.migration.receiveMigration({
    handoffToken: handoff.handoffToken,
    did: identity.did,
    envelope,
    oldIssuer: HUB_A,
    transport: hubAWire(hubA),
  });
  const rows = await hubB.collections.deviceRegistrations.find({ did: identity.did });
  assert.equal(rows.length, 2);
  const revoked = rows.find((row) => row.deviceId === "dev-gone");
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.revokedAt, revokedAt);
  const kept = rows.find((row) => row.deviceId === "dev-keep");
  assert.equal(kept.status, "active");
  assert.equal(kept.createdBy, "first-account");
});
test("membership references ride the envelope untouched and never become identity data", async () => {
  const hubA = hubFixture({ issuer: HUB_A });
  const hubB = hubFixture({ issuer: HUB_B });
  const identity = await seedHostedIdentity(hubA);

  // Networks hold references {identityRef, memberId, roles, status}; the
  // migration envelope carries them through uninterpreted (ac-4).
  const references = [
    { identityRef: identity.did, memberId: "member_77", roles: ["member"], status: "active" },
  ];
  const envelope = {
    ...(await buildEnvelope(hubA, identity)),
    membershipReferences: references,
  };
  const handoff = await hubA.migration.issueHandoff({ did: identity.did, newIssuer: HUB_B });
  const received = await hubB.migration.receiveMigration({
    handoffToken: handoff.handoffToken,
    did: identity.did,
    envelope,
    oldIssuer: HUB_A,
    transport: hubAWire(hubA),
  });

  assert.deepEqual(received.membershipReferences, references);
  const row = await hubB.collections.identities.findOne({ did: identity.did });
  assert.deepEqual(row.membershipReferences, references);
  // The identity never carries membership authority: reference data only.
  assert.equal("roles" in row, false);
});
