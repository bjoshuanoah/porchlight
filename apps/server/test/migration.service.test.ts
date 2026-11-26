// Unit tests for the versioned data-migration runner (PORCH-156, Operations
// and Owner Tooling amendment "Data migrations on update"). Pinned here: the
// once-only per-hub execution and its document-count assertions, the
// declared-version execution order, resumption at the incomplete step after
// an interruption (mid-set failure), completion-before-traffic refusal with
// plain-language diagnostics naming the failing step, the owner-initiated
// gate for destructive-capable steps, the activation gate for steps whose
// release cut has not shipped, and the outcome-count ledger bound to each
// step's identity.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MigrationRunner,
  MigrationStepFailure,
  MIGRATION_LEDGER_COLLECTION,
  parseMigrationCliArgs,
  runHubMigrations,
} from "../src/services/migration.service.js";
import { HUB_MIGRATIONS } from "../src/services/migrations/index.js";
import { fakeMigrationStore, type Row } from "./helpers/migration-store.js";
import type { MigrationStep, MigrationStore } from "../src/services/migration.service.js";

/** A counting migration step: inserts one doc per apply, returns counts. */
type CountingStepOptions = {
  version: number;
  name: string;
  /** Defaults to an activating release of "0.0.0" (active in any release). */
  activatesIn?: string | null;
  destructive?: boolean;
  fail?: string;
  outcome?: { read: number; written: number; collisions: number };
};

function countingStep(options: CountingStepOptions): { step: MigrationStep; applies: () => number } {
  let applies = 0;
  const step: MigrationStep = {
    version: options.version,
    name: options.name,
    activatesIn: options.activatesIn === undefined ? "0.0.0" : options.activatesIn,
    destructive: options.destructive ?? false,
    async apply({ store }) {
      applies += 1;
      if (options.fail) throw new Error(options.fail);
      await store.collection(`data_v${options.version}`).insertOne({ applied: new Date().toISOString() });
      return options.outcome ?? { read: 1, written: 1, collisions: 0 };
    },
  };
  return { step, applies: () => applies };
}

function runnerFor(store: MigrationStore, steps: MigrationStep[], release = "1.2.3", log: string[] = []): MigrationRunner {
  return new MigrationRunner(steps, store, { release, log: (line) => log.push(line) });
}

test("applies the pending set once, in declared version order, and never re-applies on a second run", async () => {
  const { store, data } = fakeMigrationStore();
  // Registered out of order on purpose: execution follows declared version,
  // never registration order.
  const v1 = countingStep({ version: 1, name: "first", outcome: { read: 3, written: 2, collisions: 0 } });
  const v3 = countingStep({ version: 3, name: "third", outcome: { read: 4, written: 4, collisions: 1 } });
  const v2 = countingStep({ version: 2, name: "second", outcome: { read: 2, written: 1, collisions: 0 } });

  const runner = runnerFor(store, [v3.step, v1.step, v2.step]);
  const first = await runner.runPending();
  assert.deepEqual(
    first.applied.map((record) => record.version),
    [1, 2, 3],
    "execution follows the declared version order",
  );
  assert.equal(v1.applies(), 1);
  assert.equal(v2.applies(), 1);
  assert.equal(v3.applies(), 1);
  for (const version of [1, 2, 3]) {
    assert.equal((data.get(`data_v${version}`) as Row[]).length, 1, `v${version} applied exactly once`);
  }

  // The once-only re-run: no re-apply, no skip, counts unchanged.
  const second = await runner.runPending();
  assert.deepEqual(second.applied, []);
  assert.equal(v1.applies(), 1);
  assert.deepEqual(second.skippedUnactivated, []);

  const ledgerDocs = (data.get(MIGRATION_LEDGER_COLLECTION) as Row[]) ?? [];
  assert.equal(ledgerDocs.length, 3, "the ledger holds one record per applied step");
});

test("an interruption mid-set leaves the completed steps recorded and resumes exactly at the incomplete step", async () => {
  const { store, data } = fakeMigrationStore();
  const v1 = countingStep({ version: 1, name: "fine" });
  const v2 = countingStep({ version: 2, name: "broken", fail: "the archive collection is locked by the storage volume" });
  const v3 = countingStep({ version: 3, name: "after" });

  const failing = runnerFor(store, [v1.step, v2.step, v3.step]);
  await assert.rejects(
    failing.runPending(),
    (error: MigrationStepFailure) => {
      assert.equal(error.version, 2);
      assert.equal(error.stepName, "broken");
      assert.match(error.message, /data migration step v2 \(broken\) failed/);
      assert.match(error.message, /resumes exactly at v2 on the next boot/);
      assert.match(error.message, /v1 \(fine\), recorded once-only/);
      return true;
    },
    "the failure names the failing step in plain language",
  );
  assert.equal(v1.applies(), 1);
  assert.equal(v2.applies(), 1);
  assert.equal(v3.applies(), 0, "the set stopped at the incomplete step");
  const ledgerDocs = (data.get(MIGRATION_LEDGER_COLLECTION) as Row[]) ?? [];
  assert.deepEqual(
    ledgerDocs.map((row) => row.version),
    [1],
    "only the completed steps are on the ledger",
  );

  // The restart: a fresh runner over the same hub finishes v2 and continues.
  const v2Fixed = countingStep({ version: 2, name: "broken" });
  const v3Fixed = countingStep({ version: 3, name: "after" });
  const resumed = runnerFor(store, [v1.step, v2Fixed.step, v3Fixed.step]);
  const result = await resumed.runPending();
  assert.deepEqual(
    result.applied.map((record) => record.version),
    [2, 3],
    "the pending set resumes at the incomplete step — v1 is never double-applied",
  );
  assert.equal(v1.applies(), 1, "v1 applied once and only once across the interruption");
  assert.equal(v2Fixed.applies(), 1);
});

