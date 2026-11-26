/**
 * Governance controller (admin + parental paths). Transport only: resolve
 * the actor through the injected identity plane, delegate to the services.
 * The hub-admin fact comes from the injected seam (the identity plane is the
 * only identity source; never imported); the parental check resolves family
 * facts inside the assignment service.
 */
import { delegate } from "./transport.js";

export class GovernanceController {
  /**
   * @param {{
   *   profiles: import("../services/profiles.service.js").ProfileService,
   *   assignments: import("../services/assignments.service.js").AssignmentService,
   *   provenance: import("../services/provenance.service.js").ProvenanceService,
   *   verifySession: (token: string | null) => Promise<{ did: string, deviceId?: string } | null>,
   * }} deps
   */
  constructor({ profiles, assignments, provenance, verifySession }) {
    this.profiles = profiles;
    this.assignments = assignments;
    this.provenance = provenance;
    this.verifySession = verifySession;
  }

  bearer(req) {
    const header = req.headers?.authorization ?? "";
    return header.startsWith("Bearer ") ? header.slice(7) : null;
  }

  async #actor(req) {
    const session = await this.verifySession(this.bearer(req));
    if (!session?.did) {
      const error = new Error("Sign in first.");
      error.code = "E_MUST_SIGN_IN";
      throw error;
    }
    return session.did;
  }

  async #requireAdmin(req) {
    const did = await this.#actor(req);
    if (!(await this.assignments.resolvesAdmin(did))) {
      const error = new Error("Only the hub admin can manage model profiles.");
      error.code = "E_NOT_PERMITTED";
      throw error;
    }
    return did;
  }

  /** POST /profiles — the admin defines a profile. */
  createProfile = async (req, res) => {
    return delegate(res, async () => {
      const did = await this.#actor(req);
      const body = this.#body(req);
      return this.profiles.define({
        actorDid: did,
        isAdmin: await this.assignments.resolvesAdmin(did),
        name: body.name,
        providerClass: body.providerClass,
        modelId: body.modelId,
        endpointRef: body.endpointRef ?? null,
        memberSelectable: body.memberSelectable,
        safetyFields: body.safetyFields,
      });
    });
  };

  /** GET /profiles — the admin list (including withheld profiles). */
  listProfiles = async (_req, res) => {
    return delegate(res, async () => {
      await this.#requireAdmin(_req);
      return { profiles: await this.profiles.adminList() };
    });
  };

  /** PUT /profiles/:profileId/availability — the admin availability flip. */
  setAvailability = async (req, res) => {
    return delegate(res, async () => {
      const did = await this.#actor(req);
      return this.profiles.updateAvailability({
        actorDid: did,
        isAdmin: await this.assignments.resolvesAdmin(did),
        profileId: req.params?.profileId,
        memberSelectable: this.#body(req).memberSelectable,
      });
    });
  };

  /** POST /assignments — the admin assigns to an agent type or member. */
  assign = async (req, res) => {
    return delegate(res, async () => {
      const did = await this.#actor(req);
      const body = this.#body(req);
      return this.assignments.assign({
        actorDid: did,
        isAdmin: await this.assignments.resolvesAdmin(did),
        target: body.target,
        profileId: body.profileId,
      });
    });
  };

  /** DELETE /assignments/:assignmentId — the admin revokes; the target renders unassigned. */
  revokeAssignment = async (req, res) => {
    return delegate(res, async () => {
      const did = await this.#actor(req);
      return this.assignments.revoke({
        actorDid: did,
        isAdmin: await this.assignments.resolvesAdmin(did),
        assignmentId: req.params?.assignmentId,
      });
    });
  };

  /** GET /assignments?agentType= — the list; for a queried type with none, the explicit unassigned state. */
  listAssignments = async (req, res) => {
    return delegate(res, async () => {
      await this.#requireAdmin(req);
      return this.assignments.list({ agentType: req.query?.agentType ?? null });
    });
  };

  /** GET /provenance?memberId= — the admin-visible provenance trail. */
  provenanceList = async (req, res) => {
    return delegate(res, async () => {
      await this.#requireAdmin(req);
      const memberId = req.query?.memberId;
      if (typeof memberId !== "string" || !memberId) {
        return { rows: [], total: 0 };
      }
      return this.provenance.forMember({ memberId, limit: Number(req.query?.limit ?? 50), offset: Number(req.query?.offset ?? 0) });
    });
  };

  /** POST /families/:familyId/members/:memberId/permitted-profiles — the parent narrows (the family organizer's one write surface of record). */
  parentalSet = async (req, res) => {
    return delegate(res, async () => {
      const did = await this.#actor(req);
      const body = this.#body(req);
      return this.assignments.parentalSet({
        actorDid: did,
        familyId: req.params?.familyId,
        memberId: req.params?.memberId,
        profileIds: body.profileIds,
      });
    });
  };

  /** GET /families/:familyId/members/:memberId/permitted-profiles — the narrowing as the organizer renders it. */
  parentalGet = async (req, res) => {
    return delegate(res, async () => {
      await this.#actor(req);
      return this.assignments.narrowingView(req.params?.memberId);
    });
  };

  #body(req) {
    return typeof req.body === "object" && req.body !== null ? req.body : {};
  }
}
