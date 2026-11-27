/**
 * Migration service (PORCH-151) — the per-member nanobot-class import into
 * the driftless-native stores. The source runtime is never a post-migration
 * dependency (the founding ruling: migration, not coexistence): the ONLY
 * input surface is a one-time export ARTIFACT — a plain document validated
 * against the schema check below BEFORE any write. There is no process
 * bridge, no socket, no live hand-off: a document that carries anything
 * beyond the artifact shape is materially different from the expected shape
 * and blocks with an explicit state rather than a lossy guess (TS 3).
 *
 * Per-member mechanics of record (TS 3):
 *   - imports are explicit per-member actions (admin-gated) with a READ-BACK;
 *   - a failed import stops that member's migration with a plain-language
 *     reason, retryable, never half-landed (the write plan tracks every key
 *     it touches and rolls the member's own namespace back on any failure);
 *   - the landed shape IS the driftless-native shape: topics + memory +
 *     soul + keyset ride @porchlight/agent-runtime's own per-member stores
 *     (MemberStore member:<id>:<scope> keying), so the member's first agent
 *     session carries the imported topics with no translation step;
 *   - re-migration of an already-migrated member refuses with the explicit
 *     already-migrated state; a failed import leaves nothing landed and
 *     retries freely.
 */
import { fail } from "./errors.js";
import { requireAdmin } from "./profiles.service.js";
import { MemoryStream, TopicsStore, KeysetStore, createMemberStores, normalizeSoul } from "@porchlight/agent-runtime";

/** The one export schema of record this import accepts. */
export const MIGRATION_FORMAT = "porchlight-agent-migration/1";

/** The source-runtime class of record (nanobot-class this build, per the task). */
export const MIGRATION_SOURCES = ["nanobot-class"];

const ARTIFACT_KEYS = new Set(["format", "source", "memberId", "exportId", "exportedAt", "config", "memory", "topics"]);
const CONFIG_KEYS = new Set(["soul", "keyset"]);
const ENTRY_ROLES = new Set(["user", "agent", "tool"]);
const MEMORY_KEYS = new Set(["entries"]);
const ENTRY_KEYS = new Set(["role", "text", "topic", "at", "tool"]);
const TOPIC_KEYS = new Set(["name", "createdAt"]);
/** Namespace-safe member ids only — the id becomes the storage seam namespace. */
const MEMBER_ID = /^[A-Za-z0-9_-]+$/;

