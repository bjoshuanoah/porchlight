import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, createMemoryStore } from "@porchlight/shared";
import { BOOTSTRAP_STEPS, BootstrapService } from "../src/services/bootstrap.service.js";

function service() {
  const db = createMemoryStore();
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  return { db, config, bootstrap: new BootstrapService(db, config, "/tmp/porchlight-test-home") };
}

test("a fresh ledger reports every step pending and not resumable", async () => {
  const { bootstrap } = service();
  const status = await bootstrap.status();
  // PORCH-020: the flow owns exactly two steps — invites and settings live
  // in the owner console, never as bootstrap steps.
  assert.deepEqual(BOOTSTRAP_STEPS, ["account", "network"]);
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
  // Both flow steps done: bootstrap is complete, not resumable, and the
  // owner lands in the network — no invite/quota rows exist to re-run.
  assert.equal(BOOTSTRAP_STEPS.every((step) => status.steps[step].status === "complete"), true);
  assert.equal(status.resumable, false);
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