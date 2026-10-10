import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { createMemoryStore } from "@porchlight/shared";
import { InviteService } from "../src/services/invite.service.js";
import { MembershipService } from "../src/services/membership.service.js";
import { NetworkService } from "../src/services/network.service.js";
import { ConsoleController } from "../src/controllers/console.controller.js";

/**
 * PORCH-019 ac-1: auth-failure capture on the membership plane. Every
 * captured 401 must carry the failing step (reason) plus the session/device
 * identity state, and must never carry token material.
 */

function fixture({ sink = () => {} } = {}) {
  const db = createMemoryStore();
  const invites = new InviteService(db.collection("invites"));
  const membership = new MembershipService({
    memberships: db.collection("memberships"),
    membershipSessions: db.collection("membership_sessions"),
    deviceKeys: db.collection("device_keys"),
    invites,
    verifyMemberIdToken: async (token) => (token ? { did: token } : null),
    networks: db.collection("networks"),
    audit: async () => {},
    registeredDeviceKey: null,
    authFailureSink: sink,
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

async function admitted(fixture_, networkId = "net_1") {
  const invite = await fixture_.invites.issue({ networkId, role: "owner" });
  const device = okp();
  const signature = device.sign(`porchlight-join:${invite.token}`).toString("base64url");
  const { membership } = fixture_;
  return membership.admit({
    code: invite.token,
    identityAccessToken: "did:porchlight:owner",
    deviceId: "dev_1",
    devicePublicKeyJwk: device.publicKeyJwk,
    signature,
  });
}

function stubRes() {
  const calls = [];
  return {
    calls,
    status(n) { calls.push(["status", n]); return { json(body) { calls.push(["json", body]); return body; } }; },
  };
}

function stubReq({ token, method = "GET", url = "/unknown" } = {}) {
  return {
    method,
    originalUrl: url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
}

test("ac-1 capture: membership token failure names the failing step and session/device state", async () => {
  const captured = [];
  const f = fixture({ sink: (event) => captured.push(event) });
  const admittedRow = await admitted(f);
  const token = admittedRow.accessToken;

  // Valid token: no capture.
  assert.deepEqual(await f.membership.diagnoseAccessToken(token), null);
  assert.equal(captured.length, 0);

  // Unknown token.
  const unknown = await f.membership.diagnoseAccessToken("not-a-token");
  assert.equal(unknown.reason, "unknown_token");

  // Expired access token: the 10-minute TTL step.
  const sessionRow = (await f.db.collection("membership_sessions").find({}))[0];
  await f.db.collection("membership_sessions").updateOne(
    { _id: sessionRow._id },
    { $set: { accessExpiresAt: new Date(Date.now() - 1000).toISOString() } },
  );
  const expired = await f.membership.diagnoseAccessToken(token);
  assert.equal(expired.reason, "expired_access_token");
  assert.equal(expired.did, "did:porchlight:owner");
  assert.equal(expired.deviceId, "dev_1");
  assert.equal(expired.sessionStatus, "active");
  assert.ok(expired.accessExpiresAt);

  // The membership-plane kill switch rides revoke: the step after expiry.
  // The revocation target is a plain member — the final-owner invariant
  // (PORCH-053) rightly refuses revoking the sole owner, so the fixture
  // admits one and revokes THAT member for the step diagnosis.
  const memberInvite = await f.invites.issue({ networkId: "net_1" });
  const memberDevice = okp();
  const memberAdmitted = await f.membership.admit({
    code: memberInvite.token,
    identityAccessToken: "did:porchlight:june",
    deviceId: "dev_2",
    devicePublicKeyJwk: memberDevice.publicKeyJwk,
    signature: memberDevice.sign(`porchlight-join:${memberInvite.token}`).toString("base64url"),
  });
  await f.membership.revokeMember({ networkId: "net_1", did: "did:porchlight:june" });
  const revoked = await f.membership.diagnoseAccessToken(memberAdmitted.accessToken);
  assert.equal(revoked.reason, "session_revoked");
  assert.equal(revoked.sessionStatus, "revoked");
  assert.equal(revoked.did, "did:porchlight:june");

  // No token material in any diagnosis.
  for (const event of [...captured, unknown, expired, revoked]) {
    if (!event) continue;
    assert.ok(!JSON.stringify(event).includes(token));
    assert.ok(!JSON.stringify(event).includes(memberAdmitted.accessToken));
  }
});

test("ac-1 capture: member-surface verifyAccessToken failure rides the auth-failure sink exactly once", async () => {
  const captured = [];
  const f = fixture({ sink: (event) => captured.push(event) });
  const admittedRow = await admitted(f);
  const staleToken = admittedRow.accessToken;
  // Expire the access token; the feed reads keep presenting it (client burst).
  const row = (await f.db.collection("membership_sessions").find({}))[0];
  await f.db.collection("membership_sessions").updateOne(
    { _id: row._id },
    { $set: { accessExpiresAt: new Date(Date.now() - 1000).toISOString() } },
  );

  const missed = await f.membership.verifyAccessToken(staleToken, { surface: "feed" });
  assert.equal(missed, null);
  assert.equal(captured.length, 1);
  const event = captured[0];
  assert.equal(event.endpoint, "feed");
  assert.equal(event.code, "E_SESSION_REQUIRED");
  assert.equal(event.reason, "expired_access_token");
  assert.equal(event.did, "did:porchlight:owner");
  assert.equal(event.deviceId, "dev_1");
  assert.equal(event.sessionId, row._id);
  assert.ok(!JSON.stringify(event).includes(staleToken));

  // Console-guard-shaped call (networkId, no surface): no capture here — the
  // console/frontdoor guards capture with the HTTP endpoint instead.
  const before = captured.length;
  await f.membership.verifyAccessToken(staleToken, { networkId: "net_1" });
  assert.equal(captured.length, before);
});

test("ac-1 capture: refresh renewal failure names its step", async () => {
  const f = fixture();
  const admittedRow = await admitted(f);
  const refreshToken = admittedRow.refreshToken;

  assert.equal(await f.membership.diagnoseRefreshToken(refreshToken), null);

  const row = (await f.db.collection("membership_sessions").find({}))[0];
  await f.db.collection("membership_sessions").updateOne(
    { _id: row._id },
    { $set: { refreshExpiresAt: new Date(Date.now() - 1000).toISOString() } },
  );
  const diagnosis = await f.membership.diagnoseRefreshToken(refreshToken);
  assert.equal(diagnosis.reason, "expired_refresh_token");
  assert.equal(diagnosis.sessionId, row._id);
  assert.equal(diagnosis.did, "did:porchlight:owner");

  const unknownDiagnosis = await f.membership.diagnoseRefreshToken("not-a-refresh");
  assert.equal(unknownDiagnosis.reason, "unknown_token");
});

test("ac-1 capture: console guard 401 carries the HTTP endpoint and membership diagnosis", async () => {
  const captured = [];
  const f = fixture({ sink: (event) => captured.push(event) });
  const admittedRow = await admitted(f);
  const staleToken = admittedRow.accessToken;
  const row = (await f.db.collection("membership_sessions").find({}))[0];
  await f.db.collection("membership_sessions").updateOne(
    { _id: row._id },
    { $set: { accessExpiresAt: new Date(Date.now() - 1000).toISOString() } },
  );

  const consoleController = new ConsoleController({
    networks: new NetworkService(f.db.collection("networks")),
    invites: f.invites,
    membership: f.membership,
    quota: null,
    audit: f.membership.audit,
    groups: null,
    ranking: null,
    media: null,
    system: null,
    hubUrl: null,
    log: (line) => captured.push(line),
  });
  const res = stubRes();
  const outcome = await consoleController.listInvites(
    stubReq({ token: staleToken, method: "GET", url: "/api/social/console/invites" }),
    res,
  );

  assert.ok(outcome === undefined || outcome === null);
  const status = res.calls.find(([k]) => k === "status");
  assert.deepEqual(status, ["status", 401]);
  const body = res.calls.find(([k]) => k === "json");
  assert.deepEqual(body[1].code, "E_SESSION_REQUIRED");
  assert.equal(captured.length, 1);
  const event = JSON.parse(captured[0].split("hub: auth-failure ")[1]);
  assert.equal(event.endpoint, "GET /api/social/console/invites");
  assert.equal(event.reason, "expired_access_token");
  assert.equal(event.did, "did:porchlight:owner");
  assert.ok(!JSON.stringify(event).includes(staleToken));
});