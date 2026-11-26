/**
 * Agent audit service — the module's append-only audit family of record
 * (the home module's HomeAuditService pattern). Profile definitions,
 * availability flips, assignments (admin + member-self + refusals), and
 * parental narrowing writes (including refused writes) each land one row:
 * who, what, when, what outcome. Nothing writes but the agent module's
 * services through this class.
 */
export class AgentAuditService {
  /**
   * @param {import("@porchlight/shared").CollectionLike} audit
   * @param {() => string} [now]
   */
  constructor(audit, now = defaultNow) {
    this.audit = audit;
    this.now = now;
  }

  /**
   * Record one agent-domain action. Fail-closed on missing coordinates: an
   * audit write that cannot name the type is a bug, never a silent skip.
   */
  async record({ type, actorIdentityRef = null, detail = {}, outcome = "recorded" } = {}) {
    if (!type || typeof type !== "string") {
      throw new Error("AgentAuditService.record: type required (fail closed, never silent)");
    }
    const row = {
      _id: `agaudit_${crypto.randomUUID()}`,
      type,
      actorIdentityRef: actorIdentityRef ?? null,
      detail: detail ?? {},
      outcome,
      at: this.now(),
    };
    await this.audit.insertOne(row);
    return row;
  }

  /** The audit trail page (admin surface), newest first, bounded. */
  async list({ limit = 50, offset = 0 } = {}) {
    const rows = await this.audit.find({});
    const page = [...rows]
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(offset, offset + Math.max(1, limit));
    return { rows: page, total: rows.length };
  }
}

function defaultNow() {
  return new Date().toISOString();
}
