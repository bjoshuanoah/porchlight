import { homeModels } from "../models.js";

/**
 * Home audit service (PORCH-137 TS 1). Append-only rows owned by the home
 * domain; the family app reads, nothing writes but the home module services
 * through this class. Every grant, revoke, family-distribute, command,
 * automation fire, and state-source change lands one row: actor, home,
 * device, time, outcome. state-source-change rows carry their source
 * (physical | read-back) in detail.
 */
export class HomeAuditService {
  /**
   * @param {import("@porchlight/shared").CollectionLike} homeAudit
   * @param {() => string} [now] - ISO timestamp provider (tests inject a clock).
   */
  constructor(homeAudit, now = defaultNow) {
    this.homeAudit = homeAudit;
    this.models = homeModels;
    this.now = now;
  }

  /**
   * Record one home action. Fail-closed on missing coordinates: an audit
   * write that cannot name the home and type is a bug, never a silent skip.
   */
  async record({ type, homeId, actorIdentityRef = null, deviceId = null, detail = {}, outcome, deviceSignature = null } = {}) {
    if (!type || !homeId || !outcome) {
      const error = new Error("type, homeId, and outcome required");
      error.code = "E_AUDIT_REQUIRED";
      throw error;
    }
    const event = {
      _id: `haudit_${crypto.randomUUID()}`,
      type,
      actorIdentityRef: actorIdentityRef ?? null,
      homeId: String(homeId),
      deviceId: deviceId ?? null,
      detail,
      outcome,
      deviceSignature: deviceSignature ?? null,
      at: this.now(),
    };
    await this.homeAudit.insertOne(event);
    return event;
  }

  /**
   * Per-home read (family activity surface): newest first, bounded page —
   * `limit` (1..200, default 50) and `offset` (>= 0) are part of the read
   * contract; the full unbounded set is never returned.
   */
  static AUDIT_PAGE_LIMIT = 50;
  static AUDIT_PAGE_MAX = 200;

  async list({ homeId, limit, offset } = {}) {
    if (!homeId) {
      const error = new Error("homeId required");
      error.code = "E_AUDIT_REQUIRED";
      throw error;
    }
    const pageSize = Math.min(
      Math.max(Math.floor(Number(limit) || HomeAuditService.AUDIT_PAGE_LIMIT), 1),
      HomeAuditService.AUDIT_PAGE_MAX,
    );
    const start = Math.max(Math.floor(Number(offset) || 0), 0);
    const rows = (await this.homeAudit.find({ homeId: String(homeId) }))
      .sort((a, b) =>
        String(b.at).localeCompare(String(a.at)) ||
        String(b._id).localeCompare(String(a._id)));
    return {
      events: rows.slice(start, start + pageSize),
      total: rows.length,
      limit: pageSize,
      offset: start,
      hasMore: start + pageSize < rows.length,
    };
  }
}

function defaultNow() {
  return new Date().toISOString();
}

export default HomeAuditService;
