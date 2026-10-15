// `porchlight update` (PORCH-040): the CLI drives the hub's ONE shared
// update service over HTTP — the same path the owner console uses. Already-
// latest is a version statement only; a failed apply reports plain language
// and changes nothing; a successful apply waits for the restarted hub and
// reports clean completion. All hub behavior is injected; no network, no
// real hub process.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveConfig, DEFAULT_CONFIG } from "@porchlight/shared";

async function tempHome(t) {
  const dir = await mkdtemp(join(tmpdir(), "porchlight-update-"));
  t.after(() => void rm(dir, { recursive: true, force: true }));
  saveConfig(dir, DEFAULT_CONFIG);
  return dir;
}

function harness({ statusBody, applyBody, applyStatus = 200, statusError = null, healthy = true } = {}) {
  const calls = { status: 0, apply: 0, wait: 0, lines: [] };
  return {
    calls,
    impl: {
      write: (line) => calls.lines.push(line),
      fetchStatus: async () => {
        calls.status += 1;
        if (statusError) throw statusError;
        return { status: 200, body: statusBody };
      },
      fetchApply: async () => {
        calls.apply += 1;
        return { status: applyStatus, body: applyBody };
      },
      waitForHub: async () => {
        calls.wait += 1;
        return healthy;
      },
    },
  };
}

test("ac-2: an already-latest hub is a version statement — no apply, no restart, no side effects", async (t) => {
  t.after(() => { process.exitCode = undefined; });
  const dir = await tempHome(t);
  const h = harness({
    statusBody: { release: { current: "1.2.3", latest: "1.2.3", updateAvailable: false } },
  });
  await import("../src/update.mjs").then(({ run }) => run({ home: dir }, h.impl));
  assert.equal(h.calls.apply, 0);
  assert.equal(h.calls.wait, 0);
  assert.deepEqual(
    h.calls.lines,
    ["porchlight v1.2.3 is the latest release — nothing to do.\n"],
  );
  assert.equal(process.exitCode ?? 0, 0);
});

test("ac-2: a newer release is applied through the shared path and completion is reported after the hub returns", async (t) => {
  t.after(() => { process.exitCode = undefined; });
  const dir = await tempHome(t);
  const h = harness({
    statusBody: { release: { current: "1.2.3", latest: "2.0.0", updateAvailable: true } },
    applyBody: { status: "applied", release: { from: "1.2.3", to: "2.0.0" } },
  });
  await import("../src/update.mjs").then(({ run }) => run({ home: dir }, h.impl));
  assert.equal(h.calls.apply, 1);
  assert.equal(h.calls.wait, 1);
  assert.deepEqual(h.calls.lines, [
    "current release: v1.2.3\n",
    "latest release:  v2.0.0 (npm registry)\n",
    "applying the update through the hub's update service...\n",
    "update installed — the hub is restarting (v1.2.3 → v2.0.0)...\n",
    "porchlight updated: v1.2.3 → v2.0.0 — the hub is serving again at http://127.0.0.1:8710\n",
  ]);
  assert.equal(process.exitCode ?? 0, 0);
});

test("porch-077 ac-2: the CLI prints the pending release's notes before any apply — verbatim from the shared chain", async (t) => {
  t.after(() => { process.exitCode = undefined; });
  const dir = await tempHome(t);
  const notesText = "Carries PORCH-077: release notes on the update surfaces (Brian, Oct 14, 2026).";
  const h = harness({
    statusBody: {
      release: {
        current: "1.2.3",
        latest: "2.0.0",
        updateAvailable: true,
        notes: { source: "github-release", text: notesText },
      },
    },
    applyBody: { status: "applied", release: { from: "1.2.3", to: "2.0.0" } },
  });
  await import("../src/update.mjs").then(({ run }) => run({ home: dir }, h.impl));
  // The notes print BEFORE the apply call and verbatim — never a summary.
  assert.deepEqual(h.calls.lines, [
    `what v2.0.0 changes (verbatim from the GitHub release):\n`,
    `${notesText}\n`,
    "\n",
    "current release: v1.2.3\n",
    "latest release:  v2.0.0 (npm registry)\n",
    "applying the update through the hub's update service...\n",
    "update installed — the hub is restarting (v1.2.3 → v2.0.0)...\n",
    "porchlight updated: v1.2.3 → v2.0.0 — the hub is serving again at http://127.0.0.1:8710\n",
  ]);
  assert.equal(h.calls.apply, 1);
  assert.equal(process.exitCode ?? 0, 0);
});

