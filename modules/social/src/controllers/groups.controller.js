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
      E_GROUP_VISIBILITY_INVALID: 400,
      E_GROUP_BLOCKED: 403,
      E_GROUP_MEMBER_UNKNOWN: 404,
    };
    const status = statusByCode[error.code] ?? 500;
    const message =
      status === 500
        ? "Something went wrong on the hub. Try again, or contact the network owner."
        : error.message;
    res.status(status).json({ error: message, code: error.code ?? "E_INTERNAL" });
  }

  /** GET /groups — every group container on the member's origin network (ac-1);
   *  a private group the member does not hold is not on the index (PORCH-068 ac-2). */
  list = async (req, res) => {
    const perimeter = await this.#requireMember(req, res);
    if (!perimeter) return;
    try {
      const groups = await this.groups.list({
        networkId: perimeter.membership.networkId,
        viewerDid: perimeter.session.did,
      });
      res.json({ groups });
    } catch (error) {
      this.memberError(res, error);
    }
  };

  /** GET /groups/:groupId — one group, origin-scoped (ac-1; the Members view reads this).
   *  A private group opens only for its members (PORCH-068 ac-2). */
  detail = async (req, res) => {
    const perimeter = await this.#requireMember(req, res);
    if (!perimeter) return;
    try {
      const group = await this.groups.get({
        networkId: perimeter.membership.networkId,
        groupId: req.params?.groupId,
        viewerDid: perimeter.session.did,
      });
      res.json({ group });
    } catch (error) {
      this.memberError(res, error);
    }
  };

  /**
   * POST /groups — open group creation for every member (ac-2): no owner or
   * delegate elevation; the calling member is recorded as the group's
   * creator and enters its membership. The creator picks the group's
   * visibility at creation (PORCH-068 ac-1): private by default, public
   * explicitly.
   */
  create = async (req, res) => {
    const perimeter = await this.#requireMember(req, res);
    if (!perimeter) return;
    const { name, members, visibility } = req.body ?? {};
    try {
      const group = await this.groups.create({
        networkId: perimeter.membership.networkId,
        name,
        members,
        visibility,
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

  /**
   * POST /groups/:groupId/visibility — the Members view's visibility change
   * (PORCH-068 ac-1): the group's creator (or the network owner) flips a
   * group between private and public; the group service enforces the same
   * managing-member authority as membership.
   */
  updateVisibility = async (req, res) => {
    const perimeter = await this.#requireMember(req, res, "groups.members");
    if (!perimeter) return;
    const visibility = req.body?.visibility;
    try {
      const group = await this.groups.updateVisibility({
        groupId: req.params?.groupId,
        networkId: perimeter.membership.networkId,
        actorDid: perimeter.session.did,
        visibility,
      });
      await this.audit.record({
        networkId: perimeter.membership.networkId,
        did: perimeter.session.did,
        action: "group_visibility_change",
        detail: { groupId: group._id, visibility },
      });
      res.status(200).json({ group });
    } catch (error) {
      this.memberError(res, error);
    }
  };
  /**
   * POST /groups/:groupId/join — the self-serve join (PORCH-068, lifecycle
   * ruling): a public group joins with the member's own act, no approval
   * flow and no request stage; delivery turns on immediately (the feed
   * predicate is the live roster). The service enforces visibility,
   * the blocked-rejoin gate, and the network-membership subset rule.
   */
  join = async (req, res) => {
    const perimeter = await this.#requireMember(req, res, "groups.join");
    if (!perimeter) return;
    try {
      const group = await this.groups.join({
        groupId: req.params?.groupId,
        networkId: perimeter.membership.networkId,
        did: perimeter.session.did,
      });
      await this.audit.record({
        networkId: perimeter.membership.networkId,
        did: perimeter.session.did,
        action: "group_join",
        detail: { groupId: group._id },
      });
      res.status(200).json({ group });
    } catch (error) {
      this.memberError(res, error);
    }
  };

  /**
   * POST /groups/:groupId/members/remove — the Members view's removal
   * (PORCH-068, lifecycle ruling): the managing member removes a member;
   * the removal and its blocked entry land in one storage write, so a
   * removed member can never straddle the two states.
   */
  removeMember = async (req, res) => {
    const perimeter = await this.#requireMember(req, res, "groups.members");
    if (!perimeter) return;
    const did = req.body?.did;
    try {
      const group = await this.groups.removeMember({
        groupId: req.params?.groupId,
        networkId: perimeter.membership.networkId,
        actorDid: perimeter.session.did,
        did,
      });
      await this.audit.record({
        networkId: perimeter.membership.networkId,
        did: perimeter.session.did,
        action: "group_member_remove",
        detail: { groupId: group._id, removed: did },
      });
      res.status(200).json({ group });
    } catch (error) {
      this.memberError(res, error);
    }
  };

  /**
   * POST /groups/:groupId/unblock — the managing member lifts a blocked
   * entry; the member then re-joins themselves (public) or is added
   * (private invite).
   */
  unblock = async (req, res) => {
    const perimeter = await this.#requireMember(req, res, "groups.members");
    if (!perimeter) return;
    const did = req.body?.did;
    try {
      const group = await this.groups.unblock({
        groupId: req.params?.groupId,
        networkId: perimeter.membership.networkId,
        actorDid: perimeter.session.did,
        did,
      });
      await this.audit.record({
        networkId: perimeter.membership.networkId,
        did: perimeter.session.did,
        action: "group_unblock",
        detail: { groupId: group._id, unblocked: did },
      });
      res.status(200).json({ group });
    } catch (error) {
      this.memberError(res, error);
    }
  };
}

export default GroupsController;