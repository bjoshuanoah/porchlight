import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
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

interface TestHub {
  app: Express;
  bootstrap: BootstrapService;
  config: PorchlightConfig;
  close: () => void;
  port: Promise<number>;
}

function testHub(overrides: Partial<PorchlightConfig["mode"]> = {}, home = "/tmp/porchlight-test-home"): TestHub {
  const db = createMemoryStore();
  const config = mutableConfig(overrides);
  const bootstrap = new BootstrapService(db, config, home);
  const app = createServer({ store: db, readiness: OK_PROBES, config, bootstrap });
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

test("identity module owns /api/identity session creation (contract)", async (t) => {
  const hub = testHub();
  t.after(hub.close);
  const port = await hub.port;

  const res = await fetch(`http://127.0.0.1:${port}/api/identity/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "user_1" }),
  });
  assert.equal(res.status, 201);

  const body = (await res.json()) as { userId: string; token: string };
  assert.equal(body.userId, "user_1");
  assert.equal(typeof body.token, "string");
});

test("social module owns /api/social post creation (contract)", async (t) => {
  const hub = testHub();
  t.after(hub.close);
  const port = await hub.port;

  const res = await fetch(`http://127.0.0.1:${port}/api/social/posts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "user_1", body: "hello" }),
  });
  assert.equal(res.status, 201);

  const body = (await res.json()) as { userId: string; body: string };
  assert.equal(body.userId, "user_1");
  assert.equal(body.body, "hello");
});

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

  const res = await fetch(`http://127.0.0.1:${port}/api/identity/bootstrap/account`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Brian", email: "b@example.com" }),
  });
  assert.equal(res.status, 201);
  const again = await fetch(`http://127.0.0.1:${port}/api/identity/bootstrap/account`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Other" }),
  });
  assert.equal(again.status, 200);

  const state = (await (await fetch(`http://127.0.0.1:${port}/api/bootstrap/state`)).json()) as { steps: Record<string, { status: string }> };
  assert.equal(state.steps.account.status, "complete");
});

test("identity adoption flows through the API and records the ledger", async (t) => {
  const hub = testHub();
  t.after(hub.close);
  const port = await hub.port;

  const res = await fetch(`http://127.0.0.1:${port}/api/identity/bootstrap/adopt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceHubUrl: "https://other.hub.example", externalIdentityId: "ident_77" }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { adopted: boolean; account: { kind: string } };
  assert.equal(body.adopted, true);
  assert.equal(body.account.kind, "adopted");
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