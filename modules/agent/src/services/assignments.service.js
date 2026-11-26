/**
 * Assignment service (PORCH-148 ac-3/ac-4). ProfileAssignment writes and the
 * parental permissive-set narrowing — the ONE enforcement path for the
 * family organizer's narrowing control (no parental profile control exists
 * outside it; the enforcement lives here, hub-side).
 *
 * Composition law of record (PRD 2): the hub admin's availability ruling is
 * the ceiling and assignment decides what actually runs; the gate is on
 * member self-selection and member-facing availability, never on the
 * admin's own assignment power. Parental authority narrows within the
 * admin's available set and never expands it: a parental write attempting
 * to enable an admin-withheld profile is refused at write with plain
 * language, fail closed (nothing lands).
 */
import { fail } from "./errors.js";
import { requireAdmin, memberProjection } from "./profiles.service.js";

function validTarget(target) {
  const hasType = typeof target?.agentType === "string" && target.agentType.length > 0;
  const hasMember = typeof target?.memberId === "string" && target.memberId.length > 0;
  return { ok: (hasType && !hasMember) || (hasMember && !hasType), hasType, hasMember };
}

export class AssignmentService {
  /**
   * @param {import("@porchlight/shared").CollectionLike} assignments
   * @param {import("@porchlight/shared").CollectionLike} permissive
   * @param {import("./profiles.service.js").ProfileService} profiles
   * @param {import("./audit.service.js").AgentAuditService} audit
   * @param {{
   *   isAdmin: (did: string) => Promise<boolean> | boolean,
   *     The hub-admin fact of record (the identity plane is the only identity
   *     source; injected, never imported).
   *   familiesForMember?: (did: string) => Promise<Array<family>>,
   *     The identity-plane family facts the parental write resolves against
   *     (never a model import).
   *   publishChange?: (event: object) => void,
   * }} [seam]
   * @param {() => string} [now]
   */
  constructor(assignments, permissive, profiles, audit, seam = {}, now = defaultNow) {
    this.assignments = assignments;
    this.permissive = permissive;
    this.profiles = profiles;
    this.audit = audit;
    this.seam = seam;
    this.isAdmin = typeof seam.isAdmin === "function" ? seam.isAdmin : () => false;
    this.familiesForMember = typeof seam.familiesForMember === "function" ? seam.familiesForMember : null;
    this.publishChange = typeof seam.publishChange === "function" ? seam.publishChange : null;
    this.now = now;
  }

  /**
   * The admin assigns a profile to an agent type (the type default) or to a
   * member (member-specific). Admin assignment bypasses the member-facing
   * availability gate by design; member-specific wins in resolution.
   */
  async assign({ actorDid, isAdmin, target, profileId } = {}) {
    await requireAdmin({ actorDid, isAdmin, audit: this.audit, action: "profile-assign" });
    const shape = validTarget(target);
    if (!shape.ok) {
      return fail("E_ASSIGNMENT_TARGET_INVALID", "An assignment names exactly one target: an agent type or a member.");
    }
    const profile = await this.profiles.get(profileId);
    if (!profile) return fail("E_PROFILE_NOT_FOUND", "That profile does not exist.");
    const normalized = shape.hasType
      ? { agentType: target.agentType, memberId: null }
      : { agentType: null, memberId: target.memberId };
    // Replace semantics: one current assignment per target — the swap is the
    // write; history rides the audit trail, never competing rows. The target
    // fields ALSO ride top-level (flat index columns the resolution and
    // member-facing gates query — one query, one target).
    await this.assignments.deleteMany(shape.hasType ? { agentType: normalized.agentType } : { memberId: normalized.memberId });
    const row = {
      _id: `passign_${crypto.randomUUID()}`,
      target: normalized,
      agentType: normalized.agentType,
      memberId: normalized.memberId,
      profileRef: profile._id,
      assignedBy: actorDid,
      assignedAt: this.now(),
    };
    await this.assignments.insertOne(row);
    await this.audit.record({
      type: "profile-assigned",
      actorIdentityRef: actorDid,
      detail: {
        target: normalized.agentType ? { agentType: normalized.agentType } : { memberId: normalized.memberId },
        profileId: profile._id,
        profileName: profile.name,
        source: "admin",
      },
    });
    this.#publish(normalized.agentType ? { type: "profile-changed", agentType: normalized.agentType } : { type: "profile-changed", memberId: normalized.memberId });
    return row;
  }

