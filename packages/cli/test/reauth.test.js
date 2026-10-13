// `porchlight reauth` (PORCH-065): the CLI half of the address-change
// owner re-auth. Machine-local mint over the hub's local listener with the
// shared ops token; the consume URL + single-use/expiry copy prints in plain
// language. All hub behavior is injected except for the refused-when-stopped
// case, which runs a real fetch against a dead listener — the hub must be
// running for any mint (the grant binds to its live serving state).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveConfig, DEFAULT_CONFIG } from "@porchlight/shared";

async function tempHome(t) {
  const dir = await mkdtemp(join(tmpdir(), "porchlight-reauth-"));
  t.after(() => void rm(dir, { recursive: true, force: true }));
  saveConfig(dir, DEFAULT_CONFIG);
  return dir;
}

function response(status, body) {
  return { status, body };
}

/** A lines-capturing impl: `fetch` mirrors the server contract. */
function harness({ link = null, status = null, statusPath = "/api/reauth/status" } = {}) {
  const calls = { link: [], status: [] };
  const lines = [];
  const impl = {
    write: (line) => lines.push(line),
    fetch: async (config, path, _init) => {
      if (path === "/api/reauth/link") {
        calls.link.push(path);
        if (!link) throw new Error("ECONNREFUSED 127.0.0.1:8710");
        return link;
      }
      if (path === statusPath) {
        calls.status.push(path);
        if (!status) throw new Error("ECONNREFUSED 127.0.0.1:8710");
        return status;
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
  return { impl, calls, lines };
}

test("link: mints and prints the consume URL with its single-use/expiry copy", async (t) => {
  const dir = await tempHome(t);
  const h = harness({
    link: response(201, {
      linkUrl: "https://new.porch.love/device-link/abc123",
      grantId: "dl_x",
      token: "abc123",
      expiresAt: "2026-10-14T00:00:00.000Z",
      base: "https://new.porch.love",
    }),
  });
  await import("../src/reauth.mjs").then(({ run }) => run({ home: dir, _: ["link"] }, h.impl));
  assert.equal(process.exitCode ?? 0, 0, h.lines.join(""));
  const out = h.lines.join("");
  assert.match(out, /https:\/\/new\.porch\.love\/device-link\/abc123/);
  assert.match(out, /single-use/);
  assert.match(out, /expires 2026-10-14 00:00:00Z/);
  assert.match(out, /re-auth grant minted/);
  t.after(() => (process.exitCode = undefined));
});

test("link: a stopped hub is refused in plain language — the grant binds to live serving state", async (t) => {
  const dir = await tempHome(t);
  const h = harness({});
  await import("../src/reauth.mjs").then(({ run }) => run({ home: dir, _: ["link"] }, h.impl));
  assert.equal(process.exitCode, 1);
  const out = h.lines.join("");
  assert.match(out, /the hub is not reachable on this machine/);
  assert.match(out, /start the hub first/);
  t.after(() => (process.exitCode = undefined));
});

test("link: a hub that has no recorded owner refuses with the server's plain language", async (t) => {
  const dir = await tempHome(t);
  const h = harness({
    link: response(409, {
      error: "the network row carries no recorded owner identity (the pre-founder-binding shape, PORCH-018) — the unlock cannot resolve who to re-bind. Nothing was minted.",
    }),
  });
  await import("../src/reauth.mjs").then(({ run }) => run({ home: dir, _: ["link"] }, h.impl));
  assert.equal(process.exitCode, 1);
  assert.match(h.lines.join(""), /carries no recorded owner identity/);
  t.after(() => (process.exitCode = undefined));
});

test("link: a machine without the ops token is refused — the mint is machine-local", async (t) => {
  const dir = await tempHome(t);
  const h = harness({ link: response(401, { error: "not machine local" }) });
  await import("../src/reauth.mjs").then(({ run }) => run({ home: dir, _: ["link"] }, h.impl));
  assert.equal(process.exitCode, 1);
  assert.match(h.lines.join(""), /no machine ops token/);
  t.after(() => (process.exitCode = undefined));
});

test("status: shows the serving origin, the last re-point, and clean residue", async (t) => {
  const dir = await tempHome(t);
  const h = harness({
    status: response(200, {
      servingOrigin: "https://new.porch.love",
      networkHubUrl: "https://new.porch.love",
      lastRepoint: { origin: "https://new.porch.love", at: "2026-10-13T21:00:00.000Z", surface: "console" },
      residue: [],
      instanceId: "iid-x",
    }),
  });
  await import("../src/reauth.mjs").then(({ run }) => run({ home: dir, _: ["status"] }, h.impl));
  assert.equal(process.exitCode ?? 0, 0, h.lines.join(""));
  const out = h.lines.join("");
  assert.match(out, /serving origin: https:\/\/new\.porch\.love/);
  assert.match(out, /last re-point:\s+https:\/\/new\.porch\.love at 2026-10-13T21:00:00\.000Z \(console\)/);
  assert.match(out, /residue: {8}none/);
  t.after(() => (process.exitCode = undefined));
});

test("status: residue lines are printed as diagnostics, never failures", async (t) => {
  const dir = await tempHome(t);
  const h = harness({
    status: response(200, {
      servingOrigin: "https://new.porch.love",
      lastRepoint: { origin: "https://new.porch.love", at: "2026-10-13T21:00:00.000Z", surface: "cli" },
      residue: [{ kind: "network_hubUrl", ref: "net_1", endpoint: "https://old.porch.love" }],
    }),
  });
  await import("../src/reauth.mjs").then(({ run }) => run({ home: dir, _: ["status"] }, h.impl));
  assert.ok(process.exitCode == null, `a residue diagnostic must not fail the command (exit ${process.exitCode})`);
  const out = h.lines.join("");
  assert.match(out, /network_hubUrl net_1/);
  assert.match(out, /diagnostics/);
  t.after(() => (process.exitCode = undefined));
});

test("an unknown subcommand (or none) refuses with usage", async (t) => {
  const dir = await tempHome(t);
  for (const args of [{ _: [] }, { _: ["migrate"] }]) {
    process.exitCode = undefined;
    await import("../src/reauth.mjs").then(({ run }) => run({ home: dir, ...args }, harness({}).impl));
    assert.equal(process.exitCode, 1);
    t.after(() => (process.exitCode = undefined));
  }
});

test("link runs for real against a dead local listener and refuses (the hub is stopped)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "porchlight-reauth-dead-"));
  t.after(() => void rm(dir, { recursive: true, force: true }));
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  // Port 1: nothing listens there — the refusal message exercises the real
  // fetch failure, not a coincidental neighbor on the default dev port.
  config.hub.httpPort = 1;
  await saveConfig(dir, config);
  await import("../src/reauth.mjs").then(({ run }) => run({ home: dir, _: ["link"] }, {}));
  assert.equal(process.exitCode, 1);
  t.after(() => (process.exitCode = undefined));
});

test("the bin dispatches reauth (unknown subcommand exits nonzero with usage)", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const bin = fileURLToPath(new URL("../bin/porchlight.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [bin, "reauth"], { encoding: "utf8", env: { ...process.env, PORCHLIGHT_HOME: "/tmp/porchlight-reauth-bin-nosuch" } });
  assert.equal(r.status, 1);
  // The command's refusals print through the shared stdout write (the
  // update.mjs convention); the bin's unknown-command path goes to stderr.
  assert.match(r.stdout, /porchlight reauth: unknown reauth command/);
});