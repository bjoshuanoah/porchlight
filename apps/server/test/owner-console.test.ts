import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
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

const OWNER_CONSOLE = "/api/social/console";

function mutableConfig(): PorchlightConfig {
  return normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as PorchlightConfig);
}

const OK_PROBES: { mongo: Probe; redis: Probe } = { mongo: async () => "ok", redis: async () => "ok" };

interface Json {
  [key: string]: unknown;
}

interface TestHub {
  db: StoreLike;
  bootstrap: BootstrapService;
  close: () => void;
  port: Promise<number>;
}

function testHub(version: string | null = "9.9.9-test"): TestHub {
  const db = createMemoryStore();
  const config = mutableConfig();
  // Media root on a real temp filesystem so the hub's node:fs statfs disk
  // probe reads real numbers (the owner console's disk-status consumer).
  const configDir = mkdtempSync(join(tmpdir(), "porchlight-owner-console-"));
  mkdirSync(join(configDir, "media"), { recursive: true });
  const bootstrap = new BootstrapService(db, config, configDir);
  const app = createServer({ store: db, readiness: OK_PROBES, config, bootstrap, hubUrl: () => "https://hub.test", version });
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

type Auth = { "content-type": string; authorization: string };

function bearerAuth(token: string): Auth {
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

/** Device-signed payload per the write-verification contract. */
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
      signature: sign(null, Buffer.from(challenge.body.nonce as string, "utf8"), pair.privateKey).toString("base64url"),
    }),
  });
  if (session.status !== 201) {
    throw new Error(`identity session failed: ${session.status} ${JSON.stringify(session.body)}`);
  }
  return (session.body as Json).accessToken as string;
}

type Admission = { accessToken: string; refreshToken: string; membership: Json };

async function admit(port: number, identityToken: string, pair: DevicePair, code: string): Promise<Admission> {
  const admitResult = await call(port, "/api/social/join/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      identityAccessToken: identityToken,
      deviceId: pair.deviceId,
      devicePublicKeyJwk: pair.publicKeyJwk,
      signature: sign(null, Buffer.from(`porchlight-join:${code}`, "utf8"), pair.privateKey).toString("base64url"),
    }),
  });
  if (admitResult.status !== 201) {
    throw new Error(`admission failed: ${admitResult.status} ${JSON.stringify(admitResult.body)}`);
  }
  return {
    accessToken: (admitResult.body as Json).accessToken as string,
    refreshToken: (admitResult.body as Json).refreshToken as string,
    membership: admitResult.body.membership as Json,
  };
}

interface BootedOwner {
  did: string;
  pair: DevicePair;
  auth: Auth;
  networkId: string;
}

/** Owner boot: first account → network (founder rule) → first invite → owner admission. */
async function bootOwner(port: number): Promise<BootedOwner> {
  const pair = devicePair("dev_owner");
  const account = await call(port, "/api/identity/bootstrap/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ firstName: "Brian", lastName: "Noah", device: { deviceId: pair.deviceId, publicKeyJwk: pair.publicKeyJwk } }),
  });
  if (account.status !== 201) {
    throw new Error(`account bootstrap failed: ${account.status} ${JSON.stringify(account.body)}`);
  }
  const did = (account.body.account as Json).did as string;
  const identityToken = await identitySession(port, did, pair);
  const network = await call(port, "/api/social/bootstrap/network", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Brian's Family", ownerDid: did }),
  });
  if (network.status !== 201) {
    throw new Error(`network bootstrap failed: ${network.status} ${JSON.stringify(network.body)}`);
  }
  const invite = await call(port, "/api/social/bootstrap/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "member", maxUses: 1 }),
  });
  const code = ((invite.body as Json).joinUrl as string).split("/join/")[1] as string;
  const admitted = await admit(port, identityToken, pair, code);
  return { did, pair, auth: bearerAuth(admitted.accessToken), networkId: admitted.membership.networkId as string };
}

interface BootedMember {
  did: string;
  memberId: string;
  auth: Auth;
  accessToken: string;
  refreshToken: string;
  pair: DevicePair;
}

