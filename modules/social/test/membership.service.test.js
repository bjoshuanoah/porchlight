import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { createMemoryStore } from "@porchlight/shared";
import { InviteService } from "../src/services/invite.service.js";
import { MembershipService } from "../src/services/membership.service.js";

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
