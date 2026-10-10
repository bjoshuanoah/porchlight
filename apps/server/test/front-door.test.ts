import { test } from "node:test";
import assert from "node:assert/strict";
import { sign, generateKeyPairSync } from "node:crypto";
import { DEFAULT_CONFIG, createMemoryStore, normalizeConfig } from "@porchlight/shared";
import { canonicalJson } from "@porchlight/social";
import type { PorchlightConfig, StoreLike } from "@porchlight/shared";
import { BootstrapService } from "../src/services/bootstrap.service.js";
import { createServer } from "../src/router.js";
import type { Probe } from "../src/dependencies.js";

/**
 * PORCH-010 front-door contract (live HTTP): member identity birth at the
 * front door, admission through the invite perimeter, owner-routed device
 * links with single-use + revocation semantics, and membership-session
 * restore for re-bound devices.
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

function keyPair() {
  return generateKeyPairSync("ed25519");
}

async function memberIdentitySession(
  port: number,
  args: { did: string; device: ReturnType<typeof keyPair>; deviceId: string; jwk: Json },
): Promise<string> {
  const challenge = await call(port, "/api/identity/session/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did: args.did }),
  });
  assert.equal(challenge.status, 200);
  const session = await call(port, "/api/identity/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      did: args.did,
      deviceId: args.deviceId,
      nonce: challenge.body.nonce,
      signature: sign(null, Buffer.from(challenge.body.nonce as string, "utf8"), args.device.privateKey).toString("base64url"),
    }),
  });
  assert.equal(session.status, 201);
  return (session.body as Json).accessToken as string;
}

test("front door: member identity birth, admission, device link, session restore", async (t) => {
  const hub = testHub(() => "https://hub.test");
  t.after(hub.close);
  const port = await hub.port;

  // Owner bootstrap: first account + identity session + network + first invite.
  const ownerDevice = keyPair();
  const ownerJwk = ownerDevice.publicKey.export({ format: "jwk" }) as Json;
  const owner = await call(port, "/api/identity/bootstrap/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ firstName: "Brian", lastName: "Noah", device: { deviceId: "dev_home", publicKeyJwk: ownerJwk } }),
  });
  assert.equal(owner.status, 201);
  const ownerDid = (owner.body.account as Json).did as string;

  // PORCH-031 owner-bind handoff: the founder-bound network creation carries
  // the single-use device-link grant the CLI prints at completion.
  const networkBoot = await call(port, "/api/social/bootstrap/network", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "The Noah Family", ownerDid }),
  });
  assert.equal(networkBoot.status, 201);
  const ownerBind = (networkBoot.body as Json).ownerBind as Json;
  assert.equal((ownerBind.did as string), ownerDid, "the grant targets the bootstrap identity");
  assert.ok(String(ownerBind.token).length >= 20, "the grant token is a real one-time value");
  assert.ok(ownerBind.expiresAt, "the grant carries the device-link class TTL");
  const firstInvite = await call(port, "/api/social/bootstrap/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "member", maxUses: 1 }),
  });
  assert.equal(firstInvite.status, 201);
  const ownerCode = ((firstInvite.body.invite as Json).token as string);

  // The owner walks the same two-field front door: invite verified + admitted
  // via the founder rule (hub account proves ownership, never the invite).
  const ownerIdentityToken = await memberIdentitySession(port, { did: ownerDid, device: ownerDevice, deviceId: "dev_home", jwk: ownerJwk });
  const ownerAdmit = await call(port, "/api/social/join/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: ownerCode,
      identityAccessToken: ownerIdentityToken,
      deviceId: "dev_home",
      devicePublicKeyJwk: ownerJwk,
      signature: sign(null, Buffer.from(`porchlight-join:${ownerCode}`, "utf8"), ownerDevice.privateKey).toString("base64url"),
    }),
  });
  assert.equal(ownerAdmit.status, 201);
  assert.equal((ownerAdmit.body.membership as Json).role, "owner");
  const ownerAuth = {
    "content-type": "application/json",
    authorization: `Bearer ${(ownerAdmit.body as Json).accessToken as string}`,
  };

  // Consuming the owner-bind URL in a browser (PORCH-031 ac-2): the browser
  // mints its own key, the grant binds that device to the bootstrap identity,
  // and the silent re-credential lands the owner inside the network —
  // owner access, no invite, no login form anywhere.
  const browserDevice = keyPair();
  const browserJwk = browserDevice.publicKey.export({ format: "jwk" }) as Json;
  const ownerConsume = await call(port, "/api/identity/device-link/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: ownerBind.token, device: { deviceId: "dev_browser", label: "Owner phone", publicKeyJwk: browserJwk } }),
  });
  assert.ok([200, 201].includes(ownerConsume.status), `owner-bind consume failed: ${ownerConsume.status}`);
  assert.equal(((ownerConsume.body.registration as Json).did as string), ownerDid, "the link never mints a new identity");
  assert.equal((ownerConsume.body.registration as Json).createdBy, "device-link");
  const browserToken = await memberIdentitySession(port, { did: ownerDid, device: browserDevice, deviceId: "dev_browser", jwk: browserJwk });
  const ownerLanding = await call(port, "/api/social/session/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityAccessToken: browserToken, deviceId: "dev_browser" }),
  });
  assert.equal(ownerLanding.status, 201);
  const landingSession = ((ownerLanding.body as Json).sessions as Json[])[0];
  assert.equal(landingSession?.role, "owner", "the bound device lands inside the network with owner access");

  // Replay of the consumed owner-bind link is refused with plain copy (ac-3).
  const ownerReplay = await call(port, "/api/identity/device-link/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: ownerBind.token, device: { deviceId: "dev_replay", publicKeyJwk: browserJwk } }),
  });
  assert.equal(ownerReplay.status, 409);
  assert.equal((ownerReplay.body as Json).code, "E_DEVICE_LINK_CONSUMED");
  assert.equal((ownerReplay.body as Json).error, "one-time value already consumed");

  // Fresh member: brand-new device, no identity anywhere. Identity birth at
  // the front door — verified invite first, DID + device binding minted.
  const sophieDevice = keyPair();
  const sophieJwk = sophieDevice.publicKey.export({ format: "jwk" }) as Json;
  const sophieInvite = await call(port, "/api/social/console/invites", {
    method: "POST",
    headers: ownerAuth,
    body: JSON.stringify({ role: "member", maxUses: 1 }),
  });
  assert.equal(sophieInvite.status, 201);
  const sophieCode = (sophieInvite.body.invite as Json).token as string;

  const birth = await call(port, "/api/bootstrap/join-member", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: sophieCode, firstName: "Sophie", lastName: "Marten", device: { deviceId: "dev_tablet", label: "Kitchen tablet", publicKeyJwk: sophieJwk } }),
  });
  assert.equal(birth.status, 201);
  assert.equal(birth.body.created, true);
  const sophieDid = (birth.body.account as Json).did as string;
  assert.match(sophieDid, /^did:porch:[0-9a-f]{40}$/);
  assert.equal((birth.body.registration as Json).createdBy, "join");
  assert.equal(((birth.body.network as Json)?.name as string), "The Noah Family");

  // Admission reuses the untouched perimeter guard: identity proof + device
  // signature over the invite code. Membership token scoped to the network.
  const sophieIdentityToken = await memberIdentitySession(port, { did: sophieDid, device: sophieDevice, deviceId: "dev_tablet", jwk: sophieJwk });
  const sophieAdmit = await call(port, "/api/social/join/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: sophieCode,
      identityAccessToken: sophieIdentityToken,
      deviceId: "dev_tablet",
      devicePublicKeyJwk: sophieJwk,
      signature: sign(null, Buffer.from(`porchlight-join:${sophieCode}`, "utf8"), sophieDevice.privateKey).toString("base64url"),
    }),
  });
  assert.equal(sophieAdmit.status, 201);
  assert.equal((sophieAdmit.body.membership as Json).role, "member");
  const timeline = await call(port, "/api/social/timeline", {
    headers: { authorization: `Bearer ${(sophieAdmit.body as Json).accessToken as string}` },
  });
  assert.equal(timeline.status, 200);

  // Re-bind a second device for the member through the owner-routed link.
  const mint = await call(port, "/api/social/console/device-links", {
    method: "POST",
    headers: ownerAuth,
    body: JSON.stringify({ did: sophieDid }),
  });
  assert.equal(mint.status, 201);
  assert.match((mint.body as Json).linkUrl as string, /^https:\/\/hub\.test\/device-link\/.+$/);
  const sophieGrantId = (mint.body as Json).grantId as string;

  const newDevice = keyPair();
  const newJwk = newDevice.publicKey.export({ format: "jwk" }) as Json;
  const consume = await call(port, "/api/identity/device-link/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: (mint.body as Json).token, device: { deviceId: "dev_phone", label: "Phone", publicKeyJwk: newJwk } }),
  });
  assert.equal(consume.status, 201);
  assert.equal(((consume.body.registration as Json).did as string), sophieDid, "device link never mints a new identity");
  assert.equal((consume.body.registration as Json).createdBy, "device-link");

  // Replay of the consumed grant is refused with plain copy.
  const replay = await call(port, "/api/identity/device-link/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: (mint.body as Json).token, device: { deviceId: "dev_replay", publicKeyJwk: newJwk } }),
  });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.code, "E_DEVICE_LINK_CONSUMED");

  // The re-bound device restores membership sessions for the UNCHANGED
  // identity: identity proof in, network-scoped membership tokens out.
  const newDeviceToken = await memberIdentitySession(port, { did: sophieDid, device: newDevice, deviceId: "dev_phone", jwk: newJwk });
  const restore = await call(port, "/api/social/session/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityAccessToken: newDeviceToken, deviceId: "dev_phone" }),
  });
  assert.equal(restore.status, 201);
  const restoredSessions = (restore.body as Json).sessions as Json[];
  assert.equal(restoredSessions.length, 1);
  assert.equal((restoredSessions[0] as Json).networkId, (sophieAdmit.body.membership as Json).networkId);
  const restoredTimeline = await call(port, "/api/social/timeline", {
    headers: { authorization: `Bearer ${(restoredSessions[0] as Json).accessToken as string}` },
  });
  assert.equal(restoredTimeline.status, 200);

  // PORCH-048: the re-credential also restores the per-network device key
  // enrollment, so a signed WRITE from the re-bound device verifies — the
  // read-only failure mode (E_DEVICE_NOT_ENROLLED on every write) is gone.
  const reboundPayload = { type: "text", body: "hello from the re-bound device", networkId: (sophieAdmit.body.membership as Json).networkId };
  const reboundWrite = await call(port, "/api/social/posts", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${(restoredSessions[0] as Json).accessToken as string}` },
    body: JSON.stringify({
      payload: reboundPayload,
      signature: sign(null, Buffer.from(canonicalJson(reboundPayload), "utf8"), newDevice.privateKey).toString("base64url"),
    }),
  });
  assert.equal(reboundWrite.status, 200, `re-bound device write failed: ${JSON.stringify(reboundWrite.body)}`);
  assert.equal(((reboundWrite.body as Json).post as Json).authorId, sophieDid);

  // Owner console grant states: used for the consumed grant.
  const links = await call(port, "/api/social/console/device-links", { headers: ownerAuth });
  assert.equal(links.status, 200);
  const sophieLink = ((links.body as Json).deviceLinks as Json[]).find((row) => row._id === sophieGrantId);
  assert.equal(sophieLink?.status, "used");

  // Anonymous and non-owner callers never reach the owner device surfaces.
  const anonMint = await call(port, "/api/social/console/device-links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did: sophieDid }),
  });
  assert.equal(anonMint.status, 401);
  const memberMint = await call(port, "/api/social/console/device-links", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${(sophieAdmit.body as Json).accessToken as string}` },
    body: JSON.stringify({ did: ownerDid }),
  });
  assert.equal(memberMint.status, 403);

  // Revocation: minted-then-revoked grant is refused at consume instantly.
  const jakeInvite = await call(port, "/api/social/console/invites", {
    method: "POST",
    headers: ownerAuth,
    body: JSON.stringify({ role: "member", maxUses: 1 }),
  });
  const jakeCode = (jakeInvite.body.invite as Json).token as string;
  const jakeDevice = keyPair();
  const jakeJwk = jakeDevice.publicKey.export({ format: "jwk" }) as Json;
  const jakeBirth = await call(port, "/api/bootstrap/join-member", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: jakeCode, firstName: "Jake", lastName: "River", device: { deviceId: "dev_desk", publicKeyJwk: jakeJwk } }),
  });
  assert.equal(jakeBirth.status, 201);
  const jakeDid = (jakeBirth.body.account as Json).did as string;
  const jakeIdentityToken = await memberIdentitySession(port, { did: jakeDid, device: jakeDevice, deviceId: "dev_desk", jwk: jakeJwk });
  const jakeAdmit = await call(port, "/api/social/join/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: jakeCode,
      identityAccessToken: jakeIdentityToken,
      deviceId: "dev_desk",
      devicePublicKeyJwk: jakeJwk,
      signature: sign(null, Buffer.from(`porchlight-join:${jakeCode}`, "utf8"), jakeDevice.privateKey).toString("base64url"),
    }),
  });
  assert.equal(jakeAdmit.status, 201);

  const jakeLink = await call(port, "/api/social/console/device-links", {
    method: "POST",
    headers: ownerAuth,
    body: JSON.stringify({ did: jakeDid }),
  });
  assert.equal(jakeLink.status, 201);
  const jakeGrantId = (jakeLink.body as Json).grantId as string;
  const revoke = await call(port, "/api/social/console/device-links/revoke", {
    method: "POST",
    headers: ownerAuth,
    body: JSON.stringify({ grantId: jakeGrantId }),
  });
  assert.equal(revoke.status, 200);
  assert.equal((revoke.body as Json).revoked, true);
  const revokedConsume = await call(port, "/api/identity/device-link/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: (jakeLink.body as Json).token, device: { deviceId: "dev_x", publicKeyJwk: jakeJwk } }),
  });
  assert.equal(revokedConsume.status, 403);
  assert.equal(revokedConsume.body.code, "E_DEVICE_LINK_REVOKED");

  // Birth failures name their state and store nothing: unknown code, revoked
  // invite, missing name, private key material.
  const unknownCode = await call(port, "/api/bootstrap/join-member", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "no-such-code", firstName: "X", lastName: "Guard", device: { deviceId: "dev_y", publicKeyJwk: jakeJwk } }),
  });
  assert.equal(unknownCode.status, 404);
  assert.equal(unknownCode.body.code, "E_INVITE_NOT_FOUND");

  const spareInvite = await call(port, "/api/social/console/invites", {
    method: "POST",
    headers: ownerAuth,
    body: JSON.stringify({ role: "member", maxUses: 1 }),
  });
  const spareCode = (spareInvite.body.invite as Json).token as string;
  await call(port, "/api/social/console/invites/revoke", {
    method: "POST",
    headers: ownerAuth,
    body: JSON.stringify({ inviteId: (spareInvite.body.invite as Json)._id as string }),
  });
  const revokedCode = await call(port, "/api/bootstrap/join-member", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: spareCode, firstName: "X", lastName: "Guard", device: { deviceId: "dev_y", publicKeyJwk: jakeJwk } }),
  });
  assert.equal(revokedCode.status, 403);
  assert.equal(revokedCode.body.code, "E_INVITE_REVOKED");

  const guardInvite = await call(port, "/api/social/console/invites", {
    method: "POST",
    headers: ownerAuth,
    body: JSON.stringify({ role: "member", maxUses: 1 }),
  });
  const guardCode = (guardInvite.body.invite as Json).token as string;
  const withD = { ...sophieJwk, d: "leaked-private-material" };
  const privateJwk = await call(port, "/api/bootstrap/join-member", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: guardCode, firstName: "X", lastName: "Guard", device: { deviceId: "dev_y", publicKeyJwk: withD } }),
  });
  assert.equal(privateJwk.status, 403);
  assert.equal(privateJwk.body.code, "E_PRIVATE_KEY_REJECTED");

  const identityCount = ((await hub.db.collection("identities").find({})) as unknown as Json[]).length;
  assert.equal(identityCount, 3, "failed births never store an identity row");
});
test("required names (PORCH-024): the hub rejects a join request omitting first or last name", async (t) => {
  const hub = testHub(() => "https://hub.test");
  t.after(hub.close);
  const port = await hub.port;

  // Owner + network + one live invite: the invite is valid, so the request
  // reaches the name validation and is refused there — regardless of client
  // state ("no client-side-only guard").
  const ownerDevice = keyPair();
  const owner = await call(port, "/api/identity/bootstrap/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ firstName: "Brian", lastName: "Noah", device: { deviceId: "dev_home", publicKeyJwk: ownerDevice.publicKey.export({ format: "jwk" }) } }),
  });
  assert.equal(owner.status, 201);
  const ownerDid = (owner.body.account as Json).did as string;
  await call(port, "/api/social/bootstrap/network", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "The Noah Family", ownerDid }),
  });
  const ownerIdentityToken = await memberIdentitySession(port, { did: ownerDid, device: ownerDevice, deviceId: "dev_home", jwk: ownerDevice.publicKey.export({ format: "jwk" }) as Json });
  // Founder-root admission is issued first: /console/invites sits behind the
  // membership perimeter, so the invite comes from the owner's membership.
  const firstInvite = await call(port, "/api/social/bootstrap/invite", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "member", maxUses: 1 }),
  });
  assert.equal(firstInvite.status, 201);
  const ownerCode = ((firstInvite.body.invite as Json).token as string);
  const ownerAdmit = await call(port, "/api/social/join/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: ownerCode,
      identityAccessToken: ownerIdentityToken,
      deviceId: "dev_home",
      devicePublicKeyJwk: ownerDevice.publicKey.export({ format: "jwk" }),
      signature: sign(null, Buffer.from(`porchlight-join:${ownerCode}`, "utf8"), ownerDevice.privateKey).toString("base64url"),
    }),
  });
  assert.equal(ownerAdmit.status, 201);
  const ownerAuth = {
    "content-type": "application/json",
    authorization: `Bearer ${(ownerAdmit.body as Json).accessToken as string}`,
  };
  const invite = await call(port, "/api/social/console/invites", {
    method: "POST",
    headers: ownerAuth,
    body: JSON.stringify({ role: "member", maxUses: 1 }),
  });
  assert.equal(invite.status, 201);
  const code = (invite.body.invite as Json).token as string;

  // Crafted bodies: last name omitted, first name omitted, whitespace-only —
  // every one is rejected at the hub and stores nothing.
  async function attempt(body: Json): Promise<{ status: number; body: Json }> {
    return call(port, "/api/bootstrap/join-member", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  const missingFirst = await attempt({ code, lastName: "Guard", device: { deviceId: "dev_y", publicKeyJwk: ownerDevice.publicKey.export({ format: "jwk" }) } });
  assert.equal(missingFirst.status, 400);
  assert.equal(missingFirst.body.code, "E_FIRST_NAME_REQUIRED");

  const missingLast = await attempt({ code, firstName: "Guard", device: { deviceId: "dev_y", publicKeyJwk: ownerDevice.publicKey.export({ format: "jwk" }) } });
  assert.equal(missingLast.status, 400);
  assert.equal(missingLast.body.code, "E_LAST_NAME_REQUIRED");

  const whitespace = await attempt({ code, firstName: "   ", lastName: "\t", device: { deviceId: "dev_y", publicKeyJwk: ownerDevice.publicKey.export({ format: "jwk" }) } });
  assert.equal(whitespace.status, 400);
  assert.equal(whitespace.body.code, "E_FIRST_NAME_REQUIRED");

  const identityCount = ((await hub.db.collection("identities").find({})) as unknown as Json[]).length;
  assert.equal(identityCount, 1, "rejected joins never store an identity row");

  // A valid join with both names still mints — and stores the names as
  // distinct fields with the display name composed from them.
  const memberDevice = keyPair();
  const full = await attempt({
    code,
    firstName: "  Sophie  ",
    lastName: "Marten",
    device: { deviceId: "dev_s", publicKeyJwk: memberDevice.publicKey.export({ format: "jwk" }) },
  });
  assert.equal(full.status, 201);
  const account = full.body.account as Json;
  assert.equal(account.firstName, "Sophie");
  assert.equal(account.lastName, "Marten");
  assert.equal(account.displayName, "Sophie Marten");
});
