// Fixture tests for the migration runner's first versioned step — the
// caption consolidation (PORCH-157's data passenger, declared under
// PORCH-156, Amendment 1: "get rid of caption; the post text is the post
// text"). Pinned against a fixture hub carrying legacy dual-text posts:
// the field mapping of record (the value the shipped read projection
// rendered survives into the consolidated `text` field — `caption` wins on
// media shapes, `body` on text shapes), the collision resolutions, the
// one-pass application, the idempotent re-run, and the document counts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MigrationRunner, MIGRATION_LEDGER_COLLECTION } from "../src/services/migration.service.js";
import {
  POST_TEXT_CONSOLIDATION_V1,
  POST_TEXT_CONSOLIDATION_VERSION,
} from "../src/services/migrations/caption-consolidation.migration.js";
import { fakeMigrationStore, type Row } from "./helpers/migration-store.js";

type PostRow = {
  _id: string;
  type: string;
  mediaRefs: unknown[];
  caption?: unknown;
  body?: unknown;
  text?: unknown;
};

function post(overrides: Partial<PostRow> & { _id: string }): PostRow {
  return {
    type: "photo",
    mediaRefs: ["art_1"],
    ...overrides,
  } as PostRow;
}

/** The legacy dual-text fixture hub: every shape the shipped write path produced. */
function fixtureHubRows(): PostRow[] {
  return [
    // Media post, single value: the caption the read projection rendered.
    post({ _id: "p1", caption: "Brian's birthday shot", body: null }),
    // Media post with BOTH values (the collision): the read projection
    // rendered the caption — the caption wins, the body retires.
    post({ _id: "p2", caption: "the rendered text", body: "the other value" }),
    // Text post, single value.
    post({ _id: "p3", type: "text", mediaRefs: [], body: "Plain text post", caption: null }),
    // Text post with BOTH values (collision): the body renders on text
    // shapes — the body wins.
    post({ _id: "p4", type: "text", mediaRefs: [], body: "the rendered text", caption: "the other value" }),
    // Media-only post, no text on either legacy field.
    post({ _id: "p5", caption: null, body: null }),
    // Already-consolidated row (a crash-resumed previous pass finished it).
    post({ _id: "p6", text: "kept from the resumed pass" }),
    // Blank caption: retires the same way a null one does.
    post({ _id: "p7", caption: "", body: null }),
  ];
}

test("the first versioned step is the caption consolidation, declared inert ahead of its cut", () => {
  assert.equal(POST_TEXT_CONSOLIDATION_VERSION, 1);
  assert.equal(POST_TEXT_CONSOLIDATION_V1.version, 1);
  assert.equal(POST_TEXT_CONSOLIDATION_V1.name, "post-text-consolidation");
  assert.equal(POST_TEXT_CONSOLIDATION_V1.activatesIn, null, "the caption retirement rides the later cut (PORCH-157)");
  assert.equal(POST_TEXT_CONSOLIDATION_V1.destructive, false, "the consolidation never destroys data — it maps it");
});

test("one owner-run pass consolidates every legacy shape with the ruled field mapping", async () => {
  const { store, rows, ops } = fakeMigrationStore({ posts: fixtureHubRows() });
  const runner = new MigrationRunner([POST_TEXT_CONSOLIDATION_V1], store, {
    release: "2.0.0",
    log: () => {},
  });
  const result = await runner.runPending({ ownerInitiated: true, forceVersions: [1] });
  assert.deepEqual(
    result.applied.map((record) => record.version),
    [1],
    "the first passenger applies in the one owner-run pass",
  );
  const [record] = result.applied;
  assert.deepEqual(
    record.outcome,
    { read: 6, written: 6, collisions: 2 },
    "read = the posts still carrying legacy fields; 5 retire a value + 1 blank-only; two dual-value collisions resolved",
  );

  const byId = new Map(rows("posts").map((row) => [String(row._id), row]));
  // Media shape: the caption survived, the legacy keys retired.
  assert.equal(byId.get("p1")?.text, "Brian's birthday shot");
  // Media collision: the value the shipped projection rendered won.
  assert.equal(byId.get("p2")?.text, "the rendered text");
  // Text shape.
  assert.equal(byId.get("p3")?.text, "Plain text post");
  // Text collision.
  assert.equal(byId.get("p4")?.text, "the rendered text");
  // Media-only: one text field present and null.
  assert.equal(byId.get("p5")?.text, null);
  // Blank caption counts as no text, retires the same way.
  assert.equal(byId.get("p7")?.text, null);
  // Already consolidated: untouched.
  assert.equal(byId.get("p6")?.text, "kept from the resumed pass");

  for (const row of rows("posts")) {
    assert.equal("caption" in row, false, `${String(row._id)} carries no caption key after consolidation`);
    assert.equal("body" in row, false, `${String(row._id)} carries no body key after consolidation`);
  }
  assert.equal(ops.posts.updateOne, 6, "exactly the legacy-carrying posts were written, never the consolidated one");
});