  /**
   * A member self-assigns a profile to their own agent. The availability gate
   * runs first (admin ceiling): a withheld profile is refused with plain
   * language, the refusal audited, and the withholding survives every
   * member-side attempt. Within available profiles the parental narrowing
   * applies — members ride only parent-permitted profiles.
   */
  async selfAssign({ actorDid, profileId } = {}) {
    if (!actorDid) {
      await this.audit.record({ type: "profile-self-assigned", actorIdentityRef: null, detail: { reason: "unsigned" }, outcome: "denied" });
      return fail("E_MUST_SIGN_IN", "Sign in first.");
    }
    const profile = await this.profiles.get(profileId);
    if (!profile) return fail("E_PROFILE_NOT_FOUND", "That profile does not exist.");

    // Admin availability gate — the ceiling, first (ac-3).
    if (!profile.memberSelectable) {
      await this.audit.record({
        type: "profile-self-assign-refused",
        actorIdentityRef: actorDid,
        detail: { profileId: profile._id, reason: "profile withheld by the hub admin" },
        outcome: "denied",
      });
      return fail("E_PROFILE_UNAVAILABLE", "The hub admin has not made this profile available to members.");
    }

    // Parental narrowing — within available profiles, parents decide.
    const narrowing = await this.permissive.findOne({ memberId: actorDid });
    if (narrowing && !narrowing.permittedProfileRefs.includes(profile._id)) {
      await this.audit.record({
        type: "profile-self-assign-refused",
        actorIdentityRef: actorDid,
        detail: { profileId: profile._id, reason: "profile is outside the family's permitted set" },
        outcome: "denied",
      });
      return fail("E_NOT_PERMITTED", "Your family settings do not include this profile.");
    }

    await this.assignments.deleteMany({ memberId: actorDid });
    const row = {
      _id: `passign_${crypto.randomUUID()}`,
      target: { agentType: null, memberId: actorDid },
      agentType: null,
      memberId: actorDid,
      profileRef: profile._id,
      assignedBy: actorDid,
      assignedAt: this.now(),
    };
    await this.assignments.insertOne(row);
    await this.audit.record({
      type: "profile-assigned",
      actorIdentityRef: actorDid,
      detail: { target: { memberId: actorDid }, profileId: profile._id, profileName: profile.name, source: "member" },
    });
    this.#publish({ type: "profile-changed", memberId: actorDid });
    return row;
  }

  /**
   * The family organizer's narrowing write (PORCH-148 owns the enforcement;
   * PORCH-150 renders the control). A parent narrows their member's usable
   * profiles within what the admin has made available. Any requested profile
   * the admin has withheld → refused fail closed with plain language: the
   * parental grant of a withheld profile changes nothing. An empty set
   * clears the narrowing (the member rides the available universe again).
   */
  async parentalSet({ actorDid, familyId, memberId, profileIds } = {}) {
    if (!actorDid) return fail("E_MUST_SIGN_IN", "Sign in first.");
    if (!this.familiesForMember) {
      return fail("E_FAMILY_NOT_FOUND", "Family facts are not wired — parental narrowing cannot resolve.");
    }
    if (!Array.isArray(profileIds)) {
      return fail("E_VALIDATION", "profileIds must be a list of profile ids.");
    }
    const family = (await this.familiesForMember(actorDid)).find(
      (f) => f?._id === familyId && Array.isArray(f.parentIdentityRefs) && f.parentIdentityRefs.includes(actorDid),
    );
    if (!family) {
      await this.audit.record({
        type: "parental-narrowing-refused",
        actorIdentityRef: actorDid,
        detail: { familyId, memberId, reason: "actor is not a parent of this family" },
        outcome: "denied",
      });
      return fail("E_NOT_PERMITTED", "Only a parent of this family can narrow its members' model profiles.");
    }
    if (!Array.isArray(family.memberIdentityRefs) || !family.memberIdentityRefs.includes(memberId)) {
      return fail("E_FAMILY_MEMBER_UNKNOWN", "That member does not belong to this family.");
    }
    // Validate EVERY profile before any write: fail closed, never half-landed.
    const withheld = [];
    const resolved = [];
    for (const profileId of profileIds) {
      const profile = await this.profiles.get(profileId);
      if (!profile) return fail("E_PROFILE_NOT_FOUND", "One of the requested profiles does not exist.");
      resolved.push(profile);
      if (!profile.memberSelectable) withheld.push(profile);
    }
    if (withheld.length > 0) {
      await this.audit.record({
        type: "parental-narrowing-refused",
        actorIdentityRef: actorDid,
        detail: {
          familyId,
          memberId,
          reasons: withheld.map((p) => `${p.name} is withheld by the hub admin`),
        },
        outcome: "denied",
      });
      return fail(
        "E_PROFILE_UNAVAILABLE",
        `The hub admin has withheld ${withheld.map((p) => `"${p.name}"`).join(", ")} from member availability — a family cannot re-enable it.`,
      );
    }
    if (profileIds.length === 0) {
      await this.permissive.deleteOne({ memberId });
    } else {
      await this.permissive.deleteOne({ memberId });
      await this.permissive.insertOne({
        _id: `mperm_${crypto.randomUUID()}`,
        memberId,
        familyRef: family._id,
        permittedProfileRefs: profileIds,
        updatedBy: actorDid,
        updatedAt: this.now(),
      });
    }
    await this.audit.record({
      type: "parental-narrowing",
      actorIdentityRef: actorDid,
      detail: { familyId, memberId, permittedProfileRefs: profileIds, cleared: profileIds.length === 0 },
    });
    this.#publish({ type: "profile-changed", memberId });
    return { memberId, familyRef: family._id, permittedProfileRefs: profileIds };
  }

