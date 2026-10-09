import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import { sign, generateKeyPairSync } from "node:crypto";
import { DEFAULT_CONFIG, createMemoryStore, loadConfig, normalizeConfig, saveConfig } from "@porchlight/shared";
import type { PorchlightConfig } from "@porchlight/shared";
import { BootstrapService } from "../src/services/bootstrap.service.js";
import { createServer } from "../src/router.js";
import type { Probe } from "../src/dependencies.js";

function mutableConfig(overrides: Partial<PorchlightConfig["mode"]> = {}): PorchlightConfig {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as PorchlightConfig;
  Object.assign(config.mode, overrides);
  // Re-normalize so derived fields (identity-only disables social serving)
  // stay consistent with what setup writes to disk.
  return normalizeConfig(config);
}

const OK_PROBES: { mongo: Probe; redis: Probe } = { mongo: async () => "ok", redis: async () => "ok" };

interface Json {
  [key: string]: unknown;
}
async function call(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: Json }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return { status: res.status, body: (await res.json()) as Json };
}

interface TestHub {
  app: Express;
  bootstrap: BootstrapService;
  config: PorchlightConfig;
  close: () => void;
  port: Promise<number>;
}

function testHub(
  overrides: Partial<PorchlightConfig["mode"]> = {},
  home = "/tmp/porchlight-test-home",
  hubUrl: () => string | null = () => null,
): TestHub {
  const db = createMemoryStore();
  const config = mutableConfig(overrides);
  const bootstrap = new BootstrapService(db, config, home);
  const app = createServer({ store: db, readiness: OK_PROBES, config, bootstrap, hubUrl });
  const { promise, resolve } = Promise.withResolvers<number>();
  const listener = app.listen(0, () => {
    const address = listener.address();
    const port = typeof address === "object" && address ? address.port : 0;
    resolve(port);
  });
  return { app, bootstrap, config, close: () => { listener.closeIdleConnections(); listener.close(); }, port: promise };
}

test("health route returns ok with dependency probes (contract)", async (t) => {
  const hub = testHub();
  t.after(hub.close);
  const port = await hub.port;

  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as { status: string; service: string; deps: { mongo: string; redis: string } };
  assert.equal(body.status, "ok");
  assert.equal(body.service, "porchlight-server");
  assert.deepEqual(body.deps, { mongo: "ok", redis: "ok" });
});

test("identity module owns the device-key account + auth flow (contract)", async (t) => {
  const hub = testHub();
  t.after(hub.close);
  const port = await hub.port;
  const base = `http://127.0.0.1:${port}/api/identity`;

  // The member's browser generates a non-extractable Ed25519 device key; only
  // the public half ever reaches the hub (ac-1 — hub verifies, never signs).
  const device = generateKeyPairSync("ed25519");
  const publicKeyJwk = device.publicKey.export({ format: "jwk" });
  const created = await fetch(`${base}/bootstrap/account`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Brian", device: { deviceId: "dev_1", publicKeyJwk } }),
  });
  assert.equal(created.status, 201);
  interface CreatedAccountBody { account: { did: string; actorType: string } }
  const createdBody = (await created.json()) as CreatedAccountBody;
  const account = createdBody.account;
  assert.match(account.did, /^did:porch:[0-9a-f]{40}$/);
  assert.equal(account.actorType, "human");

  // Challenge-signature auth proof → session tokens.
  const challengeRes = await fetch(`${base}/session/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did: account.did }),
  });
  assert.equal(challengeRes.status, 200);
  interface ChallengeBody { nonce: string }
  const challenge = (await challengeRes.json()) as ChallengeBody;
  const signature = sign(null, Buffer.from(challenge.nonce, "utf8"), device.privateKey).toString("base64url");
  const sessionRes = await fetch(`${base}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did: account.did, deviceId: "dev_1", nonce: challenge.nonce, signature }),
  });
  assert.equal(sessionRes.status, 201);
  interface SessionBody { accessToken: string; expiresInSeconds: number }
  const session = (await sessionRes.json()) as SessionBody;
  assert.equal(typeof session.accessToken, "string");
  assert.equal(session.expiresInSeconds, 600);

  // The DID document is served by the home hub as the homing pointer (ac-9).
  const docRes = await fetch(`${base}/did/${encodeURIComponent(account.did)}`);
  assert.equal(docRes.status, 200);
  assert.match(docRes.headers.get("content-type") ?? "", /did\+json/);
  interface DidDocumentBody { id: string }
  const document = (await docRes.json()) as DidDocumentBody;
  assert.equal(document.id, account.did);
});

