// PORCH-151: the per-member nanobot-class migration tooling — export
// artifact schema check before any write (ac-1), a valid import landing the
// member's topics/memory/soul/keyset in the driftless-native stores with a
// read-back and the imported topics carried on the member's first session
// (ac-2), a malformed/materially-different export failing clean with
// nothing landed (ac-3), one-time artifacts with no live bridging or
// coexistence (ac-4), and per-member failure isolation (ac-5).

import { test } from "node:test";
import assert from "node:assert/strict";

import express from "express";

import { MapBackend, AgentRuntime, PROVIDER_CLASSES, normalizeSoul } from "@porchlight/agent-runtime";

import { makeAgentHub } from "./helpers/fixture.js";
import { MIGRATION_FORMAT, validateExport, topicPlan } from "../src/index.js";

const ADMIN = "did:porch:admin";

/** A valid nanobot-class export artifact for one member. */
function artifactFor(memberId, overrides = {}) {
  return {
    format: MIGRATION_FORMAT,
    source: "nanobot-class",
    memberId,
    exportId: `exp_${memberId}_1`,
    exportedAt: "2026-11-25T09:00:00.000Z",
    config: {
      soul: { identity: "Maya's personal agent", voice: "warm, concise", law: ["answer for Maya only"] },
      keyset: { "home-token": "sk-live-0001" },
    },
    memory: {
      entries: [
        { role: "user", text: "what's on my plate today", topic: "daily-brief", at: "2026-11-20T15:00:00.000Z" },
        { role: "agent", text: "two things: math homework, piano at 4.", topic: "daily-brief", at: "2026-11-20T15:00:01.000Z" },
        { role: "user", text: "run the porch lights", topic: "home", at: "2026-11-21T18:00:00.000Z" },
        { role: "tool", text: '{"ok":true}', topic: "home", at: "2026-11-21T18:00:02.000Z", tool: "run_scene" },
        { role: "agent", text: "done — porch lights on.", topic: "home", at: "2026-11-21T18:00:03.000Z" },
      ],
    },
    topics: [{ name: "science-fair", createdAt: "2026-10-01T10:00:00.000Z" }, { name: "daily-brief", createdAt: "2026-11-01T10:00:00.000Z" }],
    ...overrides,
  };
}

/** Deep snapshot of one member's storage-namespace key → value map. */
async function memberSnapshot(backend, memberId) {
  const rows = await backend.list(`member:${memberId}:`);
  return new Map(rows.map((r) => [r.key, JSON.stringify(r.value)]));
}

/** Await a service failure (promise or thunk) and assert its typed code + plain-language message. */
async function expectDenied(run, code, match) {
  let error = null;
  try {
    await (typeof run === "function" ? run() : run);
  } catch (e) {
    error = e;
  }
  assert.ok(error, `expected a ${code} rejection`);
  if (code) assert.equal(error.code, code);
  if (match) assert.match(error.message, match);
  return error;
}

/** A backend that fails on set() while armed — for injected mid-write outages. */
function failingOnKeys(base, match) {
  return {
    async get(k) { return base.get(k); },
    async set(k, v) {
      if (match(k)) throw new Error(`backend write failed on ${k}`);
      return base.set(k, v);
    },
    async delete(k) { return base.delete(k); },
    async list(p) { return base.list(p); },
  };
}

function hub({ backend = new MapBackend() } = {}) {
  const h = makeAgentHub({ admins: [ADMIN], migrationBackend: backend });
  return { ...h, backend };
}

// ── ac-1: the export/import shape — schema check before any write ─────────

test("a valid artifact parses into the normalized shape: soul, keyset, entries, and the derived topic plan", async () => {
  const artifact = artifactFor("memberA");
  const shape = validateExport(artifact);
  assert.equal(shape.memberId, "memberA");
  assert.deepEqual(shape.soul, normalizeSoul(artifact.config.soul));
  assert.deepEqual(shape.keyset, artifact.config.keyset);
  assert.equal(shape.entries.length, 5);
  // The topic plan is the union of the exported topic list and the topics
  // the entries ride — zero-entry topics land too, original createdAt kept.
  assert.deepEqual(topicPlan(shape), [
    ["science-fair", "2026-10-01T10:00:00.000Z"],
    ["daily-brief", "2026-11-01T10:00:00.000Z"],
    ["home", undefined],
  ]);
});

