// Real-Mongo integration test for the migration runner (PORCH-156): the
// runner and its first versioned step against a REAL mongod, exercising the
// Mongo-specific semantics the in-memory fakes cannot certify ($unset
// retirement, $or/$exists workset matching, real ledger collections).
// Env-gated (no mongod download, no network in the default matrix):
// npm run build first, then
//   PORCHLIGHT_MIGRATION_E2E=1 node --test test/migration.mongo.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoClient } from "mongodb";
import type { Document } from "mongodb";
import { MigrationRunner } from "../src/services/migration.service.js";
import { POST_TEXT_CONSOLIDATION_V1 } from "../src/services/migrations/caption-consolidation.migration.js";
import { mongoMigrationStore } from "../src/store-adapter.js";
import type { MigrationStep } from "../src/services/migration.service.js";
// mongodb-memory-server stays a static import: the mongod binary only
// downloads when the test actually runs (MongoMemoryServer.create below),
// never at module load — the default matrix stays deterministic.
import { MongoMemoryServer } from "mongodb-memory-server";

const enabled = process.env.PORCHLIGHT_MIGRATION_E2E === "1";

test(
  "the runner and first passenger apply once, idempotently, over real Mongo — resume included",
  { skip: enabled ? false : "runs only with PORCHLIGHT_MIGRATION_E2E=1" },
  async () => {
    const mongod = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1" } });
    try {
      const client = new MongoClient(mongod.getUri());
      await client.connect();
      const db = client.db("migration-runner-it");
      const posts = db.collection("posts");
      const docs: Array<Record<string, unknown>> = [
        { _id: "p1", type: "photo", mediaRefs: ["art_1"], caption: "Brian's birthday shot", body: null, createdAt: "2026-01-01T00:00:00.000Z" },
        { _id: "p2", type: "photo", mediaRefs: ["art_2"], caption: "the rendered text", body: "the other value", createdAt: "2026-01-01T00:00:00.000Z" },
        { _id: "p3", type: "text", mediaRefs: [], caption: null, body: "Plain text post", createdAt: "2026-01-01T00:00:00.000Z" },
        { _id: "p4", type: "text", mediaRefs: [], caption: "the other value", body: "the rendered text", createdAt: "2026-01-01T00:00:00.000Z" },
        { _id: "p5", type: "video", mediaRefs: ["art_3"], caption: null, body: null, createdAt: "2026-01-01T00:00:00.000Z" },
        { _id: "p6", type: "photo", mediaRefs: [], text: "kept from the resumed pass", createdAt: "2026-01-01T00:00:00.000Z" },
      ];
      // The fixture ids are strings on purpose (they mirror the domain's
      // string post ids); this cast is the only string-id mismatch against
      // the driver's default WithId typing.
      await posts.insertMany(docs as unknown as Document[]);

      const logLines: string[] = [];
      const runner = new MigrationRunner([POST_TEXT_CONSOLIDATION_V1], mongoMigrationStore(db), {
        release: "0.6.0",
        log: (line) => logLines.push(line),
      });
      const [record] = (await runner.runPending({ ownerInitiated: true, forceVersions: [1] })).applied;
      assert.deepEqual(record.outcome, { read: 5, written: 5, collisions: 2 });

      const byId = new Map((await posts.find({}).toArray()).map((row) => [String(row._id), row]));
      assert.equal(byId.get("p1")?.text, "Brian's birthday shot");
      assert.equal(byId.get("p2")?.text, "the rendered text", "the shipped projection's value survived the collision");
      assert.equal(byId.get("p3")?.text, "Plain text post");
      assert.equal(byId.get("p4")?.text, "the rendered text");
      assert.equal(byId.get("p5")?.text, null);
      assert.equal("caption" in (byId.get("p1") ?? {}), false, "the caption key retired on real Mongo");
      assert.equal("body" in (byId.get("p3") ?? {}), false, "the body key retired on real Mongo");
      assert.equal(byId.get("p6")?.text, "kept from the resumed pass");

      // The re-run through the runner: the ledger keeps it once-only.
      const rerun = await runner.runPending({ ownerInitiated: true, forceVersions: [1] });
      assert.deepEqual(rerun.applied, []);
      const ledger = await db.collection("hub_migrations").find({}).toArray();
      assert.equal(ledger.length, 1);
      assert.deepEqual(ledger[0]?.outcome, { read: 5, written: 5, collisions: 2 });
      assert.match(logLines.join("\n"), /migration v1 \(post-text-consolidation\): applied/);

      // A mid-set interruption in a multi-step catalog: the set stops at the
      // failing step with the plain-language name, prior steps stay recorded,
      // and a fresh boot resume finishes the remainder.
      const failingStep: MigrationStep = {
        version: 2,
        name: "breaks",
        activatesIn: "0.0.1",
        destructive: false,
        apply: async () => {
          throw new Error("fixture failure");
        },
      };
      const interrupted = new MigrationRunner([POST_TEXT_CONSOLIDATION_V1, failingStep], mongoMigrationStore(db), {
        release: "0.6.0",
        log: () => {},
      });
      await assert.rejects(
        interrupted.runPending({ ownerInitiated: true }),
        /step v2 \(breaks\) failed: fixture failure/,
      );
      const resumed = new MigrationRunner(
        [POST_TEXT_CONSOLIDATION_V1, { ...failingStep, apply: async () => ({ read: 1, written: 1, collisions: 0 }) }],
        mongoMigrationStore(db),
        { release: "0.6.0", log: () => {} },
      );
      const resumeResult = await resumed.runPending({ ownerInitiated: true });
      assert.deepEqual(
        resumeResult.applied.map((row) => row.version),
        [2],
        "v1 never double-applies across the resume",
      );

      await client.close();
    } finally {
      await mongod.stop();
    }
  },
);