test("identity hub serves well-known discovery surfaces (contract)", async (t) => {
  const hub = testHub({}, "/tmp/porchlight-test-home", () => "https://hub.test");
  t.after(hub.close);
  const port = await hub.port;

  const jwks = await fetch(`http://127.0.0.1:${port}/.well-known/jwks.json`);
  assert.equal(jwks.status, 200);
  interface JwksBody { keys: unknown[] }
  const jwksBody = (await jwks.json()) as JwksBody;
  assert.ok(jwksBody.keys.length >= 1);

  const oidc = await fetch(`http://127.0.0.1:${port}/.well-known/openid-configuration`);
  assert.equal(oidc.status, 200);
  interface DiscoveryBody { issuer: string; jwks_uri: string }
  const discovery = (await oidc.json()) as DiscoveryBody;
  assert.equal(discovery.issuer, "https://hub.test");
});

test("content engine: membership-gated signed post creation ends to end (contract)", async (t) => {
  const hub = testHub();
  t.after(hub.close);
  const port = await hub.port;

  // Member identity + admission (perimeter; see membership-perimeter test
  // for the full join flow): account → session → network → invite → admit.
  const device = generateKeyPairSync("ed25519");
  const publicKeyJwk = device.publicKey.export({ format: "jwk" });
  const account = await call(port, "/api/identity/bootstrap/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Brian", device: { deviceId: "dev_1", publicKeyJwk } }),
  });
  assert.equal(account.status, 201);
  const did = (account.body.account as Json).did as string;
  const challenge = await call(port, "/api/identity/session/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did }),
  });
  const session = await call(port, "/api/identity/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did, deviceId: "dev_1", nonce: challenge.body.nonce, signature: sign(null, Buffer.from(challenge.body.nonce as string, "utf8"), device.privateKey).toString("base64url") }),
  });
  assert.equal(session.status, 201);
  const identityToken = (session.body as Json).accessToken as string;

  await call(port, "/api/social/bootstrap/network", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Family" }) });
  const invite = await call(port, "/api/social/bootstrap/invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
  const code = (invite.body.joinUrl as string).split("/join/")[1];
  const admit = await call(port, "/api/social/join/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      identityAccessToken: identityToken,
      deviceId: "dev_1",
      devicePublicKeyJwk: publicKeyJwk,
      signature: sign(null, Buffer.from(`porchlight-join:${code}`, "utf8"), device.privateKey).toString("base64url"),
    }),
  });
  assert.equal(admit.status, 201);
  const membershipToken = (admit.body as Json).accessToken as string;

  // A post write carries the signed payload + the membership Bearer token.
  const payload = { type: "text", body: "hello family" };
  const signature = sign(null, Buffer.from(canonicalJson(payload), "utf8"), device.privateKey).toString("base64url");
  const created = await fetch(`http://127.0.0.1:${port}/api/social/posts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${membershipToken}` },
    body: JSON.stringify({ payload, signature }),
  });
  assert.equal(created.status, 200);
  const createdBody = (await created.json()) as { post: Json; did: string };
  assert.equal(createdBody.post.type, "text");
  assert.equal(createdBody.post.body, "hello family");
  assert.equal("interactionCounters" in createdBody.post, false); // rank inputs never leave
  assert.equal(createdBody.did, did);

  // An unsigned write is refused before any domain state exists.
  const unsigned = await fetch(`http://127.0.0.1:${port}/api/social/posts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${membershipToken}` },
    body: JSON.stringify({ payload }),
  });
  assert.equal(unsigned.status, 403);

  // A tokenless write cannot resolve a perimeter at all.
  const tokenless = await fetch(`http://127.0.0.1:${port}/api/social/posts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload, signature }),
  });
  assert.equal(tokenless.status, 401);

  // Comment + vote under the same perimeter; the view strips vote data.
  const postId = createdBody.post._id as string;
  const commentPayload = { postId, body: "nice!" };
  const comment = await fetch(`http://127.0.0.1:${port}/api/social/posts/${postId}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${membershipToken}` },
    body: JSON.stringify({
      payload: commentPayload,
      signature: sign(null, Buffer.from(canonicalJson(commentPayload), "utf8"), device.privateKey).toString("base64url"),
    }),
  });
  assert.equal(comment.status, 200);
  const reactions = await fetch(`http://127.0.0.1:${port}/api/social/posts/${postId}/reactions`);
  assert.equal(reactions.status, 401); // reads need a membership too

  // Deleting the authored post cascades through the same surface.
  const postJson = createdBody.post as Json;
  const originNetworkId = postJson.originNetworkId as string;
  const deletePayload = { kind: "delete", postId, networkId: originNetworkId };
  const removed = await fetch(`http://127.0.0.1:${port}/api/social/posts/${postId}`, {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${membershipToken}` },
    body: JSON.stringify({ signature: sign(null, Buffer.from(canonicalJson(deletePayload), "utf8"), device.privateKey).toString("base64url") }),
  });
  assert.equal(removed.status, 200);
  const removedBody = (await removed.json()) as { deleted: boolean; cascadeRows: number };
  assert.equal(removedBody.deleted, true);
  assert.equal(removedBody.cascadeRows >= 2, true); // post + comment at minimum
});

type FeedAccountBody = { account: { did: string } };
type FeedChallengeBody = { nonce: string };
type FeedSessionBody = { accessToken: string };
type FeedInviteBody = { joinUrl: string };
type FeedAdmitBody = { accessToken: string };
type FeedCreatedPostBody = { post: { _id: string } };
type FeedGroupBody = { group: { _id: string } };
type FeedGroupTimelineBody = { group: { _id: string }; posts: { _id: string }[] };
type FeedListBody = { posts: { _id: string }[] };
type FeedVoteBody = { vote: { postId: string; effective: string } };
type FeedRankingBody = { formula: string; parameters: Record<string, Record<string, unknown>> };

test("feed assembly: timeline, group view, ranked order, and search end to end (contract)", async (t) => {
  const hub = testHub();
  t.after(hub.close);
  const port = await hub.port;

  // Member identity + admission (same perimeter flow as the content test).
  const device = generateKeyPairSync("ed25519");
  const publicKeyJwk = device.publicKey.export({ format: "jwk" });
  const account = await call(port, "/api/identity/bootstrap/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Susan", device: { deviceId: "dev_1", publicKeyJwk } }),
  });
  assert.equal(account.status, 201);
  const did = (account.body as FeedAccountBody).account.did;
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
      deviceId: "dev_1",
      nonce: (challenge.body as FeedChallengeBody).nonce,
      signature: sign(null, Buffer.from((challenge.body as FeedChallengeBody).nonce, "utf8"), device.privateKey).toString("base64url"),
    }),
  });
  const identityToken = (session.body as FeedSessionBody).accessToken;
  await call(port, "/api/social/bootstrap/network", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Family" }) });
  const invite = await call(port, "/api/social/bootstrap/invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
  const inviteBody = invite.body as FeedInviteBody;
  const code = inviteBody.joinUrl.split("/join/")[1];
  const admit = await call(port, "/api/social/join/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      identityAccessToken: identityToken,
      deviceId: "dev_1",
      devicePublicKeyJwk: publicKeyJwk,
      signature: sign(null, Buffer.from(`porchlight-join:${code}`, "utf8"), device.privateKey).toString("base64url"),
    }),
  });
  const membershipToken = (admit.body as FeedAdmitBody).accessToken;
  const auth = { "content-type": "application/json", authorization: `Bearer ${membershipToken}` };
  const signedBody = (payload: object) =>
    JSON.stringify({ payload, signature: sign(null, Buffer.from(canonicalJson(payload), "utf8"), device.privateKey).toString("base64url") });
  const createPost = async (payload: object) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/social/posts`, { method: "POST", headers: auth, body: signedBody(payload) });
    assert.equal(res.status, 200);
    return ((await res.json()) as FeedCreatedPostBody).post;
  };

  const captioned = await createPost({ type: "photo", mediaRefs: ["med_1"], caption: "Picnic at the Lake" });
  await createPost({ type: "text", body: "plain text post" });

  // Group container: group timeline is the origin-filtered groupId query.
  const group = await call(port, "/api/social/console/groups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Picnic", members: [did] }),
  });
  assert.equal(group.status, 201);
  const groupId = (group.body as FeedGroupBody).group._id;
  const picnic = await createPost({ type: "text", body: "picnic logistics", groupId });
  const groupTimeline = await fetch(`http://127.0.0.1:${port}/api/social/timeline/groups/${groupId}`, { headers: auth });
  assert.equal(groupTimeline.status, 200);
  const groupBody = (await groupTimeline.json()) as FeedGroupTimelineBody;
  assert.equal(groupBody.group._id, groupId);
  assert.deepEqual(groupBody.posts.map((post) => post._id), [picnic._id]);

  // Base timeline: the member's origin posts, newest first; no rank inputs.
  const timeline = await fetch(`http://127.0.0.1:${port}/api/social/timeline`, { headers: auth });
  assert.equal(timeline.status, 200);
  const timelineBody = (await timeline.json()) as FeedListBody;
  assert.equal(timelineBody.posts.length, 3);
  for (const post of timelineBody.posts) {
    assert.equal("interactionCounters" in post, false); // vote privacy
    assert.equal("deviceSignature" in post, false);
  }

  // Ranked section: prominence order only; a signed vote keeps the vote
  // record internal; the ranked read exposes no vote arithmetic.
  const votePayload = { postId: captioned._id, value: "up" };
  const vote = await fetch(`http://127.0.0.1:${port}/api/social/posts/${captioned._id}/votes`, {
    method: "POST",
    headers: auth,
    body: signedBody(votePayload),
  });
  assert.equal(vote.status, 200);
  assert.deepEqual(Object.keys((await vote.json()) as FeedVoteBody).sort(), ["vote"]);
  const ranked = await fetch(`http://127.0.0.1:${port}/api/social/ranked`, { headers: auth });
  assert.equal(ranked.status, 200);
  const rankedBody = (await ranked.json()) as FeedListBody;
  assert.equal(rankedBody.posts.length >= 1, true);
  for (const post of rankedBody.posts) {
    assert.equal("interactionCounters" in post, false);
    assert.equal("voteVolume" in post, false);
  }

  // Plain-text search over captions, scoped to the origin.
  const search = await fetch(`http://127.0.0.1:${port}/api/social/search?q=${encodeURIComponent("picnic")}`, { headers: auth });
  assert.equal(search.status, 200);
  const searchBody = (await search.json()) as FeedListBody;
  assert.equal(searchBody.posts.some((post) => post._id === captioned._id), true);

  // Owner-readable ranking parameters surface on the console.
  const ranking = await call(port, "/api/social/console/ranking");
  assert.equal(ranking.status, 200);
  const rankingBody = ranking.body as FeedRankingBody;
  assert.equal(rankingBody.formula.length > 0, true);
  assert.deepEqual(Object.keys(rankingBody.parameters).sort(), ["ageDecay", "ratio", "weights", "window"]);
});

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value as Record<string, unknown>));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

