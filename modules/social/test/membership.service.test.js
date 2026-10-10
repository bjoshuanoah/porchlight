import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { createMemoryStore } from "@porchlight/shared";
import { InviteService } from "../src/services/invite.service.js";
import { MembershipService, canonicalJson } from "../src/services/membership.service.js";

function fixture(options = {}) {
  const db = createMemoryStore();
  const invites = new InviteService(db.collection("invites"));
  const membership = new MembershipService({
    memberships: db.collection("memberships"),
    membershipSessions: db.collection("membership_sessions"),
    deviceKeys: db.collection("device_keys"),
    invites,
    verifyMemberIdToken: options.verifyMemberIdToken ?? (async (token) => (token ? { did: token } : null)),
    networks: db.collection("networks"),
    audit: async () => {},
    registeredDeviceKey: options.registeredDeviceKey ?? null,
    memberNames: options.memberNames ?? null,
  });
  return { db, invites, membership };
}

function okp() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyJwk = publicKey.export({ format: "jwk" });
  return {
    publicKeyJwk,
    sign: (message) => cryptoSign(null, Buffer.from(message, "utf8"), privateKey),
  };
}

test("ac-1: join link embeds an invite code and shows owner-visible states", async () => {
  const { invites } = fixture();
  const invite = await invites.issue({ networkId: "net_1", hubUrl: "https://hub.example" });
  assert.ok(invite.joinUrl.startsWith("https://hub.example/join/"));
  assert.ok(invite.joinUrl.endsWith(invite.token));

  const fresh = await invites.list({ networkId: "net_1" });
  assert.equal(fresh[0].status, "unused");

  const redeemed = await invites.redeem(invite.token);
  assert.equal(redeemed.useCount, 1);
  assert.equal((await invites.list({ networkId: "net_1" }))[0].status, "used");

  const revoked = await invites.revoke({ inviteId: invite._id });
  assert.equal(revoked.revoked, true);
  assert.equal((await invites.list({ networkId: "net_1" }))[0].status, "revoked");
});

test("ac-1: revocation is instant and member entry fails with plain language", async () => {
  const { invites } = fixture();
  const invite = await invites.issue({ networkId: "net_1" });
  await invites.revoke({ inviteId: invite._id });

  const verify = await invites.verify(invite.token);
  assert.equal(verify.valid, false);
  assert.equal(verify.code, "E_INVITE_REVOKED");
  assert.ok(verify.message.includes("revoked by the network owner"));

  const unknown = await invites.verify("not-a-code");
  assert.equal(unknown.valid, false);
  assert.equal(unknown.code, "E_INVITE_NOT_FOUND");
  assert.ok(unknown.message.includes("doesn't exist"));
});

test("ac-1: an exhausted link fails with plain language", async () => {
  const { invites } = fixture();
  const invite = await invites.issue({ networkId: "net_1", maxUses: 1 });
  await invites.redeem(invite.token);
  const result = await invites.verify(invite.token);
  assert.equal(result.valid, false);
  assert.equal(result.code, "E_INVITE_EXHAUSTED");
  assert.ok(result.message.includes("already been used"));
});

test("ac-2: admission issues a membership token scoped to that network only", async () => {
  const { invites, membership } = fixture();
  const invite = await invites.issue({ networkId: "net_1", role: "member" });
  const device = okp();
  const signature = device.sign(`porchlight-join:${invite.token}`).toString("base64url");

  const admitted = await membership.admit({
    code: invite.token,
    identityAccessToken: "did:porchlight:susan",
    deviceId: "dev_1",
    devicePublicKeyJwk: device.publicKeyJwk,
    signature,
  });
  assert.equal(admitted.membership.networkId, "net_1");
  assert.equal(admitted.membership.role, "member");
  assert.ok(admitted.accessToken.length >= 32);

  const verified = await membership.verifyAccessToken(admitted.accessToken);
  assert.equal(verified.membership.networkId, "net_1");
  assert.equal(verified.membership.did, "did:porchlight:susan");

  // Scoped to that network only: the same token is foreign on other networks.
  assert.equal(await membership.verifyAccessToken(admitted.accessToken, { networkId: "net_other" }), null);
  assert.ok(await membership.verifyAccessToken(admitted.accessToken, { networkId: "net_1" }));
});