test("every schema violation rejects with a plain-language reason and the typed E_MIGRATION_REJECTED code", async () => {
  const cases = [
    ["not an object", () => validateExport("hello"), /must be a JSON object/],
    ["foreign top-level field", () => validateExport(artifactFor("m", { runtimeEndpoint: "ws://somewhere" })), /unexpected field\(s\) "runtimeEndpoint"/],
    ["wrong format tag", () => validateExport(artifactFor("m", { format: "some-other-export/9" })), /Unrecognized export format/],
    ["unknown source", () => validateExport(artifactFor("m", { source: "skynet-class" })), /Unknown or missing export source/],
    ["unsafe memberId", () => validateExport(artifactFor("member:x")), /plain identifier/],
    ["missing exportId", () => validateExport(artifactFor("m", { exportId: "" })), /exportId/],
    ["memory missing", () => validateExport(artifactFor("m", { memory: undefined })), /memory section/],
    ["entry bad role", () => validateExport(artifactFor("m", { memory: { entries: [{ role: "system", text: "x", topic: "t", at: "2026-01-01T00:00:00.000Z" }] } })), /role "system" is not one of user, agent, tool/],
    ["tool entry without tool name", () => validateExport(artifactFor("m", { memory: { entries: [{ role: "tool", text: "x", topic: "t", at: "2026-01-01T00:00:00.000Z" }] } })), /must carry the tool name/],
    ["entry bad timestamp", () => validateExport(artifactFor("m", { memory: { entries: [{ role: "user", text: "x", topic: "t", at: "yesterday" }] } })), /ISO-8601/],
    ["bad soul", () => validateExport(artifactFor("m", { config: { soul: { voice: "only" } } })), /config\.soul is not a valid SOUL document/],
    ["keyset secret not string", () => validateExport(artifactFor("m", { config: { keyset: { k: 7 } } })), /string secret/],
    ["foreign config field", () => validateExport(artifactFor("m", { config: { bridge: "ws://live-nanobot" } })), /Unknown field.*"bridge"/],
  ];
  for (const [name, run, match] of cases) {
    let error = null;
    try {
      run();
    } catch (e) {
      error = e;
    }
    assert.ok(error, `expected ${name} to reject`);
    assert.equal(error.code, "E_MIGRATION_REJECTED", name);
    assert.match(error.message, match, name);
  }
});

test("the import refuses an unsigned caller and a non-admin with an audited plain-language denial", async () => {
  const { mod } = hub();
  await expectDenied(
    mod.migrationService.importOne({ export: artifactFor("m1") }),
    "E_MUST_SIGN_IN",
  );
  await expectDenied(
    mod.migrationService.importOne({ actorDid: "did:porch:kid", isAdmin: false, export: artifactFor("m1") }),
    "E_NOT_PERMITTED",
    /hub admin/,
  );
  const auditRows = (await mod.auditService.list({ limit: 50 })).rows.filter((r) => r.type === "member-migration");
  assert.equal(auditRows.length, 2);
  assert.equal(auditRows[1].outcome, "denied");
});

test("without a wired storage backend, migration fails closed with the explicit not-configured state", async () => {
  const { mod } = makeAgentHub({ admins: [ADMIN] });
  await expectDenied(
    mod.migrationService.importOne({ actorDid: ADMIN, isAdmin: true, export: artifactFor("m1") }),
    "E_MIGRATION_NOT_CONFIGURED",
  );
});

// ── ac-2: a valid import lands per-member state with a read-back ──────────

