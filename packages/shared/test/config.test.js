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

test("normalizeConfig: hub.host is the operator bind address — 0.0.0.0 accepted, default stays loopback (PORCH-025 ac-1)", () => {
  // The default posture: loopback plus tunnel — LAN exposure is opt-in.
  assert.equal(DEFAULT_CONFIG.hub.host, "127.0.0.1");
  const lan = normalizeConfig({ ...freshConfig(), hub: { host: "0.0.0.0" } });
  assert.equal(lan.hub.host, "0.0.0.0");
  // The rest of the hub block survives the partial override.
  assert.equal(lan.hub.httpPort, 8710);
  assert.equal(lan.hub.tunnel.enabled, true);
});

test("normalizeConfig: a bind address that could never be a host fails loudly (PORCH-025)", () => {
  for (const bad of [123, "", "bad host", "http://x", "127.0.0.1/8", null]) {
    assert.throws(
      () => normalizeConfig({ ...freshConfig(), hub: { host: bad } }),
      /hub\.host must be a bind address/,
    );
  }
});

test("normalizeConfig: schemaVersion mismatch fails loudly, not silently defaulted", () => {
  const config = freshConfig();
  config.schemaVersion = CONFIG_SCHEMA_VERSION + 1;
  assert.throws(() => normalizeConfig(config), /schemaVersion/);
});

test("normalizeConfig: identity.adoptionEnabled defaults false — and one flip restores the adoption flows (PORCH-026)", () => {
  assert.equal(DEFAULT_CONFIG.identity.adoptionEnabled, false);
  // A config written before the field existed (no identity section at all)
  // normalizes to the hidden V1 posture, never an accidental re-entry.
  const legacy = normalizeConfig({ schemaVersion: CONFIG_SCHEMA_VERSION, hub: {} });
  assert.equal(legacy.identity.adoptionEnabled, false);
  // Flag flip = the single re-enable; the rest of the config is untouched.
  const enabled = normalizeConfig({ ...freshConfig(), identity: { adoptionEnabled: true } });
  assert.equal(enabled.identity.adoptionEnabled, true);
  assert.equal(enabled.hub.httpPort, 8710);
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
test("config media.root (PORCH-054): null keeps the hub data-directory default; an absolute path is honored", () => {
  const defaulted = normalizeConfig({ ...freshConfig() });
  assert.equal(defaulted.media.root, null);
  const nas = normalizeConfig({ ...freshConfig(), media: { root: "/Volumes/FamilyArchive" } });
  assert.equal(nas.media.root, "/Volumes/FamilyArchive");
});

test("config media.root (PORCH-054): a relative path fails loudly, never a silently moving archive", () => {
  assert.throws(() => normalizeConfig({ ...freshConfig(), media: { root: "relative/volume" } }), /absolute path/);
  for (const bad of ["", "media", ".", "./archive", null]) {
    if (bad === null) continue; // null is the default (legal)
    assert.throws(() => normalizeConfig({ ...freshConfig(), media: { root: bad } }), /absolute path/, bad);
  }
});

test("config media.volumePollSeconds (PORCH-054): the ready-and-waiting poll is an owner-readable value with sane bounds", () => {
  assert.equal(normalizeConfig({ ...freshConfig() }).media.volumePollSeconds, 10);
  assert.equal(normalizeConfig({ ...freshConfig(), media: { volumePollSeconds: 30 } }).media.volumePollSeconds, 30);
  for (const bad of [0, -1, 1.5, 3601, "10", null]) {
    assert.throws(
      () => normalizeConfig({ ...freshConfig(), media: { volumePollSeconds: bad } }),
      /volumePollSeconds/,
      `bad value ${String(bad)} must fail`,
    );
  }
});

test("config media.root round-trips through disk (the owner console edit persists)", () => {
  const root = mkdtempSync(join(tmpdir(), "porchlight-config-"));
  try {
    saveConfig(root, { ...freshConfig(), media: { root: "/Volumes/FamilyArchive" } });
    const loaded = loadConfig(root);
    assert.equal(loaded.media.root, "/Volumes/FamilyArchive");
    assert.equal(loaded.media.volumePollSeconds, 10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
