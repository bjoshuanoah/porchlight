// Unit tests for the shared update service (PORCH-040). The service is the
// ONE npm-backed update path behind both owner-initiated surfaces (owner
// console action + `porchlight update`): owner-initiated only (no timers, no
// registry call without an owner request), already-latest is a version
// statement with no install and no restart, a failed apply changes nothing
// and restarts nothing, and a successful apply hands the process to its
// supervisor through the injected graceful restart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateService, isNewerVersion, versionRank } from "../src/services/update.service.js";
import type { UpdateDeps } from "../src/services/update.service.js";

/** Counting fakes; the restart signal is awaited, never timed. */
function fakes({ latest, installError, registryError }: { latest?: string; installError?: string; registryError?: string } = {}) {
  const calls: { registry: number; install: string[]; restart: number } = { registry: 0, install: [], restart: 0 };
  const restarted = Promise.withResolvers<void>();
  return {
    calls,
    restarted,
    deps: {
      version: "1.0.0",
      registry: {
        latest: async () => {
          calls.registry += 1;
          if (registryError) throw new Error(registryError);
          return latest ?? "2.0.0";
        },
      },
      installer: {
        install: async (version: string) => {
          calls.install.push(version);
          if (installError) throw new Error(installError);
        },
      },
      opsTokenFile: null as string | null,
      restart: () => {
        calls.restart += 1;
        restarted.resolve();
      },
      restartDelayMs: 0,
    } satisfies UpdateDeps,
  };
}

test("version ranking: numeric triples, prerelease below the plain release, unparsable never newer", () => {
  assert.deepEqual(versionRank("v1.2.3"), [1, 2, 3]);
  assert.deepEqual(versionRank("1.2.3-rc.1"), [1, 2, 3]);
  assert.equal(isNewerVersion("1.0.1", "1.0.0"), true);
  assert.equal(isNewerVersion("2.0.0", "1.9.9"), true);
  assert.equal(isNewerVersion("1.0.0", "1.0.0"), false);
  assert.equal(isNewerVersion("1.0.0", "1.0.1"), false);
  assert.equal(isNewerVersion("1.0.0-beta", "1.0.0"), false);
  assert.equal(isNewerVersion("1.0.0", "1.0.0-beta"), true);
  assert.equal(isNewerVersion("not-a-version", "1.0.0"), false);
  assert.equal(isNewerVersion("2.0.0", null), false);
  assert.equal(isNewerVersion("2.0.0", "garbage"), false);
});

test("ac-4: an idle hub never touches the registry — no fetch without an owner request", async () => {
  const { calls, deps } = fakes();
  new UpdateService(deps);
  await Promise.resolve();
  assert.equal(calls.registry, 0);
  assert.deepEqual(calls.install, []);
  assert.equal(calls.restart, 0);
});

test("ac-4: the release check reads the registry only inside the owner's request — and nowhere else", async () => {
  const { calls, deps } = fakes();
  const service = new UpdateService(deps);
  assert.deepEqual(await service.status(), {
    current: "1.0.0",
    latest: "2.0.0",
    updateAvailable: true,
  });
  assert.equal(calls.registry, 1); // exactly one fetch, for the one check
  assert.deepEqual(calls.install, []);
  assert.equal(calls.restart, 0);
});

test("ac-4: an unreachable registry is a plain-language note, not a crash", async () => {
  const { deps } = fakes({ registryError: "getaddrinfo ENOTFOUND registry.npmjs.org" });
  const service = new UpdateService(deps);
  const status = await service.status();
  assert.equal(status.latest, null);
  assert.equal(status.updateAvailable, false);
  assert.match(status.note ?? "", /npm registry could not be reached/);
  assert.match(status.note ?? "", /Nothing was fetched, installed, or changed/);
});

test("ac-4: already-latest apply is the version statement only — no install, no restart", async () => {
  const { calls, deps } = fakes({ latest: "1.0.0" });
  const service = new UpdateService(deps);
  const result = await service.apply();
  assert.deepEqual(result, {
    status: "latest",
    release: { current: "1.0.0", latest: "1.0.0" },
  });
  assert.deepEqual(calls.install, []);
  // The failed-to-apply arm never schedules the restart: nothing fires.
  assert.equal(calls.restart, 0);
});

