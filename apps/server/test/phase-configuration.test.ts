import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
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
 * Phase-configuration contract tests (PORCH-012): one codebase, deployment
 * modes gated entirely by runtime configuration (Porchlight Server TS 6) —
 * never build-time forks.
 */

const OK_PROBES: { mongo: Probe; redis: Probe } = { mongo: async () => "ok", redis: async () => "ok" };

/** Every collection key @porchlight/social opens through the StoreLike. */
const SOCIAL_COLLECTIONS = [
  "artifacts",
  "audit_events",
  "comments",
  "derived_data",
  "device_keys",
  "groups",
  "invites",
  "media_assets",
  "media_uploads",
  "membership_sessions",
  "memberships",
  "networks",
  "notifications",
  "posts",
  "reactions",
  "votes",
];

interface Json {
  [key: string]: unknown;
}

type Mode = Partial<PorchlightConfig["mode"]>;

function configWith(mode: Mode): PorchlightConfig {
  const config = normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as PorchlightConfig);
  Object.assign(config.mode, mode);
  return normalizeConfig(config);
}

/** StoreLike spy: records every collection name the hub opens (storage domains). */
function spyingStore(): { store: StoreLike; opened: string[] } {
  const inner = createMemoryStore();
  const opened: string[] = [];
  return {
    opened,
    store: { collection: (name: string) => { opened.push(name); return inner.collection(name); } } as unknown as StoreLike,
  };
}

interface TestHub {
  db: StoreLike;
  opened: string[];
  bootstrap: BootstrapService;
  config: PorchlightConfig;
  close: () => void;
  port: Promise<number>;
}

/** Mount a server app on an existing store + bootstrap ledger (the runtime flip). */
function mount(store: StoreLike, config: PorchlightConfig, bootstrap: BootstrapService): Omit<TestHub, "opened"> {
  const app = createServer({ store, readiness: OK_PROBES, config, bootstrap, hubUrl: () => "https://hub.test" });
  const { promise, resolve } = Promise.withResolvers<number>();
  const listener = app.listen(0, () => resolve((listener.address() as { port: number }).port));
  return {
    db: store,
    bootstrap,
    config,
    close: () => { listener.closeIdleConnections(); listener.close(); },
    port: promise,
  };
}

function bootHub(mode: Mode): TestHub {
  const spy = spyingStore();
  const config = configWith(mode);
  const configDir = mkdtempSync(join(tmpdir(), "porchlight-phase-config-"));
  mkdirSync(join(configDir, "media"), { recursive: true });
  const bootstrap = new BootstrapService(spy.store, config, configDir);
  return { ...mount(spy.store, config, bootstrap), opened: spy.opened };
}

async function call(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: Json }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  let body: Json;
  try {
    body = JSON.parse(text) as Json;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body };
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

async function admit(port: number, identityToken: string, pair: DevicePair, code: string): Promise<Json> {
  const admitted = await call(port, "/api/social/join/admit", {
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
  if (admitted.status !== 201) {
    throw new Error(`admission failed: ${admitted.status} ${JSON.stringify(admitted.body)}`);
  }
  return admitted.body;
}

interface BootedHub extends Omit<TestHub, "close"> {
  close: () => void;
  owner: { did: string; auth: Auth; pair: DevicePair; networkId: string };
}

/** Boot a serving hub (hosted/self-hosted) with an owner through the real join flow. */
async function bootServingHub(mode: Mode): Promise<BootedHub> {
  const hub = bootHub(mode);
  const port = await hub.port;
  const pair = devicePair("dev_owner");
  const account = await call(port, "/api/identity/bootstrap/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ firstName: "Brian", lastName: "Noah", device: { deviceId: pair.deviceId, publicKeyJwk: pair.publicKeyJwk } }),
  });
  assert.equal(account.status, 201, JSON.stringify(account.body));
  const did = (account.body.account as Json).did as string;
  const identityToken = await identitySession(port, did, pair);
  const network = await call(port, "/api/social/bootstrap/network", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Brian's Family", ownerDid: did }),
  });
  assert.equal(network.status, 201, JSON.stringify(network.body));
  const invite = await call(port, "/api/social/bootstrap/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "member", maxUses: 1 }),
  });
  const code = ((invite.body as Json).joinUrl as string).split("/join/")[1] as string;
  const admitted = await admit(port, identityToken, pair, code);
  return {
    ...hub,
    owner: {
      did,
      pair,
      auth: bearerAuth((admitted as Json).accessToken as string),
      networkId: (admitted.membership as Json).networkId as string,
    },
  };
}

