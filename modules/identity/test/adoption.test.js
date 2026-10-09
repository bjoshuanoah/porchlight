import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "@porchlight/shared";
import { HubSigningService } from "../src/services/signing.service.js";
import { newEd25519Jwks } from "../src/util/jwt.js";
import { DidService } from "../src/services/did.service.js";


import { AccountService } from "../src/services/account.service.js";
import { HUB_URL, okpDevice } from "./helpers/slice-b.fixture.js";

const HOME_HUB = "https://home.example";

/**
 * Two-hub Slice-B adoption fixture: hub A fully hosts the identity (it is
 * real), hub B is the adopting hub whose default remote transport is wired
 * through to hub A's DID-document store — no network involved.
 */
function twoHubFixture() {
  function buildHub(hubUrl) {
    const store = createMemoryStore();
    const identities = store.collection("identities");
    const didDocuments = store.collection("did_documents");
    const deviceRegistrations = store.collection("device_registrations");
    const signing = new HubSigningService(store.collection("issuer_keys"));
    const didService = new DidService({ identities, didDocuments, signing });
    return {
      hubUrl,
      identities,
      didDocuments,
      deviceRegistrations,
      signing,
      didService,
      accountService: new AccountService({
        identities,
        didService,
        deviceRegistrations,
        hubUrlFn: () => hubUrl,
      }),
    };
  }

  const home = buildHub(HOME_HUB);
  const adopting = buildHub(HUB_URL);
  // Hub B's remote transport resolves DIDs at hub A via injected plumbing.
  adopting.accountService.transport = async (sourceHubUrl, did) => {
    if (sourceHubUrl !== home.hubUrl) return null;
    const document = await home.didService.getDocument(did);
    return document ? { document } : null;
  };
  return { home, adopting };
}

test("adoption verifies the DID at its home hub and stores a reference account", async () => {
  const { home, adopting } = twoHubFixture();
  const created = await home.accountService.createFirstAccount({
    displayName: "Susan",
    device: okpDevice(),
  });

  const result = await adopting.accountService.adoptIdentity({
    sourceHubUrl: home.hubUrl,
    did: created.account.did,
    displayName: "Susan (adopted)",
  });
  assert.equal(result.adopted, true);
  assert.equal(result.account.kind, "adopted");
  assert.equal(result.account.did, created.account.did);
  assert.deepEqual(result.account.identityRef, { did: created.account.did, sourceHubUrl: HOME_HUB });
  assert.deepEqual(result.account.adoptedIdentity, { sourceHubUrl: HOME_HUB, did: created.account.did });
  assert.equal(result.account.displayName, "Susan (adopted)");
  assert.equal(result.account.homingStatus, "home");
  assert.match(result.account._id, /^ident_[0-9a-f-]{36}$/);
});

test("adoption NEVER copies the identity record, keys or profile — reference fields only", async () => {
  const { home, adopting } = twoHubFixture();
  const created = await home.accountService.createFirstAccount({
    displayName: "Susan",
    email: "susan@home.example",
    device: okpDevice(),
  });
  await home.accountService.recordProfile({ did: created.account.did, profile: { bio: "remote bio" } });
  // remote hub also holds a revoked device registration to prove nothing leaks
  const remoteKey = newEd25519Jwks().publicKeyJwk;
  await home.deviceRegistrations.insertOne({
    _id: `reg_${crypto.randomUUID()}`,
    did: created.account.did,
    deviceId: "device_remote_2",
    label: null,
    publicKeyJwk: remoteKey,
    createdBy: "pairing",
    status: "revoked",
    revokedAt: null,
    createdAt: new Date().toISOString(),
  });

  const result = await adopting.accountService.adoptIdentity({
    sourceHubUrl: home.hubUrl,
    did: created.account.did,
  });

  // no keys: the reference row and this hub's registrations carry nothing
  const serialized = JSON.stringify(result.account);
  assert.equal(/"publicKeyJwk"/.test(serialized), false);
  assert.equal(/"x"\s*:/.test(serialized), false);
  assert.equal((await adopting.deviceRegistrations.find()).length, 0);
  assert.deepEqual(result.account.profile, {});
  // no copied remote identity-record fields: email stays null, no bio, no label leakage
  assert.equal(result.account.email, null);
  assert.equal(serialized.includes("susan@home.example"), false);
  assert.equal(serialized.includes("remote bio"), false);
  assert.equal(serialized.includes("device_remote_2"), false);
  const stored = await adopting.identities.findOne({ kind: "adopted" });
  assert.equal((await adopting.identities.find()).length, 1, "exactly one reference row");
  assert.match(stored._id, /^ident_/);
});

