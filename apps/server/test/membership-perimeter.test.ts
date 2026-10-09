import { test } from "node:test";
import assert from "node:assert/strict";
import { sign, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { DEFAULT_CONFIG, createMemoryStore, normalizeConfig } from "@porchlight/shared";
import type { PorchlightConfig, StoreLike } from "@porchlight/shared";
import { BootstrapService } from "../src/services/bootstrap.service.js";
import { createServer } from "../src/router.js";
import type { Probe } from "../src/dependencies.js";

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

test("membership perimeter: join link verifies, admission issues a network-scoped token, console sees audit (contract)", async (t) => {
  const hub = testHub(() => "https://hub.test");
  t.after(hub.close);
  const port = await hub.port;

  // Member identity: account + device key + identity session (PORCH-004 core).
  const device = generateKeyPairSync("ed25519");
  const publicKeyJwk = device.publicKey.export({ format: "jwk" });
  const account = await call(port, "/api/identity/bootstrap/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Susan", device: { deviceId: "dev_phone", publicKeyJwk } }),
  });
  assert.equal(account.status, 201);
  const did = (account.body.account as Json).did as string;

  const challenge = await call(port, "/api/identity/session/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did }),
  });
  assert.equal(challenge.status, 200);
  const signature = sign(null, Buffer.from(challenge.body.nonce as string, "utf8"), device.privateKey).toString("base64url");
  const session = await call(port, "/api/identity/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did, deviceId: "dev_phone", nonce: challenge.body.nonce, signature }),
  });
  assert.equal(session.status, 201);
  const identityToken = (session.body as Json).accessToken as string;

  // Owner: bootstrap network + join-link invite (URL embeds the code). The
  // network carries the founder rule — the owner identity from the first
  // account is the hub owner, proven by the hub account, never the invite.
  const network = await call(port, "/api/social/bootstrap/network", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Brian's Family", ownerDid: did }),
  });
  assert.equal(network.status, 201);
  const invite = await call(port, "/api/social/bootstrap/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "member", maxUses: 1 }),
  });
  assert.equal(invite.status, 201);
  const inviteObj = invite.body.invite as Json;
  assert.ok(inviteObj);
  const joinUrl = invite.body.joinUrl as string;
  assert.match(joinUrl, /^https:\/\/hub\.test\/join\//);
  const code = joinUrl.split("/join/")[1];
  assert.ok(code);

  // Public front-door verification of the join link.
  const verification = await call(port, `/api/social/join/verify?code=${encodeURIComponent(code)}`);
  assert.equal(verification.status, 200);
  assert.equal(verification.body.valid, true);
  const networkView = verification.body.network as Json;
  assert.equal(networkView.name, "Brian's Family");

  // Admission: server URL + invite code + device-signed request → scoped
  // token. The owner identity admits through the first join invite; the
  // founder rule forces the admitted role to "owner" (hub account proves
  // ownership, not the invite).
  const admit = await call(port, "/api/social/join/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      identityAccessToken: identityToken,
      deviceId: "dev_phone",
      devicePublicKeyJwk: publicKeyJwk,
      signature: sign(null, Buffer.from(`porchlight-join:${code}`, "utf8"), device.privateKey).toString("base64url"),
    }),
  });
  assert.equal(admit.status, 201);
  const membership = admit.body.membership as Json;
  assert.ok(membership.networkId);
  assert.equal(membership.role, "owner");
  const admitToken = (admit.body as Json).accessToken as string;
  assert.equal(typeof admitToken === "string" && admitToken.length >= 32, true);

  // Refresh rotates the access token inside the same network scope; the
  // rotated token is the live console credential.
  const refresh = await call(port, "/api/social/session/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: (admit.body as Json).refreshToken }),
  });
  assert.equal(refresh.status, 200);
  const ownerToken = (refresh.body as Json).accessToken as string;
  assert.notEqual(ownerToken, admitToken);
  const ownerAuth = { "content-type": "application/json", authorization: `Bearer ${ownerToken}` };

  // A second member joins through the owner console's invite (the bootstrap
  // invite era closed once the first join invite completed). The member
  // identity is seeded directly in the identity store: first-account
  // creation is owner-gated, so a second member arrives with its own device
  // — the same shape the admission device proves against.
  const memberDevice = generateKeyPairSync("ed25519");
  const memberKeyJwk = memberDevice.publicKey.export({ format: "jwk" });
  const memberDid = `did:porch:${randomBytes(20).toString("hex")}`;
  await hub.db.collection("identities").insertOne({
    _id: `ident_${randomUUID()}`,
    did: memberDid,
    actorType: "human",
    displayName: "Tom",
    email: null,
    handle: null,
    profile: {},
    homingStatus: "home",
    migratedToIssuer: null,
    createdAt: new Date().toISOString(),
  });
  await hub.db.collection("device_registrations").insertOne({
    _id: `reg_${randomUUID()}`,
    did: memberDid,
    deviceId: "dev_laptop",
    label: null,
    publicKeyJwk: memberKeyJwk,
    createdBy: "agent",
    status: "active",
    revokedAt: null,
    createdAt: new Date().toISOString(),
  });
  const memberChallenge = await call(port, "/api/identity/session/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did: memberDid }),
  });
  const memberSession = await call(port, "/api/identity/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      did: memberDid,
      deviceId: "dev_laptop",
      nonce: memberChallenge.body.nonce,
      signature: sign(null, Buffer.from(memberChallenge.body.nonce as string, "utf8"), memberDevice.privateKey).toString("base64url"),
    }),
  });
  assert.equal(memberSession.status, 201);
  const memberIdentityToken = (memberSession.body as Json).accessToken as string;

  const consoleInvite = await call(port, "/api/social/console/invites", {
    method: "POST",
    headers: ownerAuth,
    body: JSON.stringify({ role: "member", maxUses: 1 }),
  });
  assert.equal(consoleInvite.status, 201);
  const memberCode = (consoleInvite.body.invite as Json).token as string;
  const memberAdmit = await call(port, "/api/social/join/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: memberCode,
      identityAccessToken: memberIdentityToken,
      deviceId: "dev_laptop",
      devicePublicKeyJwk: memberKeyJwk,
      signature: sign(null, Buffer.from(`porchlight-join:${memberCode}`, "utf8"), memberDevice.privateKey).toString("base64url"),
    }),
  });
  assert.equal(memberAdmit.status, 201);
  assert.equal((memberAdmit.body.membership as Json).role, "member");
  const memberToken = (memberAdmit.body as Json).accessToken as string;
  const memberAuth = { "content-type": "application/json", authorization: `Bearer ${memberToken}` };

  // Owner console: invite now shows a consumed state, the member is listed,
  // and the admission audited as a member login.
  const invites = await call(port, "/api/social/console/invites", { headers: ownerAuth });
  assert.equal(invites.status, 200);
  assert.equal((invites.body.invites as Json[])[0].status, "used");

  const members = await call(port, "/api/social/console/members", { headers: ownerAuth });
  assert.equal(members.status, 200);
  assert.equal((members.body.members as Json[]).length, 2);
  assert.ok((members.body.members as Json[]).some((entry) => entry.did === did));

  const audit = await call(port, "/api/social/console/audit", { headers: ownerAuth });
  assert.equal(audit.status, 200);
  const actions = (audit.body.events as Json[]).map((event) => event.action);
  assert.ok(actions.includes("login"));

  // The console stays closed to anonymous and non-owner members; owner is the
  // founder identity, never a mere invite role.
  const anon = await call(port, "/api/social/console/invites");
  assert.equal(anon.status, 401);
  assert.equal(anon.body.code, "E_SESSION_REQUIRED");
  const asMember = await call(port, "/api/social/console/members", { headers: memberAuth });
  assert.equal(asMember.status, 403);
  assert.equal(asMember.body.code, "E_FORBIDDEN");
  const memberLimits = await call(port, "/api/social/console/limits", { headers: memberAuth });
  assert.equal(memberLimits.status, 403);

  // Owner sets quantity-only limits; unset-before is reported, set-after holds.
  const before = await call(port, "/api/social/console/limits", { headers: ownerAuth });
  assert.equal(before.status, 200);
  assert.equal((before.body.quota as Json).storageCeilingMb, null);
  const set = await call(port, "/api/social/console/limits", {
    method: "PUT",
    headers: ownerAuth,
    body: JSON.stringify({ storageCeilingMb: 1024, retentionDays: 30 }),
  });
  assert.equal(set.status, 200);
  const after = await call(port, "/api/social/console/limits", { headers: ownerAuth });
  assert.equal((after.body.quota as Json).storageCeilingMb, 1024);
  const sweep = await call(port, "/api/social/console/retention/sweep", { method: "POST", headers: ownerAuth });
  assert.equal(sweep.status, 200);
  assert.equal(sweep.body.swept, 0);
})