async function bootMember(hub: BootedHub, displayName: string, deviceId: string): Promise<{ auth: Auth; pair: DevicePair }> {
  const port = await hub.port;
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
    deviceId: pair.deviceId,
    label: null,
    publicKeyJwk: pair.publicKeyJwk,
    createdBy: "agent",
    status: "active",
    revokedAt: null,
    createdAt: new Date().toISOString(),
  });
  const identityToken = await identitySession(port, did, pair);
  const invite = await call(port, "/api/social/console/invites", {
    method: "POST",
    headers: hub.owner.auth,
    body: JSON.stringify({ role: "member", maxUses: 1 }),
  });
  const code = ((invite.body as Json).invite as Json).token as string;
  const admitted = await admit(port, identityToken, pair, code);
  return { auth: bearerAuth((admitted as Json).accessToken as string), pair };
}

/** Signed post creation over the real HTTP surface; returns the member post view. */
async function signedPost(port: number, auth: Auth, pair: DevicePair, body: string): Promise<Json> {
  const payload = { type: "text", body };
  const created = await call(port, "/api/social/posts", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ payload, signature: signPayload(pair, payload) }),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return created.body.post as Json;
}

test("phase configuration: identity-only mode exposes no social endpoint and opens no social storage domain (contract)", async (t) => {
  const hub = bootHub({ deploymentMode: "identity-only" });
  t.after(hub.close);
  const port = await hub.port;

  // No social surface mounts: content engine, feed, media, console, and the
  // join perimeter all stay unreachable behind the same /api prefix.
  for (const path of [
    "/api/social/network",
    "/api/social/posts",
    "/api/social/timeline",
    "/api/social/media/export",
    "/api/social/console/limits",
    "/api/social/join/verify?code=x",
  ]) {
    const res = await call(port, path);
    assert.equal(res.status, 404, `${path} answered ${res.status}; identity-only mode must not mount it`);
  }

  // Identity surfaces stay live and their storage domain really opens —
  // the gate removes social serving, not serving.
  const identity = await call(port, "/api/identity/account");
  assert.equal(identity.status, 200);
  const device = devicePair("dev_id_only");
  const created = await call(port, "/api/identity/bootstrap/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ firstName: "Solo", lastName: "Test", device: { deviceId: device.deviceId, publicKeyJwk: device.publicKeyJwk } }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  // Storage-domain containment: of everything the hub opened, none is a
  // social collection — the social module is never even assembled.
  const socialDomainsOpened = hub.opened.filter((name) => SOCIAL_COLLECTIONS.includes(name));
  assert.deepEqual(socialDomainsOpened, []);

  // The running mode is operator-readable at the health surface.
  const health = await call(port, "/api/health");
  assert.equal(health.status, 200);
  assert.deepEqual(health.body.mode, {
    deploymentMode: "identity-only",
    socialServingEnabled: false,
    identityServingEnabled: true,
  });
});

test("phase configuration: the same binary serves social surfaces when the mode flips at runtime — no build-time fork", async (t) => {
  const identityOnly = bootHub({ deploymentMode: "identity-only" });
  t.after(identityOnly.close);
  const identityOnlyPort = await identityOnly.port;
  assert.equal((await call(identityOnlyPort, "/api/social/console/limits")).status, 404);

  // Runtime re-configuration: the SAME store and bootstrap ledger remount
  // under the full mode — no rebuild, no second code path.
  const full = mount(identityOnly.db, configWith({ deploymentMode: "self-hosted" }), identityOnly.bootstrap);
  t.after(full.close);
  const port = await full.port;

  // Mounted: the console answers with its perimeter guard (401 — member
  // gated) instead of the unmounted 404, and the guard consults the social
  // storage domain through the very same store spy.
  const consoleLimits = await call(port, "/api/social/console/limits");
  assert.equal(consoleLimits.status, 401);
  assert.equal(consoleLimits.body.code, "E_SESSION_REQUIRED");
  assert.equal((await call(port, "/api/identity/account")).status, 200);
  assert.ok(identityOnly.opened.includes("networks"), "the flipped runtime opened the social storage domain");
});

test("phase configuration: hosted mode enforces vendor policy limits through the same quantity-only rule as owner-set local limits (contract)", async (t) => {
  // The identical call sequence runs against a hosted hub and a self-hosted
  // hub; every status, echo, and enforcement point must match — one limit
  // rule, no mode branch in the limiter.
  const settings = [
    { storageCeilingMb: 1, retentionDays: 7 },
    { storageCeilingMb: 0 },
    { storageCeilingMb: -5 },
  ];
  const traces: Json[] = [];
  for (const mode of [{ deploymentMode: "hosted" }, { deploymentMode: "self-hosted" }] as Mode[]) {
    const hub = await bootServingHub(mode);
    t.after(hub.close);
    const port = await hub.port;
    const member = await bootMember(hub, "Tom", "dev_tom");

    // Vendor policy (hosted) and owner policy (local) write through the
    // same console surface; invalid values fail with the same rule errors,
    // and a valid write echoes quantity-only fields.
    for (const [index, settingsStep] of settings.entries()) {
      const put = await call(port, "/api/social/console/limits", {
        method: "PUT",
        headers: hub.owner.auth,
        body: JSON.stringify(settingsStep),
      });
      if (index === 0) {
        // The valid vendor-policy write echoes quantity-only fields.
        assert.equal(put.status, 200, JSON.stringify(put.body));
        assert.deepEqual(Object.keys(put.body).sort(), ["networkId", "quota"]);
      } else {
        // Quantity-only rule errors are identical in either mode.
        assert.equal(put.status, 400, JSON.stringify(put.body));
        assert.equal(put.body.code, "E_INVALID_QUOTA");
      }
      // Trace only mode-invariant fields (network ids differ per hub).
      traces.push({ status: put.status, code: put.body.code ?? null, quota: (put.body.quota as Json) ?? null });
    }

    // Enforcement point: the NEXT member upload admission breaks against the
    // ceiling with the same plain-language quantity-only rejection in BOTH
    // modes.
    const overDecl = { scope: "media-upload", size: 2 * 1024 * 1024, contentType: "image/png" };
    const denied = await call(port, "/api/social/media/uploads", {
      method: "POST",
      headers: member.auth,
      body: JSON.stringify({ payload: overDecl, signature: signPayload(member.pair, overDecl) }),
    });
    assert.equal(denied.status, 429);
    assert.equal(denied.body.code, "E_STORAGE_QUOTA_EXCEEDED");
    assert.equal(
      denied.body.error,
      "This network is full: the owner has set a storage limit and it has been reached. Free up space or ask the owner to raise the limit.",
    );
    traces.push({ status: denied.status, code: denied.body.code, error: denied.body.error });

    // Readback is quantities only.
    const limits = await call(port, "/api/social/console/limits", { headers: hub.owner.auth });
    assert.equal(limits.status, 200);
    assert.deepEqual(Object.keys(limits.body).sort(), ["network", "quota", "usedBytes"]);
    assert.equal((limits.body.quota as Json).storageCeilingMb, 1);
    traces.push({ keys: Object.keys(limits.body).sort(), quota: limits.body.quota });
  }

  // Mode-invariance of the limit rule itself: hosted and self-hosted traces
  // are identical (setting echoes, rule errors, admission rejection, readback).
  const half = traces.length / 2;
  assert.deepEqual(traces.slice(0, half), traces.slice(half));
});

test("phase configuration: hosted mode grants no content reach — the console carries quantities and events, never member content (contract)", async (t) => {
  const hub = await bootServingHub({ deploymentMode: "hosted" });
  t.after(hub.close);
  const port = await hub.port;
  const member = await bootMember(hub, "Susan", "dev_susan");

  // Member-authored content exists on the hosted box.
  const caption = "PROBE-caption-never-for-owner-surfaces-7731";
  const post = await signedPost(port, member.auth, member.pair, caption);

  // The perimeter is unchanged by the mode: content reads still demand a
  // network-scoped membership token — operating the box grants no reach.
  assert.equal((await call(port, `/api/social/posts/${post._id}`)).status, 401);
  assert.equal((await call(port, "/api/social/console/limits")).status, 401);

  // Every console surface the operator can open carries quantities, events,
  // and metadata only — the member caption never appears in any of them.
  for (const path of [
    "/api/social/console/limits",
    "/api/social/console/audit",
    "/api/social/console/system",
    "/api/social/console/members",
    "/api/social/console/groups",
    "/api/social/console/invites",
  ]) {
    const res = await call(port, path, { headers: hub.owner.auth });
    assert.equal(res.status, 200, `${path} answered ${res.status}`);
    assert.equal(JSON.stringify(res.body).includes(caption), false, `${path} leaked member content`);
  }
});

test("phase configuration: AI-native seams are mode-invariant — signed writes and the derived-artifact cascade ride one code path (contract)", async (t) => {
  const seams: Record<string, { postRowKeys: string[]; cascadeRows: number }> = {};
  for (const mode of [{ deploymentMode: "self-hosted" }, { deploymentMode: "hosted" }] as Mode[]) {
    const hub = await bootServingHub(mode);
    t.after(hub.close);
    const port = await hub.port;
    const member = await bootMember(hub, "Tom", "dev_tom");

    // Per-actor signing: an invalid device signature is refused identically;
    // a valid one stores the same actor-signed shape in both modes.
    const forged = await call(port, "/api/social/posts", {
      method: "POST",
      headers: member.auth,
      body: JSON.stringify({ payload: { type: "text", body: "forged" }, signature: signPayload(member.pair, { type: "text", body: "OTHER" }) }),
    });
    assert.equal(forged.status, 403);
    assert.equal(forged.body.code, "E_SIGNATURE_INVALID");

    const post = await signedPost(port, member.auth, member.pair, "invariance-probe");
    const storedRaw = (await hub.db.collection("posts").findOne({ _id: post._id as string })) as Json;
    assert.ok(storedRaw);
    assert.ok(typeof storedRaw.deviceSignature === "string" && (storedRaw.deviceSignature as string).length > 0);
    seams[mode.deploymentMode ?? ""] = { postRowKeys: Object.keys(storedRaw).sort(), cascadeRows: 0 };

    // A member interaction, then the author-signed deletion: the derived-
    // artifact cascade (interactions, derived rows, artifact ledger rows)
    // must behave identically in both modes.
    const commentPayload = { postId: post._id, body: "note" };
    const comment = await call(port, `/api/social/posts/${post._id}/comments`, {
      method: "POST",
      headers: member.auth,
      body: JSON.stringify({ payload: commentPayload, signature: signPayload(member.pair, commentPayload) }),
    });
    assert.equal(comment.status, 200);

    const postId = post._id as string;
    const networkId = storedRaw.originNetworkId as string;
    const deletePayload = { kind: "delete", postId, networkId };
    const removed = await call(port, `/api/social/posts/${postId}`, {
      method: "DELETE",
      headers: member.auth,
      body: JSON.stringify({ signature: signPayload(member.pair, deletePayload) }),
    });
    assert.equal(removed.status, 200);
    const removedBody = removed.body as { deleted: boolean; cascadeRows: number };
    assert.equal(removedBody.deleted, true);
    assert.equal(removedBody.cascadeRows >= 2, true, "post + comment at minimum cascade away");
    seams[mode.deploymentMode ?? ""].cascadeRows = removedBody.cascadeRows;

    // The member view never leaks the signature in either mode.
    const view = await call(port, `/api/social/posts/${postId}`, { headers: member.auth });
    assert.equal(view.status, 404, "deleted post is gone for members in both modes");
  }
  assert.deepEqual(seams["self-hosted"], seams["hosted"]);
});