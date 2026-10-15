// Unit tests for the shared update service (PORCH-040). The service is the
// ONE npm-backed update path behind both owner-initiated surfaces (owner
// console action + `porchlight update`): owner-initiated only (no timers, no
// registry call without an owner request), already-latest is a version
// statement with no install and no restart, a failed apply changes nothing
// and restarts nothing, and a successful apply hands the process to its
// supervisor through the injected graceful restart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UpdateService,
  changelogSectionFor,
  githubReleaseBody,
  isNewerVersion,
  versionRank,
  readTarballMember,
  NOTES_MAX_CHARS,
} from "../src/services/update.service.js";
import type { UpdateDeps } from "../src/services/update.service.js";

/** Counting fakes; the restart signal is awaited, never timed. */
function fakes({
  latest,
  installError,
  registryError,
  githubBody = "Stub release notes for the pending release",
  changelog = null,
  githubError = null,
}: { latest?: string; installError?: string; registryError?: string; githubBody?: string | null; changelog?: string | null; githubError?: string | null } = {}) {
  const calls: { registry: number; install: string[]; restart: number; notesGithub: number; notesChangelog: number; notesVersions: string[] } = {
    registry: 0,
    install: [],
    restart: 0,
    notesGithub: 0,
    notesChangelog: 0,
    notesVersions: [],
  };
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
      notes: {
        githubReleaseBody: async (version: string) => {
          calls.notesGithub += 1;
          calls.notesVersions.push(version);
          if (githubError) throw new Error(githubError);
          return githubBody;
        },
        changelogSection: async (_version: string) => {
          calls.notesChangelog += 1;
          return changelog;
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
    notes: { source: "github-release", text: "Stub release notes for the pending release" },
  });
  assert.equal(calls.notesVersions[0], "2.0.0"); // notes resolve for the SHOWN target version
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
  assert.equal(calls.notesGithub, 0); // notes never ride the apply path (PORCH-077 ac-4)
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
// PORCH-077: the shared notes source chain behind both update surfaces.
test("porch-077 ac-3: an empty or unavailable GitHub release body falls back to the published package's CHANGELOG section", async () => {
  const { deps } = fakes({ githubBody: null, changelog: "Carries PORCH-077: release notes on the update surfaces." });
  const service = new UpdateService(deps);
  const status = await service.status();
  assert.deepEqual(status.notes, {
    source: "package-changelog",
    text: "Carries PORCH-077: release notes on the update surfaces.",
  });
});

test("porch-077 ac-3: the GitHub release reader refuses unavailable, empty, and oversized bodies — the chain then falls to the changelog", async () => {
  const original = globalThis.fetch;
  const stubFetch = (json: unknown, ok = true) =>
    (globalThis.fetch = (async () => ({ ok, status: ok ? 200 : 404, json: async () => json })) as unknown as typeof fetch);
  try {
    stubFetch({ body: "x".repeat(NOTES_MAX_CHARS + 1) });
    assert.equal(await githubReleaseBody("2.0.0"), null, "oversized body returns null — the chain falls back");
    stubFetch({ body: "" });
    assert.equal(await githubReleaseBody("2.0.0"), null, "empty body returns null — the chain falls back");
    stubFetch({ message: "Not Found" }, false);
    assert.equal(await githubReleaseBody("2.0.0"), null, "a missing release returns null — the chain falls back");
    stubFetch({ body: "Real published notes." });
    assert.equal(await githubReleaseBody("2.0.0"), "Real published notes.");
  } finally {
    globalThis.fetch = original;
  }
  // And the service chain turns that null into the changelog fallback.
  const { deps } = fakes({ githubBody: null, changelog: "Changelog section for the cut." });
  const service = new UpdateService(deps);
  const status = await service.status();
  assert.equal(status.notes?.source, "package-changelog");
  assert.equal(status.notes?.text, "Changelog section for the cut.");
});

test("porch-077 ac-3: an oversized changelog section renders truncated under the cap — never summarized", async () => {
  const long = "b".repeat(NOTES_MAX_CHARS + 500);
  const { deps } = fakes({ githubBody: null, changelog: long });
  const service = new UpdateService(deps);
  const status = await service.status();
  assert.equal(status.notes?.source, "package-changelog");
  assert.ok((status.notes?.text ?? "").startsWith("b".repeat(NOTES_MAX_CHARS)));
  assert.match(status.notes?.text ?? "", /truncated here, never summarized/);
  assert.ok(status.notes && status.notes.text.length < NOTES_MAX_CHARS + 200);
});

test("porch-077 ac-3: both sources missing resolve the plain named-unavailable line — never a generated summary", async () => {
  const { deps } = fakes({ githubBody: null, changelog: null });
  const service = new UpdateService(deps);
  const status = await service.status();
  assert.deepEqual(status.notes, {
    source: "unavailable",
    text:
      "Release notes for v2.0.0 are unavailable — the GitHub release body and the published " +
      "package's CHANGELOG section both could not be read. Notes are always the release's own published " +
      "content and are never generated.",
  });
});

test("porch-077 ac-3: a notes-chain failure names its state in plain language and never crashes the check", async () => {
  const { deps } = fakes({ githubError: "network unreachable" });
  const service = new UpdateService(deps);
  const status = await service.status();
  assert.equal(status.notes?.source, "unavailable");
  assert.match(status.notes?.text ?? "", /Release notes for v2\.0\.0 are unavailable \(network unreachable\)/);
});

test("porch-077 ac-2: an already-latest check fetches no notes — the version statement only", async () => {
  const { calls, deps } = fakes({ latest: "1.0.0" });
  const service = new UpdateService(deps);
  const status = await service.status();
  assert.equal(status.updateAvailable, false);
  assert.equal(status.notes, undefined);
  assert.equal(calls.notesGithub, 0);
  assert.equal(calls.notesChangelog, 0);
});

test("porch-077 ac-3: the changelog section parser extracts verbatim text to the next heading", () => {
  const changelog = [
    "# porchlight changelog",
    "",
    "Intro line.",
    "",
    "## v0.3.0 — 2026-10-14",
    "",
    "- Carries PORCH-077: notes on the update surfaces.",
    "- Carries PORCH-070: profile photo.",
    "",
    "## v0.2.0 — 2026-10-14",
    "",
    "- Earlier entry.",
    "",
    "### v0.1.9 — 2026-10-13",
    "",
    "- Nested-level heading must not leak into the running section.",
  ].join("\n");
  const section = changelogSectionFor(changelog, "0.3.0");
  assert.equal(section, [
    "",
    "- Carries PORCH-077: notes on the update surfaces.",
    "- Carries PORCH-070: profile photo.",
  ].join("\n").trim());
  assert.equal(changelogSectionFor(changelog, "9.9.9"), null);
  assert.equal(changelogSectionFor(changelog, "0.3.0-beta.1"), null);
  assert.equal(changelogSectionFor("", "0.1.0"), null);
});

test("porch-077 ac-3: the tarball reader extracts the published CHANGELOG member streaming and skips everything else", async () => {
  const changelogBytes = Buffer.from("## v0.3.0 — 2026-10-14\n\n- Carries PORCH-077.\n", "utf8");
  const filler = Buffer.alloc(2048, 0x61);
  const tarball = tarFile([
    { name: "package/README.md", data: filler.subarray(0, 600) },
    { name: "package/CHANGELOG.md", data: changelogBytes },
    { name: "package/src/hub.js", data: filler },
    { name: "package/bin/porchlight.mjs", data: filler.subarray(0, 512) },
  ]);
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/gzip" });
    res.end(tarball);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("the test server reported no address");
  const url = `http://127.0.0.1:${address.port}/porchlight.tgz`;
  try {
    const member = await readTarballMember(url, ["package/CHANGELOG.md"]);
    assert.equal(member?.toString("utf8"), "## v0.3.0 — 2026-10-14\n\n- Carries PORCH-077.\n");
    const missing = await readTarballMember(url, ["package/NOTES.md"]);
    assert.equal(missing, null);
  } finally {
    server.close();
  }
});

/** Minimal ustar builder for the tarball-reader seam test (no npm, no network). */
function tarFile(members: { name: string; data: Buffer }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const { name, data } of members) {
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100, "utf8");
    header.write("0001750\0", 108, "utf8");
    header.write("0001750\0", 116, "utf8");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "utf8");
    header.write("        ", 148, "utf8");
    header.write("0", 156, "utf8");
    header.write("ustar\0", 257, "utf8");
    header.write("00", 263, "utf8");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive marker
  return gzipSync(Buffer.concat(blocks));
}
