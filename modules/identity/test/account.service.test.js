import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, HUB_URL, okpDevice } from "./helpers/slice-b.fixture.js";
import { newEd25519Jwks } from "../src/util/jwt.js";

const UNKNOWN_DID = "did:porch:" + "0".repeat(40);

test("the first owner account creates identity + DID document + first-account device binding", async () => {
  const { accountService } = fixture();
  const device = okpDevice({ deviceId: "owner-phone", label: "Pocket" });
  const result = await accountService.createFirstAccount({
    displayName: "Brian",
    email: "b@example.com",
    device,
  });

  assert.equal(result.created, true);
  const { account, didDocument, registration } = result;
  assert.match(account._id, /^ident_[0-9a-f-]{36}$/);
  assert.match(account.did, /^did:porch:[0-9a-f]{40}$/);
  assert.equal(account.actorType, "human");
  assert.equal(account.kind, "owner");
  assert.equal(account.displayName, "Brian");
  assert.equal(account.email, "b@example.com");
  assert.equal(account.homingStatus, "home");
  assert.equal(account.migratedToIssuer, null);

  assert.deepEqual(didDocument["@context"], [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/suites/jws-2020/v1",
  ]);
  assert.equal(didDocument.id, account.did);
  assert.equal(didDocument.service[0].id, `${account.did}#porchlight-home`);
  assert.equal(didDocument.service[0].serviceEndpoint, HUB_URL);
  assert.equal(didDocument.service[1].type, "IdentityAuth");

  assert.match(registration._id, /^reg_[0-9a-f-]{36}$/);
  assert.equal(registration.did, account.did);
  assert.equal(registration.deviceId, "owner-phone");
  assert.equal(registration.label, "Pocket");
  assert.equal(registration.createdBy, "first-account");
  assert.equal(registration.status, "active");
  assert.equal(registration.revokedAt, null);
  assert.deepEqual(registration.publicKeyJwk, device.publicKeyJwk);
  // keys ride on the device: the stored registration holds ONLY the public half
  assert.equal("d" in registration.publicKeyJwk, false);
});

test("bootstrap is idempotent: an existing owner account returns created:false, nothing minted", async () => {
  const { accountService } = fixture();
  const first = await accountService.createFirstAccount({
    displayName: "Brian",
    device: okpDevice(),
  });
  const second = await accountService.createFirstAccount({ displayName: "Someone Else" });
  assert.equal(second.created, false);
  assert.equal(second.account._id, first.account._id);
  assert.equal(second.account.displayName, "Brian");
  assert.equal("didDocument" in second, false, "no second document or registration minted");
  assert.equal("registration" in second, false);
  assert.equal((await accountService.identities.find({ kind: "owner" })).length, 1);
  assert.equal((await accountService.deviceRegistrations.find()).length, 1);
});

test("bootstrap requires the device binding: missing or incomplete device → E_DEVICE_KEY_REQUIRED", async () => {
  const { accountService } = fixture();
  for (const arg of [
    { displayName: "Brian" },
    { displayName: "Brian", device: {} },
    { displayName: "Brian", device: { deviceId: "no-key-device" } },
    { displayName: "Brian", device: { publicKeyJwk: okpDevice().publicKeyJwk } },
  ]) {
    await assert.rejects(
      () => accountService.createFirstAccount(arg),
      (error) => error.code === "E_DEVICE_KEY_REQUIRED",
    );
  }
  assert.equal((await accountService.identities.find()).length, 0, "nothing minted on refusal");
  assert.equal((await accountService.deviceRegistrations.find()).length, 0);
});

test("private key material is rejected at the hub: E_PRIVATE_KEY_REJECTED (and never stored)", async () => {
  const { accountService } = fixture();
  assert.ok(okpDevice().publicKeyJwk, "the fixture's device key is public-half only");
  const { privateKeyJwk } = newEd25519Jwks(); // the only place a private key exists: the test itself
  const badDevice = { deviceId: "d1", label: null, publicKeyJwk: { ...privateKeyJwk, d: privateKeyJwk.d } };
  await assert.rejects(
    () => accountService.createFirstAccount({ displayName: "Brian", device: badDevice }),
    (error) => error.code === "E_PRIVATE_KEY_REJECTED",
  );
  assert.equal((await accountService.deviceRegistrations.find()).length, 0);
});

