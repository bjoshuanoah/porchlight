import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, createMemoryStore, loadConfig, saveConfig } from "@porchlight/shared";
import { BootstrapService, BOOTSTRAP_STEPS } from "../src/services/bootstrap.service.js";

function service() {
  const db = createMemoryStore();
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  return { db, config, bootstrap: new BootstrapService(db, config, "/tmp/porchlight-test-home") };
}

test("a fresh ledger reports every step pending and not resumable", async () => {
  const { bootstrap } = service();
  const status = await bootstrap.status();
  for (const step of BOOTSTRAP_STEPS) {
    assert.equal(status.steps[step].status, "pending");
  }
  assert.equal(status.resumable, false);
  assert.equal(status.lastError, null);
});

test("completed steps are recorded and stay complete across reloads", async () => {
  const { bootstrap } = service();
  await bootstrap.record("account", { detail: "owner account created" });
  await bootstrap.record("network", { detail: "network created" });

  const status = await bootstrap.status();
  assert.equal(status.steps.account.status, "complete");
  assert.equal(status.steps.network.detail, "network created");
  assert.equal(status.resumable, true);
  // Remaining steps stay pending: a re-run continues, never restarts.
  assert.equal(status.steps.invite.status, "pending");
});

test("a failed step is recorded as a diagnostic, not silently dropped", async () => {
  const { bootstrap } = service();
  await bootstrap.record("account", { detail: "owner account created" });
  await bootstrap.record("invite", { detail: "network missing when invite was requested", source: "bootstrap", failed: true });

  const status = await bootstrap.status();
  assert.equal(status.steps.invite.status, "failed");
  assert.equal(status.lastError, "network missing when invite was requested");
  assert.ok(status.diagnostics.length >= 1);
});

test("quota writes go to the runtime config, never a fork", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "porchlight-ledger-"));
  t.after(() => void rm(home, { recursive: true, force: true }));

  const { db } = service();
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  saveConfig(home, config as typeof DEFAULT_CONFIG);
  const bootstrap = new BootstrapService(db, config, home);

  const updated = await bootstrap.setQuotas({ storageCeilingMb: 2048 });
  assert.equal(updated.quota.storageCeilingMb, 2048);
  assert.equal(loadConfig(home)?.quota.retentionDays, null);
  const reread = await bootstrap.setQuotas({ retentionDays: 30 });
  assert.equal(reread.quota.retentionDays, 30);
});

test("quota validation refuses non-positive values", async () => {
  const { bootstrap } = service();
  await assert.rejects(() => bootstrap.setQuotas({ storageCeilingMb: 0 }), (error) => (error as { code?: string }).code === "E_INVALID_QUOTA");
});