/** Member boot: identity seeded (first account is owner-gated), console-issued invite admission. */
async function bootMember(hub: TestHub, port: number, ownerAuth: Auth, displayName: string, deviceId: string): Promise<BootedMember> {
  const pair = devicePair(deviceId);
  const did = `did:porch:${randomBytes(20).toString("hex")}`;
  await hub.db.collection("identities").insertOne({
    _id: `ident_${randomUUID()}`,
    did,
    actorType: "human",
    displayName,
    email: null,
    handle: null,
    profile: {},
    homingStatus: "home",
    migratedToIssuer: null,
    createdAt: new Date().toISOString(),
  });
  await hub.db.collection("device_registrations").insertOne({
    _id: `reg_${randomUUID()}`,
    did,
    deviceId,
    label: null,
    publicKeyJwk: pair.publicKeyJwk,
    createdBy: "agent",
    status: "active",
    revokedAt: null,
    createdAt: new Date().toISOString(),
  });
  const identityToken = await identitySession(port, did, pair);
  const invite = await call(port, `${OWNER_CONSOLE}/invites`, {
    method: "POST",
    headers: ownerAuth,
    body: JSON.stringify({ role: "member", maxUses: 1 }),
  });
  const code = ((invite.body as Json).invite as Json).token as string;
  const admission = await admit(port, identityToken, pair, code);
  return {
    did,
    memberId: admission.membership._id as string,
    auth: bearerAuth(admission.accessToken),
    accessToken: admission.accessToken,
    refreshToken: admission.refreshToken,
    pair,
  };
}

/** Resumable original upload through the real media API; returns its mediaId. */
async function uploadOriginal(port: number, pair: DevicePair, auth: Auth, sizeBytes = 12): Promise<string> {
  const contentType = "image/png";
  const bytes = randomBytes(sizeBytes);
  const begin = await call(port, "/api/social/media/uploads", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      payload: { scope: "media-upload", size: sizeBytes, contentType },
      signature: signPayload(pair, { scope: "media-upload", size: sizeBytes, contentType }),
    }),
  });
  if (begin.status !== 200) {
    throw new Error(`upload begin failed: ${begin.status} ${JSON.stringify(begin.body)}`);
  }
  const uploadId = begin.body.uploadId as string;
  const chunkSha = createHash("sha256").update(bytes).digest("hex");
  const chunk = await fetch(`http://127.0.0.1:${port}/api/social/media/uploads/${uploadId}/chunks/0`, {
    method: "PUT",
    headers: { ...auth, "content-type": "application/octet-stream", "x-chunk-sha256": chunkSha },
    body: bytes,
  });
  if (chunk.status !== 200) {
    throw new Error(`chunk upload failed: ${chunk.status} ${await chunk.text()}`);
  }
  const commit = await call(port, `/api/social/media/uploads/${uploadId}/complete`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      payload: { sha256: chunkSha, size: sizeBytes },
      signature: signPayload(pair, { scope: "media-commit", uploadId, sha256: chunkSha, size: sizeBytes }),
    }),
  });
  if (commit.status !== 200) {
    throw new Error(`upload commit failed: ${commit.status} ${JSON.stringify(commit.body)}`);
  }
  return commit.body.mediaId as string;
}

test("ac-1: owner console disk status is owner-readable; the audit trail lists member-level events with no content bytes", async (t) => {
  const hub = testHub();
  t.after(hub.close);
  const port = await hub.port;
  const owner = await bootOwner(port);
  await bootMember(hub, port, owner.auth, "Tom", "dev_laptop");
  await uploadOriginal(port, owner.pair, owner.auth);

  // Disk status: usage + soft/hard threshold states, owner-readable, coherent.
  const disk = await call(port, `${OWNER_CONSOLE}/disk`, { headers: owner.auth });
  assert.equal(disk.status, 200);
  assert.equal(disk.body.available, true);
  assert.equal(typeof disk.body.totalBytes, "number");
  assert.equal(typeof disk.body.usedRatio, "number");
  assert.ok((disk.body.usedRatio as number) >= 0 && (disk.body.usedRatio as number) <= 1);
  assert.equal(disk.body.softThreshold, 0.9);
  assert.equal(disk.body.hardThreshold, 0.95);
  assert.equal(typeof disk.body.warning, "boolean");
  assert.equal(typeof disk.body.uploadsHalted, "boolean");
  assert.equal(disk.body.warning, (disk.body.usedRatio as number) >= 0.9);
  assert.equal(disk.body.uploadsHalted, (disk.body.usedRatio as number) >= 0.95);

  // The audit trail lists member-level events: logins, uploads — and
  // deletions once a retention pass runs.
  const sweep = await call(port, `${OWNER_CONSOLE}/retention/sweep`, { method: "POST", headers: owner.auth });
  assert.equal(sweep.status, 200);
  const audit = await call(port, `${OWNER_CONSOLE}/audit`, { headers: owner.auth });
  assert.equal(audit.status, 200);
  const events = audit.body.events as Json[];
  const actions = events.map((event) => event.action as string);
  assert.ok(actions.includes("login"), "admission audits a member login");
  assert.ok(actions.includes("upload_begin"));
  assert.ok(actions.includes("upload"));
  assert.ok(actions.includes("upload_commit"));
  assert.ok(actions.includes("media_sweep"), "a deletion pass is audited");

  // No content bytes are reachable through the console: the trail carries
  // ids and quantities only — no blob keys, no content payloads.
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes("blobKey"));
  assert.ok(!serialized.includes("contentType"));
});

