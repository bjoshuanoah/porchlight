/**
 * Resolution service (PORCH-148 ac-2). THE one resolution function of the
 * model-profile chain of record — agent-type default and member-specific
 * assignment both resolve through here, and the enforcement order is the
 * TS 2 chain verbatim: admin availability gate, then parental narrowing,
 * then type/member assignment. No parallel resolution path is permitted;
 * member self-selection, the member surface read, and every inference call
 * compose these same gates through this single function.
 *
 * Composition (the PRD 2 law, resolved):
 *  - The admin's availability ruling is the ceiling: a withheld profile is
 *    unusable by member selection and member-facing reads. The gate is never
 *    on the admin's own assignment power: a withheld profile rides only an
 *    admin-sourced assignment (ac-3), and such a ride is exempt from the
 *    parental narrowing too — the withheld profile does not exist in the
 *    parental universe (parents can never permit it), so parental narrowing
 *    composes over the available set only.
 *  - Within available profiles, the parent's narrowing governs everything
 *    that runs for a narrowed member: a resolved assignment outside the
 *    permitted set fails with an explicit parental-blocked state (the agent
 *    runs only parent-permitted profiles; members outside that family are
 *    unaffected).
 *  - Member-specific assignment wins over the agent-type default; an agent
 *    type (or member) with no assignment resolves the explicit unassigned
 *    state — never a silent default model.
 */
import { AGENT_TYPE_HOUSEHOLD_MEMBER } from "../inference/profile-provider.js";

export class ResolutionService {
  /**
   * @param {import("@porchlight/shared").CollectionLike} assignments
   * @param {import("@porchlight/shared").CollectionLike} permissive
   * @param {import("./profiles.service.js").ProfileService} profiles
   * @param {(did: string) => Promise<boolean> | boolean} isAdmin
   *   The hub-admin fact of record — injected, never imported.
   * @param {() => string} [now]
   */
  constructor(assignments, permissive, profiles, isAdmin = () => false, now = defaultNow) {
    this.assignments = assignments;
    this.permissive = permissive;
    this.profiles = profiles;
    this.#isAdmin = isAdmin;
    this.now = now;
  }

  #isAdmin;

  /**
   * @param {{
   *   memberId: string,
   *   agentType?: string | null,
   * }} input
   * @returns {Promise<{ state: "resolved", profile: object, source: "member"|"type", adminSourced: boolean, at: string }
   *   | { state: "unassigned"|"unassigned-type", memberId: string, reason: string, at: string }
   *   | { state: "unavailable", memberId: string, profileId: string, reason: string, at: string }
   *   | { state: "parental-blocked", memberId: string, profileId: string, reason: string, at: string }>}
   */
  async resolve({ memberId, agentType = null } = {}) {
    const at = this.now();
    if (typeof memberId !== "string" || memberId.length === 0) {
      throw new TypeError("ResolutionService.resolve: memberId required");
    }

    // 1. The assignment source: member-specific wins over the agent-type
    //    default; the type default applies to every member without their own.
    let assignment = await this.assignments.findOne({ memberId });
    let source = "member";
    if (!assignment && agentType) {
      assignment = await this.assignments.findOne({ agentType });
      source = "type";
    }
    if (!assignment) {
      return {
        state: "unassigned",
        memberId,
        at,
        reason: "No model profile is assigned — the admin surface names the unassigned state; there is no silent default model.",
      };
    }
    const profile = await this.profiles.get(assignment.profileRef);
    if (!profile) {
      return {
        state: "unassigned",
        memberId,
        at,
        reason: "The assigned profile no longer exists — resolving as unassigned, never a silent default.",
      };
    }

    // 2. The admin availability gate (the ceiling, first): withheld profiles
    //    are member-facing unavailable — they ride only the admin's own
    //    assignment power.
    const adminSourced = Boolean(await this.#isAdmin(assignment.assignedBy));
    if (!profile.memberSelectable && !adminSourced) {
      return {
        state: "unavailable",
        memberId,
        profileId: profile._id,
        at,
        reason: "The hub admin has withheld this profile from member availability.",
      };
    }

    // 3. The parental narrowing: within available profiles, parents decide
    //    what their member's agent may run. A withheld profile passes the
    //    same way it entered — under the admin's own assignment power.
    const narrowing = await this.permissive.findOne({ memberId });
    if (narrowing && profile.memberSelectable && !narrowing.permittedProfileRefs.includes(profile._id)) {
      return {
        state: "parental-blocked",
        memberId,
        profileId: profile._id,
        at,
        reason: "Your family settings do not include this model profile.",
      };
    }

    return { state: "resolved", profile, source, adminSourced, at };
  }

  /**
   * The member-surface read of record (TS 2 privacy invariants, PORCH-148
   * ac-6): which model is running, and the profile's provider CLASS — never
   * the address, never a token. Degradation surfaces here by name (the
   * never-silent law): the latest provenance row's degraded/fallback state
   * rides, and the unassigned / unavailable / parental-blocked states name
   * themselves. The read carries no withheld-profile existence: a withheld
   * profile reachable only through admin assignment surfaces as any other
   * running model (name and class of what actually runs — no selection
   * surface leaks it).
   */
  async memberModelView({ memberId, agentType = null, provenance = null } = {}) {
    // Unassigned members fall to the agent-type default — the member surface
    // reads the same chain (the household-member agent is the default type).
    const resolution = await this.resolve({ memberId, agentType: agentType ?? AGENT_TYPE_HOUSEHOLD_MEMBER });
    if (resolution.state !== "resolved") {
      return {
        state: resolution.state === "unassigned" ? "unassigned" : resolution.state === "parental-blocked" ? "parental-blocked" : "unavailable",
        reason: resolution.reason,
        model: null,
      };
    }
    const p = resolution.profile;
    const latest = provenance ? await provenance.latestForMember(memberId) : null;
    const degraded = latest?.degraded
      ? { reason: latest.degraded.reason }
      : latest?.fallback
        ? { reason: `Running the explicitly configured fallback (${latest.fallback.profileName}) — the assigned profile's provider could not answer.`, fallback: latest.fallback }
        : null;
    // The read names what actually runs: a fallback ride renders the
    // fallback's model and class, never a silent switch.
    const model = degraded?.fallback
      ? { modelId: latest.modelId, providerClass: latest.providerClass }
      : { modelId: p.modelId, providerClass: p.providerClass };
    return {
      state: degraded ? "degraded" : "running",
      model,
      reason: degraded ? degraded.reason : null,
      fallback: latest?.fallback ?? null,
      resolvedAt: resolution.at,
    };
  }
}

function defaultNow() {
  return new Date().toISOString();
}
