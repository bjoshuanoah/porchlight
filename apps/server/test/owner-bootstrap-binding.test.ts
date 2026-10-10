import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, createMemoryStore, normalizeConfig } from "@porchlight/shared";
import type { PorchlightConfig, StoreLike } from "@porchlight/shared";
import { canonicalJson } from "@porchlight/social";
import { BootstrapService } from "../src/services/bootstrap.service.js";
import { createServer } from "../src/router.js";
import type { Probe } from "../src/dependencies.js";

/**
 * PORCH-018: the owner hub account created by bootstrap binds to the network
 * at creation. No separate bind step, no invite consumed by the owner, no
 * 401-only experience after the network exists.
 */

interface Json {
  [key: string]: unknown;
}

function mutableConfig(): PorchlightConfig {
  return normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as PorchlightConfig);
}

const OK_PROBES: { mongo: Probe; redis: Probe } = { mongo: async () => "ok", redis: async () => "ok" };

interface TestHub {
  db: StoreLike;
  bootstrap: BootstrapService;
  close: () => void;
  port: Promise<number>;
}

function testHub(): TestHub {
  const db = createMemoryStore();
  const config = mutableConfig();
  const configDir = mkdtempSync(join(tmpdir(), "porchlight-owner-bind-"));
  mkdirSync(join(configDir, "media"), { recursive: true });
  const bootstrap = new BootstrapService(db, config, configDir);
  const app = createServer({ store: db, readiness: OK_PROBES, config, bootstrap, hubUrl: () => "https://hub.test" });
  const { promise, resolve } = Promise.withResolvers<number>();
  const listener = app.listen(0, () => resolve((listener.address() as { port: number }).port));
  return {
    db,
    bootstrap,
    close: () => {
      listener.closeIdleConnections();
      listener.close();
    },
    port: promise,
  };
}

async function call(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: Json }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return { status: res.status, body: (await res.json()) as Json };
}

function bearerAuth(token: string): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

interface DevicePair {
  deviceId: string;
  privateKey: KeyObject;
  publicKeyJwk: Json;
}

function devicePair(deviceId: string): DevicePair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { deviceId, privateKey, publicKeyJwk: publicKey.export({ format: "jwk" }) as Json };
}

function signNonce(pair: DevicePair, nonce: string): string {
  return sign(null, Buffer.from(nonce, "utf8"), pair.privateKey).toString("base64url");
}

function signPayload(pair: DevicePair, payload: object): string {
  return sign(null, Buffer.from(canonicalJson(payload), "utf8"), pair.privateKey).toString("base64url");
}

/** Identity challenge/session for a DID: returns the identity access token. */
async function identitySession(port: number, did: string, pair: DevicePair): Promise<string> {
  const challenge = await call(port, "/api/identity/session/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did }),
  });
  const session = await call(port, "/api/identity/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      did,
      deviceId: pair.deviceId,
      nonce: challenge.body.nonce,
      signature: signNonce(pair, challenge.body.nonce as string),
    }),
  });
  if (session.status !== 201) {
    throw new Error(`identity session failed: ${session.status} ${JSON.stringify(session.body)}`);
  }
  return session.body.accessToken as string;
}

/**
 * ac-1 — bootstrap completes account and network creation and the owner
 * holds an owner-role membership on that network; ac-3 — reached with no
 * invite consumption and no manual binding call anywhere in the flow.
 */