test("revoked join link fails member entry instantly with plain language (contract)", async (t) => {
  const hub = testHub();
  t.after(hub.close);
  const port = await hub.port;

  // Owner identity + network (founder rule) + first join invite → owner token.
  const device = generateKeyPairSync("ed25519");
  const publicKeyJwk = device.publicKey.export({ format: "jwk" });
  const account = await call(port, "/api/identity/bootstrap/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Brian", device: { deviceId: "dev_phone", publicKeyJwk } }),
  });
  assert.equal(account.status, 201);
  const did = (account.body.account as Json).did as string;
  await call(port, "/api/social/bootstrap/network", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Brian's Family", ownerDid: did }),
  });
  const ownerInvite = await call(port, "/api/social/bootstrap/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ maxUses: 1 }),
  });
  const ownerCode = (ownerInvite.body.joinUrl as string).split("/join/")[1];
  const challenge = await call(port, "/api/identity/session/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did }),
  });
  const session = await call(port, "/api/identity/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did, deviceId: "dev_phone", nonce: challenge.body.nonce, signature: sign(null, Buffer.from(challenge.body.nonce as string, "utf8"), device.privateKey).toString("base64url") }),
  });
  const ownerAdmit = await call(port, "/api/social/join/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: ownerCode,
      identityAccessToken: (session.body as Json).accessToken,
      deviceId: "dev_phone",
      devicePublicKeyJwk: publicKeyJwk,
      signature: sign(null, Buffer.from(`porchlight-join:${ownerCode}`, "utf8"), device.privateKey).toString("base64url"),
    }),
  });
  assert.equal(ownerAdmit.status, 201);
  const ownerAuth = { "content-type": "application/json", authorization: `Bearer ${(ownerAdmit.body as Json).accessToken}` };

  // The member's join link is issued (and revoked) through the owner console.
  const invite = await call(port, "/api/social/console/invites", {
    method: "POST",
    headers: ownerAuth,
    body: JSON.stringify({ maxUses: 1 }),
  });
  assert.equal(invite.status, 201);
  const inviteObj = invite.body.invite as Json;
  const code = inviteObj.token as string;

  const revoke = await call(port, "/api/social/console/invites/revoke", {
    method: "POST",
    headers: ownerAuth,
    body: JSON.stringify({ inviteId: inviteObj._id }),
  });
  assert.equal(revoke.status, 200);

  // Instant: the verification endpoint fails the member the moment it returns.
  const entry = await call(port, `/api/social/join/verify?code=${encodeURIComponent(code)}`);
  assert.equal(entry.status, 200);
  assert.equal(entry.body.valid, false);
  assert.equal(entry.body.code, "E_INVITE_REVOKED");
  assert.match(entry.body.message as string, /revoked by the network owner/);

  const unknown = await call(port, "/api/social/join/verify?code=not-a-real-code");
  assert.match(unknown.body.message as string, /doesn't exist/);
});