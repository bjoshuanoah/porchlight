import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, HUB_URL } from "./helpers/slice-b.fixture.js";

test("minted DIDs are opaque did:porch method strings, unique per mint", () => {
  const { didService } = fixture();
  const didA = didService.mintDid();
  const didB = didService.mintDid();
  assert.match(didA, /^did:porch:[0-9a-f]{40}$/);
  assert.match(didB, /^did:porch:[0-9a-f]{40}$/);
  assert.notEqual(didA, didB);
});

test("createIdentity homes the identity locally with actorType and no migrated issuer", async () => {
  const { identities, didService } = fixture();
  const row = await didService.createIdentity({
    actorType: "human",
    displayName: "Susan",
    email: "sus@n.example",
    profile: { pronouns: "she/her" },
  });
  assert.match(row._id, /^ident_[0-9a-f-]{36}$/);
  assert.match(row.did, /^did:porch:[0-9a-f]{40}$/);
  assert.equal(row.actorType, "human");
  assert.equal(row.displayName, "Susan");
  assert.equal(row.homingStatus, "home");
  assert.equal(row.migratedToIssuer, null);
  assert.equal((await identities.find()).length, 1);
});

test("the DID stays stable across handle changes (setHandle resolves to the same DID)", async () => {
  const { didService } = fixture();
  const created = await didService.createIdentity({ actorType: "human", displayName: "Susan" });
  await didService.setHandle({ did: created.did, handle: "susan" });
  assert.equal(created.did, (await didService.resolveHandle("susan")).did);
  await didService.setHandle({ did: created.did, handle: "susan-2" });
  assert.equal(created.did, (await didService.resolveHandle("susan-2")).did);
});

test("DID document follows the W3C shape with the hub-adjacent identity-plane verificationMethod", async () => {
  const { signing, didService } = fixture();
  const identity = await didService.createIdentity({ actorType: "human", displayName: "Susan" });
  const document = await didService.putDocument(identity.did, { hubUrlFn: () => HUB_URL });
  const did = identity.did;

  assert.deepEqual(document["@context"], [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/suites/jws-2020/v1",
  ]);
  assert.equal(document.id, did);

  const operatorKey = await signing.didDocKey();
  assert.equal(document.verificationMethod.length, 1);
  const vm = document.verificationMethod[0];
  assert.equal(vm.id, `${did}#identity-plane-key`);
  assert.equal(vm.type, "JsonWebKey2020");
  assert.equal(vm.controller, did);
  assert.deepEqual(vm.publicKeyJwk, operatorKey.publicKeyJwk);
  assert.equal(document.authentication.length, 1);
  assert.equal(document.authentication[0], `${did}#identity-plane-key`);

  assert.deepEqual(document.service, [
    { id: `${did}#porchlight-home`, type: "PorchlightHome", serviceEndpoint: HUB_URL },
    { id: `${did}#identity-auth`, type: "IdentityAuth", serviceEndpoint: HUB_URL },
  ]);
});

test("no DID document carries private key material, and the operator key is a public OKP JWK", async () => {
  const { didService } = fixture();
  const identity = await didService.createIdentity({ actorType: "human", displayName: "Susan" });
  const document = await didService.putDocument(identity.did, { hubUrlFn: () => HUB_URL });
  const serialized = JSON.stringify(document);
  assert.equal(/"d"\s*:/.test(serialized), false, "no private `d` member anywhere in the document");
  const jwk = document.verificationMethod[0].publicKeyJwk;
  assert.equal(jwk.kty, "OKP");
  assert.equal(jwk.crv, "Ed25519");
  assert.ok(typeof jwk.x === "string" && jwk.x.length > 0);
});

test("putDocument is an upsert: a re-put updates endpoints in the single stored row", async () => {
  const { didDocuments, didService } = fixture();
  const identity = await didService.createIdentity({ actorType: "human", displayName: "Susan" });
  await didService.putDocument(identity.did, { hubUrlFn: () => "https://first.example" });
  const countBefore = (await didDocuments.find({ did: identity.did })).length;
  await didService.putDocument(identity.did, { hubUrlFn: () => "https://second.example" });
  assert.equal(countBefore, 1);
  assert.equal((await didDocuments.find({ did: identity.did })).length, 1, "still one upserted row");
  const stored = await didService.getDocument(identity.did);
  assert.equal(stored.service[0].serviceEndpoint, "https://second.example");
  assert.equal(stored.service[1].serviceEndpoint, "https://second.example");
});

