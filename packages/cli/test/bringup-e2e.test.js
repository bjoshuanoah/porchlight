// E2E bring-up proof (PORCH-003 ac-1..ac-5). Gated behind PORCHLIGHT_E2E=1
// because it downloads real daemon binaries (~100 MB) and runs real daemons;
// the regular `npm run test` matrix stays deterministic without network.
// Run: npm run build && PORCHLIGHT_E2E=1 node --test test/bringup-e2e.test.js
// (server-adjacent tunnel leg of ac-3 is exercised live; see task evidence —
// this e2e runs without the tunnel to stay deterministic.)
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/porchlight.mjs", import.meta.url));
const enabled = process.env.PORCHLIGHT_E2E === "1";

function cli(args) {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  return child;
}

function killTree(child) {
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode == null) child.kill("SIGKILL");
  }, 5000).unref();
}

async function waitHealthy(base, timeoutMs = 90_000) {
  const startedAt = Date.now();
  for (;;) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`hub not healthy within ${timeoutMs}ms: ${base}`);
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return res.json();
    } catch {
      /* retry */
    }
    await new Promise((wait) => setTimeout(wait, 500));
  }
}

async function waitHubDown(base, timeoutMs = 30_000) {
  const startedAt = Date.now();
  for (;;) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`hub still reachable at ${base} after ${timeoutMs}ms`);
    try {
      await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    await new Promise((wait) => setTimeout(wait, 500));
  }
}

async function getState(base) {
  return (await fetch(`${base}/api/bootstrap/state`)).json();
}

