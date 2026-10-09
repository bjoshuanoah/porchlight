import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_SCHEMA_VERSION, DEFAULT_CONFIG, loadConfig, normalizeConfig, saveConfig } from "../src/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function freshConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

test("normalizeConfig: identity-only mode derives its single serving domain (phase configuration, TS 6)", () => {
  const config = normalizeConfig({ ...freshConfig(), mode: { deploymentMode: "identity-only" } });
  assert.equal(config.mode.deploymentMode, "identity-only");
  assert.equal(config.mode.socialServingEnabled, false);
  assert.equal(config.mode.identityServingEnabled, true);
});

test("normalizeConfig: identity-only derivation overrides a contradicting social flag loudly at normalize time", () => {
  // Any config written with identity-only + social on re-emerges normalized:
  // runtime configuration can never produce a fork where social endpoints
  // mount in identity-only mode.
  const config = normalizeConfig({ ...freshConfig(), mode: { deploymentMode: "identity-only", socialServingEnabled: true } });
  assert.equal(config.mode.socialServingEnabled, false);
});

test("normalizeConfig: hosted and self-hosted keep serving flags owner-choosable", () => {
  // Phase 2 hosted hubs run both domains by default; configuration may
  // disable identity serving for hosted network modes, so hosted mode
  // derives nothing.
  for (const deploymentMode of ["self-hosted", "hosted"]) {
    const bothOn = normalizeConfig({ ...freshConfig(), mode: { deploymentMode } });
    assert.equal(bothOn.mode.identityServingEnabled, true);
    assert.equal(bothOn.mode.socialServingEnabled, true);

    const identityOff = normalizeConfig({
      ...freshConfig(),
      mode: { deploymentMode, identityServingEnabled: false, socialServingEnabled: true },
    });
    assert.equal(identityOff.mode.identityServingEnabled, false);
    assert.equal(identityOff.mode.socialServingEnabled, true);
  }
});

test("normalizeConfig: unknown deployment modes fail loudly (bootstrap diagnostics contract)", () => {
  assert.throws(
    () => normalizeConfig({ ...freshConfig(), mode: { deploymentMode: "nonsense" } }),
    /must be one of/,
  );
});

test("normalizeConfig: schemaVersion mismatch fails loudly, not silently defaulted", () => {
  const config = freshConfig();
  config.schemaVersion = CONFIG_SCHEMA_VERSION + 1;
  assert.throws(() => normalizeConfig(config), /schemaVersion/);
});

test("config round-trips through disk and re-normalizes on load (runtime config is the single source of truth)", () => {
  const root = mkdtempSync(join(tmpdir(), "porchlight-config-"));
  try {
    saveConfig(root, { ...freshConfig(), mode: { deploymentMode: "identity-only", socialServingEnabled: true } });
    const loaded = loadConfig(root);
    assert.equal(loaded.mode.deploymentMode, "identity-only");
    assert.equal(loaded.mode.socialServingEnabled, false);
    assert.equal(loaded.mode.identityServingEnabled, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});