test("missing fields return 400 without domain state", async (t) => {
  const hub = testHub();
  t.after(hub.close);
  const port = await hub.port;

  const res = await fetch(`http://127.0.0.1:${port}/api/identity/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test("bootstrap page is served as HTML at /bootstrap", async (t) => {
  const hub = testHub();
  t.after(hub.close);
  const port = await hub.port;

  const res = await fetch(`http://127.0.0.1:${port}/bootstrap`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await res.text(), /hub setup/);
});

test("bootstrap state route exposes the ledger with pending steps", async (t) => {
  const hub = testHub();
  t.after(hub.close);
  const port = await hub.port;

  const res = await fetch(`http://127.0.0.1:${port}/api/bootstrap/state`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { resumable: boolean; steps: Record<string, { status: string }> };
  assert.equal(body.resumable, false);
  assert.deepEqual(Object.values(body.steps).map((step) => step.status), ["pending", "pending", "pending", "pending"]);
});

test("first account creation records into the bootstrap ledger", async (t) => {
  const hub = testHub();
  t.after(hub.close);
  const port = await hub.port;

  const device = generateKeyPairSync("ed25519");
  const publicKeyJwk = device.publicKey.export({ format: "jwk" });
  const devicePayload = { deviceId: "dev_1", publicKeyJwk };
  const res = await fetch(`http://127.0.0.1:${port}/api/identity/bootstrap/account`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Brian", email: "b@example.com", device: devicePayload }),
  });
  assert.equal(res.status, 201);
  const again = await fetch(`http://127.0.0.1:${port}/api/identity/bootstrap/account`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Other", device: devicePayload }),
  });
  assert.equal(again.status, 200);

  const state = (await (await fetch(`http://127.0.0.1:${port}/api/bootstrap/state`)).json()) as { steps: Record<string, { status: string }> };
  assert.equal(state.steps.account.status, "complete");
});

