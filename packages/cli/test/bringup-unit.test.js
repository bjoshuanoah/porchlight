// Unit tests for the bring-up internals under a throwaway porchlight home.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readFileSync } from "node:fs";
import { homePaths, loadConfig, saveConfig, DEFAULT_CONFIG } from "@porchlight/shared";
import { redisBottleTag } from "../src/binaries.mjs";

function tempHome(t) {
  return mkdtemp(join(tmpdir(), "porchlight-unit-")).then(async (dir) => {
    t.after(() => void rm(dir, { recursive: true, force: true }));
    return dir;
  });
}

test("config from an empty root normalizes to DEFAULT_CONFIG and persists", async (t) => {
  const dir = await tempHome(t);
  const saved = saveConfig(dir, {});
  assert.equal(saved.mode.deploymentMode, DEFAULT_CONFIG.mode.deploymentMode);
  assert.equal(saved.hub.httpPort, DEFAULT_CONFIG.hub.httpPort);
  const round = loadConfig(dir);
  assert.deepEqual(round, saved);
});

test("invalid mode and ports fail loudly (no silently half-configured hub)", () => {
  assert.throws(() => saveConfig("/tmp/porchlight-never", { mode: { deploymentMode: "nonsense" } }));
  assert.throws(() => saveConfig("/tmp/porchlight-never", { hub: { httpPort: 70000 } }));
});

test("PORCHLIGHT_HOME override drives the layout", () => {
  const paths = homePaths({ PORCHLIGHT_HOME: "/tmp/porchlight-where" });
  assert.equal(paths.root, "/tmp/porchlight-where");
  assert.equal(paths.mongoData, "/tmp/porchlight-where/data/mongo");
});

test("redis bottle tag selection: newest compatible macos tag wins", () => {
  const formula = {
    versions: { stable: "8.10.2" },
    bottle: {
      stable: {
        files: {
          arm64_golden_gate: { url: "a" },
          arm64_tahoe: { url: "b" },
          arm64_sequoia: { url: "c" },
          x86_64_linux: { url: "d" },
          arm64_linux: { url: "e" },
        },
      },
    },
  };
  const mac = { platform: "darwin", arch: "arm64", release: "27.0.0" };
  assert.equal(redisBottleTag(formula, mac), "arm64_golden_gate");
  assert.equal(redisBottleTag(formula, { ...mac, release: "25.0.0" }), "arm64_tahoe");
  assert.equal(redisBottleTag(formula, { platform: "linux", arch: "arm64", release: "6.1.0" }), "arm64_linux");
});

test("supervisor restarts an exited child automatically and journals it", async (t) => {
  const dir = await tempHome(t);
  const paths = homePaths({ PORCHLIGHT_HOME: dir });
  saveConfig(dir, DEFAULT_CONFIG);
  const { Supervisor } = await import("../src/supervisor.mjs");
  const { ensureDirs } = await import("../src/state.mjs");
  ensureDirs(paths);
  const supervisor = new Supervisor(paths, loadConfig(dir));
  t.after(() => supervisor.stop());

  // First child exits immediately; after the restart flag is set, every
  // later child stays up — so the journal must show >=1 restart and a live pid.
  const script = `if (process.env.PORCH_UNIT_LOOP === "1") { setInterval(() => {}, 9e9); } else { process.exit(3); }`;

  supervisor.spawnChild("tester", process.execPath, ["-e", script]);
  setTimeout(() => { process.env.PORCH_UNIT_LOOP = "1"; }, 300);
  const pidFile = join(paths.pidfiles, "tester.json");

  // Backoff after exit #1 is 2s; allow the restart to boot by t+3.5s.
  await new Promise((wait) => setTimeout(wait, 3500));
  const journal = JSON.parse(readFileSync(pidFile, "utf8"));
  assert.ok(journal.restarts >= 1, `expected restarts >= 1, got ${journal.restarts}`);
  assert.ok(journal.pid, "expected a live pid journaled after restart");
});