test("ac-2: owners view member roles, and revocation is instant — sessions die and link states flip owner-visible", async (t) => {
  const hub = testHub();
  t.after(hub.close);
  const port = await hub.port;
  const owner = await bootOwner(port);
  const member = await bootMember(hub, port, owner.auth, "Tom", "dev_laptop");

  // Member listing with roles visible, no content-access data returned.
  const members = await call(port, `${OWNER_CONSOLE}/members`, { headers: owner.auth });
  assert.equal(members.status, 200);
  const rows = members.body.members as Json[];
  assert.equal(rows.length, 2);
  assert.ok(rows.some((row) => row.did === owner.did && row.role === "owner"));
  assert.ok(rows.some((row) => row.did === member.did && row.role === "member"));
  const memberView = rows.find((row) => row.did === member.did) as Json;
  const memberKeys = Object.keys(memberView).sort();
  // The full owner-visible record is identity + name (PORCH-029 directory) +
  // role + state only.
  assert.deepEqual(memberKeys, ["_id", "admittedAt", "did", "name", "networkId", "revokedAt", "role", "state"]);
  assert.equal(memberView.name, "Tom", "the directory shows the member's identity-plane display name");

  // The member's perimeter is live before revocation.
  const before = await call(port, "/api/social/timeline", { headers: member.auth });
  assert.equal(before.status, 200);

  // Revocation: membership inactive, every open session dead in the same write.
  const revoke = await call(port, `${OWNER_CONSOLE}/members/revoke`, {
    method: "POST",
    headers: owner.auth,
    body: JSON.stringify({ memberId: member.memberId }),
  });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.body.revoked, true);

  // Instant: the member's token no longer opens the perimeter (the feed's
  // member-facing contract for a dead session: 403, not permitted), and
  // the session cannot refresh either.
  const after = await call(port, "/api/social/timeline", { headers: member.auth });
  assert.equal(after.status, 403);
  assert.equal(after.body.code, "E_NOT_PERMITTED");
  const refresh = await call(port, "/api/social/session/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: member.refreshToken }),
  });
  assert.equal(refresh.status, 401);
  assert.equal(refresh.body.code, "E_SESSION_REQUIRED");

  // The flip is owner-visible immediately.
  const afterRevoke = await call(port, `${OWNER_CONSOLE}/members`, { headers: owner.auth });
  const revokedRow = ((afterRevoke.body.members as Json[]).find((row) => row.did === member.did) as Json);
  assert.equal(revokedRow.state, "revoked");
  assert.ok(typeof revokedRow.revokedAt === "string");

  // Idempotent: revoking a revoked member reports without acting.
  const again = await call(port, `${OWNER_CONSOLE}/members/revoke`, {
    method: "POST",
    headers: owner.auth,
    body: JSON.stringify({ memberId: member.memberId }),
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.revoked, false);

  // Unknown member is a loud 404.
  const unknown = await call(port, `${OWNER_CONSOLE}/members/revoke`, {
    method: "POST",
    headers: owner.auth,
    body: JSON.stringify({ memberId: "mem_nope" }),
  });
  assert.equal(unknown.status, 404);
});

