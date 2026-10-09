// Unit tests for the crash-loop fallback machinery (PORCH-016 ac-5):
// a child that cannot reach readiness exhausts its restart budget, the
// group stops into a NAMED fallback state, and a ready-then-crash child
// never counts toward the budget (only failed STARTS do).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { homePaths, loadConfig, saveConfig, DEFAULT_CONFIG } from "@porchlight/shared";

function tempHome(t) {
  return mkdtemp(join(tmpdir(), "porchlight-fb-")).then(async (dir) => {
    t.after(() => void rm(dir, { recursive: true, force: true }));
    return dir;
  });
}

async function supervisorFor(t, dir, options) {
  const paths = homePaths({ PORCHLIGHT_HOME: dir });
  saveConfig(dir, DEFAULT_CONFIG);
  const { Supervisor } = await import("../src/supervisor.mjs");
  const { ensureDirs } = await import("../src/state.mjs");
  ensureDirs(paths);
  const supervisor = new Supervisor(paths, loadConfig(dir), options);
  const cleanup = supervisor.stop.bind(supervisor);
  t.after(() => cleanup());
  return { paths, supervisor };
}

async function until(predicate, timeoutMs = 10_000, everyMs = 50) {
  const startedAt = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((wait) => setTimeout(wait, everyMs));
  }
}

test("a child that never reaches readiness stops the group into a named fallback state", async (t) => {
  const dir = await tempHome(t);
  const { paths, supervisor } = await supervisorFor(t, dir, { maxFailedStarts: 3, backoffScale: 0.01 });

  // Alway-failing child: exits 1 immediately on every attempt.
  supervisor.spawnChild("hub", process.execPath, ["-e", "process.exit(1)"]);

  const fallback = await until(() => supervisor.fallbackState());
  assert.equal(fallback.state, "crash-loop-fallback");
  assert.equal(fallback.child, "hub");
  assert.equal(fallback.failedAttempts, 3);
  assert.match(fallback.lastError, /exited code=1/);
  assert.equal(fallback.log, join(paths.logs, "hub.log"));

  // The fallback is durable on disk exactly where status reads it.
  const { hubFallbackState } = await import("../src/supervisor.mjs");
  assert.deepEqual(hubFallbackState(paths), fallback);

  // The group is clearly stopped: the hub journal is cleared by the
  // group stop (no live pid survives the give-up).
  const hubJournalPath = join(paths.pidfiles, "hub.json");
  let hubJournal = null;
  try {
    hubJournal = JSON.parse(readFileSync(hubJournalPath, "utf8"));
  } catch {
    /* cleared — the stopped group keeps no journal */
  }
  if (hubJournal) assert.equal(hubJournal.pid ?? null, null);
});

test("a child that reached readiness does not count toward the crash-loop budget", async (t) => {
  const dir = await tempHome(t);
  const { paths, supervisor } = await supervisorFor(t, dir, { maxFailedStarts: 2, backoffScale: 0.01 });

  // Readies immediately, then exits — a crash after readiness restarts
  // normally forever without ever declaring the fallback.
  supervisor.spawnChild(
    "hub",
    process.execPath,
    ["-e", "process.on('SIGTERM', () => process.exit(0)); setTimeout(() => process.exit(0), 150);"],
    {
      ready: (_name, _proc, signalReady) => signalReady("hub"),
    },
  );

  // Wait for at least 3 real restarts of the ready-then-exit child.
  const journalPath = join(paths.pidfiles, "hub.json");
  await until(() => {
    try {
      return JSON.parse(readFileSync(journalPath, "utf8")).restarts >= 3 ? true : null;
    } catch {
      return null;
    }
  });
  assert.equal(supervisor.fallbackState(), null);
  const { hubFallbackState } = await import("../src/supervisor.mjs");
  assert.equal(hubFallbackState(paths), null);
});

test("readiness deadline turns a serve-but-sick child into counted failed starts", async (t) => {
  const dir = await tempHome(t);
  const { supervisor } = await supervisorFor(t, dir, { maxFailedStarts: 2, backoffScale: 0.01 });

  // Stays alive forever and never readies — with a never-signalling ready
  // probe plus the deadline, the deadline must kill it and every unready
  // attempt must count toward the budget.
  supervisor.spawnChild("hub", process.execPath, ["-e", "setInterval(() => {}, 9e9)"], {
    ready: () => {},
    readinessTimeoutMs: 300,
  });

  const fallback = await until(() => supervisor.fallbackState(), 15_000);
  assert.equal(fallback.state, "crash-loop-fallback");
  assert.equal(fallback.failedAttempts, 2);
  assert.match(fallback.lastError, /readiness deadline exceeded/);
});