test("ac-2: admission requires an identity-verified member", async () => {
  const { invites, membership } = fixture();
  const invite = await invites.issue({ networkId: "net_1" });
  await assert.rejects(
    () => membership.admit({ code: invite.token, identityAccessToken: null, deviceId: "dev_1", devicePublicKeyJwk: okp().publicKeyJwk, signature: "x" }),
    (error) => error.code === "E_MUST_SIGN_IN",
  );

  const anon = fixture({ verifyMemberIdToken: async (token) => (token === "real" ? null : { did: token }) });
  await anon.invites.issue({ networkId: "net_1" });
  // The server-wired resolver returning null means identity rejected the token.
  await assert.rejects(
    () => anon.membership.admit({ code: "x", identityAccessToken: "real", deviceId: "dev_1", devicePublicKeyJwk: okp().publicKeyJwk, signature: "y" }),
    (error) => error.code === "E_MUST_SIGN_IN",
  );
});

test("ac-2: admission verifies device-key possession and rejects private key material", async () => {
  const { invites, membership } = fixture();
  const invite = await invites.issue({ networkId: "net_1" });
  const device = okp();
  const other = okp();

  await assert.rejects(
    () =>
      membership.admit({
        code: invite.token,
        identityAccessToken: "did:porchlight:susan",
        deviceId: "dev_1",
        devicePublicKeyJwk: other.publicKeyJwk,
        signature: device.sign(`porchlight-join:${invite.token}`).toString("base64url"),
      }),
    (error) => error.code === "E_SIGNATURE_INVALID",
  );

  const withD = { ...device.publicKeyJwk, d: "privatematerial" };
  const secondInvite = await invites.issue({ networkId: "net_1" });
  await assert.rejects(
    () =>
      membership.admit({
        code: secondInvite.token,
        identityAccessToken: "did:porchlight:susan",
        deviceId: "dev_2",
        devicePublicKeyJwk: withD,
        signature: device.sign(`porchlight-join:${secondInvite.token}`).toString("base64url"),
      }),
    (error) => error.code === "E_PRIVATE_KEY_REJECTED",
  );
});

test("ac-2: membership writes verify against the enrolled device key at the origin", async () => {
  const { invites, membership } = fixture();
  const invite = await invites.issue({ networkId: "net_1" });
  const device = okp();
  await membership.admit({
    code: invite.token,
    identityAccessToken: "did:porchlight:susan",
    deviceId: "dev_1",
    devicePublicKeyJwk: device.publicKeyJwk,
    signature: device.sign(`porchlight-join:${invite.token}`).toString("base64url"),
  });

  const payload = { type: "text", body: "hello family" };
  const signature = device.sign(canonical(payload)).toString("base64url");
  const result = await membership.verifyMemberWrite({
    networkId: "net_1",
    did: "did:porchlight:susan",
    deviceId: "dev_1",
    payload,
    signature,
  });
  assert.equal(result.verified, true);

  const wrongPayload = { type: "text", body: "tampered" };
  await assert.rejects(
    () =>
      membership.verifyMemberWrite({
        networkId: "net_1",
        did: "did:porchlight:susan",
        deviceId: "dev_1",
        payload: wrongPayload,
        signature,
      }),
    (error) => error.code === "E_SIGNATURE_INVALID",
  );

  await assert.rejects(
    () =>
      membership.verifyMemberWrite({
        networkId: "net_1",
        did: "did:porchlight:outsider",
        deviceId: "dev_1",
        payload,
        signature,
      }),
    (error) => error.code === "E_NOT_A_MEMBER",
  );
});