test("ac-3: quantity-only limits apply to the next upload admission and the next retention pass", async (t) => {
  const hub = testHub();
  t.after(hub.close);
  const port = await hub.port;
  const owner = await bootOwner(port);
  const member = await bootMember(hub, port, owner.auth, "Tom", "dev_laptop");

  // The owner sets ceilings and windows — quantity only, nothing that
  // grants content reach (the settings surface carries quantities alone).
  const put = await call(port, `${OWNER_CONSOLE}/limits`, {
    method: "PUT",
    headers: owner.auth,
    body: JSON.stringify({ storageCeilingMb: 1, retentionDays: 1 }),
  });
  assert.equal(put.status, 200);
  assert.deepEqual(Object.keys(put.body).sort(), ["networkId", "quota"]);
  assert.equal((put.body.quota as Json).storageCeilingMb, 1);
  assert.equal((put.body.quota as Json).retentionDays, 1);

  // NEXT upload admission enforces the new ceiling: 2 MiB breaks 1 MiB.
  const overDecl = { scope: "media-upload", size: 2 * 1024 * 1024, contentType: "image/png" };
  const denied = await call(port, "/api/social/media/uploads", {
    method: "POST",
    headers: member.auth,
    body: JSON.stringify({ payload: overDecl, signature: signPayload(member.pair, overDecl) }),
  });
  assert.equal(denied.status, 429);
  assert.equal(denied.body.code, "E_STORAGE_QUOTA_EXCEEDED");

  // A small original fits under the ceiling; the artifact ledger records it.
  const mediaId = await uploadOriginal(port, member.pair, member.auth);

  const limits = await call(port, `${OWNER_CONSOLE}/limits`, { headers: owner.auth });
  assert.equal(limits.status, 200);
  assert.ok((limits.body.usedBytes as number) > 0);
  assert.deepEqual(Object.keys(limits.body).sort(), ["network", "quota", "usedBytes"]);
  const networkView = limits.body.network as Json;
  assert.deepEqual(Object.keys(networkView).sort(), ["_id", "name"]);

  // NEXT retention pass enforces the (tightened) window: age the artifact
  // rows ten days, then sweep — the pass removes the recorded artifacts and
  // their stored content, and member reads stop finding them.
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await hub.db.collection("artifacts").find({ networkId: owner.networkId });
  for (const row of rows) {
    await hub.db.collection("artifacts").updateOne({ _id: row._id }, { $set: { createdAt: tenDaysAgo } });
  }
  const sweep = await call(port, `${OWNER_CONSOLE}/retention/sweep`, { method: "POST", headers: owner.auth });
  assert.equal(sweep.status, 200);
  assert.ok((sweep.body.swept as number) >= 1);
  assert.ok((sweep.body.assetRowsRemoved as number) >= 1);
  const gone = await call(port, `/api/social/media/${mediaId}/original`, { headers: member.auth });
  assert.equal(gone.status, 404);

  const audit = await call(port, `${OWNER_CONSOLE}/audit`, { headers: owner.auth });
  const actions = (audit.body.events as Json[]).map((event) => event.action as string);
  assert.ok(actions.includes("retention_delete"));
  assert.ok(actions.includes("media_sweep"));
});

test("ac-4: the console shows the running release/version and launch diagnostics name the failed-start check — with no background update machinery", async (t) => {
  const hub = testHub();
  t.after(hub.close);
  const port = await hub.port;
  const owner = await bootOwner(port);
  const member = await bootMember(hub, port, owner.auth, "Tom", "dev_laptop");

  const anon = await call(port, `${OWNER_CONSOLE}/system`);
  assert.equal(anon.status, 401);
  assert.equal(anon.body.code, "E_SESSION_REQUIRED");
  const asMember = await call(port, `${OWNER_CONSOLE}/system`, { headers: member.auth });
  assert.equal(asMember.status, 403);
  assert.equal(asMember.body.code, "E_FORBIDDEN");

  const response = await call(port, `${OWNER_CONSOLE}/system`, { headers: owner.auth });
  assert.equal(response.status, 200);
  // The surface is release identity + launch diagnostics only: no update
  // check, no registry polling, no background machinery of any kind.
  assert.deepEqual(Object.keys(response.body).sort(), ["launch", "release"]);
  assert.equal((response.body.release as Json).service, "porchlight-server");
  assert.equal((response.body.release as Json).version, "9.9.9-test");
  assert.deepEqual((response.body.launch as Json).diagnostics, []);

  // A failed start is diagnosable: the failing check is NAMED in the hub
  // diagnostics ledger (the update-cycle contract, PORCH-016 ac-2). The
  // update cycle records the post-start check failure; the console
  // surfaces the named entry.
  await hub.bootstrap.record("invite", {
    failed: true,
    source: "post-start-feed-smoke",
    detail: "post-start feed smoke check failed after restart",
  });
  const afterFailure = await call(port, `${OWNER_CONSOLE}/system`, { headers: owner.auth });
  assert.equal(afterFailure.status, 200);
  const launch = afterFailure.body.launch as Json;
  const entry = (launch.diagnostics as Json[])[(launch.diagnostics as Json[]).length - 1];
  assert.equal(entry.source, "post-start-feed-smoke");
  assert.match(entry.message as string, /feed smoke check failed/);
  assert.equal(launch.lastError, entry.message);
  assert.equal(((launch.steps as Json).invite as Json).status, "failed");
});

