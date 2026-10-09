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

  /** Owner console read: the network's action trail, newest-last stable order. */
  async list({ networkId } = {}) {
    if (!networkId) {
      const error = new Error("networkId required");
      error.code = "E_AUDIT_REQUIRED";
      throw error;
    }
    return this.auditEvents.find({ networkId: String(networkId) });
  }
}

export default AuditService;