function isIso(value) {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function plainKeys(keys) {
  return keys.map((k) => `"${k}"`).join(", ");
}

/**
 * The migration schema check of record for ac-1 (TS 3: validated against a
 * schema check before writing; a failed import stops that member's
 * migration with a plain-language reason). Strict on purpose: exact known
 * keys at every level. Unknown or missing required fields are materially
 * different from the expected shape → block with an explicit reason.
 *
 * @param {unknown} doc the export artifact document
 * @returns {{
 *   memberId: string, exportId: string, source: string, exportedAt: string,
 *   soul: object|null, keyset: Record<string, string>|null,
 *   entries: object[], topics: object[],
 * }}
 */
export function validateExport(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    const what = doc === null ? "null" : Array.isArray(doc) ? "an array" : typeof doc;
    return fail("E_MIGRATION_REJECTED", `The export must be a JSON object (an export artifact document), not ${what}.`);
  }
  const unknown = Object.keys(doc).filter((k) => !ARTIFACT_KEYS.has(k));
  if (unknown.length) {
    return fail(
      "E_MIGRATION_REJECTED",
      `This export is not a ${MIGRATION_FORMAT} artifact: unexpected field(s) ${plainKeys(unknown)}. The import does not guess at foreign shapes — reshape the source runtime's export into the artifact of record first.`,
    );
  }
  if (doc.format !== MIGRATION_FORMAT) {
    return fail("E_MIGRATION_REJECTED", `Unrecognized export format ${JSON.stringify(doc.format ?? null)}; this hub imports ${MIGRATION_FORMAT} artifacts only.`);
  }
  if (typeof doc.source !== "string" || !MIGRATION_SOURCES.includes(doc.source)) {
    return fail("E_MIGRATION_REJECTED", `Unknown or missing export source ${JSON.stringify(doc.source ?? null)}; expected one of ${MIGRATION_SOURCES.join(", ")}.`);
  }
  if (typeof doc.memberId !== "string" || !MEMBER_ID.test(doc.memberId)) {
    return fail("E_MIGRATION_REJECTED", "The export's memberId must be a plain identifier (letters, digits, dash, underscore) — it names the member's storage namespace.");
  }
  if (typeof doc.exportId !== "string" || doc.exportId.trim().length === 0) {
    return fail("E_MIGRATION_REJECTED", "The export artifact must carry an exportId — its one-time identity.");
  }
  if (!isIso(doc.exportedAt)) {
    return fail("E_MIGRATION_REJECTED", "The export artifact must carry an exportedAt ISO-8601 timestamp.");
  }
  if (doc.config !== undefined && (!doc.config || typeof doc.config !== "object" || Array.isArray(doc.config))) {
    return fail("E_MIGRATION_REJECTED", "The export's config must be an object with soul and/or keyset.");
  }
  if (doc.topics !== undefined && !Array.isArray(doc.topics)) {
    return fail("E_MIGRATION_REJECTED", "The export's topics must be an array of {name, createdAt?}.");
  }
  if (!doc.memory || typeof doc.memory !== "object" || Array.isArray(doc.memory)) {
    return fail("E_MIGRATION_REJECTED", "The export must carry a memory section (the member's interaction stream).");
  }
  const memoryUnknown = Object.keys(doc.memory).filter((k) => !MEMORY_KEYS.has(k));
  if (memoryUnknown.length) {
    return fail("E_MIGRATION_REJECTED", `Unknown field(s) in the export's memory section: ${plainKeys(memoryUnknown)}.`);
  }
  if (!Array.isArray(doc.memory.entries)) {
    return fail("E_MIGRATION_REJECTED", "The export's memory.entries must be an array of interaction entries.");
  }

  const config = doc.config ?? {};
  const configUnknown = Object.keys(config).filter((k) => !CONFIG_KEYS.has(k));
  if (configUnknown.length) {
    return fail("E_MIGRATION_REJECTED", `Unknown field(s) in the export's config: ${plainKeys(configUnknown)}.`);
  }
  let soul = null;
  if (config.soul !== undefined) {
    try {
      soul = normalizeSoul(config.soul);
    } catch {
      return fail("E_MIGRATION_REJECTED", "The export's config.soul is not a valid SOUL document (identity required; optional voice string and law list).");
    }
  }
  let keyset = null;
  if (config.keyset !== undefined) {
    if (!config.keyset || typeof config.keyset !== "object" || Array.isArray(config.keyset)) {
      return fail("E_MIGRATION_REJECTED", "The export's config.keyset must be an object of name → secret.");
    }
    keyset = { ...config.keyset };
    for (const [name, secret] of Object.entries(keyset)) {
      if (typeof secret !== "string") {
        return fail("E_MIGRATION_REJECTED", `The export's config.keyset entry "${name}" must map the name to a string secret.`);
      }
    }
  }

  const entries = doc.memory.entries.map((e, i) => {
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      return fail("E_MIGRATION_REJECTED", `memory.entries[${i}] must be an object.`);
    }
    const bad = Object.keys(e).filter((k) => !ENTRY_KEYS.has(k));
    if (bad.length) {
      return fail("E_MIGRATION_REJECTED", `Unknown field(s) in memory.entries[${i}]: ${plainKeys(bad)}.`);
    }
    if (!ENTRY_ROLES.has(e.role)) {
      return fail("E_MIGRATION_REJECTED", `memory.entries[${i}].role ${JSON.stringify(e.role ?? null)} is not one of user, agent, tool.`);
    }
    if (e.role === "tool" && typeof e.tool !== "string") {
      return fail("E_MIGRATION_REJECTED", `memory.entries[${i}] has role "tool" and must carry the tool name.`);
    }
    if (typeof e.text !== "string") {
      return fail("E_MIGRATION_REJECTED", `memory.entries[${i}].text must be a string.`);
    }
    if (typeof e.topic !== "string" || !e.topic.trim()) {
      return fail("E_MIGRATION_REJECTED", `memory.entries[${i}].topic must be a non-empty topic name.`);
    }
    if (!isIso(e.at)) {
      return fail("E_MIGRATION_REJECTED", `memory.entries[${i}].at must be an ISO-8601 timestamp.`);
    }
    return e;
  });

  const topics = (doc.topics ?? []).map((t, i) => {
    if (!t || typeof t !== "object" || Array.isArray(t)) {
      return fail("E_MIGRATION_REJECTED", `topics[${i}] must be an object {name, createdAt?}.`);
    }
    const bad = Object.keys(t).filter((k) => !TOPIC_KEYS.has(k));
    if (bad.length) {
      return fail("E_MIGRATION_REJECTED", `Unknown field(s) in topics[${i}]: ${plainKeys(bad)}.`);
    }
    if (typeof t.name !== "string" || !t.name.trim()) {
      return fail("E_MIGRATION_REJECTED", `topics[${i}].name must be a non-empty topic name.`);
    }
    if (t.createdAt !== undefined && !isIso(t.createdAt)) {
      return fail("E_MIGRATION_REJECTED", `topics[${i}].createdAt must be an ISO-8601 timestamp when present.`);
    }
    return t;
  });

  return { memberId: doc.memberId, exportId: doc.exportId, source: doc.source, exportedAt: doc.exportedAt, soul, keyset, entries, topics };
}