test("a valid import lands topics, memory, soul, and keyset in the driftless-native stores, verified by read-back", async () => {
  const backend = new MapBackend();
  const { mod } = hub({ backend });
  const result = await mod.migrationService.importOne({ actorDid: ADMIN, isAdmin: true, export: artifactFor("memberA") });

  assert.equal(result.state, "imported");
  assert.equal(result.readBack, "verified");
  assert.deepEqual(result.topics.map((t) => t.name).sort(), ["daily-brief", "home", "science-fair"]);
  assert.deepEqual(result.topics.find((t) => t.name === "daily-brief"), { name: "daily-brief", entryCount: 2, createdAt: "2026-11-01T10:00:00.000Z" });
  assert.deepEqual(result.topics.find((t) => t.name === "science-fair"), { name: "science-fair", entryCount: 0, createdAt: "2026-10-01T10:00:00.000Z" });
  assert.equal(result.entries, 5);
  assert.deepEqual(result.keysetNames, ["home-token"]);
  assert.deepEqual(result.counts, { topics: 3, entries: 5, soul: 1, keys: 1 });

  // The landed shape IS the driftless-native shape: the member's own
  // namespace, keyed member:<id>:<scope> — and nothing else exists.
  for (const key of (await backend.list("member:memberA:")).map((r) => r.key)) {
    assert.ok(key.startsWith("member:memberA:"), key);
    assert.ok(!key.includes("nanobot"), key);
  }

  // The migration row of record and its audited, admin-readable state.
  const status = await mod.migrationService.statusFor({ actorDid: ADMIN, isAdmin: true, memberId: "memberA" });
  assert.equal(status.state, "imported");
  assert.equal(status.exportId, "exp_memberA_1");
  assert.deepEqual(status.counts, { topics: 3, entries: 5, soul: 1, keys: 1 });
  const rows = await mod.migrationService.list({ actorDid: ADMIN, isAdmin: true });
  assert.equal(rows.total, 1);
  assert.equal(rows.rows[0].state, "imported");
});

test("the member's FIRST agent session after migration carries the imported topics, memory, soul, and keyset", async () => {
  const backend = new MapBackend();
  const { mod } = hub({ backend });
  await mod.migrationService.importOne({ actorDid: ADMIN, isAdmin: true, export: artifactFor("memberA") });

  // A brand-new runtime session over the same backend — the member's first
  // session after migration — sees the imported state with no translation.
  const runtime = new AgentRuntime({
    backend,
    inference: { name: "stub", providerClass: PROVIDER_CLASSES[0], complete: async () => ({ text: "ok" }) },
  });
  const entity = runtime.agentFor("memberA");
  const topics = await entity.topics.list();
  assert.deepEqual(topics.map((t) => t.name).sort(), ["daily-brief", "home", "science-fair"]);
  const home = await entity.memory.byTopic("home");
  assert.equal(home.length, 3);
  assert.equal(home[1].role, "tool");
  assert.equal(home[1].tool, "run_scene");
  assert.equal(home[2].text, "done — porch lights on.");
  const brief = await entity.memory.byTopic("daily-brief");
  assert.equal(brief.length, 2);
  assert.equal(brief[0].at, "2026-11-20T15:00:00.000Z");
  assert.ok((await entity.soulInjection()).includes("Maya's personal agent"));
  assert.equal(await entity.keyset.get("home-token"), "sk-live-0001");
});

test("re-migrating an already-migrated member refuses with the explicit already-migrated state", async () => {
  const { mod } = hub();
  await mod.migrationService.importOne({ actorDid: ADMIN, isAdmin: true, export: artifactFor("memberA") });
  await expectDenied(
    mod.migrationService.importOne({ actorDid: ADMIN, isAdmin: true, export: artifactFor("memberA", { exportId: "exp_memberA_2" }) }),
    "E_MIGRATION_ALREADY_MIGRATED",
    /already migrated/,
  );
});

// ── ac-3: a malformed export fails clean, nothing landed ──────────────────

test("a schema-rejected artifact lands the explicit failed state and writes nothing to the member's namespace", async () => {
  const backend = new MapBackend();
  const { mod } = hub({ backend });
  const bad = artifactFor("memberA", { topics: { not: "an array" } });
  await expectDenied(
    mod.migrationService.importOne({ actorDid: ADMIN, isAdmin: true, export: bad }),
    "E_MIGRATION_REJECTED",
    /topics must be an array/,
  );
  assert.equal((await backend.list("member:memberA:")).length, 0);
  const status = await mod.migrationService.statusFor({ actorDid: ADMIN, isAdmin: true, memberId: "memberA" });
  assert.equal(status.state, "failed");
  assert.equal(status.retryable, true);
  assert.match(status.reason, /topics must be an array/);
});