test("member revocation closes the perimeter instantly (open sessions die)", async () => {
  const { invites, membership } = fixture();
  const invite = await invites.issue({ networkId: "net_1" });
  const device = okp();
  const admitted = await membership.admit({
    code: invite.token,
    identityAccessToken: "did:porchlight:susan",
    deviceId: "dev_1",
    devicePublicKeyJwk: device.publicKeyJwk,
    signature: device.sign(`porchlight-join:${invite.token}`).toString("base64url"),
  });
  assert.ok(await membership.verifyAccessToken(admitted.accessToken));

  const revoked = await membership.revokeMember({ networkId: "net_1", did: "did:porchlight:susan" });
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.membership.state, "revoked");
  assert.equal(await membership.verifyAccessToken(admitted.accessToken), null);
});

test("repeat admission with another valid invite keeps one membership record", async () => {
  const { invites, membership, db } = fixture();
  for (const networkId of ["net_1", "net_1"]) {
    const invite = await invites.issue({ networkId });
    const device = okp();
    await membership.admit({
      code: invite.token,
      identityAccessToken: "did:porchlight:susan",
      deviceId: `dev_${networkId}`,
      devicePublicKeyJwk: device.publicKeyJwk,
      signature: device.sign(`porchlight-join:${invite.token}`).toString("base64url"),
    });
  }
  const rows = await db.collection("memberships").find({ did: "did:porchlight:susan" });
  assert.equal(rows.filter((row) => row.state === "active").length, 1);
});

test("session refresh rotates the access token inside the same network scope", async () => {
  const { invites, membership } = fixture();
  const invite = await invites.issue({ networkId: "net_1" });
  const device = okp();
  const admitted = await membership.admit({
    code: invite.token,
    identityAccessToken: "did:porchlight:susan",
    deviceId: "dev_1",
    devicePublicKeyJwk: device.publicKeyJwk,
    signature: device.sign(`porchlight-join:${invite.token}`).toString("base64url"),
  });

  const rotated = await membership.refresh({ refreshToken: admitted.refreshToken });
  assert.equal(rotated.networkId, "net_1");
  assert.notEqual(rotated.accessToken, admitted.accessToken);
  assert.ok(await membership.verifyAccessToken(rotated.accessToken, { networkId: "net_1" }));

  await assert.rejects(
    () => membership.refresh({ refreshToken: "bogus" }),
    (error) => error.code === "E_SESSION_REQUIRED",
  );
});

/* ---- owner-root rule (PORCH-015): ownership is the hub account's ------- */

test("owner-root rule: the network's ownerDid admits as owner regardless of invite role", async () => {
  const { db, invites, membership } = fixture();
  // The founder's hub identity is recorded on the network row at creation.
  await db.collection("networks").insertOne({
    _id: "net_1",
    name: "Family",
    ownerDid: "did:porchlight:owner",
    ownerAccountId: null,
    quota: { storageCeilingMb: null, retentionDays: null },
    createdAt: "2026-10-08T00:00:00.000Z",
  });
  const invite = await invites.issue({ networkId: "net_1", role: "member" });
  const device = okp();
  const admitted = await membership.admit({
    code: invite.token,
    identityAccessToken: "did:porchlight:owner",
    deviceId: "dev_1",
    devicePublicKeyJwk: device.publicKeyJwk,
    signature: device.sign(`porchlight-join:${invite.token}`).toString("base64url"),
  });
  // The invite's role never demotes the founder — the hub account proves it.
  assert.equal(admitted.membership.role, "owner");
});

test("owner-root rule: every other DID takes the invite's role", async () => {
  const { db, invites, membership } = fixture();
  await db.collection("networks").insertOne({
    _id: "net_1",
    name: "Family",
    ownerDid: "did:porchlight:owner",
    ownerAccountId: null,
    quota: { storageCeilingMb: null, retentionDays: null },
    createdAt: "2026-10-08T00:00:00.000Z",
  });
  const invite = await invites.issue({ networkId: "net_1", role: "member" });
  const device = okp();
  const admitted = await membership.admit({
    code: invite.token,
    identityAccessToken: "did:porchlight:susan",
    deviceId: "dev_1",
    devicePublicKeyJwk: device.publicKeyJwk,
    signature: device.sign(`porchlight-join:${invite.token}`).toString("base64url"),
  });
  assert.equal(admitted.membership.role, "member");
});