test("ac-1/ac-3: fresh bootstrap binds the owner to the network they created", async () => {
  const hub = testHub();
  try {
    const port = await hub.port;
    const pair = devicePair(`dev_${randomUUID()}`);

    // Step 1: bootstrap account creation (founder device bound at birth).
    const account = await call(port, "/api/identity/bootstrap/account", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstName: "Brian", lastName: "Noah", device: { deviceId: pair.deviceId, publicKeyJwk: pair.publicKeyJwk } }),
    });
    assert.equal(account.status, 201);
    const did = (account.body.account as Json).did as string;

    // Step 2: network creation — the founder-binding step, nothing else.
    const network = await call(port, "/api/social/bootstrap/network", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Brian's Family", ownerDid: did }),
    });
    assert.equal(network.status, 201);
    const networkId = (network.body.network as Json)._id as string;
    const membership = network.body.membership as Json;
    assert.ok(membership, "bootstrap network creation returns the founder membership");
    assert.equal(membership.networkId, networkId);
    assert.equal(membership.did, did);
    assert.equal(membership.role, "owner");
    assert.equal(membership.state, "active");

    // The stored membership row exists (ac-1), and no invite was ever
    // consumed for it (ac-3): the network has zero used invitations.
    const rows = await hub.db.collection("memberships").find({ networkId });
    assert.equal(rows.length, 1);
    assert.equal((await hub.db.collection("invites").find({})).length, 0);

    // ac-2: the bound owner on the paired device opens the network — tokens
    // come from session restore (the silent re-credential), never an invite.
    const identityToken = await identitySession(port, did, pair);
    const restored = await call(port, "/api/social/session/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identityAccessToken: identityToken, deviceId: pair.deviceId }),
    });
    assert.equal(restored.status, 201);
    const sessions = restored.body.sessions as Array<Json>;
    const own = sessions.find((session) => session.networkId === networkId);
    assert.ok(own);
    assert.equal(own.role, "owner");
    const accessToken = own.accessToken as string;

    // Content view works without a 401 (ac-2): the member timeline reads.
    const read = await call(port, "/api/social/timeline", { headers: bearerAuth(accessToken) });
    assert.equal(read.status, 200);

    // Owner actions work without a 401 (ac-2): an owner-role console write.
    const inviteIssue = await call(port, "/api/social/console/invites", {
      method: "POST",
      headers: bearerAuth(accessToken),
      body: JSON.stringify({ role: "member", maxUses: 1 }),
    });
    assert.equal(inviteIssue.status, 201);

    // Owner write verification works too: the presenting device is enrolled
    // (copied from the identity-plane registration), so an owner-authored
    // moment verifies like any member write.
    const payload = { type: "text", body: "First moment at home." };
    const createdPost = await call(port, "/api/social/posts", {
      method: "POST",
      headers: bearerAuth(accessToken),
      body: JSON.stringify({ payload, signature: signPayload(pair, payload) }),
    });
    assert.equal(createdPost.status, 200, `post create failed: ${JSON.stringify(createdPost.body)}`);
    assert.equal((createdPost.body.post as Json).authorId, did);
  } finally {
    hub.close();
  }
});

/**
 * Repair path (PORCH-018): a hub bootstrapped before the binding existed —
 * member network row, NO membership row — binds the founder at the next
 * session restore, with the same founder-root proof and no manual step.
 */
test("ac-2: a founder whose hub predates the binding is repaired at restore", async () => {
  const hub = testHub();
  try {
    const port = await hub.port;
    const pair = devicePair(`dev_${randomUUID()}`);

    const account = await call(port, "/api/identity/bootstrap/account", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstName: "Brian", lastName: "Noah", device: { deviceId: pair.deviceId, publicKeyJwk: pair.publicKeyJwk } }),
    });
    assert.equal(account.status, 201);
    const did = (account.body.account as Json).did as string;

    // Legacy hub shape: network row with ownerDid, no membership anywhere.
    const network = await call(port, "/api/social/bootstrap/network", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Brian's Family", ownerDid: did }),
    });
    assert.equal(network.status, 201);
    const networkId = (network.body.network as Json)._id as string;
    await hub.db.collection("memberships").deleteOne({ networkId, did });
    assert.equal((await hub.db.collection("memberships").find({})).length, 0);

    // Owner opens the network: restore re-binds instead of E_NOT_A_MEMBER.
    const identityToken = await identitySession(port, did, pair);
    const restored = await call(port, "/api/social/session/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identityAccessToken: identityToken, deviceId: pair.deviceId }),
    });
    assert.equal(restored.status, 201);
    const own = (restored.body.sessions as Array<Json>).find((session) => session.networkId === networkId);
    assert.ok(own);
    assert.equal(own.role, "owner");

    // The presenting device's identity-plane key enrolled for write checks.
    const keys = await hub.db.collection("device_keys").find({ networkId, did });
    assert.equal(keys.length, 1);
    assert.deepEqual((keys[0] as Json).publicKeyJwk, pair.publicKeyJwk);

    // The owner console answers (no 401-only experience).
    const consoleMembers = await call(port, "/api/social/console/members", { headers: bearerAuth(own.accessToken as string) });
    assert.equal(consoleMembers.status, 200);
    const members = consoleMembers.body.members as Array<Json>;
    assert.equal(members.length, 1);
    assert.equal(members[0].role, "owner");
    assert.equal(members[0].did, did);
  } finally {
    hub.close();
  }
});