test("a materially-different export without an attributable memberId still rejects audited and touches nothing", async () => {
  const backend = new MapBackend();
  const { mod } = hub({ backend });
  const bad = { hello: "world" };
  await expectDenied(
    mod.migrationService.importOne({ actorDid: ADMIN, isAdmin: true, export: bad }),
    "E_MIGRATION_REJECTED",
    /unexpected field\(s\) "hello"/,
  );
  assert.equal((await backend.list("member:")).length, 0);
});

test("a mid-write backend failure rolls the member's namespace back to the pre-import baseline — nothing landed", async () => {
  const base = new MapBackend();
  // Injected outage: the first memory-ENTRY write fails (topics + config
  // already written by then — the rollback must unwind them too).
  const backend = failingOnKeys(base, (k) => k.includes(":memory:entry:"));
  const { mod: modOut } = makeAgentHub({ admins: [ADMIN], migrationBackend: backend });
  // Pre-seed one unrelated prior key in a DIFFERENT member's namespace to
  // prove the rollback never touches it.
  await base.set("member:other:soul:doc", { identity: "someone else" });

  const before = await memberSnapshot(base, "memberA");
  await expectDenied(
    modOut.migrationService.importOne({ actorDid: ADMIN, isAdmin: true, export: artifactFor("memberA") }),
    "E_MIGRATION_FAILED",
    /Nothing was landed for this member/,
  );
  const after = await memberSnapshot(base, "memberA");
  assert.deepEqual([...after.entries()], [...before.entries()]);
  assert.deepEqual(await base.get("member:other:soul:doc").then((v) => JSON.stringify(v)), JSON.stringify({ identity: "someone else" }));

  // The explicit retryable failed state rides the admin surface.
  const status = await modOut.migrationService.statusFor({ actorDid: ADMIN, isAdmin: true, memberId: "memberA" });
  assert.equal(status.state, "failed");
  assert.equal(status.retryable, true);

  // The retry is free: the SAME artifact imports clean once the backend
  // stops failing (never half-landed → retry-safe).
  const modRetry = makeAgentHub({ admins: [ADMIN], migrationBackend: base }).mod;
  const result = await modRetry.migrationService.importOne({ actorDid: ADMIN, isAdmin: true, export: artifactFor("memberA") });
  assert.equal(result.state, "imported");
  assert.equal(result.entries, 5);
});

// ── ac-4: one-time artifacts, no coexistence ──────────────────────────────

test("the import surface is the one-time artifact only: fields implying a live bridge are materially different and refuse", async () => {
  const { mod } = hub();
  for (const field of ["liveBridge", "runtimeSocket", "sourceProcess"]) {
    const artifact = artifactFor("memberA", { [field]: "ws://nowhere" });
    await expectDenied(
      mod.migrationService.importOne({ actorDid: ADMIN, isAdmin: true, export: artifact }),
      "E_MIGRATION_REJECTED",
      new RegExp(`unexpected field\\(s\\) "${field}"`),
    );
  }
  // Nothing landed from any of the attempts, and the service exposes no
  // bridging, socketing, or process-spawning surface of any kind.
  assert.deepEqual(Object.keys(mod.migrationService).filter((k) => /bridge|socket|process|stream/i.test(k)), []);
});

test("after a completed migration nothing source-runtime-shaped remains: driftless-native keys only", async () => {
  const backend = new MapBackend();
  const { mod } = hub({ backend });
  await mod.migrationService.importOne({ actorDid: ADMIN, isAdmin: true, export: artifactFor("memberA") });
  const rows = await backend.list("member:memberA:");
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.ok(row.key.startsWith("member:memberA:"), row.key);
    assert.ok(!/nanobot|socket|bridge|process/i.test(row.key + JSON.stringify(row.value)), row.key);
  }
  // The migration row names the one-time artifact, never a live handle.
  const status = await mod.migrationService.statusFor({ actorDid: ADMIN, isAdmin: true, memberId: "memberA" });
  assert.equal(status.state, "imported");
  assert.equal(status.source, "nanobot-class");
  assert.ok(!("endpoint" in status));
});

// ── ac-5: per-member failure isolation ────────────────────────────────────