function canonical(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}
test("ac-2 (PORCH-010): membership sessions restore for the unchanged member on a re-bound device", async () => {
  const { invites, membership } = fixture();
  const invite = await invites.issue({ networkId: "net_1", role: "member" });
  const device = okp();
  await membership.admit({
    code: invite.token,
    identityAccessToken: "did:porchlight:susan",
    deviceId: "dev_1",
    devicePublicKeyJwk: device.publicKeyJwk,
    signature: device.sign(`porchlight-join:${invite.token}`).toString("base64url"),
  });

  // Re-bound device: identity proof in, network-scoped membership token out.
  const restored = await membership.restoreSession({ identityAccessToken: "did:porchlight:susan", deviceId: "dev_2" });
  assert.equal(restored.did, "did:porchlight:susan");
  assert.equal(restored.sessions.length, 1);
  assert.equal(restored.sessions[0].networkId, "net_1");
  assert.ok(restored.sessions[0].accessToken);

  // The restored token is exactly the admission scope: one network, never wide.
  const round = await membership.verifyAccessToken(restored.sessions[0].accessToken, { networkId: "net_1" });
  assert.ok(round?.membership);
  assert.equal(await membership.verifyAccessToken(restored.sessions[0].accessToken, { networkId: "net_other" }), null);
});

test("restore and admit carry the member's family-facing name — a re-bound device never masquerades as its device label (PORCH-034)", async () => {
  const { invites, membership } = fixture({
    memberNames: async (dids) => dids.map((did) => ({ did, displayName: did === "did:porchlight:susan" ? "Susan Hale" : null })),
  });
  const invite = await invites.issue({ networkId: "net_1", role: "member" });
  const device = okp();
  const admitted = await membership.admit({
    code: invite.token,
    identityAccessToken: "did:porchlight:susan",
    deviceId: "dev_1",
    devicePublicKeyJwk: device.publicKeyJwk,
    signature: device.sign(`porchlight-join:${invite.token}`).toString("base64url"),
  });
  assert.equal(admitted.name, "Susan Hale");

  const restored = await membership.restoreSession({ identityAccessToken: "did:porchlight:susan", deviceId: "dev_2" });
  assert.equal(restored.sessions.length, 1);
  assert.equal(restored.sessions[0].name, "Susan Hale");

  // An assembly with no name resolver renders nameless sessions — never invents one.
  const plain = fixture();
  const plainInvite = await plain.invites.issue({ networkId: "net_1", role: "member" });
  const plainDevice = okp();
  const plainAdmit = await plain.membership.admit({
    code: plainInvite.token,
    identityAccessToken: "did:porchlight:susan",
    deviceId: "dev_1",
    devicePublicKeyJwk: plainDevice.publicKeyJwk,
    signature: plainDevice.sign(`porchlight-join:${plainInvite.token}`).toString("base64url"),
  });
  assert.equal(plainAdmit.name, null);
  const plainRestored = await plain.membership.restoreSession({ identityAccessToken: "did:porchlight:susan", deviceId: "dev_3" });
  assert.equal(plainRestored.sessions[0].name, null);
});

test("ac-2 (PORCH-010): restore never widens the perimeter — no proof, no membership", async () => {
  const { invites, membership } = fixture();
  const invite = await invites.issue({ networkId: "net_1" });
  const device = okp();
  await membership.admit({
    code: invite.token,
    identityAccessToken: "did:porchlight:susan",
    deviceId: "dev_1",
    devicePublicKeyJwk: device.publicKeyJwk,
    signature: device.sign(`porchlight-join:${invite.token}`).toString("base64url"),
  });

  await assert.rejects(
    () => membership.restoreSession({ identityAccessToken: null }),
    (error) => error.code === "E_MUST_SIGN_IN",
  );
  await assert.rejects(
    () => membership.restoreSession({ identityAccessToken: "did:porchlight:stranger" }),
    (error) => error.code === "E_NOT_A_MEMBER",
  );

  // Revocation closes the perimeter instantly: restore rides live rows only.
  await membership.revokeMember({ networkId: "net_1", did: "did:porchlight:susan" });
  await assert.rejects(
    () => membership.restoreSession({ identityAccessToken: "did:porchlight:susan" }),
    (error) => error.code === "E_NOT_A_MEMBER",
  );
});

