/**
 * Provenance service (PORCH-148 ac-6). The admin-visible provenance of
 * record: every inference call records the resolved profile's identity —
 * which model answered, under which profile, at which time — and every
 * degradation (provider unreachable, explicit fallback ride) lands its own
 * row so the session and admin surfaces name the state (never silent).
 */
export class ProvenanceService {
  /**
   * @param {import("@porchlight/shared").CollectionLike} provenance
   * @param {() => string} [now]
   */
  constructor(provenance, now = defaultNow) {
    this.provenance = provenance;
    this.now = now;
  }

  /**
   * The inference record of one call: profile identity, model, timestamp.
   * Rows never carry endpoint refs, keys, or tokens (the privacy sweep
   * surface of record).
   */
  async record({ memberId, sessionId = null, profile, providerName, _providerClass, modelId, degraded = null, fallback = null } = {}) {
    if (!profile?._id || !memberId) {
      throw new Error("ProvenanceService.record: profile identity and member are required (fail closed, never silent)");
    }
    const row = {
      _id: `iproven_${crypto.randomUUID()}`,
      memberId,
      sessionId,
      profileRef: profile._id,
      profileName: profile.name,
      providerName: providerName ?? null,
      // The row's class is the resolved profile's class of record — callers
      // never widen it past the profile.
      providerClass: profile.providerClass,
      modelId: modelId ?? null,
      at: this.now(),
      degraded: degraded ?? null,
      fallback: fallback ?? null,
    };
    await this.provenance.insertOne(row);
    return row;
  }

  /** The admin-visible list for a member, newest first, bounded. */
  async forMember({ memberId, limit = 50, offset = 0 } = {}) {
    const rows = await this.provenance.find({ memberId });
    const page = [...rows]
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(offset, offset + Math.max(1, limit));
    return { rows: page, total: rows.length };
  }

  /** The member's latest inference record (the session status read). */
  async latestForMember(memberId) {
    const rows = await this.provenance.find({ memberId });
    return [...rows].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0] ?? null;
  }
}

function defaultNow() {
  return new Date().toISOString();
}