/**
 * The topics the import lands: the union of the exported topic list and the
 * topics the entries ride, each with its (optional) original createdAt.
 * @returns {Array<[string, string | undefined]>} [name, createdAt?]
 */
export function topicPlan(shape) {
  const plan = new Map();
  for (const t of shape.topics) {
    if (!plan.has(t.name)) plan.set(t.name, t.createdAt);
  }
  for (const e of shape.entries) {
    if (!plan.has(e.topic)) plan.set(e.topic, undefined);
  }
  return [...plan];
}

/**
 * The migration service of record. One explicit per-member import at a
 * time, admin-gated; migration failures isolate to the member (ac-5).
 */
export class MigrationService {
  /**
   * @param {{
   *   backend: (import("@porchlight/agent-runtime").KeyValueBackend) | null,
   *     The per-member storage seam backend the import writes through
   *     (createMemberStores member:<id>:<scope> keying). Null → migration
   *     fails closed with an explicit not-configured state.
   *   migrations: import("@porchlight/shared").CollectionLike,
   *     The module's agent_migrations rows: the per-member explicit states
   *     (imported | failed), the read-back record, the admin surface.
   *   audit: import("./audit.service.js").AgentAuditService,
   *   now?: () => string,
   * }} deps
   */
  constructor({ backend, migrations, audit, now = defaultNow }) {
    this.backend = backend ?? null;
    this.migrations = migrations;
    this.audit = audit;
    this.now = now;
  }