  /** A member's narrowing document, if the parents set one. */
  async narrowingFor(memberId) {
    return this.permissive.findOne({ memberId });
  }

  /** A member's narrowing with profile projections (parent/organizer view). */
  async narrowingView(memberId) {
    const narrowing = await this.narrowingFor(memberId);
    if (!narrowing) return { narrowed: false, memberId };
    const profiles = [];
    for (const profileId of narrowing.permittedProfileRefs) {
      const profile = await this.profiles.get(profileId);
      if (profile) profiles.push(memberProjection(profile));
    }
    return { narrowed: true, memberId, familyRef: narrowing.familyRef, updates: { updatedAt: narrowing.updatedAt, updatedBy: narrowing.updatedBy }, profiles };
  }

  /**
   * The admin assignment list; for a queried agent type with no assignment,
   * the explicit unassigned state renders (never a silent default model).
   */
  async list({ agentType = null } = {}) {
    const rows = await this.assignments.find({});
    if (agentType !== null) {
      const row = rows.find((r) => r.target?.agentType === agentType);
      if (!row) return { state: "unassigned", agentType, detail: "No profile is assigned to this agent type. The admin must assign one — member agents of this type refuse to resolve a silent default." };
      const profile = await this.profiles.get(row.profileRef);
      return { state: "assigned", agentType, assignment: row, profile: profile ? adminView(profile) : null };
    }
    const withProfiles = [];
    for (const row of rows) {
      const profile = await this.profiles.get(row.profileRef);
      withProfiles.push({ ...row, profile: profile ? adminView(profile) : null });
    }
    return { rows: withProfiles };
  }

  /** Admin revokes an assignment — the target renders explicitly unassigned. */
  async revoke({ actorDid, isAdmin, assignmentId } = {}) {
    await requireAdmin({ actorDid, isAdmin, audit: this.audit, action: "profile-assign-revoked" });
    const row = await this.assignments.findOne({ _id: assignmentId });
    if (!row) return fail("E_ASSIGNMENT_NOT_FOUND", "That assignment does not exist.");
    await this.assignments.deleteOne({ _id: row._id });
    await this.audit.record({
      type: "profile-assign-revoked",
      actorIdentityRef: actorDid,
      detail: { assignmentId: row._id, target: row.target, profileRef: row.profileRef },
    });
    this.#publish(row.target?.memberId ? { type: "profile-changed", memberId: row.target.memberId } : { type: "profile-changed", agentType: row.target?.agentType ?? null });
    return { revoked: true, assignmentId: row._id };
  }

  /** Whether a did resolves as the hub admin (used by resolution's gate). */
  async resolvesAdmin(did) {
    if (!did) return false;
    return Boolean(await this.isAdmin(did));
  }

  #publish(event) {
    if (!this.publishChange) return;
    try {
      this.publishChange({ ...event, at: this.now() });
    } catch (error) {
      void this.audit
        .record({ type: "profile-change-publish-failed", actorIdentityRef: null, detail: { event, reason: String(error?.message ?? error) } })
        .catch(() => {});
    }
  }
}

export function adminView(profile) {
  return {
    profileId: profile._id,
    name: profile.name,
    providerClass: profile.providerClass,
    modelId: profile.modelId,
    memberSelectable: Boolean(profile.memberSelectable),
  };
}

function defaultNow() {
  return new Date().toISOString();
}