test("non-OKP / non-Ed25519 device keys are rejected: E_KEY_TYPE_REJECTED", async () => {
  const { accountService } = fixture();
  await assert.rejects(
    () =>
      accountService.createFirstAccount({
        displayName: "Brian",
        device: { deviceId: "d1", publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" } },
      }),
    (error) => error.code === "E_KEY_TYPE_REJECTED",
  );
});

test("agent identities mint freely (no owner gate) with actorType 'agent' and host-bound keys", async () => {
  const { accountService, deviceRegistrations } = fixture();
  const first = await accountService.createAgentIdentity({
    displayName: "Bookkeeper",
    device: okpDevice({ deviceId: "agent-host-1" }),
  });
  assert.equal(first.created, true);
  assert.equal(first.account.actorType, "agent");
  assert.match(first.account._id, /^ident_[0-9a-f-]{36}$/);
  assert.equal(first.didDocument.service[0].serviceEndpoint, HUB_URL);
  assert.equal(first.registration.did, first.account.did);
  assert.equal(first.registration.deviceId, "agent-host-1");
  assert.equal(first.registration.createdBy, "agent");
  assert.equal("d" in first.registration.publicKeyJwk, false);

  // no single-owner gate: several agents mint independently
  const second = await accountService.createAgentIdentity({
    displayName: "Scheduler",
    device: okpDevice({ deviceId: "agent-host-2" }),
  });
  assert.equal(second.created, true);
  assert.notEqual(second.account.did, first.account.did);
  assert.equal((await deviceRegistrations.find()).length, 2);
});

test("agent creation enforces the same key discipline (device required, private `d` rejected)", async () => {
  const { accountService } = fixture();
  await assert.rejects(
    () => accountService.createAgentIdentity({ displayName: "Bookkeeper" }),
    (error) => error.code === "E_DEVICE_KEY_REQUIRED",
  );
  const { privateKeyJwk } = newEd25519Jwks();
  await assert.rejects(
    () =>
      accountService.createAgentIdentity({
        displayName: "Bookkeeper",
        device: { deviceId: "h", publicKeyJwk: { ...privateKeyJwk, d: privateKeyJwk.d } },
      }),
    (error) => error.code === "E_PRIVATE_KEY_REJECTED",
  );
});

test("recordProfile updates profile (and displayName) on the account row; unknown DID → E_IDENTITY_NOT_FOUND", async () => {
  const { accountService } = fixture();
  const created = await accountService.createFirstAccount({ displayName: "Brian", device: okpDevice() });
  const updated = await accountService.recordProfile({
    did: created.account.did,
    displayName: "Bri",
    profile: { pronouns: "they/them" },
  });
  assert.equal(updated.displayName, "Bri");
  assert.deepEqual(updated.profile, { pronouns: "they/them" });
  assert.equal(updated.did, created.account.did);

  const nameOnly = await accountService.recordProfile({ did: created.account.did, displayName: "Brian" });
  assert.equal(nameOnly.displayName, "Brian");
  assert.deepEqual(nameOnly.profile, { pronouns: "they/them" }, "untouched fields survive");

  await assert.rejects(() => accountService.recordProfile({ did: UNKNOWN_DID, profile: {} }), {
    code: "E_IDENTITY_NOT_FOUND",
  });
});

test("setHandle rides through to the DID service: DID unchanged, per-hub uniqueness enforced", async () => {
  const { accountService, didService } = fixture();
  const created = await accountService.createFirstAccount({ displayName: "Brian", device: okpDevice() });
  await accountService.setHandle({ did: created.account.did, handle: "brian" });
  const updated = await accountService.identities.findOne({ did: created.account.did });
  assert.equal(updated.handle, "brian");
  assert.equal(updated.did, created.account.did, "DID stable across handle change");

  const outsider = await didService.createIdentity({ actorType: "human", displayName: "Other" });
  await assert.rejects(
    () => accountService.setHandle({ did: outsider.did, handle: "brian" }),
    (error) => error.code === "E_HANDLE_TAKEN",
  );
  await assert.rejects(() => accountService.setHandle({ did: UNKNOWN_DID, handle: "x" }), {
    code: "E_IDENTITY_NOT_FOUND",
  });
});

test("no stored row — identity, document, or registration — ever carries private key material", async () => {
  const { accountService, identities, deviceRegistrations, didDocuments } = fixture();
  await accountService.createFirstAccount({ displayName: "Brian", device: okpDevice() });
  await accountService.createAgentIdentity({ displayName: "Agent", device: okpDevice() });
  assert.equal((await identities.find()).length, 2);
  for (const rows of [
    await identities.find(),
    await deviceRegistrations.find(),
    await didDocuments.find(),
  ]) {
    const serialized = JSON.stringify(rows);
    assert.equal(/privateKeyJwk/.test(serialized), false, "no privateKeyJwk field");
    assert.equal(/"d"\s*:/.test(serialized), false, "no `d` member");
    assert.equal(/"private_key"/.test(serialized), false);
  }
});
test("member identity birth at the front door mints kind member and binds the device key (PORCH-010)", async () => {
  const { accountService } = fixture();
  const device = okpDevice({ deviceId: "member-tablet", label: "Kitchen tablet" });
  const result = await accountService.createMemberAccount({ displayName: "Sophie", device });

  assert.equal(result.created, true);
  assert.equal(result.account.kind, "member");
  assert.equal(result.account.actorType, "human");
  assert.match(result.account.did, /^did:porch:[0-9a-f]{40}$/);
  assert.equal(result.account.displayName, "Sophie");
  assert.equal(result.registration.createdBy, "join");
  assert.equal(result.registration.deviceId, "member-tablet");
  assert.equal(result.registration.publicKeyJwk, device.publicKeyJwk);
});

test("member identity birth is not owner-gated and fails loud on bad input", async () => {
  const { accountService } = fixture();
  // Member birth before and after an owner account exists: the single-owner
  // gate never applies to members.
  const owner = await accountService.createFirstAccount({
    displayName: "Brian",
    device: okpDevice({ deviceId: "owner-phone" }),
  });
  assert.equal(owner.created, true);
  const member = await accountService.createMemberAccount({
    displayName: "Jake",
    device: okpDevice({ deviceId: "jake-phone" }),
  });
  assert.equal(member.created, true);

  await assert.rejects(
    () => accountService.createMemberAccount({ displayName: "", device: okpDevice() }),
    (error) => error.code === "E_DISPLAY_NAME_REQUIRED",
  );
  await assert.rejects(
    () => accountService.createMemberAccount({ displayName: "No Device" }),
    (error) => error.code === "E_DEVICE_KEY_REQUIRED",
  );
  const { publicKeyJwk } = newEd25519Jwks();
  await assert.rejects(
    () => accountService.createMemberAccount({ displayName: "Leak", device: { deviceId: "dev", publicKeyJwk: { ...publicKeyJwk, d: "x" } } }),
    (error) => error.code === "E_PRIVATE_KEY_REJECTED",
  );
});