test(
  "a straggler written inside the serving window settles against real Mongo",
  { skip: enabled ? false : "runs only with PORCHLIGHT_MIGRATION_E2E=1" },
  async () => {
    const mongod = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1" } });
    try {
      const client = new MongoClient(mongod.getUri());
      await client.connect();
      const db = client.db("migration-runner-settle");
      const posts = db.collection("posts");
      const docs: Array<Record<string, unknown>> = [
        { _id: "p1", type: "photo", mediaRefs: ["art_1"], caption: "original", body: null },
        { _id: "p2", type: "text", mediaRefs: [], caption: null, body: "plain" },
      ];      // The fixture ids are strings on purpose (they mirror the domain's
      // string post ids); this cast is the only string-id mismatch against
      // the driver's default WithId typing.
      await posts.insertMany(docs as unknown as Document[]);
      const runner = new MigrationRunner([POST_TEXT_CONSOLIDATION_V1], mongoMigrationStore(db), {
        release: "0.6.0",
        log: () => {},
      });
      const [first] = (await runner.runPending({ ownerInitiated: true, forceVersions: [1] })).applied;
      assert.deepEqual(first.outcome, { read: 2, written: 2, collisions: 0 });

      // The still-serving prior release wrote a legacy-shaped post after the
      // pass — the settle pass sweeps it on the next run. (Fixture string
      // ids: the cast is the only string-id mismatch against the driver's
      // default WithId typing.)
      const stragglerDoc = { _id: "p3", type: "photo", mediaRefs: [], caption: "straggler", body: null } as unknown as Document;
      await posts.insertOne(stragglerDoc);
      const settle = await runner.runPending({ ownerInitiated: true, forceVersions: [1] });
      assert.deepEqual(settle.applied[0]?.outcome, { read: 1, written: 1, collisions: 0 });
      const straggler = (await posts.findOne({ _id: "p3" } as unknown as Document)) as Record<string, unknown> | null;
      assert.equal(straggler?.text, "straggler");
      assert.equal("caption" in (straggler ?? {}), false);
      const ledger = await db.collection("hub_migrations").find({}).toArray();
      assert.equal(ledger.length, 1, "still one ledger record — the settle accumulated in place");
      assert.deepEqual(ledger[0]?.outcome, { read: 3, written: 3, collisions: 0 });
      const done = await runner.runPending({ ownerInitiated: true, forceVersions: [1] });
      assert.deepEqual(done.applied, []);
      await client.close();
    } finally {
      await mongod.stop();
    }
  },
);
