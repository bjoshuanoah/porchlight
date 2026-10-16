import { socialModels } from "../models.js";
import { canSeeGroup } from "./group.service.js";
import { typedError, computeCounters, ruledRootCompare } from "./post.service.js";

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
   * @param {import("./push.service.js").PushService} [deps.push]
   *   PORCH-059: the push send pipeline — reactions to your post fan out to
   *   the post's author through it (live membership + settings at send time).
   * @param {(action: string, payload?: object) => Promise<void>} [deps.audit]
   * @param {import("./link-preview.service.js").LinkPreviewService} [deps.previews]
   * @param {import("@porchlight/shared").CollectionLike} [deps.groups]
   *   PORCH-068: the group collection behind the private-group conversation
   *   gate — every interaction surface on a private-group post resolves only
   *   for members of that group.
   */
  constructor({ posts, comments, reactions, votes, membership, notifications, audit, realtime, previews, push, groups = null }) {
    this.posts = posts;
    this.comments = comments;
    this.reactions = reactions;
    this.votes = votes;
    this.membership = membership;
    this.notifications = notifications;
    this.push = push ?? null;
    this.previews = previews ?? null;
    this.realtime = realtime ?? null;
    this.audit = audit ?? (async () => {});
    this.groups = groups;
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
      previewId: (await this.previews?.assertAttachable({ networkId, previewId: payload.previewId }))?._id ?? null,
      deviceSignature: signature,
      createdAt: new Date().toISOString(),
    };
    await this.comments.insertOne(comment);
    // PORCH-068 ac-5: a private-group post's triggers never compose a
    // notification for a non-member — the post rides the fan-out for the
    // group-membership filter inside the notification service.
    await this.notifications.forComment({ comment, parent, mentions, post: session.post });
    await this.#recount({ postId: payload.postId });
    await this.audit("comment_create", {
      networkId,
      did: session.did,
      detail: { postId: payload.postId, commentId: comment._id },
    });
    // PORCH-047: reply.created to the origin room — content-only payload
    // (the comment view; parentId rides it for nested replies). PORCH-081
    // client parity: attribution and the attach-time preview ride the
    // envelope exactly as they ride a REST slice row, so the arriving reply
    // renders as-given without a follow-up read. No vote writes emit
    // events: votes modulate prominence internally only.
    const commentContent = await this.#replyContent(comment, networkId);
    await this.realtime?.published({
      networkId,
      type: "reply.created",
      postId: payload.postId,
      // PORCH-068: the envelope carries the post's group target so the
      // delivery layer can hold a private-group conversation event out of a
      // non-member's room and catch-up.
      groupId: session.post.groupId ?? null,
      content: commentContent,
    });
    return { comment: commentContent };
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
    // PORCH-047: reaction.applied to the origin room — the as-authored emoji
    // view only (open vocabulary is content, always). The envelope carries
    // the post's group target so the delivery layer can hold the event out
    // of a private-group non-member's room and catch-up (PORCH-068).
    await this.realtime?.published({
      networkId,
      type: "reaction.applied",
      postId: payload.postId,
      groupId: session.post.groupId ?? null,
      content: InteractionService.reactionView(reaction),
    });
    // PORCH-059: "reactions to your post" — the post's author gets the push
    // through the send pipeline (live membership + settings at send time);
    // they authored the target, so the caption/excerpt rides. The reactor
    // never receives their own reaction. A private-group post's author
    // holds the group membership (the write gate enforces it), so the
    // target is never a non-member here.
    await this.push?.notify({
      networkId,
      type: "reaction",
      targetDids: [session.post.authorId ?? ""],
      postId: payload.postId,
      actorDid: session.did,
      excerpt: session.post.caption ?? session.post.body ?? null,
    });
    return { reaction: InteractionService.reactionView(reaction) };
  }

  /**
   * Clear one of the member's own reactions (PORCH-036 ac-3: reactions
   * stay changeable — the member can remove an emoji they reacted with
   * and the change renders everywhere the reaction renders). Only the
   * member's own row at this origin is ever touched; clearing an emoji
   * not currently reacted is a no-op result, never an error.
   */
  async unreact({ accessToken, payload, signature } = {}) {
    interactionPayload(payload);
    const session = await this.#requireSession({ accessToken, postId: payload?.postId });
    await this.#verifyWrite({ session, payload, signature });
    const emoji = typeof payload.emoji === "string" ? payload.emoji.trim() : "";
    if (emoji.length === 0 || emoji.length > EMOJI_MAX_LENGTH) {
      throw typedError("E_EMOJI_REQUIRED", "React with the emoji you want — any emoji works.");
    }
    const networkId = session.networkId;
    const existing = await this.reactions.findOne({
      postId: payload.postId,
      networkId,
      memberDid: session.did,
      emoji,
    });
    if (!existing) {
      return { removed: false, reaction: null };
    }
    await this.reactions.deleteOne({ _id: existing._id });
    await this.#recount({ postId: payload.postId });
    await this.audit("reaction_remove", {
      networkId,
      did: session.did,
      detail: { postId: payload.postId, reactionId: existing._id },
    });
    return { removed: true, reaction: InteractionService.reactionView(existing) };
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

  /**
   * Thread read for a member: mentions in views, roots → leaves. The ruled
   * read order of record (PORCH-085, paired PRD 6ad13dde89855af1a3cc050b):
   * roots serve threaded-first then newest-first; each root's tree serves
   * chronological (ascending) immediately after its root. Containment and
   * the private-group gate ran in #requireSession BEFORE the sort — the
   * ruled order can never promote a row the member may not see.
   */
  async commentThread({ accessToken, postId } = {}) {
    const session = await this.#requireSession({ accessToken, postId });
    const rows = await this.comments.find({ postId, networkId: session.networkId });
    const views = await this.#withAttribution(
      InteractionService.orderedThread(rows).map((row) => InteractionService.commentView(row)),
      session.networkId,
    );
    return { comments: this.previews ? await this.previews.withViews(views, session.networkId) : views };
  }

  /**
   * The ruled detail-thread order (PORCH-085). One comparator home
   * (ruledRootCompare, post.service.js) serves the detail read and the card
   * slice window, so the rendered order never disagrees with the served
   * order; a root's entire subtree rides ascending by createdAt right after
   * it. Pure: identical rows read identically on every fetch.
   */
  static orderedThread(rows) {
    const children = new Map();
    for (const comment of rows ?? []) {
      if (comment.parentId == null) continue;
      if (!children.has(comment.parentId)) children.set(comment.parentId, []);
      children.get(comment.parentId).push(comment);
    }
    const ordered = [];
    const roots = (rows ?? [])
      .filter((comment) => comment.parentId == null)
      .sort((a, b) => ruledRootCompare(a, b, (root) => (children.get(root._id)?.length ?? 0) > 0));
    for (const root of roots) {
      ordered.push(root);
      const subtree = [];
      const pending = [...(children.get(root._id) ?? [])];
      while (pending.length) {
        const child = pending.shift();
        subtree.push(child);
        pending.push(...(children.get(child._id) ?? []));
      }
      subtree.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
      ordered.push(...subtree);
    }
    return ordered;
  }

  /**
   * Reaction read for a member: as-authored emoji values, by member, with
   * reactor attribution (PORCH-091 ac-1) — every row carries the reactor's
   * display name and avatar rendering data, resolved at READ time against
   * THIS origin's active membership only (a DID holding no active
   * membership here renders nameless, exactly as comments do). Content
   * only: no count, no roster, no aggregate field ever rides this payload;
   * the client derives the people count from the rows themselves.
   */
  async reactionsFor({ accessToken, postId } = {}) {
    const session = await this.#requireSession({ accessToken, postId });
    const rows = await this.reactions.find({ postId, networkId: session.networkId });
    const names = await this.membership.attributionNames({
      networkId: session.networkId,
      dids: rows.map((row) => row.memberDid),
    });
    return { reactions: rows.map((row) => InteractionService.attributedReactionView(row, names)) };
  }

  /**
   * Reaction rows already hold the member reference (memberDid); PORCH-091
   * adds projection breadth on the origin reads that serve the chips: the
   * reactor's display name and avatar rendering data ride beside it, in the
   * origin's served row order (the collection insertion order — the read's
   * order of record). Rows stay flat; the client groups them per emoji.
   * Content only — no count and no roster field joins the row.
   */
  static attributedReactionView(reaction, names) {
    const resolved = names?.get(String(reaction.memberDid)) ?? null;
    return {
      ...InteractionService.reactionView(reaction),
      memberName: resolved?.name ?? null,
      memberAvatar: resolved?.avatar ?? null,
    };
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
      previewId: comment.previewId ?? null,
      createdAt: comment.createdAt,
    };
  }

  /**
   * Attribution (PORCH-034): member comment views carry the author's
   * family-facing name, resolved at READ time against the origin's active
   * membership — never a frozen copy on the comment document. A DID that
   * holds no active membership at the origin renders the plain nameless
   * fallback (names render for network members only). PORCH-070:
   * `authorAvatar` rides beside the name on comment and reply views — the
   * identity-plane avatar meta passed through verbatim, never mutated here;
   * mention names stay name-only.
   */
  /**
   * The decorated reply view (attach-time previews + attribution) shared by
   * the write response and the realtime envelope (PORCH-034, PORCH-052):
   * the arriving reply (PORCH-081) renders as-given, exactly like a REST
   * slice row. Content only — no count-bearing field rides it.
   */
  async #replyContent(comment, networkId) {
    const withPreview = await this.previews
      ? (await this.previews.withViews([InteractionService.commentView(comment)], networkId))[0]
      : InteractionService.commentView(comment);
    return (await this.#withAttribution([withPreview], networkId))[0];
  }

  async #withAttribution(views, networkId) {
    const names = await this.membership.attributionNames({
      networkId,
      dids: views.flatMap((view) => [view.authorDid, ...(view.mentions ?? [])]),
    });
    return views.map((view) => ({
      ...view,
      authorName: names.get(String(view.authorDid))?.name ?? null,
      authorAvatar: names.get(String(view.authorDid))?.avatar ?? null,
      // Mention names (PORCH-037): every comment view resolves each
      // mentioned member's family-facing name at READ time against the
      // origin's active membership. Clients render @Name — a mention that
      // no longer resolves (left member) renders the plain body text.
      mentionNames: (view.mentions ?? []).map((mentionedDid) => names.get(String(mentionedDid))?.name ?? null),
    }));
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
    // Private-group conversation gate (PORCH-068 ac-2): a private group's
    // posts and conversation render for members of that group only — every
    // interaction read AND write on the post refuses a non-member.
    if (post.groupId && this.groups) {
      const group = await this.groups.findOne({ _id: post.groupId });
      if (!canSeeGroup(group, perimeter.session.did)) {
        throw typedError("E_GROUP_NOT_MEMBER", "Only members of the group can read or join this conversation.");
      }
    }
    // Session projection carries {did, deviceId}; the ORIGIN rides on the
    // membership row (PORCH-005 verifyAccessToken contract). The post rides
    // back so the write paths gate notifications/events on the same
    // resolution instead of a second read.
    return {
      did: perimeter.session.did,
      deviceId: perimeter.session.deviceId,
      networkId: perimeter.membership.networkId,
      post,
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