test("a destructive-capable step refuses to run without an owner-initiated path and applies only on one", async () => {
  const { store, data } = fakeMigrationStore();
  const destructive = countingStep({
    version: 1,
    name: "reindex-archive",
    destructive: true,
    outcome: { read: 10, written: 0, collisions: 0 },
  });
  const runner = runnerFor(store, [destructive.step]);

  const refused = await runner.runPending();
  assert.deepEqual(refused.applied, []);
  assert.deepEqual(
    refused.skippedDestructive,
    ["v1 (reindex-archive)"],
    "the destructive-capable step refuses without an owner-initiated run",
  );
  assert.equal(destructive.applies(), 0);
  assert.equal(((data.get(MIGRATION_LEDGER_COLLECTION) as Row[]) ?? []).length, 0);

  const ownerRun = await runner.runPending({ ownerInitiated: true });
  assert.deepEqual(
    ownerRun.applied.map((record) => record.version),
    [1],
    "the owner-initiated path is the only way a destructive step runs",
  );
  assert.equal(destructive.applies(), 1);
});

test("a declared step whose activating release has not shipped stays inert until forced by the owner", async () => {
  const { store } = fakeMigrationStore();
  const caption = countingStep({
    version: 1,
    name: "post-text-consolidation",
    activatesIn: null,
    outcome: { read: 5, written: 5, collisions: 1 },
  });
  // The current release is 1.2.3; the step activates in 2.0.0.
  const runner = runnerFor(store, [caption.step], "1.2.3");

  const inactive = await runner.runPending();
  assert.deepEqual(inactive.applied, []);
  assert.equal(caption.applies(), 0, "an unreleased step never applies on a hub update");
  assert.deepEqual(inactive.skippedUnactivated, ["v1 (post-text-consolidation)"]);

  const cutStep = countingStep({
    version: 1,
    name: "post-text-consolidation",
    activatesIn: "2.0.0",
    outcome: { read: 5, written: 5, collisions: 1 },
  });
  const activeOnCut = runnerFor(store, [cutStep.step], "2.0.0");
  const result = await activeOnCut.runPending();
  assert.deepEqual(
    result.applied.map((record) => record.version),
    [1],
    "the step activates exactly at its cut",
  );

  // The explicit owner hook forces an unactivated step for one run —
  // still once-only, still ledger-recorded.
  const { store: store2 } = fakeMigrationStore();
  const caption2 = countingStep({
    version: 1,
    name: "post-text-consolidation",
    activatesIn: null,
    outcome: { read: 5, written: 5, collisions: 0 },
  });
  const forced = runnerFor(store2, [caption2.step], "1.2.3");
  const forcedOnce = await forced.runPending({ forceVersions: [1] });
  assert.deepEqual(forcedOnce.applied.map((record) => record.version), [1]);
  assert.equal(caption2.applies(), 1);
  const forcedAgain = await forced.runPending({ forceVersions: [1] });
  assert.deepEqual(forcedAgain.applied, []);
  assert.equal(caption2.applies(), 1, "even a forced run stays once-only per hub");
});

test("an unknown release version refuses to guess activation", async () => {
  const { store, data } = fakeMigrationStore();
  const caption = countingStep({ version: 1, name: "post-text-consolidation" });
  const runner = new MigrationRunner([caption.step], store, { release: null, log: () => {} });
  await assert.rejects(
    runner.runPending(),
    /release version is unknown .*refusing to run any migration against the family archive/,
  );
  assert.equal(caption.applies(), 0);
  assert.equal(((data.get(MIGRATION_LEDGER_COLLECTION) as Row[]) ?? []).length, 0);
});

