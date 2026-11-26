/**
 * Member controller — the member-facing agent surface of record (TS 2
 * privacy invariants; PORCH-148 ac-6): which model is running and its
 * provider CLASS, the member's selectable profile list (availability
 * enforced by the schema's memberSelectable — a withheld profile renders
 * nowhere and its existence never leaks), and the self-selection attempt
 * that rides the ONE assignment path.
 */
import { delegate } from "./transport.js";

export class MemberController {
  /**
   * @param {{
   *   profiles: import("../services/profiles.service.js").ProfileService,
   *   assignments: import("../services/assignments.service.js").AssignmentService,
   *   resolution: import("../services/resolution.service.js").ResolutionService,
   *   provenance: import("../services/provenance.service.js").ProvenanceService,
   *   verifySession: (token: string | null) => Promise<{ did: string, deviceId?: string } | null>,
   * }} deps
   */
  constructor({ profiles, assignments, resolution, provenance, verifySession }) {
    this.profiles = profiles;
    this.assignments = assignments;
    this.resolution = resolution;
    this.provenance = provenance;
    this.verifySession = verifySession;
  }

  bearer(req) {
    const header = req.headers?.authorization ?? "";
    return header.startsWith("Bearer ") ? header.slice(7) : null;
  }

  async #memberDid(req) {
    const session = await this.verifySession(this.bearer(req));
    if (!session?.did) {
      const error = new Error("Sign in first.");
      error.code = "E_MUST_SIGN_IN";
      throw error;
    }
    return session.did;
  }

  /** GET /me/model — the member reads their agent's running model + provider class (no endpoint/token strings anywhere). */
  myModel = async (req, res) => {
    return delegate(res, async () => {
      const did = await this.#memberDid(req);
      return this.resolution.memberModelView({ memberId: did, agentType: req.query?.agentType ?? null, provenance: this.provenance });
    });
  };

  /** GET /me/profiles — the profiles a member may select (withheld ones absent, existence never leaked). */
  mySelectableProfiles = async (req, res) => {
    return delegate(res, async () => {
      await this.#memberDid(req);
      return { profiles: await this.profiles.memberList() };
    });
  };

  /** POST /me/model {profileId} — the member self-selects; withheld → plain-language refusal (audited). */
  myModelSet = async (req, res) => {
    return delegate(res, async () => {
      const did = await this.#memberDid(req);
      const body = typeof req.body === "object" && req.body !== null ? req.body : {};
      return this.assignments.selfAssign({ actorDid: did, profileId: body.profileId });
    });
  };
}