test("porchlight bring-up, supervision, resumable bootstrap, and setup completion", { skip: enabled ? false : "runs only with PORCHLIGHT_E2E=1" }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "porchlight-e2e-"));
  t.after(async () => {
    if (process.env.PORCHLIGHT_E2E_KEEP) { process.stdout.write(`e2e home kept: ${home}\n`); return; }
    // Supervised daemons flush and exit asynchronously after killTree; the
    // data dir can briefly still hold files when the removal lands. Retry
    // the removal instead of failing the test on a teardown race.
    for (let attempt = 0; attempt < 12; attempt++) {
      try { await rm(home, { recursive: true }); return; } catch (error) {
        if (error.code !== "ENOTEMPTY" && error.code !== "EBUSY") throw error;
        await new Promise((wait) => setTimeout(wait, 500));
      }
    }
  });
  process.stdout.write(`e2e home: ${home}\n`);

  // ---- ac-1: dependency-complete install path ----
  const setupOut = (await execFileP(process.execPath, [BIN, "setup", "--home", home], { maxBuffer: 4 * 1024 * 1024 })).stdout;
  assert.match(setupOut, /mongod ready/);
  assert.match(setupOut, /redis-server ready/);
  assert.match(setupOut, /cloudflared ready/);
  assert.match(setupOut, /setup complete/);

  // idempotent re-run (bootstrap/bring-up is re-runnable)
  const setupAgain = (await execFileP(process.execPath, [BIN, "setup", "--home", home], { maxBuffer: 1024 * 1024 })).stdout;
  assert.match(setupAgain, /keeping existing settings/);

  // Unique ports per run: daemons and listener must never collide with any
  // concurrently running porchlight instance (or an earlier crashed run).
  const seed = 10_000 + (process.pid % 20_000) * 3;
  const httpPort = 20_000 + (seed % 20_000);
  const mongoPort = 30_000 + (seed % 20_000);
  const redisPort = mongoPort + 1;
  {
    const { loadConfig, saveConfig } = await import("@porchlight/shared");
    const config = loadConfig(home);
    config.daemons.mongoPort = mongoPort;
    config.daemons.redisPort = redisPort;
    config.hub.httpPort = httpPort;
    saveConfig(home, config);
  }
  const base = `http://127.0.0.1:${httpPort}`;
  let hub = cli(["start", "--foreground", "--no-tunnel", "--home", home]);
  try {
    const health = await waitHealthy(base);
    // ---- ac-2: server on the setup-created config; deps reachable ----
    assert.equal(health.status, "ok");
    assert.deepEqual(health.deps, { mongo: "ok", redis: "ok" });

    // ---- ac-2/auto restart: kill mongo; supervisor restores it ----
    const journalPath = join(home, "state", "processes", "mongo.json");
    const before = JSON.parse(readFileSync(journalPath, "utf8"));
    process.kill(before.pid, "SIGKILL");
    let restored = null;
    const startedAt = Date.now();
    while (!restored && Date.now() - startedAt < 30_000) {
      await new Promise((wait) => setTimeout(wait, 1000));
      try {
        const current = JSON.parse(readFileSync(journalPath, "utf8"));
        if (current.pid !== before.pid && current.pid) {
          const after = await waitHealthy(base, 20_000);
          if (after.deps.mongo === "ok") restored = current;
        }
      } catch {
        /* retry */
      }
    }
    assert.ok(restored, "supervisor did not restart the mongo daemon");
    assert.ok(restored.restarts >= 1);

    // ---- ac-4: interrupted bootstrap — complete one step, then crash ----
    // Keys on device: the first account binds a device-held Ed25519 key
    // (identity core, PORCH-004). A device-less account can never open a
    // challenge-signature session, so creation without one must fail closed.
    const deviceless = await fetch(`${base}/api/identity/bootstrap/account`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstName: "Brian", lastName: "Noah" }),
    });
    assert.ok(deviceless.status >= 400, "a device-less first account must be rejected");
    assert.equal((await deviceless.json()).code, "E_DEVICE_KEY_REQUIRED");
    const { generateKeyPairSync } = await import("node:crypto");
    const bootstrapDevice = generateKeyPairSync("ed25519");
    const publicKeyJwk = bootstrapDevice.publicKey.export({ format: "jwk" });
    const response = await fetch(`${base}/api/identity/bootstrap/account`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstName: "Brian", lastName: "Noah", device: { deviceId: "dev_e2e", label: "Owner CLI", publicKeyJwk } }),
    });
    assert.ok([200, 201].includes(response.status));
    const preKill = await getState(base);
    assert.equal(preKill.steps.account.status, "complete", `ledger write expected pre-kill; got ${JSON.stringify(preKill.steps)}`);
  } finally {
    killTree(hub);
  }
  await waitHubDown(`http://127.0.0.1:${httpPort}`);

  // ---- re-run: resumable from the ledger; first account kept ----
  // The owner path re-runs `porchlight start` on the same home and config.
  hub = cli(["start", "--foreground", "--no-tunnel", "--home", home]);
  hub.stdout.on("data", (chunk) => process.stdout.write(`[phase2] ${chunk}`));
  hub.stderr.on("data", (chunk) => process.stdout.write(`[phase2:err] ${chunk}`));
  try {
    const health = await waitHealthy(base);
    assert.equal(health.status, "ok");
    // Compare the hub's ledger view against a direct Mongo read — if they
    // diverge, the hub misreads resumability; if both are pending, the
    // daemon data was lost in the crash (diagnostics for both cases).
    const { MongoClient } = await import("mongodb");
    const probe = new MongoClient(`mongodb://127.0.0.1:${mongoPort}/?directConnection=true`, {
      serverSelectionTimeoutMS: 8000,
    });
    await probe.connect();
    const directLedger = await probe.db("porchlight").collection("bootstrap_state").findOne({});
    process.stdout.write(
      `direct ledger after restart: ${directLedger ? JSON.stringify(Object.fromEntries(Object.entries(directLedger.steps ?? {}).map(([k, v]) => [k, v.status]))) : "MISSING"}\n`,
    );
    await probe.close();
    const resumed = await getState(base);
    assert.equal(
      resumed.steps.account.status,
      "complete",
      `ledger must survive the crash; got ${JSON.stringify(resumed.steps)} (diagnostics: ${JSON.stringify(resumed.diagnostics)})`,
    );
    assert.equal(resumed.steps.network.status, "pending");
    assert.equal(resumed.resumable, true);

    // drive the remaining steps through the CLI driver (the real owner path;
    // PORCH-020: two steps only — invites and settings live in the console)
    const driver = await execFileP(
      process.execPath,
      [BIN, "bootstrap", "--home", home, "--network", "Family"],
      { maxBuffer: 1024 * 1024 },
    );
    assert.match(driver.stdout, /\[skip\] account — already complete/);
    assert.match(driver.stdout, /\[done\] network — "Family"/);
    // Founder-root binding (PORCH-018): the resumed bootstrap still binds
    // the owner — the membership row exists the moment the network does.
    assert.match(driver.stdout, /owner bound to this network \(role: owner\)/);
    assert.doesNotMatch(driver.stdout, /invite|quota/);

    const final = await getState(base);
    for (const step of ["account", "network"]) {
      assert.equal(final.steps[step].status, "complete");
    }
    // ---- ac-5: the owner is bound and the network is live ----
    const network = (await (await fetch(`${base}/api/social/network`)).json()).network;
    assert.ok(String(network._id).startsWith("net_"));
    assert.equal(network.name, "Family");
  } finally {
    killTree(hub);
  }
});