test("adoption fails closed when the DID does not resolve at the source hub", async () => {
  const { home, adopting } = twoHubFixture();
  await assert.rejects(
    () => adopting.accountService.adoptIdentity({ sourceHubUrl: home.hubUrl, did: "did:porch:" + "0".repeat(40) }),
    (error) => error.code === "E_REMOTE_IDENTITY_NOT_FOUND",
  );
  assert.equal((await adopting.identities.find()).length, 0, "no partial reference rows");
  // a dead source hub (transport null) is the same fail-closed path
  adopting.accountService.transport = async () => null;
  const { didService: homeService } = home;
  const created = { did: await homeService.mintDid() };
  await assert.rejects(
    () => adopting.accountService.adoptIdentity({ sourceHubUrl: home.hubUrl, did: created.did }),
    (error) => error.code === "E_REMOTE_IDENTITY_NOT_FOUND",
  );
});

test("adoption is idempotent on (sourceHubUrl, did): the same reference row returns", async () => {
  const { home, adopting } = twoHubFixture();
  const created = await home.accountService.createFirstAccount({
    displayName: "Susan",
    device: okpDevice(),
  });
  const first = await adopting.accountService.adoptIdentity({
    sourceHubUrl: home.hubUrl,
    did: created.account.did,
  });
  const second = await adopting.accountService.adoptIdentity({
    sourceHubUrl: home.hubUrl,
    did: created.account.did,
  });
  assert.equal(second.adopted, false);
  assert.equal(second.alreadyAdopted, true);
  assert.equal(second.account._id, first.account._id);
  assert.equal((await adopting.identities.find()).length, 1);
});

test("the bootstrap gate holds: E_OWNER_ACCOUNT_EXISTS when an owner account already exists", async () => {
  const { home, adopting } = twoHubFixture();
  const created = await home.accountService.createFirstAccount({ displayName: "Susan", device: okpDevice() });
  await adopting.accountService.createFirstAccount({ displayName: "Local Owner", device: okpDevice() });
  await assert.rejects(
    () => adopting.accountService.adoptIdentity({ sourceHubUrl: home.hubUrl, did: created.account.did }),
    (error) => error.code === "E_OWNER_ACCOUNT_EXISTS",
  );
});

test("adoption from different source hubs for the same DID are distinct references", async () => {
  const { home, adopting } = twoHubFixture();
  const created = await home.accountService.createFirstAccount({ displayName: "Susan", device: okpDevice() });
  const mirrorHub = "https://mirror.example";
  adopting.accountService.transport = async (sourceHubUrl, did) => {
    if (sourceHubUrl === home.hubUrl) {
      const document = await home.didService.getDocument(did);
      return document ? { document } : null;
    }
    if (sourceHubUrl === mirrorHub) return { document: { id: did } };
    return null;
  };

  const first = await adopting.accountService.adoptIdentity({ sourceHubUrl: home.hubUrl, did: created.account.did });
  const second = await adopting.accountService.adoptIdentity({
    sourceHubUrl: mirrorHub,
    did: created.account.did,
    displayName: "Mirror copy",
  });
  assert.equal(second.adopted, true, "a different source hub is not the same adopted identity");
  assert.notEqual(second.account._id, first.account._id);
  assert.equal(second.account.identityRef.sourceHubUrl, mirrorHub);
});

test("adoption without source hub or did refuses with E_ADOPTION_FIELDS_REQUIRED", async () => {
  const { adopting } = twoHubFixture();
  await assert.rejects(() => adopting.accountService.adoptIdentity({ did: "did:porch:x" }), {
    code: "E_ADOPTION_FIELDS_REQUIRED",
  });
  await assert.rejects(() => adopting.accountService.adoptIdentity({ sourceHubUrl: "https://x" }), {
    code: "E_ADOPTION_FIELDS_REQUIRED",
  });
});