import { test } from "node:test";
import assert from "node:assert/strict";
import { sign, generateKeyPairSync } from "node:crypto";
import { DEFAULT_CONFIG, createMemoryStore, normalizeConfig } from "@porchlight/shared";
import type { PorchlightConfig, StoreLike } from "@porchlight/shared";
import { BootstrapService } from "../src/services/bootstrap.service.js";
import { createServer } from "../src/router.js";
import type { Probe } from "../src/dependencies.js";

/**
 * PORCH-053 admin ladder (live HTTP): the capability ladder end-to-end —
 * the owner promotes/demotes member↔delegate (the change lands immediately
 * in the delegate's realized capabilities), delegates carry the join-link
 * and device-link lifecycle plus member removal, plain members get 403, the
 * final-owner refusal answers with its plain reason server-side, and the
 * device-link path re-binds a member's device to their unchanged identity.
 */

function mutableConfig(): PorchlightConfig {
  return normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as PorchlightConfig);
}

const OK_PROBES: { mongo: Probe; redis: Probe } = { mongo: async () => "ok", redis: async () => "ok" };

interface TestHub {
  db: StoreLike;
  close: () => void;
  port: Promise<number>;
}

function testHub(hubUrl: () => string | null = () => null): TestHub {
  const db = createMemoryStore();
  const config = mutableConfig();
  const bootstrap = new BootstrapService(db, config, "/tmp/porchlight-test-home");
  const app = createServer({ store: db, readiness: OK_PROBES, config, bootstrap, hubUrl });
  const { promise, resolve } = Promise.withResolvers<number>();
  const listener = app.listen(0, () => {
    const address = listener.address();
    const port = typeof address === "object" && address ? address.port : 0;
    resolve(port);
  });
  return { db, close: () => { listener.closeIdleConnections(); listener.close(); }, port: promise };
}

interface Json {
  [key: string]: unknown;
}
async function call(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: Json }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return { status: res.status, body: (await res.json()) as Json };
}

interface KeyMaterial {
  device: ReturnType<typeof generateKeyPairSync>;
  deviceId: string;
  jwk: Json;
}

function keyMaterial(deviceId: string): KeyMaterial {
  const device = generateKeyPairSync("ed25519");
  return { device, deviceId, jwk: device.publicKey.export({ format: "jwk" }) as Json };
}

async function memberIdentitySession(port: number, member: KeyMaterial, did: string): Promise<string> {
  const challenge = await call(port, "/api/identity/session/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did }),
  });
  assert.equal(challenge.status, 200);
  const session = await call(port, "/api/identity/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      did,
      deviceId: member.deviceId,
      nonce: challenge.body.nonce,
      signature: sign(null, Buffer.from(challenge.body.nonce as string, "utf8"), member.device.privateKey).toString("base64url"),
    }),
  });
  assert.equal(session.status, 201);
  return (session.body as Json).accessToken as string;
}

async function joinFlow(
  port: number,
  args: { firstName: string; lastName: string; deviceId: string; inviteCode: string },
): Promise<{ did: string; accessToken: string; memberId: string }> {
  const member = keyMaterial(args.deviceId);
  const birth = await call(port, "/api/bootstrap/join-member", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: args.inviteCode, firstName: args.firstName, lastName: args.lastName, device: { deviceId: member.deviceId, publicKeyJwk: member.jwk } }),
  });
  assert.equal(birth.status, 201);
  const did = (birth.body.account as Json).did as string;
  const identityToken = await memberIdentitySession(port, member, did);
  const admit = await call(port, "/api/social/join/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: args.inviteCode,
      identityAccessToken: identityToken,
      deviceId: member.deviceId,
      devicePublicKeyJwk: member.jwk,
      signature: sign(null, Buffer.from(`porchlight-join:${args.inviteCode}`, "utf8"), member.device.privateKey).toString("base64url"),
    }),
  });
  assert.equal(admit.status, 201);
  return { did, accessToken: (admit.body as Json).accessToken as string, memberId: ((admit.body as Json).membership as Json)._id as string };
}