test("the step is idempotent by itself: a re-run finds an empty workset and writes nothing", async () => {
  const stepStore = fakeMigrationStore({ posts: fixtureHubRows() });
  const first = await POST_TEXT_CONSOLIDATION_V1.apply({ store: stepStore.store, log: () => {} });
  assert.deepEqual(first, { read: 6, written: 6, collisions: 2 });
  const second = await POST_TEXT_CONSOLIDATION_V1.apply({ store: stepStore.store, log: () => {} });
  assert.deepEqual(second, { read: 0, written: 0, collisions: 0 }, "a re-run or resumed pass never double-applies");
  // Document-count assertions: the archive never grew or shrank across runs.
  assert.equal(stepStore.rows("posts").length, 7);
});

test("a crash-resumed run through the runner re-grounds on the ledger and never double-writes", async () => {
  const { store, rows } = fakeMigrationStore({ posts: fixtureHubRows() });
  const runner = new MigrationRunner([POST_TEXT_CONSOLIDATION_V1], store, { release: "2.0.0", log: () => {} });
  await runner.runPending({ ownerInitiated: true, forceVersions: [1] });
  // A hypothetical interrupted pass (whatever stage it broke at) leaves the
  // ledger record behind — a fresh runner resolves the pending set to empty.
  const resumed = new MigrationRunner([POST_TEXT_CONSOLIDATION_V1], store, { release: "2.0.0", log: () => {} });
  const result = await resumed.runPending({ ownerInitiated: true, forceVersions: [1] });
  assert.deepEqual(result.applied, []);
  const ledger = rows(MIGRATION_LEDGER_COLLECTION);
  assert.equal(ledger.length, 1, "exactly one ledger record for the step's identity");
  assert.deepEqual(ledger[0]?.outcome, { read: 6, written: 6, collisions: 2 });
  const byId = new Map(rows("posts").map((row) => [String(row._id), row]));
  assert.equal(byId.get("p1")?.text, "Brian's birthday shot", "the consolidated values are unchanged by the resume");
});

test("the ledger record binds the consolidation's outcome counts to the run's step identity for the carrier trail", async () => {
  const { store, rows } = fakeMigrationStore({ posts: fixtureHubRows() });
  const logged: string[] = [];
  const runner = new MigrationRunner([POST_TEXT_CONSOLIDATION_V1], store, {
    release: "2.0.0",
    log: (line) => logged.push(line),
  });
  const [record] = (await runner.runPending({ ownerInitiated: true, forceVersions: [1] })).applied;
  assert.equal(record.name, "post-text-consolidation");
  assert.equal(record.version, 1);
  assert.deepEqual(record.outcome, { read: 6, written: 6, collisions: 2 });
  const ledger = rows(MIGRATION_LEDGER_COLLECTION)[0] as Row;
  assert.equal(ledger._id, "migration_v1");
  assert.match(logged.join("\n"), /migration v1 \(post-text-consolidation\): applied — read=6 written=6 collisions=2/);
});

test("a legacy-shaped post written inside the serving window settles on the next pass", async () => {
  const { store, rows } = fakeMigrationStore({ posts: fixtureHubRows() });
  const runner = new MigrationRunner([POST_TEXT_CONSOLIDATION_V1], store, { release: "2.0.0", log: () => {} });
  await runner.runPending({ ownerInitiated: true, forceVersions: [1] });

  // A post created by the still-serving prior release after the pass: the
  // old code writes the legacy shape until the swap.
  (rows("posts") as PostRow[]).push(post({ _id: "p8", caption: "late straggler", body: null }));

  const settle = await new MigrationRunner([POST_TEXT_CONSOLIDATION_V1], store, { release: "2.0.0", log: () => {} })
    .runPending({ ownerInitiated: true, forceVersions: [1] });
  assert.deepEqual(
    settle.applied.map((record) => record.version),
    [1],
    "the recorded step settles because its workset is non-empty",
  );
  assert.deepEqual(settle.applied[0]?.outcome, { read: 1, written: 1, collisions: 0 }, "only the straggler was written");
  const byId = new Map(rows("posts").map((row) => [String(row._id), row]));
  assert.equal(byId.get("p8")?.text, "late straggler");
  const ledger = rows(MIGRATION_LEDGER_COLLECTION)[0] as Row;
  assert.deepEqual(ledger.outcome, { read: 7, written: 7, collisions: 2 }, "the ledger outcome accumulates the passes");
  // Settled again: nothing left to count, the runner never re-runs the step.
  const done = await runner.runPending({ ownerInitiated: true, forceVersions: [1] });
  assert.deepEqual(done.applied, []);
});