test("getDocument returns null for an unknown DID", async () => {
  const { didService } = fixture();
  assert.equal(await didService.getDocument("did:porch:" + "0".repeat(40)), null);
});

test("repointDocument re-points services without touching the DID or verificationMethod", async () => {
  const { identities, didService } = fixture();
  const identity = await didService.createIdentity({ actorType: "human", displayName: "Susan" });
  await didService.setHandle({ did: identity.did, handle: "susan" });
  const before = await didService.putDocument(identity.did, { hubUrlFn: () => HUB_URL });
  await didService.repointDocument(identity.did, {
    hubUrlFn: () => "https://new-home.example",
    homingStatus: "moved",
  });
  const after = await didService.getDocument(identity.did);
  assert.equal(after.id, identity.did, "DID unchanged");
  assert.deepEqual(after.verificationMethod, before.verificationMethod, "operator key untouched");
  assert.equal(after.service[0].serviceEndpoint, "https://new-home.example");
  assert.equal(after.service[1].serviceEndpoint, "https://new-home.example");
  assert.equal((await identities.findOne({ did: identity.did })).homingStatus, "moved");
  // handle (presentation plane) is independent of the document re-point
  assert.equal((await didService.resolveHandle("susan")).did, identity.did);
});

test("setHandle enforces per-hub uniqueness; identical re-set to own handle is fine", async () => {
  const { identities, didService } = fixture();
  const a = await didService.createIdentity({ actorType: "human", displayName: "A" });
  const b = await didService.createIdentity({ actorType: "human", displayName: "B" });
  await didService.setHandle({ did: a.did, handle: "shared-name" });
  await assert.rejects(
    () => didService.setHandle({ did: b.did, handle: "shared-name" }),
    (error) => error.code === "E_HANDLE_TAKEN",
  );
  // identical re-set to own handle: no-op success
  await didService.setHandle({ did: a.did, handle: "shared-name" });
  await didService.setHandle({ did: a.did, handle: null });
  await didService.setHandle({ did: b.did, handle: "shared-name" });
  assert.equal((await identities.find()).length, 2);
});

test("setHandle refuses unknown identities", async () => {
  const { didService } = fixture();
  await assert.rejects(
    () => didService.setHandle({ did: "did:porch:" + "0".repeat(40), handle: "x" }),
    (error) => error.code === "E_IDENTITY_NOT_FOUND",
  );
});

test("resolveHandle returns the identity row or null", async () => {
  const { didService } = fixture();
  const created = await didService.createIdentity({ actorType: "human", displayName: "Susan" });
  assert.equal(await didService.resolveHandle("nobody"), null);
  assert.equal(null, await didService.resolveHandle(null));
  await didService.setHandle({ did: created.did, handle: "susan" });
  const found = await didService.resolveHandle("susan");
  assert.equal(found._id, created._id);
});

test("agent identities mint through the same path as humans", async () => {
  const { didService } = fixture();
  const human = await didService.createIdentity({ actorType: "human", displayName: "Susan" });
  const agent = await didService.createIdentity({ actorType: "agent", displayName: "Bookkeeper" });
  assert.equal(agent.actorType, "agent");
  assert.equal(human.actorType, "human");
  assert.notEqual(agent.did, human.did);
});

test("createIdentity refuses invalid actor types and missing display names", async () => {
  const { didService } = fixture();
  await assert.rejects(
    () => didService.createIdentity({ actorType: "robot", displayName: "Robot" }),
    (error) => error.code === "E_ACTOR_TYPE_INVALID",
  );
  await assert.rejects(
    () => didService.createIdentity({ actorType: "human" }),
    (error) => error.code === "E_DISPLAY_NAME_REQUIRED",
  );
});