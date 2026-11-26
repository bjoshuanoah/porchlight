import { requireSessionOr401 } from "../util/session-guard.js";

/**
 * Family controller (PORCH-138): transport only. The session-bound family
 * organizer surfaces — every decision lives in FamilyService; errors map
 * by typed code. Parents govern membership; the caller's own session did
 * is the only authority ever used.
 */
export class FamilyController {
  /**
   * @param {import("../services/family.service.js").FamilyService} familyService
   * @param {import("authService").AuthService} authService
   * @param {((line: string) => void) | null} [log] - auth-failure capture sink (PORCH-019).
   */
  constructor(familyService, authService, log = null) {
    this.familyService = familyService;
    this.authService = authService;
    this.log = log;
  }

  async requireSession(req, res) {
    return requireSessionOr401({ req, res, authService: this.authService, log: this.log });
  }

  /** POST /families {name, parentIdentityRefs?, memberIdentityRefs?} — create + designate parents. */
  create = async (req, res) => {
    const session = await this.requireSession(req, res);
    if (!session) return;
    const { name, parentIdentityRefs, memberIdentityRefs } = req.body ?? {};
    try {
      const result = await this.familyService.create({
        actorDid: session.did,
        name,
        parentIdentityRefs,
        memberIdentityRefs,
      });
      res.status(201).json(result);
    } catch (error) {
      res.status(statusByCode(error)).json({ error: error.message, code: error.code ?? "E_INTERNAL" });
    }
  };

  /** GET /families — the caller's families. */
  list = async (req, res) => {
    const session = await this.requireSession(req, res);
    if (!session) return;
    try {
      res.json(await this.familyService.list({ actorDid: session.did }));
    } catch (error) {
      res.status(statusByCode(error)).json({ error: error.message, code: error.code ?? "E_INTERNAL" });
    }
  };

  /** POST /families/:familyId/members {did} — parent adds a member. */
  addMember = async (req, res) => {
    return this.#mutate(req, res, (session) => ({
      actorDid: session.did,
      familyId: req.params?.familyId,
      did: req.body?.did,
    }), "addMember");
  };

  /** POST /families/:familyId/members/remove {did} — parent removes a member. */
  removeMember = async (req, res) => {
    return this.#mutate(req, res, (session) => ({
      actorDid: session.did,
      familyId: req.params?.familyId,
      did: req.body?.did,
    }), "removeMember");
  };

  /** POST /families/:familyId/parents {did} — parent designates a parent. */
  addParent = async (req, res) => {
    return this.#mutate(req, res, (session) => ({
      actorDid: session.did,
      familyId: req.params?.familyId,
      did: req.body?.did,
    }), "addParent");
  };

  /** POST /families/:familyId/parents/remove {did} — with the last-parent rule. */
  removeParent = async (req, res) => {
    return this.#mutate(req, res, (session) => ({
      actorDid: session.did,
      familyId: req.params?.familyId,
      did: req.body?.did,
    }), "removeParent");
  };

  async #mutate(req, res, args, method) {
    const session = await this.requireSession(req, res);
    if (!session) return;
    try {
      res.json(await this.familyService[method](args(session)));
    } catch (error) {
      res.status(statusByCode(error)).json({ error: error.message, code: error.code ?? "E_INTERNAL" });
    }
  }
}

const STATUS = {
  400: ["E_FIELDS_REQUIRED", "E_VALIDATION", "E_NAME_REQUIRED", "E_NAME_TOO_LONG", "E_IDENTITY_REQUIRED", "E_IDENTITY_NOT_FOUND"],
  403: ["E_FORBIDDEN", "E_LAST_PARENT", "E_ALREADY_IN_ROLE", "E_NOT_A_MEMBER", "E_NOT_A_PARENT"],
  404: ["E_FAMILY_NOT_FOUND", "E_FAMILY_ROLE_OVERLAP"],
};

function statusByCode(error) {
  for (const [status, codes] of Object.entries(STATUS)) {
    if (codes.includes(error?.code)) return Number(status);
  }
  return 500;
}

export default FamilyController;