test("identity adoption flows through the API and records the ledger", async (t) => {
  const homeHub = testHub();
  const adoptingHub = testHub();
  t.after(() => { homeHub.close(); adoptingHub.close(); });
  const homePort = await homeHub.port;
  const port = await adoptingHub.port;

  // The identity exists on its home hub first (second-hub adoption, ac-3).
  const device = generateKeyPairSync("ed25519");
  const publicKeyJwk = device.publicKey.export({ format: "jwk" });
  const created = await fetch(`http://127.0.0.1:${homePort}/api/identity/bootstrap/account`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Susan", device: { deviceId: "dev_s1", publicKeyJwk } }),
  });
  const createdBody = (await created.json()) as { account: { did: string; displayName: string } };

  // The adopting hub verifies the DID at its home hub and stores a reference —
  // the identity record never copies (the server adapter carries only a public shape).
  const res = await fetch(`http://127.0.0.1:${port}/api/identity/bootstrap/adopt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceHubUrl: `http://127.0.0.1:${homePort}`, did: createdBody.account.did }),
  });
  assert.equal(res.status, 201);
  interface AdoptedBody { adopted: boolean; account: { kind: string; did: string; adoptedIdentity: { sourceHubUrl: string; did: string } } }
  const body = (await res.json()) as AdoptedBody;
  assert.equal(body.adopted, true);
  assert.equal(body.account.kind, "adopted");
  assert.equal(body.account.did, createdBody.account.did);
  assert.equal(body.account.adoptedIdentity.did, createdBody.account.did);
});