  /**
   * The explicit per-member import. Admin-gated (the closed question this
   * session: no automatic backfill, no silent bulk migration — every
   * member's migration is an individually confirmed action). Validates the
   * artifact BEFORE any write, writes the member's topics/memory/soul/
   * keyset through the runtime's own per-member stores, reads every
   * written key back verbatim, and only then records the imported state.
   * Any failure — schema, write, or read-back mismatch — rolls the
   * member's namespace back and stops THAT member's migration with a
   * plain-language reason (ac-3, never half-landed).
   */
  async importOne({ actorDid, isAdmin, export: artifact } = {}) {
    await requireAdmin({ actorDid, isAdmin, audit: this.audit, action: "member-migration" });
    if (!this.backend) {
      return fail("E_MIGRATION_NOT_CONFIGURED", "Member migration is not configured on this hub yet — no member storage backend is wired. Nothing was imported.");
    }

    // The explicit per-member failed state (ac-3), even for artifacts the
    // schema check refuses: a member-attributable rejection stops THAT
    // member's migration with the reason of record. An artifact we cannot
    // attribute to any member still audits, but cannot name a row.
    let shape;
    try {
      shape = validateExport(artifact);
    } catch (error) {
      const reason = String(error?.message ?? error);
      if (error?.code === "E_MIGRATION_REJECTED" && typeof artifact?.memberId === "string" && MEMBER_ID.test(artifact.memberId)) {
        await this.migrations.insertOne({
          _id: `agmig_${crypto.randomUUID()}`,
          memberId: artifact.memberId,
          exportId: typeof artifact?.exportId === "string" ? artifact.exportId : null,
          source: typeof artifact?.source === "string" ? artifact.source : null,
          state: "failed",
          reason,
          rollback: { undid: 0, failedKeys: [] },
          at: this.now(),
          actorIdentityRef: actorDid ?? null,
          retryable: true,
        });
      }
      await this.audit.record({
        type: "member-migration",
        actorIdentityRef: actorDid ?? null,
        detail: { memberId: artifact?.memberId ?? null, state: "failed", reason },
        outcome: "denied",
      });
      throw error;
    }

    const prior = await this.migrations.findOne({ memberId: shape.memberId, state: "imported" });
    if (prior) {
      return fail(
        "E_MIGRATION_ALREADY_MIGRATED",
        `Member ${shape.memberId} already migrated on ${prior.at} (export ${prior.exportId}) — imports are one-time per-member actions, and one-time artifacts cannot re-migrate them.`,
        { memberId: shape.memberId },
      );
    }

    // The rollback baseline: the set of keys that already exist in THIS
    // member's namespace before the import touches anything. A failed
    // import deletes exactly the keys that are new since this snapshot —
    // nothing landed, nothing half-landed, and the member's own prior
    // state is never touched. One query touches one member's records.
    const baseline = new Set((await this.backend.list(`member:${shape.memberId}:`)).map((r) => r.key));

    const refuse = [];
    const stores = createMemberStores({
      memberId: shape.memberId,
      backend: this.backend,
      refuse: (attempt) => refuse.push(attempt),
    });
    const topics = new TopicsStore({ store: stores.topics });
    const memory = new MemoryStream({ store: stores.memory, topics });
    const keyset = new KeysetStore({ store: stores.keyset });

    /** Every key the write plan touches — the rollback plan too. */
    const plan = [];
    let stage = "writing the member's topics";
    try {
      // Topics first: the union of the exported topic list and the topics
      // the entries ride, so zero-entry topics land too. An exported
      // createdAt with a different value is restored onto the ensured row.
      for (const [name, createdAt] of topicPlan(shape)) {
        const row = await topics.ensure(name);
        plan.push({ store: stores.topics, key: `topic:${row.id}`, value: row });
        if (createdAt && createdAt !== row.createdAt) {
          const landed = { ...row, createdAt };
          await stores.topics.set(`topic:${row.id}`, landed);
          plan[plan.length - 1].value = landed;
        }
      }
      // SOUL + keyset config.
      if (shape.soul) {
        await stores.soul.set("doc", shape.soul);
        plan.push({ store: stores.soul, key: "doc", value: shape.soul });
      }
      if (shape.keyset) {
        stage = "writing the member's keyset config";
        for (const [name, secret] of Object.entries(shape.keyset)) {
          await keyset.set(name, secret);
          plan.push({ store: stores.keyset, key: `key:${name}`, value: String(secret) });
        }
      }
      // The memory stream, in export order — entries ride their own topics
      // via the stream's own append (the driftless-native write path: ids,
      // sequencing, and topic counts are the runtime's, not ours).
      stage = "writing the member's memory stream";
      for (const e of shape.entries) {
        const entry = await memory.append({
          role: e.role,
          text: e.text,
          topic: e.topic,
          at: e.at,
          ...(e.role === "tool" ? { tool: e.tool } : {}),
        });
        plan.push({ store: stores.memory, key: `entry:${entry.id}`, value: entry });
      }

      // The read-back of record: every written key, re-read and compared
      // verbatim. A mismatch is a failure like any other — rollback, then
      // the explicit state.
      stage = "the read-back";
      for (const { store, key, value } of plan) {
        const got = await store.get(key);
        if (JSON.stringify(got) !== JSON.stringify(value)) {
          return fail(
            "E_MIGRATION_FAILED",
            `Read-back verification failed while importing member ${shape.memberId} (key ${key} did not read back as written). Nothing was landed for this member; the migration can be retried.`,
            { memberId: shape.memberId, rollbackKeys: plan.length },
          );
        }
      }
      if (refuse.length) {
        throw new Error(`${refuse.length} isolation refusal(s) at the storage seam during the import`);
      }
    } catch (error) {
      const rollback = await this.#rollbackTo(shape.memberId, baseline);
      const reason = String(error?.message ?? error);
      const at = this.now();
      // The explicit failed state of record (ac-3): the member's migration
      // stopped, nothing landed, and the reason + retryable flag ride the
      // row the admin surface renders.
      await this.migrations.insertOne({
        _id: `agmig_${crypto.randomUUID()}`,
        memberId: shape.memberId,
        exportId: shape.exportId,
        source: shape.source,
        state: "failed",
        reason,
        rollback,
        at,
        actorIdentityRef: actorDid ?? null,
        retryable: true,
      });
      await this.audit.record({
        type: "member-migration",
        actorIdentityRef: actorDid ?? null,
        detail: { memberId: shape.memberId, exportId: shape.exportId, state: "failed", reason, rollback },
        outcome: "denied",
        at,
      });
      return fail(
        "E_MIGRATION_FAILED",
        `Member ${shape.memberId}'s migration failed${stage ? ` while ${stage}` : ""}: ${reason}. Nothing was landed for this member — the migration stopped with an explicit state and can be retried.`,
        { memberId: shape.memberId },
      );
    }

    // The imported-state read-back the admin surface renders (ac-2): the
    // member's own stores, read through the runtime's own views.
    const landedTopics = await topics.list();
    const landedEntries = await memory.all();
    const counts = {
      topics: landedTopics.length,
      entries: landedEntries.length,
      soul: shape.soul ? 1 : 0,
      keys: shape.keyset ? Object.keys(shape.keyset).length : 0,
    };
    const row = {
      _id: `agmig_${crypto.randomUUID()}`,
      memberId: shape.memberId,
      exportId: shape.exportId,
      source: shape.source,
      exportedAt: shape.exportedAt,
      /** imported | failed — the explicit per-member states of record. */
      state: "imported",
      counts,
      at: this.now(),
      actorIdentityRef: actorDid ?? null,
      retryable: false,
    };
    await this.migrations.insertOne(row);
    await this.audit.record({
      type: "member-migration",
      actorIdentityRef: actorDid ?? null,
      detail: { memberId: shape.memberId, exportId: shape.exportId, counts },
      outcome: "recorded",
    });

    return {
      memberId: shape.memberId,
      exportId: shape.exportId,
      state: "imported",
      topics: landedTopics.map((t) => ({ name: t.name, entryCount: t.entryCount, createdAt: t.createdAt })),
      entries: landedEntries.length,
      soulIdentity: shape.soul?.identity ?? null,
      keysetNames: shape.keyset ? Object.keys(shape.keyset).sort() : [],
      readBack: "verified",
      counts,
    };
  }