/**
 * The perimeter does not widen: a non-founder DID gets no membership from
 * either surface (restore stays E_NOT_A_MEMBER), and revocation still ends
 * the founder's binding without resurrection at the next restore.
 */
test("perimeter: restore binds nothing for a non-founder and never resurrects a revoked founder", async () => {
  const hub = testHub();
  try {
    const port = await hub.port;
    const ownerPair = devicePair(`dev_${randomUUID()}`);

    const account = await call(port, "/api/identity/bootstrap/account", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstName: "Brian", lastName: "Noah", device: { deviceId: ownerPair.deviceId, publicKeyJwk: ownerPair.publicKeyJwk } }),
    });
    assert.equal(account.status, 201);
    const ownerDid = (account.body.account as Json).did as string;

    // A second identity (like a front-door member device would mint) with a
    // direct registration row, so it can open an identity session.
    const memberPair = devicePair(`dev_${randomUUID()}`);
    const memberDid = `did:porch:${randomUUID()}`;
    await hub.db.collection("identities").insertOne({
      _id: `ident_${randomUUID()}`,
      did: memberDid,
      actorType: "human",
      displayName: "Sophie",
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
      deviceId: memberPair.deviceId,
      label: null,
      publicKeyJwk: memberPair.publicKeyJwk,
      createdBy: "test",
      status: "active",
      revokedAt: null,
      createdAt: new Date().toISOString(),
    });

    const network = await call(port, "/api/social/bootstrap/network", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Brian's Family", ownerDid }),
    });
    assert.equal(network.status, 201);
    const networkId = (network.body.network as Json)._id as string;

    // Non-founder restore: membership untouched, restore refuses plainly.
    const memberToken = await identitySession(port, memberDid, memberPair);
    const refused = await call(port, "/api/social/session/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identityAccessToken: memberToken, deviceId: memberPair.deviceId }),
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "E_NOT_A_MEMBER");
    assert.equal((await hub.db.collection("memberships").find({})).length, 1);

    // Self-removal of the SOLE owner is refused (final-owner invariant,
    // PORCH-053): the last owner is un-removable, server-side, plain reason.
    const soleOwnerIdentityToken = await identitySession(port, ownerDid, ownerPair);
    const soleBounded = await call(port, "/api/social/session/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identityAccessToken: soleOwnerIdentityToken, deviceId: ownerPair.deviceId }),
    });
    assert.equal(soleBounded.status, 201);
    const soleToken = (soleBounded.body.sessions as Array<Json>)[0].accessToken as string;
    const soleRevoke = await call(port, "/api/social/console/members/revoke", {
      method: "POST",
      headers: bearerAuth(soleToken),
      body: JSON.stringify({ did: ownerDid }),
    });
    assert.equal(soleRevoke.status, 409);
    assert.equal(soleRevoke.body.code, "E_LAST_OWNER");

    // With a second owner in place, the removal is legal — and the revoked
    // founder binding must NOT resurrect at the next restore.
    await hub.db.collection("memberships").insertOne({
      _id: `mem_${randomUUID()}`,
      networkId,
      did: memberDid,
      role: "owner",
      state: "active",
      admittedViaInviteId: null,
      admittedAt: new Date().toISOString(),
      revokedAt: null,
    });
    const revoke = await call(port, "/api/social/console/members/revoke", {
      method: "POST",
      headers: bearerAuth(soleToken),
      body: JSON.stringify({ did: ownerDid }),
    });
    assert.equal(revoke.status, 200);

    const again = await identitySession(port, ownerDid, ownerPair);
    const resurrect = await call(port, "/api/social/session/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identityAccessToken: again, deviceId: ownerPair.deviceId }),
    });
    assert.equal(resurrect.status, 403);
    assert.equal(resurrect.body.code, "E_NOT_A_MEMBER");
    const remaining = await hub.db.collection("memberships").find({ networkId, did: ownerDid });
    assert.equal(remaining.length, 1);
    assert.equal((remaining as Array<Json>)[0].state, "revoked");
  } finally {
    hub.close();
  }
});