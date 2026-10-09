/**
 * Member group controller (PORCH-030). The member plane for group
 * containers: the groups index and group detail are readable by every
 * member, group creation is open to every network member (groups amendment,
 * Brian Oct 14 2026), and the group's membership is managed by its creator
 * from the group's Members view. Transport-specific only — all domain logic
 * lives in the group service.
 */
const GROUP_MESSAGES = {
  E_MUST_SIGN_IN: "Sign in to your membership before opening the groups.",
  E_NOT_PERMITTED: "This action is not available to you in this network.",
};

export class GroupsController {
  /**
   * @param {object} deps
   * @param {import("../services/group.service.js").GroupService} deps.groups
   * @param {import("../services/membership.service.js").MembershipService} deps.membership
   * @param {import("../services/audit.service.js").AuditService} deps.audit
   * @param {((line: string) => void) | null} [deps.log]
   */
  constructor({ groups, membership, audit, log }) {
    this.groups = groups;
    this.membership = membership;
    this.audit = audit;
    this.log = log ?? null;
  }

  /**
   * Member perimeter guard: a valid Bearer membership token resolves the
   * session's origin network and acting DID. No token is 401, a token that
   * carries no active membership session is 403 — the same member-plane
   * contract the feed controller enforces (the failure capture rides the
   * membership service's auth-failure sink, PORCH-019).
   *
   * @returns {Promise<{membership: object, session: {did: string}} | null>}
   *   the verified perimeter to continue with, or null after writing the error.
   */
  async #requireMember(req, res, surface = "groups") {
    const header = req.headers?.authorization ?? "";
    const accessToken = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    const perimeter = accessToken
      ? await this.membership.verifyAccessToken(accessToken, { surface })
      : null;
    if (!perimeter) {
      res
        .status(accessToken ? 403 : 401)
        .json(
          accessToken
            ? { error: GROUP_MESSAGES.E_NOT_PERMITTED, code: "E_NOT_PERMITTED" }
            : { error: GROUP_MESSAGES.E_MUST_SIGN_IN, code: "E_MUST_SIGN_IN" },
        );
      return null;
    }
    return perimeter;
  }

  memberError(res, error) {
    const statusByCode = {
      E_MUST_SIGN_IN: 401,
      E_NOT_PERMITTED: 403,
      E_GROUP_UNKNOWN: 404,
      E_GROUP_NOT_MEMBER: 403,
      E_GROUP_NOT_CREATOR: 403,
      E_GROUP_NAME_REQUIRED: 400,
      E_GROUP_MEMBERS_INVALID: 400,
    };
    const status = statusByCode[error.code] ?? 500;
    const message =
      status === 500
        ? "Something went wrong on the hub. Try again, or contact the network owner."
        : error.message;
    res.status(status).json({ error: message, code: error.code ?? "E_INTERNAL" });
  }

  /** GET /groups — every group container on the member's origin network (ac-1). */
  list = async (req, res) => {
    const perimeter = await this.#requireMember(req, res);
    if (!perimeter) return;
    try {
      const groups = await this.groups.list({ networkId: perimeter.membership.networkId });
      res.json({ groups });
    } catch (error) {
      this.memberError(res, error);
    }
  };

  /** GET /groups/:groupId — one group, origin-scoped (ac-1; the Members view reads this). */
  detail = async (req, res) => {
    const perimeter = await this.#requireMember(req, res);
    if (!perimeter) return;
    try {
      const group = await this.groups.get({
        networkId: perimeter.membership.networkId,
        groupId: req.params?.groupId,
      });
      res.json({ group });
    } catch (error) {
      this.memberError(res, error);
    }
  };

  /**
   * POST /groups — open group creation for every member (ac-2): no owner or
   * delegate elevation; the calling member is recorded as the group's
   * creator and enters its membership.
   */
  create = async (req, res) => {
    const perimeter = await this.#requireMember(req, res);
    if (!perimeter) return;
    const { name, members } = req.body ?? {};
    try {
      const group = await this.groups.create({
        networkId: perimeter.membership.networkId,
        name,
        members,
        createdBy: perimeter.session.did,
      });
      await this.audit.record({
        networkId: perimeter.membership.networkId,
        did: perimeter.session.did,
        action: "group_create",
        detail: { groupId: group._id },
      });
      res.status(201).json({ group });
    } catch (error) {
      this.memberError(res, error);
    }
  };

  /**
   * POST /groups/:groupId/members — the Members view's add action (ac-3).
   * Accepts one member DID (`{did}`) or a list (`{dids}`); the group
   * service enforces creator-or-owner authority and the network-membership
   * subset rule.
   */
  addMembers = async (req, res) => {
    const perimeter = await this.#requireMember(req, res, "groups.members");
    if (!perimeter) return;
    const body = req.body ?? {};
    const dids = Array.isArray(body.dids) ? body.dids : body.did != null ? [body.did] : [];
    try {
      const group = await this.groups.addMembers({
        groupId: req.params?.groupId,
        networkId: perimeter.membership.networkId,
        actorDid: perimeter.session.did,
        dids,
      });
      await this.audit.record({
        networkId: perimeter.membership.networkId,
        did: perimeter.session.did,
        action: "group_member_add",
        detail: { groupId: group._id, added: dids },
      });
      res.status(200).json({ group });
    } catch (error) {
      this.memberError(res, error);
    }
  };
}

export default GroupsController;