test("every applied step's ledger record binds the outcome counts to the run's step identity", async () => {
  const { store, data } = fakeMigrationStore();
  const step = countingStep({ version: 7, name: "rebuild-derived-indexes", outcome: { read: 1234, written: 900, collisions: 3 } });
  const runner = runnerFor(store, [step.step], "0.5.2");
  const result = await runner.runPending();
  assert.equal(result.applied.length, 1);
  const record = (data.get(MIGRATION_LEDGER_COLLECTION) as Row[])[0];
  assert.equal(record._id, "migration_v7", "the ledger address is the step's identity");
  assert.equal(record.version, 7);
  assert.equal(record.name, "rebuild-derived-indexes");
  assert.equal(record.release, "0.5.2");
  assert.deepEqual(record.outcome, { read: 1234, written: 900, collisions: 3 });
  assert.match(String(record.appliedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, "appliedAt is an ISO 8601 stamp");
});

test("the boot-gate entry refuses with the failing step named when a catalog step breaks", async () => {
  const broken: MigrationStep = {
    version: 1,
    name: "post-text-consolidation",
    activatesIn: "0.6.0",
    destructive: false,
    apply: async () => {
      throw new Error("fixture failure");
    },
  };
  const { store } = fakeMigrationStore();
  const runner = runnerFor(store, [broken], "0.6.0");
  await assert.rejects(
    runner.runPending(),
    (error: MigrationStepFailure) => {
      assert.match(error.message, /step v1 \(post-text-consolidation\) failed: fixture failure/);
      assert.match(error.message, /must not accept traffic/);
      return true;
    },
  );
});

test("runHubMigrations runs the declared catalog with an empty pending set when every step rides a later cut", async () => {
  const { store, ops } = fakeMigrationStore();
  const result = await runHubMigrations({ store, release: "0.5.2", log: () => {} });
  assert.deepEqual(result.applied, []);
  // The declared first passenger is in the catalog but inactive; with an
  // empty active set the boot gate never touches the hub's data.
  assert.equal(HUB_MIGRATIONS[0]?.name, "post-text-consolidation");
  assert.equal(HUB_MIGRATIONS.every((step) => step.version > 0), true);
  assert.equal(ops[MIGRATION_LEDGER_COLLECTION]?.find ?? 0, 0, "no ledger read when no step is active");
});

test("the catalog rejects duplicate versions and non-positive versions at construction", () => {
  const { store } = fakeMigrationStore();
  const a = countingStep({ version: 1, name: "one" });
  const b = countingStep({ version: 1, name: "one-again" });
  assert.throws(() => runnerFor(store, [a.step, b.step]), /declares v1 twice/);
  const zero = countingStep({ version: 0, name: "zero" });
  assert.throws(() => runnerFor(store, [zero.step]), /non-positive version/);
});

test("the migration CLI knobs parse owner-initiated and forced versions", () => {
  assert.deepEqual(parseMigrationCliArgs(["--migrate"]), { ownerInitiated: false, forceVersions: [] });
  assert.deepEqual(parseMigrationCliArgs(["--migrate", "--owner-initiated"]), { ownerInitiated: true, forceVersions: [] });
  assert.deepEqual(parseMigrationCliArgs(["--migrate", "--force-version=1"]), { ownerInitiated: false, forceVersions: [1] });
  assert.deepEqual(parseMigrationCliArgs(["--migrate", "--owner-initiated", "--force-version=1,2"]), {
    ownerInitiated: true,
    forceVersions: [1, 2],
  });
});

test("PORCH-156 settle: a legacy-shaped straggler written during the serving window settles on the next run", async () => {
  const { store, data } = fakeMigrationStore();
  const step = countingStep({ version: 1, name: "post-text-consolidation", outcome: { read: 2, written: 2, collisions: 0 } });
  // Give the step a workRemaining check: the workset is the data_v1 docs
  // still carrying the legacy marker.
  step.step.workRemaining = async ({ store: s }) => await s.collection("data_v1").countDocuments({ legacy: true });
  const runner = runnerFor(store, [step.step]);
  const rows = data;
  rows.set("data_v1", [
    { _id: "a", legacy: true },
    { _id: "b", legacy: true },
  ]);
  const originalApply = step.step.apply;
  step.step.apply = async (ctx) => {
    const col = ctx.store.collection("data_v1");
    const legacy = await col.find({ legacy: true });
    for (const row of legacy) await col.updateOne({ _id: row._id }, { $set: { legacy: false } });
    return { read: legacy.length, written: legacy.length, collisions: 0 };
  };
  const first = await runner.runPending();
  assert.deepEqual(first.applied.map((record) => record.version), [1]);
  assert.deepEqual(first.applied[0]?.outcome, { read: 2, written: 2, collisions: 0 });

  // The straggler: the still-serving prior release wrote one more
  // legacy-shaped document after the pass recorded its ledger entry.
  (rows.get("data_v1") as Array<Record<string, unknown>>).push({ _id: "c", legacy: true });

  const second = await runner.runPending();
  assert.deepEqual(
    second.applied.map((record) => record.version),
    [1],
    "the recorded step settles: the runner re-runs it because its workset is non-empty",
  );
  assert.deepEqual(second.applied[0]?.outcome, { read: 1, written: 1, collisions: 0 }, "the pass applies only to the straggler");
  const ledger = (rows.get(MIGRATION_LEDGER_COLLECTION) as Array<Record<string, unknown>>)[0];
  assert.deepEqual(ledger.outcome, { read: 3, written: 3, collisions: 0 }, "the cumulative outcome reflects every pass");
  assert.equal((ledger.passes as unknown[]).length, 2, "each pass carries its own per-pass counts");

  // Settled: the next run finds zero remaining and never re-runs the step.
  const third = await runner.runPending();
  assert.deepEqual(third.applied, []);
  void originalApply;
});