test("ac-1/ac-2: the owner action installs the newer release through npm and restarts through the supervisor seam", async () => {
  const { calls, deps, restarted } = fakes();
  const service = new UpdateService(deps);
  const result = await service.apply();
  assert.equal(result.status, "applied");
  assert.deepEqual(result.release, { from: "1.0.0", to: "2.0.0" });
  await restarted.promise;
  // Exactly the npm-backed path: the registry version, installed verbatim.
  assert.deepEqual(calls.install, ["2.0.0"]);
  // The restart fires AFTER the response value exists (scheduled post-apply)
  // and rides the injected supervisor seam, once.
  assert.equal(calls.restart, 1);
});

test("ac-3: a registry failure at apply changes nothing and restarts nothing", async () => {
  const { calls, deps } = fakes({ registryError: "ECONNRESET" });
  const service = new UpdateService(deps);
  const result = await service.apply();
  assert.equal(result.status, "failed");
  assert.match(result.error, /could not reach the npm registry/);
  assert.match(result.error, /the hub keeps serving the current release v1\.0\.0/);
  assert.deepEqual(calls.install, []);
  assert.equal(calls.restart, 0);
});

test("ac-1/2: a failed install keeps the prior release and names its state in plain language", async () => {
  const { calls, deps } = fakes({ installError: "npm EACCES: permission denied" });
  const service = new UpdateService(deps);
  const result = await service.apply();
  assert.equal(result.status, "failed");
  assert.match(result.error, /update to v2\.0\.0 could not be installed/);
  assert.match(result.error, /npm leaves the previous release in place on a failed install/);
  assert.match(result.error, /the hub keeps serving v1\.0\.0 and was not restarted/);
  assert.deepEqual(calls.install, ["2.0.0"]); // npm's own atomic step ran; npm rolled it back
  assert.equal(calls.restart, 0); // no handoff attempt on a failed install
});

test("ac-3: concurrent applies share one flight — npm's path runs exactly once", async () => {
  const { calls, deps, restarted } = fakes();
  const service = new UpdateService(deps);
  const [a, b] = await Promise.all([service.apply(), service.apply()]);
  assert.equal(a.status, "applied");
  assert.deepEqual(b, a);
  await restarted.promise;
  assert.deepEqual(calls.install, ["2.0.0"]);
  assert.equal(calls.restart, 1);
});

test("ac-3: an unknown running version refuses to apply — nothing half-changed", async () => {
  const { calls, deps } = fakes();
  const service = new UpdateService({ ...deps, version: null });
  const result = await service.apply();
  assert.equal(result.status, "failed");
  assert.match(result.error, /running release version is unknown/);
  assert.match(result.error, /Nothing was changed/);
  assert.deepEqual(calls.install, []);
  assert.equal(calls.restart, 0);
  void calls.registry;
});

test("ac-2: the ops token is minted machine-local (0600), stable across reads, and rejects every other token", () => {
  const dir = mkdtempSync(join(tmpdir(), "porchlight-ops-"));
  try {
    const opsTokenFile = join(dir, "state", "ops-token.json");
    const { deps } = fakes();
    const service = new UpdateService({ ...deps, opsTokenFile });
    const row = JSON.parse(readFileSync(opsTokenFile, "utf8")) as { token: string };
    assert.match(row.token, /^[0-9a-f]{64}$/);
    // 0600 on the file: machine-owner readable only.
    assert.equal(statSync(opsTokenFile).mode & 0o777, 0o600);
    assert.equal(service.verifyToken(row.token), true);
    assert.equal(service.verifyToken(""), false);
    assert.equal(service.verifyToken(`${row.token}x`), false);
    assert.equal(
      service.verifyToken(row.token.slice(0, -1) + (row.token.endsWith("a") ? "b" : "a")),
      false,
    );
    // A service reading an existing file re-uses the same token: stable.
    const service2 = new UpdateService({ ...deps, opsTokenFile });
    assert.equal(service2.verifyToken(row.token), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});