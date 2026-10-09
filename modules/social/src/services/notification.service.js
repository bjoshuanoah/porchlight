import { socialModels } from "../models.js";

/**
 * Notification service (PORCH-006 ac-3): mention/reply triggers land as
 * MEMBER-scoped, content-free rows the client can poll. Payloads are
 * content-free by contract — ids and type only, never a comment body, a
 * caption, or any other content. Push transport lives in client delivery.
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
   * every recipient.
   */
  async forComment({ comment, parent, mentions }) {
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

  /** Insert one content-free notification row for the recipient. */
  async record({ networkId, memberId, type, postId, commentId = null, actorDid = null }) {
    if (!networkId || !memberId || !type || !postId) {
      const error = new Error("networkId, memberId, type, postId required");
      error.code = "E_NOTIFICATION_REQUIRED";
      throw error;
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

  /** The member's own inbox at the origin, newest first. */
  async inbox({ accessToken } = {}) {
    if (!accessToken) {
      const error = new Error("membership access required");
      error.code = "E_MUST_SIGN_IN";
      throw error;
    }
    const perimeter = await this.membership.verifyAccessToken(accessToken);
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
}

function typedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export default NotificationService;