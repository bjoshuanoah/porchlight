import { test } from "node:test";
import assert from "node:assert/strict";
import { sign, generateKeyPairSync } from "node:crypto";
import { DEFAULT_CONFIG, createMemoryStore, normalizeConfig } from "@porchlight/shared";
import type { PorchlightConfig } from "@porchlight/shared";
import { BootstrapService } from "../src/services/bootstrap.service.js";
import { createServer } from "../src/router.js";
import type { Probe } from "../src/dependencies.js";

function mutableConfig(): PorchlightConfig {
  return normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as PorchlightConfig);
}

const OK_PROBES: { mongo: Probe; redis: Probe } = { mongo: async () => "ok", redis: async () => "ok" };

interface TestHub {
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
  return { close: () => { listener.closeIdleConnections(); listener.close(); }, port: promise };
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

  // Owner: bootstrap network + join-link invite (URL embeds the code).
  const network = await call(port, "/api/social/bootstrap/network", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Brian's Family" }),
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

  // Admission: server URL + invite code + device-signed request → scoped token.
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
  const membershipToken = (admit.body as Json).accessToken as string;
  assert.equal(typeof membershipToken === "string" && membershipToken.length >= 32, true);

  // Refresh rotates the access token inside the same network scope.
  const refresh = await call(port, "/api/social/session/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: (admit.body as Json).refreshToken }),
  });
  assert.equal(refresh.status, 200);
  assert.notEqual(refresh.body.accessToken, membershipToken);

  // Owner console: invite now shows a consumed state, the member is listed,
  // and the admission audited as a member login.
  const invites = await call(port, "/api/social/console/invites");
  assert.equal(invites.status, 200);
  assert.equal((invites.body.invites as Json[])[0].status, "used");

  const members = await call(port, "/api/social/console/members");
  assert.equal(members.status, 200);
  assert.equal((members.body.members as Json[]).length, 1);
  assert.equal((members.body.members as Json[])[0].did, did);

  const audit = await call(port, "/api/social/console/audit");
  assert.equal(audit.status, 200);
  const actions = (audit.body.events as Json[]).map((event) => event.action);
  assert.ok(actions.includes("login"));

  // Owner sets quantity-only limits; unset-before is reported, set-after holds.
  const before = await call(port, "/api/social/console/limits");
  assert.equal(before.status, 200);
  assert.equal((before.body.quota as Json).storageCeilingMb, null);
  const set = await call(port, "/api/social/console/limits", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ storageCeilingMb: 1024, retentionDays: 30 }),
  });
  assert.equal(set.status, 200);
  const after = await call(port, "/api/social/console/limits");
  assert.equal((after.body.quota as Json).storageCeilingMb, 1024);
  const sweep = await call(port, "/api/social/console/retention/sweep", { method: "POST" });
  assert.equal(sweep.status, 200);
  assert.equal(sweep.body.swept, 0);
})

test("revoked join link fails member entry instantly with plain language (contract)", async (t) => {
  const hub = testHub();
  t.after(hub.close);
  const port = await hub.port;

  await call(port, "/api/social/bootstrap/network", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Brian's Family" }),
  });
  const invite = await call(port, "/api/social/bootstrap/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const code = ((invite.body.joinUrl as string).split("/join/")[1]);

  const revoke = await call(port, "/api/social/console/invites/revoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inviteId: (invite.body.invite as Json)._id }),
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