  /**
   * The explicit per-member migration state for the admin surface: not
   * migrated / failed (with the plain-language reason, retryable) /
   * imported (with the read-back counts).
   */
  async statusFor({ actorDid, isAdmin, memberId } = {}) {
    await requireAdmin({ actorDid, isAdmin, audit: this.audit, action: "member-migration-status" });
    if (typeof memberId !== "string" || !memberId) {
      return fail("E_VALIDATION", "memberId is required.");
    }
    const failedRow = await this.migrations.findOne({ memberId, state: "failed" });
    const imported = await this.migrations.findOne({ memberId, state: "imported" });
    if (imported) {
      return {
        memberId,
        state: "imported",
        exportId: imported.exportId,
        source: imported.source,
        counts: imported.counts,
        at: imported.at,
        retryable: false,
      };
    }
    if (failedRow) {
      return { memberId, state: "failed", reason: failedRow.reason, exportId: failedRow.exportId, retryable: true, at: failedRow.at };
    }
    return { memberId, state: "not-migrated", retryable: false };
  }

  /** Every migration row, newest first (the admin surface's migration list). */
  async list({ actorDid, isAdmin, limit = 50, offset = 0 } = {}) {
    await requireAdmin({ actorDid, isAdmin, audit: this.audit, action: "member-migration-status" });
    const rows = await this.migrations.find({});
    const page = [...rows]
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(offset, offset + Math.max(1, limit));
    return { rows: page.map(publicRow), total: rows.length };
  }

  /**
   * The compensating rollback that keeps a failed import from half-landing
   * (never half-lands, TS 3): delete every key that appeared in the
   * member's namespace since the pre-import baseline, best-effort — a
   * rollback delete that itself fails is named on the failure row, never
   * silently swallowed. Keys that pre-existed are never touched.
   */
  async #rollbackTo(memberId, baseline) {
    const nowKeys = (await this.backend.list(`member:${memberId}:`)).map((r) => r.key);
    const undid = [];
    const failedKeys = [];
    for (const key of nowKeys) {
      if (baseline.has(key)) continue;
      try {
        await this.backend.delete(key);
        undid.push(key);
      } catch (error) {
        failedKeys.push({ key, reason: String(error?.message ?? error) });
      }
    }
    return { undid: undid.length, failedKeys };
  }
}

function publicRow(row) {
  return { memberId: row.memberId, exportId: row.exportId, source: row.source, state: row.state, counts: row.counts, at: row.at };
}

function defaultNow() {
  return new Date().toISOString();
}
