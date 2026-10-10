import { socialModels } from "../models.js";

/**
 * Audit service (PORCH-005 ac-4). Member actions are auditable events,
 * visible in the owner console: logins (admissions), uploads, deletions
 * (retention sweep), membership revocations. Append-only rows owned by the
 * social domain; the owner console reads, nothing writes but the module
 * services through this class.
 */
export class AuditService {
  /**
   * @param {import("@porchlight/shared").CollectionLike} auditEvents
   * @param {{ record: (step: string, detail?: object) => Promise<void> }} [bootstrapLedger]
   */
  constructor(auditEvents, bootstrapLedger) {
    this.auditEvents = auditEvents;
    this.bootstrapLedger = bootstrapLedger ?? null;
    this.models = socialModels;
  }

  /** Record one member action event. */
  async record({ networkId, did = null, action, detail = {} } = {}) {
    if (!networkId || !action) {
      const error = new Error("networkId and action required");
      error.code = "E_AUDIT_REQUIRED";
      throw error;
    }
    const event = {
      _id: `aud_${crypto.randomUUID()}`,
      networkId: String(networkId),
      did,
      action,
      detail,
      createdAt: new Date().toISOString(),
    };
    await this.auditEvents.insertOne(event);
    return event;
  }

  /** Recording adapter wired into the domain services (per-network events). */
  recorderFor(networkId) {
    return (action, payload = {}) =>
      this.record({
        networkId: payload.networkId ?? networkId,
        did: payload.did ?? null,
        action,
        detail: payload.detail ?? {},
      });
  }

  /**
   * Owner console read (PORCH-058): the network's action trail, newest
   * first — reverse chronological, most recent event at the top — with a
   * bounded page: `limit` (1..AUDIT_PAGE_MAX, default AUDIT_PAGE_LIMIT)
   * and `offset` (>= 0) are part of the read contract; the full unbounded
   * event set is never returned.
   */
  static AUDIT_PAGE_LIMIT = 50;
  static AUDIT_PAGE_MAX = 200;

  async list({ networkId, limit, offset } = {}) {
    if (!networkId) {
      const error = new Error("networkId required");
      error.code = "E_AUDIT_REQUIRED";
      throw error;
    }
    const pageSize = Math.min(
      Math.max(Math.floor(Number(limit) || AuditService.AUDIT_PAGE_LIMIT), 1),
      AuditService.AUDIT_PAGE_MAX,
    );
    const start = Math.max(Math.floor(Number(offset) || 0), 0);
    // No re-backfill, no event reshaping (PORCH-058 ac-4): prior rows read
    // exactly as stored and are only ordered and windowed for the page.
    const rows = (await this.auditEvents.find({ networkId: String(networkId) }))
      .sort((a, b) =>
        String(b.createdAt).localeCompare(String(a.createdAt)) ||
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

export default AuditService;