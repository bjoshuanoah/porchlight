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
   * @param {import("../services/post.service.js").PostService} [deps.postsService]
   *   PORCH-088: the owner post-removal's service (the moderation write
   *   lives in the post service, where the deletion cascade lives).
   * @param {((line: string) => void) | null} [deps.log]
   */
  constructor({ groups, membership, audit, postsService = null, log }) {
    this.groups = groups;
    this.membership = membership;
    this.audit = audit;
    this.postsService = postsService;
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

  /** The Bearer token extractor for the service-delegating write handlers. */
  #bearerToken(req) {
    const header = req.headers?.authorization ?? "";
    return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  }

  memberError(res, error) {
    const statusByCode = {
      E_MUST_SIGN_IN: 401,
      E_NOT_PERMITTED: 403,
      E_GROUP_UNKNOWN: 404,
      E_GROUP_MEMBER_UNKNOWN: 404,
      E_GROUP_NOT_MEMBER: 403,
      E_GROUP_NOT_CREATOR: 403,
      E_GROUP_NAME_REQUIRED: 400,
      E_GROUP_MEMBERS_INVALID: 400,
      E_GROUP_VISIBILITY_INVALID: 400,
      E_GROUP_BLOCKED: 403,
      E_GROUP_POST_ONLY: 403,
      // PORCH-088: the group settings' plain-language refusal classes.
      E_GROUP_COLOR_INVALID: 400,
      E_GROUP_AVATAR_REQUIRED: 400,
      E_GROUP_AVATAR_DECLARATION_INVALID: 400,
      E_GROUP_AVATAR_SHA_MISMATCH: 400,
      E_GROUP_AVATAR_UNAVAILABLE: 503,
      E_GROUP_AVATAR_NOT_FOUND: 404,
      // The treatment's own refusal classes (the member-avatar ingest
      // treatment's named states), forwarded verbatim.
      E_AVATAR_UNSUPPORTED_TYPE: 400,
      E_AVATAR_TOO_LARGE: 400,
      E_AVATAR_UNDECODABLE: 400,
      E_SIGNATURE_REQUIRED: 401,
      E_SIGNATURE_INVALID: 401,
      E_DEVICE_REQUIRED: 403,
      E_BLOB_MISSING: 500,
      E_POST_NOT_FOUND: 404,
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
   * POST /groups/:groupId/avatar (PORCH-088 ac-2): the managing member's
   * avatar write — raw image bytes as the body (the byte route's
   * Content-Length gate runs BEFORE the bytes buffer), the device-signed
   * declaration in the `x-porchlight-avatar-payload` header and its
   * signature in `x-porchlight-signature` (the member-avatar route's
   * declaration shape, scoped "group-avatar"). The service runs the
   * member-avatar ingest treatment and enforces the managing-member
   * authority in the write path.
   */
  setAvatar = async (req, res) => {
    const perimeter = await this.#requireMember(req, res, "groups.settings");
    if (!perimeter) return;
    let payload = null;
    try {
      payload = JSON.parse(String(req.headers["x-porchlight-avatar-payload"] ?? ""));
    } catch {
      payload = null;
    }
    try {
      const group = await this.groups.setAvatar({
        groupId: req.params?.groupId,
        networkId: perimeter.membership.networkId,
        actorDid: perimeter.session.did,
        actorDeviceId: perimeter.session.deviceId ?? null,
        bytes: req.body && Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        contentType: req.headers["content-type"] ?? null,
        payload,
        signature: req.headers["x-porchlight-signature"] ?? null,
      });
      await this.audit.record({
        networkId: perimeter.membership.networkId,
        did: perimeter.session.did,
        action: "group_avatar_set",
        detail: { groupId: group._id, deviceSignature: req.headers["x-porchlight-signature"] ?? null },
      });
      res.status(200).json({ group });
    } catch (error) {
      this.memberError(res, error);
    }
  };

  /**
   * PATCH /groups/:groupId/color (PORCH-088 ac-3): the managing member's
   * palette-color write; `null` (the JSON body's `color: null`) resets to
   * the neutral default. Family language on refusal.
   */
  setColor = async (req, res) => {
    const perimeter = await this.#requireMember(req, res, "groups.settings");
    if (!perimeter) return;
    const color = req.body?.color ?? null;
    try {
      const group = await this.groups.setColor({
        groupId: req.params?.groupId,
        networkId: perimeter.membership.networkId,
        actorDid: perimeter.session.did,
        actorDeviceId: perimeter.session.deviceId ?? null,
        color,
        payload: req.body?.payload ?? null,
        signature: req.body?.signature ?? null,
      });
      await this.audit.record({
        networkId: perimeter.membership.networkId,
        did: perimeter.session.did,
        action: "group_color_set",
        detail: { groupId: group._id, color },
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

  /**
   * DELETE /groups/:groupId/posts/:postId (PORCH-088 ac-4): the managing
   * member's (or network owner's) post removal — the device-signed
   * moderation act riding the origin deletion cascade in the post service.
   * Authorization, cascade, and the audit record live in the service.
   */
  removePost = async (req, res) => {
    const perimeter = await this.#requireMember(req, res, "posts");
    if (!perimeter) return;
    try {
      const result = await this.postsService.removePost({
        accessToken: this.#bearerToken(req),
        postId: req.params?.postId,
        signature: req.body?.signature ?? null,
      });
      res.status(200).json(result);
    } catch (error) {
      this.memberError(res, error);
    }
  };

  /**
   * GET /groups/:groupId/avatar/:kind (PORCH-088 ac-2): the group face's
   * rendition surface — content-addressed and immutable, hub origin only.
   */
  serveAvatarRung = async (req, res) => {
    const perimeter = await this.#requireMember(req, res, "groups");
    if (!perimeter) return;
    try {
      const rung = await this.groups.serveAvatarRung({
        groupId: req.params?.groupId,
        networkId: perimeter.membership.networkId,
        viewerDid: perimeter.session.did,
        kind: req.params?.kind,
        version: req.query?.v ?? null,
      });
      res.status(200);
      res.setHeader("Content-Type", rung.contentType);
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      res.setHeader("ETag", `"${rung.sha256}"`);
      // The media-geometry stamps (square dims on every rung — zero reflow).
      res.setHeader("X-Porchlight-Media-Width", String(rung.width));
      res.setHeader("X-Porchlight-Media-Height", String(rung.height));
      res.send(rung.bytes);
    } catch (error) {
      this.memberError(res, error);
    }
  };
}

export default GroupsController;