test("porch-077 ac-3: an unavailable notes chain prints the named-unavailable line and still applies cleanly", async (t) => {
  t.after(() => { process.exitCode = undefined; });
  const dir = await tempHome(t);
  const unavailableLine =
    "Release notes for v2.0.0 are unavailable — the GitHub release body and the published package's CHANGELOG section both could not be read. Notes are always the release's own published content and are never generated.";
  const h = harness({
    statusBody: {
      release: {
        current: "1.2.3",
        latest: "2.0.0",
        updateAvailable: true,
        notes: { source: "unavailable", text: unavailableLine },
      },
    },
    applyBody: { status: "applied", release: { from: "1.2.3", to: "2.0.0" } },
  });
  await import("../src/update.mjs").then(({ run }) => run({ home: dir }, h.impl));
  const joined = h.calls.lines.join("");
  assert.match(joined, new RegExp(unavailableLine.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // Notes never gate the apply: unavailable notes, applied anyway.
  assert.equal(h.calls.apply, 1);
  assert.match(joined, /porchlight updated: v1\.2\.3 → v2\.0\.0/);
  assert.equal(process.exitCode ?? 0, 0);
});

test("ac-2: the CLI reports the running version and an unreachable registry in plain language", async (t) => {
  t.after(() => { process.exitCode = undefined; });
  const dir = await tempHome(t);
  const h = harness({
    statusBody: { release: { current: "1.2.3", latest: null, note: "the npm registry could not be reached, so the latest release is unknown (ETIMEDOUT). Nothing was fetched, installed, or changed." } },
  });
  await import("../src/update.mjs").then(({ run }) => run({ home: dir }, h.impl));
  assert.equal(h.calls.apply, 0);
  assert.match(h.calls.lines.join(""), /current release: v1\.2\.3/);
  assert.match(h.calls.lines.join(""), /npm registry could not be reached/);
  assert.equal(process.exitCode, 1);
});

test("ac-3: a failed apply reports the hub's plain-language state — nothing is restarted", async (t) => {
  t.after(() => { process.exitCode = undefined; });
  const dir = await tempHome(t);
  const h = harness({
    statusBody: { release: { current: "1.2.3", latest: "2.0.0", updateAvailable: true } },
    applyBody: {
      status: "failed",
      error: "the update to v2.0.0 could not be installed (npm EACCES). npm leaves the previous release in place on a failed install — the hub keeps serving v1.2.3 and was not restarted.",
      release: { current: "1.2.3" },
    },
  });
  await import("../src/update.mjs").then(({ run }) => run({ home: dir }, h.impl));
  assert.equal(h.calls.wait, 0);
  assert.match(h.calls.lines.join(""), /could not be installed \(npm EACCES\)/);
  assert.match(h.calls.lines.join(""), /hub keeps serving v1\.2\.3/);
  assert.equal(process.exitCode, 1);
});

test("ac-3: a hub that does not come back healthy after the restart is named, with the status command as the next step", async (t) => {
  t.after(() => { process.exitCode = undefined; });
  const dir = await tempHome(t);
  const h = harness({
    statusBody: { release: { current: "1.2.3", latest: "2.0.0", updateAvailable: true } },
    applyBody: { status: "applied", release: { from: "1.2.3", to: "2.0.0" } },
    healthy: false,
  });
  await import("../src/update.mjs").then(({ run }) => run({ home: dir }, { ...h.impl, waitMs: 5 }));
  assert.match(h.calls.lines.join(""), /has not come back healthy within/);
  assert.match(h.calls.lines.join(""), /porchlight status/);
  assert.equal(process.exitCode, 1);
});

test("ac-4: an unreachable hub is refused — the command changes nothing", async (t) => {
  t.after(() => { process.exitCode = undefined; });
  const dir = await tempHome(t);
  const h = harness({ statusError: new Error("hub unreachable for /api/social/console/update") });
  await import("../src/update.mjs").then(({ run }) => run({ home: dir }, h.impl));
  assert.equal(h.calls.apply, 0);
  assert.match(h.calls.lines.join(""), /hub is unreachable/);
  assert.match(h.calls.lines.join(""), /nothing was checked or changed/);
  assert.equal(process.exitCode, 1);
});

test("the command refuses without any credential and points at the console", async (t) => {
  t.after(() => { process.exitCode = undefined; });
  const dir = await tempHome(t);
  // No ops-token file in the temp home; the hub answer is perimeter-gated.
  const h = harness({ statusBody: { code: "E_SESSION_REQUIRED" }, applyStatus: 401 });
  // Simulate the hub's 401: fetchStatus returns the non-JSON-free JSON body with status.
  h.impl.fetchStatus = async () => ({ status: 401, body: { code: "E_SESSION_REQUIRED" } });
  await import("../src/update.mjs").then(({ run }) => run({ home: dir }, h.impl));
  assert.equal(h.calls.apply, 0);
  assert.match(h.calls.lines.join(""), /the hub refused this command/);
  assert.match(h.calls.lines.join(""), /owner console instead/);
  assert.equal(process.exitCode, 1);
});