/* ---- founder-root binding (PORCH-018): bootstrap binds the owner -------- */

function founderNetworkRow() {
  return {
    _id: "net_1",
    name: "Family",
    ownerDid: "did:porchlight:owner",
    ownerAccountId: null,
    quota: { storageCeilingMb: null, retentionDays: null },
    createdAt: "2026-10-08T00:00:00.000Z",
  };
}

test("ac-1: bindFounder seeds the owner-role membership for the network owner", async () => {
  const { db, membership } = fixture();
  const network = founderNetworkRow();
  await db.collection("networks").insertOne(network);

  const bound = await membership.bindFounder({ network, did: "did:porchlight:owner" });
  assert.equal(bound.networkId, "net_1");
  assert.equal(bound.did, "did:porchlight:owner");
  assert.equal(bound.role, "owner");
  assert.equal(bound.state, "active");

  // Exactly one membership row exists, admitted without any invite.
  const rows = await db.collection("memberships").find({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].admittedViaInviteId, null);
});

test("ac-3: bindFounder is idempotent and binds nothing for a non-founder", async () => {
  const { db, membership } = fixture();
  const network = founderNetworkRow();
  await db.collection("networks").insertOne(network);

  const first = await membership.bindFounder({ network, did: "did:porchlight:owner" });
  const second = await membership.bindFounder({ network, did: "did:porchlight:owner" });
  assert.equal(second._id, first._id);
  assert.equal((await db.collection("memberships").find({})).length, 1);

  // A DID the network row does not record as its owner binds nothing, and
  // an ownerless network row (legacy shape) binds nothing either.
  assert.equal(await membership.bindFounder({ network, did: "did:porchlight:susan" }), null);
  assert.equal(await membership.bindFounder({ network, did: null }), null);
  assert.equal(await membership.bindFounder({ network: { ...network, ownerDid: null }, did: "did:porchlight:owner" }), null);
  assert.equal((await db.collection("memberships").find({})).length, 1);
});

test("ac-1/ac-2: restore re-binds a founder whose hub predates the binding and enrolls the presenting device", async () => {
  const deviceJwk = { kty: "OKP", crv: "Ed25519", x: "reg-public-key" };
  const { db, membership } = fixture({
    registeredDeviceKey: async (did, deviceId) =>
      did === "did:porchlight:owner" && deviceId === "dev_1" ? { publicKeyJwk: deviceJwk } : null,
  });
  // Legacy hub shape: network row recorded the owner, no membership row, and
  // the identity plane holds the founder's device registration.
  await db.collection("networks").insertOne(founderNetworkRow());
  await db.collection("device_registrations").insertOne({
    _id: "reg_1",
    did: "did:porchlight:owner",
    deviceId: "dev_1",
    publicKeyJwk: deviceJwk,
  });

  const restored = await membership.restoreSession({ identityAccessToken: "did:porchlight:owner", deviceId: "dev_1" });
  assert.equal(restored.did, "did:porchlight:owner");
  assert.equal(restored.sessions.length, 1);
  assert.equal(restored.sessions[0].networkId, "net_1");
  assert.equal(restored.sessions[0].role, "owner");

  // The presenting device's registered key enrolled for write verification.
  const keys = await db.collection("device_keys").find({ networkId: "net_1", did: "did:porchlight:owner" });
  assert.equal(keys.length, 1);
  assert.deepEqual(keys[0].publicKeyJwk, deviceJwk);

  // A non-founder device enrollment is untouched by the founder path.
  assert.equal((await db.collection("device_keys").find({ deviceId: "dev_x" })).length, 0);
});

test("verify carries the join link the invite names (PORCH-023 ac-2)", async () => {
  const { invites } = fixture();
  const named = await invites.issue({ networkId: "net_1", hubUrl: "https://home-1234.porchlight.example/" });
  const verified = await invites.verify(named.token);
  assert.equal(verified.valid, true);
  assert.equal(verified.invite.joinUrl, `https://home-1234.porchlight.example/join/${named.token}`);

  // No recorded hub URL: the invite names nothing, so nothing reads as a mismatch.
  const silent = await invites.issue({ networkId: "net_1" });
  const anonymous = await invites.verify(silent.token);
  assert.equal(anonymous.invite.joinUrl, `/join/${silent.token}`);
});