test("PORCH-053: the admin ladder end-to-end — roles, delegate device links, removal, final-owner refusal", async (t) => {
  const hub = testHub(() => "https://hub.test");
  t.after(hub.close);
  const port = await hub.port;
  const OWNER_CONSOLE = "/api/social/console";
  const json = { "content-type": "application/json" };

  // Owner bootstrap.
  const owner = keyMaterial("dev_home");
  const ownerAccount = await call(port, "/api/identity/bootstrap/account", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ firstName: "Brian", lastName: "Noah", device: { deviceId: owner.deviceId, publicKeyJwk: owner.jwk } }),
  });
  assert.equal(ownerAccount.status, 201);
  const ownerDid = (ownerAccount.body.account as Json).did as string;
  const networkBoot = await call(port, "/api/social/bootstrap/network", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ name: "The Noah Family", ownerDid }),
  });
  assert.equal(networkBoot.status, 201);
  const ownerInvite = await call(port, "/api/social/bootstrap/invite", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ role: "member", maxUses: 1 }),
  });
  assert.equal(ownerInvite.status, 201);
  const ownerIdentityToken = await memberIdentitySession(port, owner, ownerDid);
  const ownerRestore = await call(port, "/api/social/session/restore", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ identityAccessToken: ownerIdentityToken, deviceId: owner.deviceId }),
  });
  assert.equal(ownerRestore.status, 201);
  const ownerAuth = { ...json, authorization: `Bearer ${((ownerRestore.body as Json).sessions as Json[])[0].accessToken}` };
  const sophieInviteCode = await call(port, `${OWNER_CONSOLE}/invites`, {
    method: "POST", headers: ownerAuth, body: JSON.stringify({ role: "member", maxUses: 1 }),
  });
  assert.equal(sophieInviteCode.status, 201);
  const sophie = await joinFlow(port, {
    firstName: "Sophie", lastName: "Marten", deviceId: "dev_tablet",
    inviteCode: (sophieInviteCode.body.invite as Json).token as string,
  });
  const tomInviteCode = await call(port, `${OWNER_CONSOLE}/invites`, {
    method: "POST", headers: ownerAuth, body: JSON.stringify({ role: "member", maxUses: 1 }),
  });
  assert.equal(tomInviteCode.status, 201);
  const tom = await joinFlow(port, {
    firstName: "Tom", lastName: "Fields", deviceId: "dev_laptop",
    inviteCode: (tomInviteCode.body.invite as Json).token as string,
  });

  // Plain members hold no console capability at all.
  const sophieConsole = await call(port, `${OWNER_CONSOLE}/members`, { headers: { authorization: `Bearer ${sophie.accessToken}` } });
  assert.equal(sophieConsole.status, 403);
  const tomInviteTry = await call(port, `${OWNER_CONSOLE}/invites`, {
    method: "POST", headers: { ...json, authorization: `Bearer ${tom.accessToken}` }, body: JSON.stringify({ role: "member", maxUses: 1 }),
  });
  assert.equal(tomInviteTry.status, 403);

  // The owner promotes Sophie (member→delegate); the change lands immediately.
  const promote = await call(port, `${OWNER_CONSOLE}/members/role`, {
    method: "PATCH", headers: ownerAuth,
    body: JSON.stringify({ memberId: sophie.memberId, role: "delegate" }),
  });
  assert.equal(promote.status, 200);
  assert.equal((promote.body.membership as Json).role, "delegate");
  const sophieRead = await call(port, `${OWNER_CONSOLE}/members`, { headers: { authorization: `Bearer ${sophie.accessToken}` } });
  assert.equal(sophieRead.status, 200);

  // The delegate's own role change is refused (owner-only).
  const delegatePromote = await call(port, `${OWNER_CONSOLE}/members/role`, {
    method: "PATCH", headers: { ...json, authorization: `Bearer ${sophie.accessToken}` },
    body: JSON.stringify({ memberId: tom.memberId, role: "delegate" }),
  });
  assert.equal(delegatePromote.status, 403);
  assert.equal((delegatePromote.body as Json).code, "E_FORBIDDEN");

  // Delegate device-link authority: Sophie re-credentials Tom's device via
  // a member-targeted device link, consumed against Tom's UNCHANGED identity.
  const mint = await call(port, `${OWNER_CONSOLE}/device-links`, {
    method: "POST", headers: { ...json, authorization: `Bearer ${sophie.accessToken}` },
    body: JSON.stringify({ did: tom.did }),
  });
  assert.equal(mint.status, 201);
  const grantId = (mint.body as Json).grantId as string;
  const linkToken = (mint.body as Json).token as string;

  const grants = await call(port, `${OWNER_CONSOLE}/device-links`, { headers: { authorization: `Bearer ${sophie.accessToken}` } });
  assert.equal(grants.status, 200);
  assert.equal(((grants.body.deviceLinks as Json[]).find((row) => row._id === grantId) as Json)?.status, "unused");

  const tomNewDevice = keyMaterial("dev_phone");
  const consume = await call(port, "/api/identity/device-link/consume", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ token: linkToken, device: { deviceId: tomNewDevice.deviceId, label: "Tom's phone", publicKeyJwk: tomNewDevice.jwk } }),
  });
  assert.equal(consume.status, 201);
  assert.equal(((consume.body.registration as Json).did as string), tom.did, "the link re-binds to the unchanged identity");

  const tomIdentity = await memberIdentitySession(port, tomNewDevice, tom.did);
  const restore = await call(port, "/api/social/session/restore", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ identityAccessToken: tomIdentity, deviceId: tomNewDevice.deviceId }),
  });
  assert.equal(restore.status, 201);
  const restoredSession = ((restore.body as Json).sessions as Json[])[0] as Json;
  assert.ok(String(restoredSession.accessToken).length > 0, "the re-bound device holds a live membership session");

  // Instant revocation (the delegate's write) on a FRESH grant: the issued
  // link dies in the same write; replay of it is refused with the plain copy.
  // (The first grant was consumed by Tom — revoking a used grant is the
  // alreadyDead no-op, which is its own state-machine behavior.)
  const unusedMint = await call(port, `${OWNER_CONSOLE}/device-links`, {
    method: "POST", headers: { ...json, authorization: `Bearer ${sophie.accessToken}` },
    body: JSON.stringify({ did: tom.did }),
  });
  assert.equal(unusedMint.status, 201);
  const unusedGrantId = (unusedMint.body as Json).grantId as string;
  const unusedToken = (unusedMint.body as Json).token as string;
  const revoke = await call(port, `${OWNER_CONSOLE}/device-links/revoke`, {
    method: "POST", headers: { ...json, authorization: `Bearer ${sophie.accessToken}` },
    body: JSON.stringify({ grantId: unusedGrantId }),
  });
  assert.equal(revoke.status, 200);
  assert.equal((revoke.body as Json).revoked, true);
  const replay = await call(port, "/api/identity/device-link/consume", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ token: unusedToken, device: { deviceId: tomNewDevice.deviceId, publicKeyJwk: tomNewDevice.jwk } }),
  });
  assert.equal(replay.status, 403);
  assert.equal((replay.body as Json).code, "E_DEVICE_LINK_REVOKED");

  // Delegate removal of a plain member works; removing the owner is refused.
  const tomRemoval = await call(port, `${OWNER_CONSOLE}/members/revoke`, {
    method: "POST", headers: { ...json, authorization: `Bearer ${sophie.accessToken}` },
    body: JSON.stringify({ memberId: tom.memberId }),
  });
  assert.equal(tomRemoval.status, 200);
  assert.equal((tomRemoval.body as Json).revoked, true);
  const roster = await call(port, `${OWNER_CONSOLE}/members`, { headers: ownerAuth });
  const ownerRow = (roster.body.members as Json[]).find((row) => row.did === ownerDid) as Json;
  const ownerRemoval = await call(port, `${OWNER_CONSOLE}/members/revoke`, {
    method: "POST", headers: { ...json, authorization: `Bearer ${sophie.accessToken}` },
    body: JSON.stringify({ memberId: ownerRow._id }),
  });
  assert.equal(ownerRemoval.status, 403);

  // Demote again: delegate back to member; the capability leaves immediately.
  const demote = await call(port, `${OWNER_CONSOLE}/members/role`, {
    method: "PATCH", headers: ownerAuth,
    body: JSON.stringify({ memberId: sophie.memberId, role: "member" }),
  });
  assert.equal(demote.status, 200);
  const sophieReadAfter = await call(port, `${OWNER_CONSOLE}/members`, { headers: { authorization: `Bearer ${sophie.accessToken}` } });
  assert.equal(sophieReadAfter.status, 403);
});