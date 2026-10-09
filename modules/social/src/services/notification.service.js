import { socialModels } from "../models.js";

/**
 * Notification service (PORCH-006 ac-3, PORCH-014): mention/reply triggers
 * land as MEMBER-scoped, content-free rows the client can poll. Payloads
 * are content-free by contract — ids and type only, never a comment body,
 * a caption, or any other content (zero-leak guarantee). Push transport
 * lives in client delivery.
 *
 * Origin containment holds at the notification surface itself (PORCH-014
 * ac-2): a notification is only ever composed for an active member of the
 * origin network, and a cross-origin reply trigger is refused here exactly
 * as every interaction surface refuses cross-origin writes.
 */
export class NotificationService {
  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} deps.notifications
   * @param {import("./membership.service.js").MembershipService} deps.membership
   */
  constructor({ notifications, membership }) {
    this.notifications = notifications;
    this.membership = membership;
    this.models = socialModels;
  }

  /**
   * Fan-out for a comment: mention notifications to every mentioned member
   * (never the author), plus a reply notification to the parent's author —
   * skipped when a mention already reached them. Content-free payloads for
   * every recipient. Composition refuses a cross-origin parent.
   */
  async forComment({ comment, parent, mentions }) {
    if (parent !== null && parent.networkId !== comment.networkId) {
      // Containment at the notification surface (ac-2): a reply trigger whose
      // parent lives on another origin is refused, never composed across
      // origins — the same containment every interaction write enforces.
      throw typedError("E_NOTIFICATION_CROSS_ORIGIN", "Notifications cannot reach across networks.");
    }
    const mentioned = new Set(mentions.filter((memberId) => memberId !== comment.authorDid));
    for (const memberId of mentioned) {
      await this.record({
        networkId: comment.networkId,
        memberId,
        type: "mention",
        postId: comment.postId,
        commentId: comment._id,
        actorDid: comment.authorDid,
      });
    }
    if (parent !== null && parent.authorDid !== comment.authorDid && !mentioned.has(parent.authorDid)) {
      await this.record({
        networkId: comment.networkId,
        memberId: parent.authorDid,
        type: "reply",
        postId: comment.postId,
        commentId: comment._id,
        actorDid: comment.authorDid,
      });
    }
  }

  /**
   * Insert one content-free notification row for the recipient. Refuses
   * non-member targeting (ac-2): the recipient must hold an active
   * membership in the origin network, or nothing is composed.
   */
  async record({ networkId, memberId, type, postId, commentId = null, actorDid = null }) {
    if (!networkId || !memberId || !type || !postId) {
      const error = new Error("networkId, memberId, type, postId required");
      error.code = "E_NOTIFICATION_REQUIRED";
      throw error;
    }
    const membership = await this.membership.activeMembership({ networkId, did: memberId });
    if (!membership) {
      throw typedError("E_NOTIFICATION_NOT_MEMBER", "Notification targets must be members of this network.");
    }
    const row = {
      _id: `ntf_${crypto.randomUUID()}`,
      networkId,
      memberId,
      type,
      postId,
      commentId,
      actorDid,
      createdAt: new Date().toISOString(),
    };
    await this.notifications.insertOne(row);
    return row;
  }

  /**
   * The member's own inbox at the origin, newest first.
   */
  async inbox({ accessToken } = {}) {
    if (!accessToken) {
      throw typedError("E_MUST_SIGN_IN", "Sign in to your membership to see your notifications.");
    }
    const perimeter = await this.membership.verifyAccessToken(accessToken, { surface: "notification.inbox" });
    if (!perimeter) {
      throw typedError("E_NOT_PERMITTED", "This action is not available to you in this network.");
    }
    const { networkId, did } = {
      networkId: perimeter.membership.networkId,
      did: perimeter.session.did,
    };
    const rows = await this.notifications.find({ networkId, memberId: did });
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    // Content-free by contract: ids, type, actor, timestamps — nothing else.
    return { notifications: rows.map((row) => ({
      _id: row._id,
      type: row.type,
      postId: row.postId,
      commentId: row.commentId,
      actorDid: row.actorDid,
      createdAt: row.createdAt,
    })), did };
  }

  /**
   * Mention autocomplete (PORCH-014 ac-2): resolves against ORIGIN
   * membership only. The token's single network scope is the only roster
   * ever searched; members of any other network are invisible here, and no
   * content rides the candidates — membership identity fields only.
   * @param {object} deps
   * @param {string} [deps.accessToken]
   * @param {string} [deps.q] substring filter on the family-facing member name
   *   (PORCH-037: autocomplete keys on the name, never on an identifier)
   */
  async mentionCandidates({ accessToken, q } = {}) {
    if (!accessToken) {
      throw typedError("E_MUST_SIGN_IN", "Sign in to your membership to mention someone.");
    }
    const perimeter = await this.membership.verifyAccessToken(accessToken, { surface: "notification.suggest" });
    if (!perimeter) {
      throw typedError("E_NOT_PERMITTED", "This action is not available to you in this network.");
    }
    const networkId = perimeter.membership.networkId;
    const rows = (await this.membership.listMembers({ networkId }))
      .filter((row) => row.state === "active" && row.did !== perimeter.session.did);
    const names = await this.membership.attributionNames({ networkId, dids: rows.map((row) => row.did) });
    const query = typeof q === "string" ? q.trim().toLowerCase() : "";
    const candidates = rows
      .map((row) => ({ did: row.did, name: names.get(String(row.did)) ?? null, role: row.role, admittedAt: row.admittedAt }))
      .filter((candidate) => query === "" || (candidate.name !== null && candidate.name.toLowerCase().includes(query)))
      .sort((a, b) => {
        const names = (a.name ?? "").localeCompare(b.name ?? "");
        return names !== 0 || a.did === b.did ? names : a.did < b.did ? -1 : 1;
      });
    return { candidates };
  }
}

function typedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export default NotificationService;