/* ---- member directory (PORCH-029) ---------------------------------------- */

test("ac-1: the directory joins membership rows with identity display names", async () => {
  const db = createMemoryStore();
  db.collection("memberships").insertOne({ _id: "mem_o", networkId: "net_1", did: "did:porch:owner", role: "owner", state: "active", admittedAt: "2026-10-09T10:00:00.000Z", revokedAt: null });
  db.collection("memberships").insertOne({ _id: "mem_m", networkId: "net_1", did: "did:porch:june", role: "member", state: "active", admittedAt: "2026-10-09T11:00:00.000Z", revokedAt: null });
  db.collection("memberships").insertOne({ _id: "mem_r", networkId: "net_1", did: "did:porch:gone", role: "member", state: "revoked", admittedAt: "2026-10-09T12:00:00.000Z", revokedAt: "2026-10-09T13:00:00.000Z" });
  const asked = [];
  const membership = new MembershipService({
    memberships: db.collection("memberships"),
    membershipSessions: db.collection("membership_sessions"),
    deviceKeys: db.collection("device_keys"),
    invites: new InviteService(db.collection("invites")),
    verifyMemberIdToken: async () => null,
    networks: db.collection("networks"),
    audit: async () => {},
    memberNames: async (dids) => {
      asked.push(...dids);
      return [
        { did: "did:porch:owner", displayName: "Brian Noah" },
        { did: "did:porch:june", displayName: "June Noah" },
      ];
    },
  });
  const views = await membership.listMemberViews({ networkId: "net_1" });
  const byDid = new Map(views.map((row) => [row.did, row]));
  assert.equal(byDid.get("did:porch:owner").name, "Brian Noah");
  assert.equal(byDid.get("did:porch:june").name, "June Noah");
  // A membership whose identity row disappeared renders without a name.
  assert.equal(byDid.get("did:porch:gone").name, null);
  // Join state stays the membership row's own: role + active/revoked + dates.
  assert.equal(byDid.get("did:porch:owner").role, "owner");
  assert.equal(byDid.get("did:porch:june").state, "active");
  assert.equal(byDid.get("did:porch:gone").state, "revoked");
  assert.equal(byDid.get("did:porch:gone").revokedAt, "2026-10-09T13:00:00.000Z");
  // Only this network's member DIDs ride the boundary callback.
  assert.deepEqual([...asked].sort(), ["did:porch:gone", "did:porch:june", "did:porch:owner"]);
  // The join row keeps its public shape; private key material never appears.
  assert.ok(byDid.get("did:porch:june"));
  assert.ok(!("publicKeyJwk" in byDid.get("did:porch:june")));
  assert.ok(!("deviceId" in byDid.get("did:porch:june")));
});

test("ac-1: an assembly without the name resolver keeps the directory working", async () => {
  const { membership } = fixture();
  await membership.memberships.insertOne({ _id: "mem_1", networkId: "net_1", did: "did:porch:owner", role: "owner", state: "active", admittedAt: "2026-10-09T10:00:00.000Z", revokedAt: null });
  const views = await membership.listMemberViews({ networkId: "net_1" });
  assert.equal(views.length, 1);
  assert.equal(views[0].name, null);
  assert.equal(views[0].role, "owner");
  assert.equal(views[0].state, "active");
});

/* ---- member re-bind enrollment (PORCH-048) -------------------------------- */

/**
 * Fixture with the full re-bind shape: Susan admitted via her laptop through
 * the real invite path (the admitting device's enrollment is the baseline),
 * plus an identity-plane device_registrations stand-in with the active-only
 * resolution AuthService.activeDeviceRegistration implements — a revoked row
 * resolves to nothing.
 */
