import { socialModels } from "../models.js";
import { typedError, computeCounters } from "./post.service.js";

/**
 * Replies nest to a depth cap (directive: "a depth cap [Assumed: 8]"). A
 * root sits at depth 0; a reply may descend at most 8 levels below it.
 */
export const MAX_COMMENT_DEPTH = 8;

const EMOJI_MAX_LENGTH = 64;

/** A structured signed payload object is required on every interaction write. */
function interactionPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw typedError("E_COMMENT_BODY_REQUIRED", "This write needs a payload object.");
  }
}

/**
 * Interaction service (PORCH-006 ac-3/ac-4): comments (nested replies,
 * @mentions validated against origin membership), open-vocabulary
 * reactions, and signed changeable private votes.
 *
 * Origin containment is enforced on every write here: the membership token
 * scopes the request to exactly one network, the post must be born in that
 * origin, and the device signature proves the writer — there is no path in
 * this service (and therefore no endpoint over it) that accepts an
 * interaction across origins.
 */
export class InteractionService {
  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} deps.posts
   * @param {import("@porchlight/shared").CollectionLike} deps.comments
   * @param {import("@porchlight/shared").CollectionLike} deps.reactions
   * @param {import("@porchlight/shared").CollectionLike} deps.votes
   * @param {import("./membership.service.js").MembershipService} deps.membership
   * @param {import("./notification.service.js").NotificationService} deps.notifications
   * @param {(action: string, payload?: object) => Promise<void>} [deps.audit]
   */
  constructor({ posts, comments, reactions, votes, membership, notifications, audit }) {
    this.posts = posts;
    this.comments = comments;
    this.reactions = reactions;
    this.votes = votes;
    this.membership = membership;
    this.notifications = notifications;
    this.audit = audit ?? (async () => {});
    this.models = socialModels;
  }

  /**
   * Write a comment (ac-3): nested replies via parentId (root = null,
   * depth cap 8), @mentions validated against origin membership, and
   * content-free notifications to mentioned members and the parent author.
   */
  async comment({ accessToken, payload, signature } = {}) {
    interactionPayload(payload);
    const session = await this.#requireSession({ accessToken, postId: payload?.postId });
    await this.#verifyWrite({ session, payload, signature });
    const body = typeof payload.body === "string" && payload.body.trim().length > 0 ? payload.body : null;
    if (!body) {
      throw typedError("E_COMMENT_BODY_REQUIRED", "A comment needs some text.");
    }
    const parent = await this.#resolveParent({ postId: payload.postId, parentId: payload.parentId ?? null });
    const networkId = session.networkId;
    const depth = parent === null ? 0 : (await this.#chainDepth(parent)) + 1;
    if (depth > MAX_COMMENT_DEPTH) {
      throw typedError("E_REPLY_TOO_DEEP", "This reply is nested too deep — keep replies within 8 levels.");
    }
    const mentions = await this.#validatedMentions({ networkId, mentions: payload.mentions, did: session.did });

    const comment = {
      _id: `cmt_${crypto.randomUUID()}`,
      postId: payload.postId,
      networkId,
      authorDid: session.did,
      parentId: parent === null ? null : parent._id,
      body,
      mentions,
      deviceSignature: signature,
      createdAt: new Date().toISOString(),
    };
    await this.comments.insertOne(comment);
    await this.notifications.forComment({ comment, parent, mentions });
    await this.#recount({ postId: payload.postId });
    await this.audit("comment_create", {
      networkId,
      did: session.did,
      detail: { postId: payload.postId, commentId: comment._id },
    });
    return { comment: InteractionService.commentView(comment) };
  }

  /**
   * React to a post (ac-4, open-vocabulary ruling): any member-provided
   * emoji is accepted as-authored and stored verbatim — there is no
   * hub-defined emoji set, no owner-managed emoji assets, and no
   * reaction-to-asset id references (Brian Oct 8 2026). Validation prevents
   * cross-origin writes and nothing else.
   */
  async react({ accessToken, payload, signature } = {}) {
    interactionPayload(payload);
    const session = await this.#requireSession({ accessToken, postId: payload?.postId });
    await this.#verifyWrite({ session, payload, signature });
    const emoji = typeof payload.emoji === "string" ? payload.emoji.trim() : "";
    if (emoji.length === 0 || emoji.length > EMOJI_MAX_LENGTH) {
      // Open vocabulary: only a non-empty as-authored emoji is required.
      throw typedError("E_EMOJI_REQUIRED", "React with the emoji you want — any emoji works.");
    }
    const networkId = session.networkId;
    const duplicate = await this.reactions.findOne({
      postId: payload.postId,
      networkId,
      memberDid: session.did,
      emoji,
    });
    if (duplicate) {
      throw typedError("E_REACTION_EXISTS", "You already reacted with that emoji.");
    }
    const reaction = {
      _id: `rct_${crypto.randomUUID()}`,
      postId: payload.postId,
      networkId,
      memberDid: session.did,
      emoji,
      deviceSignature: signature,
      createdAt: new Date().toISOString(),
    };
    await this.reactions.insertOne(reaction);
    await this.#recount({ postId: payload.postId });
    await this.audit("reaction_create", {
      networkId,
      did: session.did,
      detail: { postId: payload.postId, reactionId: reaction._id },
    });
    return { reaction: InteractionService.reactionView(reaction) };
  }

  /**
   * Cast or change the member's vote (ac-4, vote privacy contract): one
   * effective vote per member per post; changing re-signs the doc. Vote
   * records are consumed only by the ranking formula — nothing here or in
   * the routes returns a vote, a count, or a ratio for display.
   */
  async vote({ accessToken, payload, signature } = {}) {
    interactionPayload(payload);
    const session = await this.#requireSession({ accessToken, postId: payload?.postId });
    await this.#verifyWrite({ session, payload, signature });
    if (payload.value !== "up" && payload.value !== "down") {
      throw typedError("E_INVALID_VOTE", "A vote is up or down.");
    }
    const networkId = session.networkId;
    const existing = await this.votes.findOne({ postId: payload.postId, networkId, memberDid: session.did });
    if (existing && existing.value === payload.value) {
      // One effective vote: re-stating it changes nothing.
      return { vote: { postId: payload.postId, effective: existing.value } };
    }
    if (existing) {
      await this.votes.updateOne(
        { _id: existing._id },
        { $set: { value: payload.value, deviceSignature: signature, changedAt: new Date().toISOString() } },
      );
    } else {
      await this.votes.insertOne({
        _id: `vot_${crypto.randomUUID()}`,
        postId: payload.postId,
        networkId,
        memberDid: session.did,
        value: payload.value,
        deviceSignature: signature,
        changedAt: null,
        createdAt: new Date().toISOString(),
      });
    }
    await this.#recount({ postId: payload.postId });
    return { vote: { postId: payload.postId, effective: payload.value } };
  }

  /** Thread read for a member: nested comments with mentions, roots → leaves. */
  async commentThread({ accessToken, postId } = {}) {
    const session = await this.#requireSession({ accessToken, postId });
    const rows = await this.comments.find({ postId, networkId: session.networkId });
    rows.sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1));
    return { comments: rows.map((row) => InteractionService.commentView(row)) };
  }

  /** Reaction read for a member: as-authored emoji values, by member. */
  async reactionsFor({ accessToken, postId } = {}) {
    const session = await this.#requireSession({ accessToken, postId });
    const rows = await this.reactions.find({ postId, networkId: session.networkId });
    return { reactions: rows.map((row) => InteractionService.reactionView(row)) };
  }

  /** Every interaction write is actor-signed (device signature at the origin). */
  async #verifyWrite({ session, payload, signature }) {
    await this.membership.verifyMemberWrite({
      networkId: session.networkId,
      did: session.did,
      deviceId: session.deviceId,
      payload,
      signature,
    });
  }

  static commentView(comment) {
    return {
      _id: comment._id,
      postId: comment.postId,
      parentId: comment.parentId,
      authorDid: comment.authorDid,
      body: comment.body,
      mentions: comment.mentions,
      createdAt: comment.createdAt,
    };
  }

  static reactionView(reaction) {
    return {
      _id: reaction._id,
      memberDid: reaction.memberDid,
      /** Rendered by clients exactly as the member authored it. */
      emoji: reaction.emoji,
      createdAt: reaction.createdAt,
    };
  }

  async #requireSession({ accessToken, postId }) {
    if (!accessToken) {
      throw typedError("E_MUST_SIGN_IN", "Sign in to your membership before writing content.");
    }
    const perimeter = await this.membership.verifyAccessToken(accessToken, { surface: "interaction" });
    if (!perimeter) {
      // The membership token is scoped to exactly one network; a request
      // without a resolvable perimeter has no origin to touch.
      throw typedError("E_NOT_PERMITTED", "This action is not available to you in this network.");
    }
    const post = await this.posts.findOne({ _id: postId });
    if (!post || post.originNetworkId !== perimeter.membership.networkId) {
      // Containment: interactions exist only within the network whose post
      // prompted them; a post of another origin is unaddressable here.
      throw typedError("E_POST_NOT_FOUND", "That post doesn't exist in this network.");
    }
    // Session projection carries {did, deviceId}; the ORIGIN rides on the
    // membership row (PORCH-005 verifyAccessToken contract).
    return {
      did: perimeter.session.did,
      deviceId: perimeter.session.deviceId,
      networkId: perimeter.membership.networkId,
    };
  }

  async #resolveParent({ postId, parentId }) {
    if (parentId === null || parentId === undefined) return null;
    const parent = await this.comments.findOne({ _id: parentId });
    if (!parent || parent.postId !== postId) {
      throw typedError("E_PARENT_UNKNOWN", "The reply target doesn't exist on this post.");
    }
    return parent;
  }

  /** Depth counts the parent chain (root = 0). */
  async #chainDepth(comment) {
    let depth = 0;
    let current = comment;
    while (current !== null && current !== undefined) {
      depth += 1;
      current = current.parentId ? await this.comments.findOne({ _id: current.parentId }) : null;
    }
    return depth - 1;
  }

  /**
   * @mentions validate against origin membership (ac-3): every mentioned
   * DID must hold an active membership in the origin network.
   */
  async #validatedMentions({ networkId, mentions, did }) {
    if (mentions === undefined || mentions === null) return [];
    if (!Array.isArray(mentions) || mentions.some((entry) => typeof entry !== "string" || entry.length === 0)) {
      throw typedError("E_MENTION_INVALID", "Mentions must be the DIDs of members of this network.");
    }
    const unique = [...new Set(mentions)];
    for (const mentionedDid of unique) {
      const membership = await this.membership.activeMembership({ networkId, did: mentionedDid });
      if (!membership) {
        throw typedError("E_MENTION_NOT_MEMBER", "You can only mention members of this network.");
      }
    }
    void did;
    return unique;
  }

  /**
   * Rank-input counter refresh + latest-activity bump on the post (ac-1
   * timeline ordering): an interaction is the post's latest activity, so
   * every comment/reaction/vote write also moves `lastActivityAt`. Rank
   * inputs are never returned for display.
   */
  async #recount({ postId }) {
    const comments = await this.comments.find({ postId });
    const reactions = await this.reactions.find({ postId });
    const votes = await this.votes.find({ postId });
    await this.posts.updateOne(
      { _id: postId },
      {
        $set: {
          interactionCounters: computeCounters({ comments, reactions, votes }),
          lastActivityAt: new Date().toISOString(),
        },
      },
    );
  }
}

export default InteractionService;