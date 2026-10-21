import { socialModels } from "../models.js";
import { canSeeGroup } from "./group.service.js";
import { typedError, computeCounters, ruledRootCompare } from "./post.service.js";
import { purgeAtFor } from "./lifecycle.time.js";

const COMMENT_LIFECYCLE_MESSAGES = {
  E_COMMENT_NOT_FOUND: "That comment doesn't exist in this network.",
  E_COMMENT_DELETE_NOT_PERMITTED: "Only the comment's author or the network owner can delete a comment.",
  E_COMMENT_EDIT_NOT_AUTHOR: "Only the comment's author can edit it — ownership never confers edit authority.",
};

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
 * The reaction subject (PORCH-098, comment-reactions amendment), read from
 * the signed payload: post subjects ride the shipped shape (absence of
 * subjectType resolves as post — the legacy default, so pre-existing
 * payloads keep signing identically); comment subjects add subjectType:
 * "comment" and the commentId. Comment subjects are validated against the
 * LIVE comment in the write path (below); this helper resolves the subject
 * declaration only — malformed declarations refuse with plain language and
 * zero mutation.
 */
function reactionSubject(payload) {
  const declared = payload.subjectType ?? "post";
  if (declared !== "post" && declared !== "comment") {
    throw typedError("E_REACTION_SUBJECT_INVALID", "React to the post or to one of its comments.");
  }
  if (declared === "comment") {
    if (typeof payload.commentId !== "string" || payload.commentId.trim().length === 0) {
      throw typedError("E_REACTION_SUBJECT_INVALID", "Reacting to a comment needs its comment id.");
    }
    return { subjectType: "comment", commentId: payload.commentId };
  }
  if (payload.commentId == null) {
    // commentId is null on post rows (additive default).
    return { subjectType: "post", commentId: null };
  }
  throw typedError("E_REACTION_SUBJECT_INVALID", "React to the post or to one of its comments.");
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
  constructor({ posts, comments, reactions, votes, membership, notifications, audit, realtime, previews, push, groups = null, tombstones = null, notificationRows = null }) {
    this.posts = posts;
    this.comments = comments;
    this.reactions = reactions;
    this.votes = votes;
    this.membership = membership;
    this.notifications = notifications;
    // PORCH-093: the notifications COLLECTION (distinct from the
    // NotificationService above) — the comment cascade removes the reply/
    // mention rows keyed to the deleted comments in the same write.
    this.notificationRows = notificationRows ?? null;
    this.tombstones = tombstones;
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
   * Delete a comment (PORCH-093 ac-1): one atomic operation tombstones the
   * root and cascades every nested reply in the same all-or-nothing write
   * (the reply tree, their notifications, their link previews). Authority
   * resolves against TWO roles only — the comment's author and the network
   * owner of the comment's origin; ownership never confers edit authority
   * and a group's managing member holds NO lifecycle authority over
   * comments. Refusals are plain-language and write nothing. The
   * cascaded children carry no tombstones of their own — they are captured
   * on the subject's tombstone for the restore window.
   *
   * The comment.deleted event is tree-scoped and content-only: one event
   * carrying the deleted root and the ids of its cascaded children, riding
   * the shipped transport (ordered and idempotent per origin).
   *
   * @param {{ accessToken: string, postId: string, commentId: string, signature: string }} args
   */
  async deleteComment({ accessToken, postId, commentId, signature } = {}) {
    const session = await this.#requireSession({ accessToken, postId });
    const networkId = session.networkId;
    const comment = await this.comments.findOne({ _id: commentId, postId });
    if (!comment || comment.networkId !== networkId) {
      throw typedError("E_COMMENT_NOT_FOUND", COMMENT_LIFECYCLE_MESSAGES.E_COMMENT_NOT_FOUND);
    }
    // Two-role authority (TS 14 lifecycle write contract): the comment's
    // author, or the network owner. A group's managing member is refused
    // here exactly like any other member.
    let deletedByRole = null;
    if (comment.authorDid === session.did) {
      deletedByRole = "author";
    } else {
      const membership = await this.membership.activeMembership({ networkId, did: session.did });
      if (membership?.role !== "owner") {
        throw typedError("E_COMMENT_DELETE_NOT_PERMITTED", COMMENT_LIFECYCLE_MESSAGES.E_COMMENT_DELETE_NOT_PERMITTED);
      }
      deletedByRole = "owner";
    }
    await this.#verifyWrite({
      session,
      payload: { kind: "comment-delete", postId, commentId, networkId },
      signature,
    });
    // The cascade of record: the root plus every nested reply, depth-first.
    const subtree = [comment];
    const seen = new Set([comment._id]);
    let frontier = [comment._id];
    while (frontier.length) {
      const children = (await this.comments.find({ parentId: frontier[0] })).filter((row) => !seen.has(row._id));
      for (const child of children) {
        seen.add(child._id);
        subtree.push(child);
      }
      frontier = [...children.map((row) => row._id), ...frontier.slice(1)];
    }
    const subtreeIds = new Set(subtree.map((row) => row._id));
    // Notifications keyed to the deleted comments die in the same write.
    const cascadedNotifications = this.notificationRows
      ? (await this.notificationRows.find({ postId })).filter(
          (row) => row.commentId !== null && subtreeIds.has(row.commentId),
        )
      : [];
    // Link previews on the deleted comments' rows ride the preview cascade
    // (held bytes through the window — never released at delete).
    const previewIds = subtree.map((row) => row.previewId).filter(Boolean);
    const previewCascade = this.previews
      ? await this.previews.cascadeRows({ networkId, previewIds })
      : { parts: [], blobKeys: [] };
    const cascadeByKind = {};
    for (const part of previewCascade.parts) {
      cascadeByKind[part.kind] = [...(cascadeByKind[part.kind] ?? []), ...part.rows];
    }
    const cascadedChildren = subtree.filter((row) => row._id !== comment._id);
    // PORCH-098: comment reactions die with the comment cascade in the same
    // atomic write — every comment-subject row keyed to the subtree (the
    // shipped slot on the tombstone's cascade; restore re-materializes
    // them with the comments so a restored comment accepts reactions
    // again from the restored rows).
    const cascadeReactions = (await this.reactions.find({ postId })).filter(
      (row) => row.subjectType === "comment" && subtreeIds.has(row.commentId),
    );
    const snapshot = [
      { collection: this.comments, rows: subtree },
      { collection: this.reactions, rows: cascadeReactions },
      ...(this.notificationRows && cascadedNotifications.length
        ? [{ collection: this.notificationRows, rows: cascadedNotifications }]
        : []),
      ...previewCascade.parts,
    ];
    const nowIso = new Date().toISOString();
    const tombstone = {
      _id: `tmb_${crypto.randomUUID()}`,
      subjectType: "comment",
      subjectId: comment._id,
      originNetworkId: networkId,
      deletedBy: session.did,
      deletedByRole,
      deletedAt: nowIso,
      purgeAt: purgeAtFor(nowIso),
      purgedAt: null,
      mediaOrigins: [],
      heldBlobKeys: [...new Set(previewCascade.blobKeys)],
      cascade: {
        subject: comment,
        post: session.post,
        comments: cascadedChildren,
        reactions: cascadeReactions,
        votes: [],
        notifications: cascadedNotifications,
        derivedData: [],
        previews: cascadeByKind.previews ?? [],
        assets: cascadeByKind.assets ?? [],
        artifacts: cascadeByKind.artifacts ?? [],
      },
    };
    // One all-or-nothing write: tombstone + cascade (the same compensating
    // shape the post cascade rides — a failure removes the tombstone and
    // rolls every deletion back).
    try {
      await this.tombstones.insertOne(tombstone);
      await this.#runTransactional(snapshot);
    } catch (error) {
      await this.tombstones.deleteOne({ _id: tombstone._id });
      throw error;
    }
    // Expander counts compute against live comments only — the recount
    // re-derives the totals on the next served read; no counter
    // maintenance lives on the write path beyond this recompute.
    await this.#recount({ postId });
    // Tree-scoped content-only removal event (the shipped transport).
    await this.realtime?.published({
      networkId,
      type: "comment.deleted",
      postId,
      groupId: session.post.groupId ?? null,
      content: {
        rootId: comment._id,
        cascadeIds: cascadedChildren.map((row) => row._id),
      },
    });
    await this.audit("comment_delete", {
      networkId,
      did: session.did,
      detail: {
        postId,
        commentId: comment._id,
        deletedByRole,
        tombstoneId: tombstone._id,
        cascadedReplies: cascadedChildren.length,
      },
    });
    return { deleted: true, commentId: comment._id, tombstoneId: tombstone._id, cascadedReplies: cascadedChildren.length };
  }

  /**
   * Edit a comment (PORCH-093 ac-4): the author may change the comment's
   * TEXT only — media refs are immutable on comment edits (a comment
   * carries no media), ownership never confers edit authority, and edits
   * are silent (no edited marker, no annotation, no version history; the
   * comment.updated event payload carries the same shape as creation, so
   * nothing in the event vocabulary reveals an edit occurred).
   *
   * @param {{ accessToken: string, postId: string, commentId: string, payload: object, signature: string }} args
   */
  async editComment({ accessToken, postId, commentId, payload, signature } = {}) {
    const session = await this.#requireSession({ accessToken, postId });
    const networkId = session.networkId;
    const comment = await this.comments.findOne({ _id: commentId, postId });
    if (!comment || comment.networkId !== networkId) {
      throw typedError("E_COMMENT_NOT_FOUND", COMMENT_LIFECYCLE_MESSAGES.E_COMMENT_NOT_FOUND);
    }
    if (comment.authorDid !== session.did) {
      throw typedError("E_COMMENT_EDIT_NOT_AUTHOR", COMMENT_LIFECYCLE_MESSAGES.E_COMMENT_EDIT_NOT_AUTHOR);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw typedError("E_COMMENT_BODY_REQUIRED", "A comment edit needs a payload object.");
    }
    const body = typeof payload.body === "string" && payload.body.trim().length > 0 ? payload.body : null;
    if (!body) {
      throw typedError("E_COMMENT_BODY_REQUIRED", "A comment needs some text.");
    }
    await this.#verifyWrite({
      session,
      payload: { kind: "comment-edit", postId, commentId, body, networkId },
      signature,
    });
    await this.comments.updateOne({ _id: comment._id }, { $set: { body } });
    const updated = await this.comments.findOne({ _id: comment._id });
    // comment.updated carries the same decorated view the reply.created
    // event carries (TS 14: creation shape, no edit-revealing field).
    const commentContent = await this.#replyContent(updated, networkId);
    await this.realtime?.published({
      networkId,
      type: "comment.updated",
      postId,
      groupId: session.post.groupId ?? null,
      content: commentContent,
    });
    await this.audit("comment_edit", {
      networkId,
      did: session.did,
      detail: { postId, commentId: comment._id },
    });
    return { comment: commentContent };
  }

  /**
   * Transactional write over the CollectionLike boundary (the same
   * snapshot/rollback all-or-nothing shape PostService.cascadePost rides,
   * local to the interaction side so the comment cascade stays
   * service-layer work).
   */
  async #runTransactional(snapshot) {
    const placed = [];
    try {
      for (const part of snapshot) {
        for (const row of part.rows) {
          await part.collection.deleteOne({ _id: row._id });
        }
        placed.push(part);
      }
    } catch (error) {
      for (const part of placed.reverse()) {
        for (const row of part.rows) {
          await part.collection.insertOne(structuredClone(row));
        }
      }
      throw error;
    }
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
    // PORCH-098: the subject rides the payload. A comment subject must be
    // LIVE at this origin — a tombstoned or cascade-deleted comment is no
    // longer in the collection, so the resolution below refuses the write
    // with plain language and zero mutation (restored comments resolve
    // again after the owner console re-materializes them).
    const { subjectType, commentId } = reactionSubject(payload);
    let comment = null;
    if (subjectType === "comment") {
      comment = await this.comments.findOne({ _id: commentId, postId: payload.postId });
      if (!comment || comment.networkId !== session.networkId) {
        throw typedError("E_COMMENT_NOT_FOUND", COMMENT_LIFECYCLE_MESSAGES.E_COMMENT_NOT_FOUND);
      }
    }
    const networkId = session.networkId;
    // One row per member per emoji per SUBJECT (PORCH-098): the same emoji
    // on a comment and on its parent post are two separate reactions, so
    // the probe scopes by subject — absence of subjectType on a stored row
    // resolves as post (the legacy additive default, no rewrite required).
    const ownRows = await this.reactions.find({
      postId: payload.postId,
      networkId,
      memberDid: session.did,
      emoji,
    });
    const duplicate = ownRows.find((row) =>
      subjectType === "comment"
        ? row.subjectType === "comment" && row.commentId === commentId
        : (row.subjectType ?? "post") === "post",
    );
    if (duplicate) {
      throw typedError("E_REACTION_EXISTS", "You already reacted with that emoji.");
    }
    const reaction = {
      _id: `rct_${crypto.randomUUID()}`,
      postId: payload.postId,
      networkId,
      memberDid: session.did,
      emoji,
      subjectType,
      commentId,
      deviceSignature: signature,
      createdAt: new Date().toISOString(),
    };
    await this.reactions.insertOne(reaction);
    await this.#recount({ postId: payload.postId });
    await this.audit("reaction_create", {
      networkId,
      did: session.did,
      detail: { postId: payload.postId, reactionId: reaction._id, subjectType, commentId },
    });
    // PORCH-047: reaction.applied to the origin room — the as-authored emoji
    // view only (open vocabulary is content, always). The envelope carries
    // the post's group target so the delivery layer can hold the event out
    // of a private-group non-member's room and catch-up (PORCH-068).
    // PORCH-098: comment-subject rows add the subject reference to the
    // content (commentId present, postId null — the envelope already
    // carries the post context); their post rows keep the shipped content
    // exactly (the arriving subjectType keys are the additive carrier).
    const eventContent = InteractionService.reactionEventView(reaction);
    await this.realtime?.published({
      networkId,
      type: "reaction.applied",
      postId: payload.postId,
      groupId: session.post.groupId ?? null,
      content: eventContent,
    });
    // PORCH-059: "reactions to your post" — the target's author gets the
    // push through the send pipeline (live membership + settings at send
    // time); they authored the target, so the excerpt rides. PORCH-098:
    // reacting to a comment targets the comment's author with the
    // comment's body as the excerpt [Assumed: flag in task comment]. The
    // reactor never receives their own reaction.
    const pushTarget =
      subjectType === "comment"
        ? { targetDids: [comment.authorDid], excerpt: comment.body }
        : { targetDids: [session.post.authorId ?? ""], excerpt: session.post.caption ?? session.post.body ?? null };
    await this.push?.notify({
      networkId,
      type: "reaction",
      ...pushTarget,
      postId: payload.postId,
      commentId: subjectType === "comment" ? commentId : null,
      actorDid: session.did,
      // PORCH-115: the emoji rides as authored — the actor line composes
      // "{actor}: {emoji}" on the send pipeline.
      emoji,
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
    // PORCH-098: a comment-subject leave clears only the member's own row
    // on THAT comment (the parent post's rows and other comments' rows
    // ride untouched); a chip the member never joined stays a no-op. The
    // subject must have resolved validly on the same declarations the add
    // path enforces (no live-comment gate on a leave — an empty subject
    // resolves against zero rows and stays the no-op result).
    const { subjectType, commentId } = reactionSubject(payload);
    const networkId = session.networkId;
    const ownRows = await this.reactions.find({
      postId: payload.postId,
      networkId,
      memberDid: session.did,
      emoji,
    });
    const existing = ownRows.find((row) =>
      subjectType === "comment"
        ? row.subjectType === "comment" && row.commentId === commentId
        : (row.subjectType ?? "post") === "post",
    );
    if (!existing) {
      return { removed: false, reaction: null };
    }
    await this.reactions.deleteOne({ _id: existing._id });
    await this.#recount({ postId: payload.postId });
    await this.audit("reaction_remove", {
      networkId,
      did: session.did,
      detail: { postId: payload.postId, reactionId: existing._id, subjectType, commentId: existing.commentId ?? null },
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
   * Clear the member's own vote — the un-vote ride (PORCH-113; the
   * vote-display ruling's "clicking a held vote again removes it", Brian,
   * Oct 19, 2026): the clear write removes only the member's own vote row
   * on the existing signed vote path (same token scope, same device-signature
   * verification, same recount), recomputing volume and ratio in the stored
   * counters. Other members' rows are untouched. A member holding no vote
   * receives a plain refusal with zero mutation (idempotent: the repeated
   * clear resolves the same refusal, never a state change).
   */
  async unvote({ accessToken, payload, signature } = {}) {
    interactionPayload(payload);
    const session = await this.#requireSession({ accessToken, postId: payload?.postId });
    await this.#verifyWrite({ session, payload, signature });
    const networkId = session.networkId;
    const existing = await this.votes.findOne({ postId: payload.postId, networkId, memberDid: session.did });
    if (!existing) {
      throw typedError("E_VOTE_NOT_HELD", "You have no vote on this post to clear.");
    }
    await this.votes.deleteOne({ _id: existing._id });
    await this.#recount({ postId: payload.postId });
    await this.audit("vote_remove", {
      networkId,
      did: session.did,
      detail: { postId: payload.postId, voteId: existing._id, value: existing.value },
    });
    return { vote: { postId: payload.postId, effective: null } };
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
    // PORCH-098 ac-3: each comment's attributed reaction rows ride the same
    // origin-scoped read (one find for the post's comment-subject rows,
    // never a per-row fetch) and the SAME attribution projection the post
    // rows carry — display name + avatar rendering data per reactor in the
    // origin's served order. Content only: no count, no roster field.
    const reactionRowsByComment = await this.#commentReactionRows({ postId, networkId: session.networkId });
    const views = await this.#withAttribution(
      InteractionService.orderedThread(rows).map((row) => InteractionService.commentView(row)),
      session.networkId,
      { reactionRowsByComment },
    );
    return { comments: this.previews ? await this.previews.withViews(views, session.networkId) : views };
  }

  /**
   * One origin-scoped read of the post's comment-subject reaction rows,
   * grouped for the comment decorations (PORCH-098). Rows keep the
   * collection's served order — the order of record the client renders
   * per emoji.
   */
  async #commentReactionRows({ postId, networkId }) {
    const byComment = new Map();
    for (const row of await this.reactions.find({ postId, networkId })) {
      if (row.subjectType !== "comment") continue;
      const commentId = row.commentId ?? "";
      if (!commentId) continue;
      if (!byComment.has(commentId)) byComment.set(commentId, []);
      byComment.get(commentId).push(row);
    }
    return byComment;
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
    // PORCH-098: the post's chips read is a POST-subject read — a comment
    // subject carries its own rows on the comment decorations, never on
    // the post's reaction endpoint. Absence of subjectType resolves as
    // post (the legacy additive default).
    const rows = (await this.reactions.find({ postId, networkId: session.networkId })).filter(
      (row) => (row.subjectType ?? "post") !== "comment",
    );
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
      // PORCH-098 ac-3: every served comment view carries its reaction rows
      // (empty until a member reacts) — the uniform additively-defaulted
      // shape the comments' decorations compose over.
      reactionRows: [],
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

  async #withAttribution(views, networkId, { reactionRowsByComment = null } = {}) {
    // The single origin-scoped names read of record: authors, mentions, and
    // (PORCH-098) comment reactors resolve in one batch — the reactor
    // attribution never triggers a second membership read.
    const names = await this.membership.attributionNames({
      networkId,
      dids: [
        ...views.flatMap((view) => [view.authorDid, ...(view.mentions ?? [])]),
        ...(reactionRowsByComment
          ? [...reactionRowsByComment.values()].flat().map((row) => row.memberDid)
          : []),
      ],
    });
    return views.map((view) => {
      const attributed = {
        ...view,
        authorName: names.get(String(view.authorDid))?.name ?? null,
        authorAvatar: names.get(String(view.authorDid))?.avatar ?? null,
        // Mention names (PORCH-037): every comment view resolves each
        // mentioned member's family-facing name at READ time against the
        // origin's active membership. Clients render @Name — a mention that
        // no longer resolves (left member) renders the plain body text.
        mentionNames: (view.mentions ?? []).map((mentionedDid) => names.get(String(mentionedDid))?.name ?? null),
      };
      if (reactionRowsByComment) {
        // PORCH-098 ac-3: the comment's attributed reaction rows in the
        // origin's served order (collection insertion order). Empty on a
        // comment nobody reacted to — the shape stays uniform.
        attributed.reactionRows = (reactionRowsByComment.get(view._id) ?? []).map((row) =>
          InteractionService.attributedReactionView(row, names),
        );
      }
      return attributed;
    });
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

  /**
   * PORCH-098 ac-4: the reaction.applied content. Post subjects keep the
   * shipped content exactly — member + emoji, key-stable, so a client
   * that never met a comment subject resolves the post row unchanged (the
   * event's absent subjectType is the post default, identical to the row
   * resolution). Comment subjects add the subject reference: commentId
   * present, postId null (the envelope already carries the post context)
   * — and nothing else: no count, no roster, no aggregate ever enters an
   * envelope (payload-privacy law).
   */
  static reactionEventView(reaction) {
    if ((reaction.subjectType ?? "post") !== "comment") {
      return InteractionService.reactionView(reaction);
    }
    return {
      ...InteractionService.reactionView(reaction),
      subjectType: "comment",
      commentId: reaction.commentId ?? null,
      postId: null,
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