async function rebindFixture(registrationStatus = "active") {
  const { db, invites, membership } = fixture();
  const invite = await invites.issue({ networkId: "net_1", role: "member" });
  const laptop = okp();
  await membership.admit({
    code: invite.token,
    identityAccessToken: "did:porchlight:susan",
    deviceId: "dev_laptop",
    devicePublicKeyJwk: laptop.publicKeyJwk,
    signature: laptop.sign(`porchlight-join:${invite.token}`).toString("base64url"),
  });

  // Identity plane: the owner-routed device link (or pairing code) bound the
  // fresh browser device. Private identity detail (createdBy, label) is
  // irrelevant here — only did + deviceId + status + public key resolve.
  const bindings = db.collection("device_registrations");
  await bindings.insertOne({ _id: "reg_laptop", did: "did:porchlight:susan", deviceId: "dev_laptop", publicKeyJwk: laptop.publicKeyJwk, status: "active", revokedAt: null });
  const phone = okp();
  await bindings.insertOne({
    _id: "reg_phone",
    did: "did:porchlight:susan",
    deviceId: "dev_phone",
    publicKeyJwk: phone.publicKeyJwk,
    status: registrationStatus,
    revokedAt: registrationStatus === "active" ? null : "2026-10-10T00:00:00.000Z",
  });
  membership.registeredDeviceKey = async (did, deviceId) =>
    bindings.findOne({ did, deviceId, status: "active" });
  return { db, membership, phone };
}

test("PORCH-048: a member device re-bound by device link or pairing re-credentials its write enrollment at restore, and the write verifies", async () => {
  const { db, membership, phone } = await rebindFixture();

  // The re-bound device's re-credential: identity proof in, session + the
  // per-network device key enrollment out.
  const restored = await membership.restoreSession({ identityAccessToken: "did:porchlight:susan", deviceId: "dev_phone" });
  assert.equal(restored.did, "did:porchlight:susan");
  assert.equal(restored.sessions.length, 1);
  assert.equal(restored.sessions[0].networkId, "net_1");

  const enrolled = await db.collection("device_keys").findOne({ networkId: "net_1", did: "did:porchlight:susan", deviceId: "dev_phone" });
  assert.deepEqual(enrolled.publicKeyJwk, phone.publicKeyJwk, "the active registration's key is the enrollment copy");
  // The admit-time enrollment for the other device is untouched.
  assert.equal((await db.collection("device_keys").find({ did: "did:porchlight:susan" })).length, 2);

  // The written payload verifies under the same verifyMemberWrite contract
  // as every origin write (post, comment, reaction, vote), signed by the
  // re-bound device's own key.
  const payload = { type: "text", body: "hello from the re-bound device", networkId: "net_1" };
  const write = await membership.verifyMemberWrite({
    networkId: "net_1",
    did: "did:porchlight:susan",
    deviceId: "dev_phone",
    payload,
    signature: phone.sign(canonicalJson(payload)).toString("base64url"),
  });
  assert.equal(write.verified, true);
  assert.equal(write.membership.did, "did:porchlight:susan");

  // Origin containment: the restored session is scoped to exactly the
  // membership's own network.
  assert.equal(restored.sessions[0].networkId, "net_1");
});

test("PORCH-048: a revoked device registration loses enrollment — restore enrolls nothing and the write is refused", async () => {
  const { db, membership, phone } = await rebindFixture("revoked");

  // The membership session still restores (reads keep working); the dead
  // registration produces no enrollment, so the write plane stays closed.
  const restored = await membership.restoreSession({ identityAccessToken: "did:porchlight:susan", deviceId: "dev_phone" });
  assert.equal(restored.sessions.length, 1);
  assert.equal((await db.collection("device_keys").find({ deviceId: "dev_phone" })).length, 0, "no resurrection of revoked keys");

  // No key, no write — the same typed error the admitting-device path uses.
  const payload = { type: "text", body: "should not verify", networkId: "net_1" };
  await assert.rejects(
    () =>
      membership.verifyMemberWrite({
        networkId: "net_1",
        did: "did:porchlight:susan",
        deviceId: "dev_phone",
        payload,
        signature: phone.sign(canonicalJson(payload)).toString("base64url"),
      }),
    (error) => error.code === "E_DEVICE_NOT_ENROLLED",
  );
});