test("network creation and invite issuance complete the social bootstrap steps", async (t) => {
  const hub = testHub();
  t.after(hub.close);
  const port = await hub.port;

  const network = await fetch(`http://127.0.0.1:${port}/api/social/bootstrap/network`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Family" }),
  });
  assert.equal(network.status, 201);

  const invite = await fetch(`http://127.0.0.1:${port}/api/social/bootstrap/invite`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hubUrl: "https://hub.example" }),
  });
  assert.equal(invite.status, 201);
  const inviteBody = (await invite.json()) as { invite: { state: string; token: string }, joinUrl: string | null };
  assert.equal(inviteBody.invite.state, "active");
  assert.ok(inviteBody.invite.token.length > 10);
});

test("invite issuance is refused before a network exists", async (t) => {
  const hub = testHub();
  t.after(hub.close);
  const port = await hub.port;

  const invite = await fetch(`http://127.0.0.1:${port}/api/social/bootstrap/invite`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(invite.status, 409);
});

test("quota settings complete over the API into the runtime config file", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "porchlight-quotas-"));
  const config = mutableConfig();
  saveConfig(home, config);
  const db = createMemoryStore();
  const bootstrap = new BootstrapService(db, config, home);
  const app = createServer({ store: db, readiness: OK_PROBES, config, bootstrap });
  const { promise, resolve } = Promise.withResolvers<number>();
  const listener = app.listen(0, () => {
    const address = listener.address();
    resolve(typeof address === "object" && address ? address.port : 0);
  });
  t.after(() => {
    listener.closeIdleConnections();
    listener.close();
  });
  t.after(() => void rm(home, { recursive: true, force: true }));
  const port = await promise;

  const res = await fetch(`http://127.0.0.1:${port}/api/bootstrap/quotas`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ storageCeilingMb: 5120, retentionDays: 365 }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { quota: { storageCeilingMb: number; retentionDays: number } };
  assert.deepEqual(body.quota, { storageCeilingMb: 5120, retentionDays: 365 });
  const stored = loadConfig(home);
  assert.equal(stored?.quota.storageCeilingMb, 5120);
});

test("quota values below zero are refused before any write", async (t) => {
  const hub = testHub();
  t.after(hub.close);
  const port = await hub.port;

  const res = await fetch(`http://127.0.0.1:${port}/api/bootstrap/quotas`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ storageCeilingMb: -1 }),
  });
  assert.equal(res.status, 400);
});

test("identity-only mode exposes no social routes (phase configuration)", async (t) => {
  const hub = testHub({ deploymentMode: "identity-only" });
  t.after(hub.close);
  const port = await hub.port;

  const res = await fetch(`http://127.0.0.1:${port}/api/social/network`);
  assert.equal(res.status, 404);
  const identity = await fetch(`http://127.0.0.1:${port}/api/identity/account`);
  assert.equal(identity.status, 200);
});