test("ac-3 (PORCH-029): the member directory reflects live membership state on the next read", async (t) => {
  const hub = testHub();
  t.after(hub.close);
  const port = await hub.port;
  const owner = await bootOwner(port);

  // Start: the founder alone, directory rows carry the owner's name.
  const before = await call(port, `${OWNER_CONSOLE}/members`, { headers: owner.auth });
  assert.equal(before.status, 200);
  assert.equal((before.body.members as Json[]).length, 1);
  assert.equal((before.body.members as Json[])[0].role, "owner");
  assert.ok((before.body.members as Json[])[0].name, "the bound founder renders with a name, not a raw identity row");

  // A member completes the issued join link → the directory shows them on
  // the next read (name, role, active join state) without any manual step.
  const member = await bootMember(hub, port, owner.auth, "June River", "dev_phone");
  const afterJoin = await call(port, `${OWNER_CONSOLE}/members`, { headers: owner.auth });
  const joinedRow = ((afterJoin.body.members as Json[]).find((row) => row.did === member.did) as Json);
  assert.equal(joinedRow.role, "member");
  assert.equal(joinedRow.state, "active");
  assert.equal(joinedRow.name, "June River");
  assert.ok(typeof joinedRow.admittedAt === "string");

  // The minted invites are consumed (boot used two) — every earlier link
  // reads used in the lifecycle, and a second issued link reads unused with
  // its shareable join URL (ac-2: the link the owner can copy and send).
  const invites = await call(port, `${OWNER_CONSOLE}/invites`, { headers: owner.auth });
  const states = (invites.body.invites as Json[]).map((row) => row.status as string).sort();
  assert.deepEqual(states, ["used", "used"]);
  const spare = await call(port, `${OWNER_CONSOLE}/invites`, { method: "POST", headers: owner.auth, body: JSON.stringify({ role: "member", maxUses: 1 }) });
  const spareInvite = spare.body.invite as Json;
  assert.match((spareInvite.joinUrl as string), /^https:\/\/hub\.test\/join\//);
  const spareList = await call(port, `${OWNER_CONSOLE}/invites`, { headers: owner.auth });
  const spareRow = ((spareList.body.invites as Json[]).find((row) => (row as Json)._id === spareInvite._id) as Json);
  assert.equal(spareRow.status, "unused");

  // Revoking that link flips it owner-visible on the next read (ac-3).
  const revoked = await call(port, `${OWNER_CONSOLE}/invites/revoke`, {
    method: "POST",
    headers: owner.auth,
    body: JSON.stringify({ inviteId: (spareInvite as Json)._id }),
  });
  assert.equal(revoked.status, 200);
  const afterRevoke = await call(port, `${OWNER_CONSOLE}/invites`, { headers: owner.auth });
  const revokedRow = ((afterRevoke.body.invites as Json[]).find((row) => (row as Json)._id === spareInvite._id) as Json);
  assert.equal(revokedRow.status, "revoked");

  // Revoking the member's membership lands in the directory the same way.
  const memberRevoke = await call(port, `${OWNER_CONSOLE}/members/revoke`, {
    method: "POST",
    headers: owner.auth,
    body: JSON.stringify({ memberId: member.memberId }),
  });
  assert.equal(memberRevoke.status, 200);
  const directoryFinal = await call(port, `${OWNER_CONSOLE}/members`, { headers: owner.auth });
  const finalRow = ((directoryFinal.body.members as Json[]).find((row) => row.did === member.did) as Json);
  assert.equal(finalRow.state, "revoked");
});