test("one member's failed import never touches another member's landing migration", async () => {
  const { mod } = hub();
  const good = artifactFor("memberA");
  const bad = artifactFor("memberB", { memory: { entries: [{ role: "user", text: "x", topic: "t", at: "not-a-date" }] } });

  // A lands; B refuses on its schema check — B's failure must not reach A.
  const aResult = await mod.migrationService.importOne({ actorDid: ADMIN, isAdmin: true, export: good });
  assert.equal(aResult.state, "imported");
  await expectDenied(
    mod.migrationService.importOne({ actorDid: ADMIN, isAdmin: true, export: bad }),
    "E_MIGRATION_REJECTED",
    /ISO-8601/,
  );

  // A's namespace is exactly what the good import landed — B's failure
  // (and B's rollback) never reached into it.
  const aStatus = await mod.migrationService.statusFor({ actorDid: ADMIN, isAdmin: true, memberId: "memberA" });
  assert.equal(aStatus.state, "imported");
  const bStatus = await mod.migrationService.statusFor({ actorDid: ADMIN, isAdmin: true, memberId: "memberB" });
  assert.equal(bStatus.state, "failed");
  // B is free to retry with a corrected artifact right away.
  const fixed = artifactFor("memberB", { exportId: "exp_memberB_2" });
  const bRetry = await mod.migrationService.importOne({ actorDid: ADMIN, isAdmin: true, export: fixed });
  assert.equal(bRetry.state, "imported");
});

test("a mid-write failure in one member's namespace leaves another member's already-landed state byte-identical", async () => {
  const base = new MapBackend();
  const { mod } = hub({ backend: base });
  // MemberB lands first.
  await mod.migrationService.importOne({ actorDid: ADMIN, isAdmin: true, export: artifactFor("memberB") });
  const bBefore = await memberSnapshot(base, "memberB");

  // MemberA's import fails mid-write over the same shared backend.
  let failing = false;
  const gated = {
    async get(k) { return base.get(k); },
    async set(k, v) { if (failing) throw new Error("injected write outage"); return base.set(k, v); },
    async delete(k) { return base.delete(k); },
    async list(p) { return base.list(p); },
  };
  const mod2 = makeAgentHub({ admins: [ADMIN], migrationBackend: gated }).mod;
  failing = true;
  await expectDenied(
    mod2.migrationService.importOne({ actorDid: ADMIN, isAdmin: true, export: artifactFor("memberA") }),
    "E_MIGRATION_FAILED",
  );
  // A clean; B byte-identical.
  const bAfter = await memberSnapshot(base, "memberB");
  assert.deepEqual([...bAfter.entries()], [...bBefore.entries()]);
  assert.equal((await gated.list("member:memberA:")).length, 0);
});

// ── the REST vertical rides the migration service ─────────────────────────

test("the REST vertical: admin imports and reads the migration state over POST/GET /migrations", async () => {
  const backend = new MapBackend();
  const h = hub({ backend });
  const app = express();
  app.use(express.json());
  app.use("/agent", h.mod.api);
  const listener = app.listen(0);
  await new Promise((resolve) => listener.once("listening", resolve));
  const port = listener.address().port;
  const token = h.sign(ADMIN);
  try {
    const post = await fetch(`http://127.0.0.1:${port}/agent/migrations`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ export: artifactFor("memberA") }),
    });
    assert.equal(post.status, 200);
    const posted = await post.json();
    assert.equal(posted.state, "imported");
    assert.equal(posted.readBack, "verified");

    const get = await fetch(`http://127.0.0.1:${port}/agent/migrations?memberId=memberA`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(get.status, 200);
    assert.equal((await get.json()).state, "imported");

    // A malformed artifact over the same surface: clean 400, plain language.
    const bad = await fetch(`http://127.0.0.1:${port}/agent/migrations`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ export: artifactFor("memberB", { runtimeSocket: "ws://x" }) }),
    });
    assert.equal(bad.status, 400);
    const badBody = await bad.json();
    assert.equal(badBody.code, "E_MIGRATION_REJECTED");
    assert.match(badBody.error, /runtimeSocket/);

    // Non-admin: refused.
    const kid = h.sign("did:porch:kid");
    const denied = await fetch(`http://127.0.0.1:${port}/agent/migrations?memberId=memberA`, { headers: { authorization: `Bearer ${kid}` } });
    assert.equal(denied.status, 403);
  } finally {
    listener.close();
  }
});
