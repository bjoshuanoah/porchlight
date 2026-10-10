import { socialModels } from "../models.js";

/** Plain-language content failures for member clients. */
export const POST_MESSAGES = {
  E_MUST_SIGN_IN: "Sign in to your membership before using the content surfaces.",
  E_NOT_PERMITTED: "This action is not available to you in this network.",
  E_POST_NOT_FOUND: "That post doesn't exist in this network.",
  E_TYPE_REQUIRED: "Posts are text, photo, video, or audio.",
  E_BODY_REQUIRED: "A text post needs some text.",
  E_MEDIA_REQUIRED: "A photo, video, or audio post needs its media attached.",
  E_GROUP_UNKNOWN: "That group doesn't exist in this network.",
  E_GROUP_NOT_MEMBER: "Only members of the group can post into it.",
  E_SIGNATURE_REQUIRED: "This write must be signed by your device key.",
  E_SIGNATURE_INVALID: "This write's device signature does not verify.",
};

export function typedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

const POST_TYPES = ["text", "photo", "video", "audio"];
const MEDIA_TYPES = ["photo", "video", "audio"];

/**
 * Reverse-chron by latest activity (PORCH-007 timeline ordering): the sort
 * key is `lastActivityAt ?? createdAt`. Shared by every timeline read (post
 * list, base timeline, group timelines, search) so ordering lives in one
 * place; the ranked section has its own produced order in the ranking
 * module.
 */
export function newestFirstByActivity(rows) {
  const key = (post) => post.lastActivityAt ?? post.createdAt;
  rows.sort((a, b) => {
    const ka = new Date(key(a)).getTime();
    const kb = new Date(key(b)).getTime();
    if (ka !== kb) return kb - ka;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a._id < b._id ? -1 : 1;
  });
  return rows;
}

const ZERO_COUNTERS = Object.freeze({
  upVolume: 0,
  downVolume: 0,
  voteVolume: 0,
  voteRatio: 0,
  commentCount: 0,
  reactionCount: 0,
});

/**
 * Rank-input counters (feed-ranking contract): vote volume and up/down
 * ratio plus interaction volume, computed from the live rows. Consumed only
 * by the ranking module; read surfaces strip them.
 */
export function computeCounters({ comments, reactions, votes }) {
  const up = votes.filter((row) => row.value === "up").length;
  const volume = votes.length;
  return {
    upVolume: up,
    downVolume: volume - up,
    voteVolume: volume,
    voteRatio: volume === 0 ? 0 : up / volume,
    commentCount: comments.length,
    reactionCount: reactions.length,
  };
}

/**
 * Post service (PORCH-006 ac-1/ac-2/ac-5). Owns the complete route →
 * controller → service → model path for posts: the four post types with
 * exactly one origin network, actor-signed authorship, optional group
 * containment, cross-post as an independent post, and the transactional
 * deletion cascade.
 *
 * Every write is actor-signed: the payload verifies against the origin
 * network's enrolled device key via the perimeter service, the membership
 * token resolves the DID inside exactly one network scope, and the write's
 * origin must equal that scope — there is no endpoint that accepts a write
 * across origins.
 */
export class PostService {
  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} deps.posts
   * @param {import("@porchlight/shared").CollectionLike} deps.comments
   * @param {import("@porchlight/shared").CollectionLike} deps.reactions
   * @param {import("@porchlight/shared").CollectionLike} deps.votes
   * @param {import("@porchlight/shared").CollectionLike} deps.notifications
   * @param {import("@porchlight/shared").CollectionLike} deps.derivedData
   * @param {import("@porchlight/shared").CollectionLike} deps.artifacts
   * @param {import("@porchlight/shared").CollectionLike} deps.groups
   * @param {import("./membership.service.js").MembershipService} deps.membership
   * @param {import("./media.service.js").MediaService} deps.media
   *   The media pipeline: member views hydrate `mediaMeta` (rendition set
   *   of record, display dims) so clients never fetch rendition metadata
   *   per item (PORCH-044 ac-2).
   * @param {(action: string, payload?: object) => Promise<void>} [deps.audit]
   * @param {import("./link-preview.service.js").LinkPreviewService} [deps.previews]
   *   Link previews (PORCH-052) — compose-time attach validation, view
   *   hydration, and the deletion cascade for ingested og:image artifacts.
   */
  constructor({ posts, comments, reactions, votes, notifications, derivedData, artifacts, groups, membership, media, audit, realtime, previews }) {
    this.posts = posts;
    this.comments = comments;
    this.reactions = reactions;
    this.votes = votes;
    this.notifications = notifications;
    this.derivedData = derivedData;
    this.artifacts = artifacts;
    this.groups = groups;
    this.membership = membership;
    this.media = media;
    this.previews = previews ?? null;
    this.realtime = realtime ?? null;
    this.audit = audit ?? (async () => {});
    this.models = socialModels;
  }

  /**
   * Create a post (ac-1). The membership token scopes the write to exactly
   * one network: that network is the post's origin, and nothing is stored
   * on any other network. `payload` is the device-signed content document;
   * the verified signature is stored on the document (actor-signed
   * authorship).
   *
   * For cross-posts (ac-2) the payload carries `crossPostRef`: the source
   * post id reaches the new post only as an optional client-side display
   * hint. The source document is untouched, the new post is fully
   * independent (own caption, own mediaRefs, own interactions), and no
   * dedupe machinery exists.
   */
  async create({ accessToken, payload, signature } = {}) {
    const session = await this.#requireSession(accessToken);
    if (!payload || typeof payload !== "object") {
      throw typedError("E_BODY_REQUIRED", POST_MESSAGES.E_BODY_REQUIRED);
    }
    const networkId = session.networkId;
    if (payload.networkId && payload.networkId !== networkId) {
      // A write claiming another origin never resolves: the perimeter token
      // is the only origin key and cannot span networks.
      throw typedError("E_NOT_PERMITTED", POST_MESSAGES.E_NOT_PERMITTED);
    }
    await this.verifyWrite({ networkId, did: session.did, deviceId: session.deviceId, payload, signature });
    const { post, preview } = await this.#buildPost({ networkId, did: session.did, payload, signature });
    await this.posts.insertOne(post);
    await this.audit("post_create", { networkId, did: session.did, detail: { postId: post._id, type: post.type } });
    // PORCH-047: the origin's live timeline learns the post the moment the
    // commit lands — post.created, content-only payload (postView), to the
    // origin room only. The attach-time preview metadata rides content
    // only (no engagement data exists on a preview record).
    await this.realtime?.published({
      networkId,
      type: "post.created",
      postId: post._id,
      content: { ...postView(post), preview: this.previewPayload(preview) },
    });
    return { post: (await this.memberViews([post], networkId))[0], did: session.did };
  }

  /** Read one post as a member view (no counters, no vote data). */
  async get({ accessToken, postId } = {}) {
    const session = await this.#requireSession(accessToken);
    const post = await this.posts.findOne({ _id: postId });
    if (!post || post.originNetworkId !== session.networkId) {
      // Containment: a post of another origin simply does not exist here.
      throw typedError("E_POST_NOT_FOUND", POST_MESSAGES.E_POST_NOT_FOUND);
    }
    return { post: (await this.memberViews([post], session.networkId))[0], did: session.did };
  }

  /** List the origin network's posts, newest first (base timeline read). */
  async list({ accessToken } = {}) {
    const session = await this.#requireSession(accessToken);
    const rows = await this.posts.find({ originNetworkId: session.networkId });
    // Base timeline ordering (PORCH-007): newest first by latest activity;
    // reverse-chron pagination only — this read never re-sorts by rank.
    newestFirstByActivity(rows);
    return { posts: await this.memberViews(rows, session.networkId), did: session.did };
  }

  /** Member views with attribution, mediaMeta (PORCH-044), and previews (PORCH-052). */
  async memberViews(postRows, networkId) {
    const attributed = await this.#withAttribution(postRows.map((post) => this.view(post)), networkId);
    const withMeta = await this.media.withMediaMeta(attributed, networkId);
    return this.previews ? await this.previews.withViews(withMeta, networkId) : withMeta;
  }

  /**
   * Delete a post (ac-5): the transactional cascade. The author signs the
   * deletion like any write; the post plus every derived artifact keyed to
   * it (renditions, tags, album memberships in the derived-data container;
   * quota artifact rows keyed by source id) and every comment, reaction,
   * vote, and notification on it are removed in one all-or-nothing write.
   */
  async deletePost({ accessToken, postId, signature } = {}) {
    const session = await this.#requireSession(accessToken);
    const post = await this.posts.findOne({ _id: postId });
    if (!post || post.originNetworkId !== session.networkId) {
      throw typedError("E_POST_NOT_FOUND", POST_MESSAGES.E_POST_NOT_FOUND);
    }
    if (post.authorId !== session.did) {
      throw typedError("E_NOT_PERMITTED", POST_MESSAGES.E_NOT_PERMITTED);
    }
    await this.verifyWrite({
      networkId: session.networkId,
      did: session.did,
      deviceId: session.deviceId,
      payload: { kind: "delete", postId: post._id, networkId: post.originNetworkId },
      signature,
    });
    return this.cascadePost(post, { actorDid: session.did });
  }

  /**
   * Member-level deletion (ac-5 tail): sweeps ALL of the member's authored
   * content at this origin — every authored post (full cascade), plus every
   * comment, reaction, and vote they authored on other posts. Transactional
   * by the same snapshot/rollback mechanism.
   */
  async memberContentSweep({ accessToken, signature } = {}) {
    const session = await this.#requireSession(accessToken);
    const networkId = session.networkId;
    await this.verifyWrite({
      networkId,
      did: session.did,
      deviceId: session.deviceId,
      payload: { kind: "delete", scope: "member", networkId },
      signature,
    });

    const authoredPosts = await this.posts.find({ originNetworkId: networkId, authorId: session.did });
    const theirComments = await this.comments.find({ networkId, authorDid: session.did });
    const theirReactions = await this.reactions.find({ networkId, memberDid: session.did });
    const theirVotes = await this.votes.find({ networkId, memberDid: session.did });
    // Reply notifications fired onto comments the member authored die with
    // those comments; their own posts cascade their notifications below.
    const theirCommentIds = new Set(theirComments.map((row) => row._id));
    const networkNotifications = await this.notifications.find({ networkId });
    const repliesToTheirComments = networkNotifications.filter(
      (row) => row.type === "reply" && row.commentId !== null && theirCommentIds.has(row.commentId),
    );
    const keyed = await this.#keyedRows({ networkId, posts: authoredPosts });
    // Derived-artifact-class rows (people tags, album memberships) are keyed
    // to the originals — they die with the same transactional write. Without
    // this part the sweep would orphan every manual-organization row keyed
    // to the member's posts.
    const sweptPostIdSet = new Set(authoredPosts.map((post) => post._id));
    const sweptDerived = (await this.derivedData.find({ networkId })).filter((row) => sweptPostIdSet.has(row.postId));
    // Link previews (PORCH-052): the member's posts' references plus every
    // reply they authored elsewhere die with the sweep — same og:image
    // cascade coverage as the single-post cascade.
    const previewIds = [...authoredPosts, ...theirComments]
      .map((row) => row.previewId)
      .filter(Boolean);
    const previewCascade = this.previews
      ? await this.previews.cascadeRows({ networkId, previewIds })
      : { parts: [], blobKeys: [] };

    const snapshot = [
      { collection: this.posts, rows: authoredPosts },
      { collection: this.comments, rows: theirComments },
      { collection: this.reactions, rows: theirReactions },
      { collection: this.votes, rows: theirVotes },
      { collection: this.notifications, rows: repliesToTheirComments },
      { collection: this.derivedData, rows: sweptDerived },
      ...keyed,
      ...previewCascade.parts,
    ];
    await this.runTransactional(snapshot);
    await this.previews?.releaseBlobs(previewCascade.blobKeys);

    // Surviving posts the member interacted with must forget those
    // interactions in their rank-input counters.
    const sweptPostIds = new Set(authoredPosts.map((post) => post._id));
    const touchedPostIds = [
      ...theirComments.map((row) => row.postId),
      ...theirReactions.map((row) => row.postId),
      ...theirVotes.map((row) => row.postId),
    ].filter((postId) => !sweptPostIds.has(postId));
    for (const postId of touchedPostIds) {
      await this.recount({ postId, networkId });
    }

    await this.audit("member_content_delete", {
      networkId,
      did: session.did,
      detail: { postsSwept: authoredPosts.length },
    });
    return { sweptPosts: authoredPosts.length };
  }

  /**
   * The deletion cascade for ONE post (ac-5): everything keyed to it goes
   * in the same all-or-nothing write — comments, reactions, votes,
   * notifications, derived-artifact-class rows, and the quota artifact
   * ledger rows for the post's media (keyed by post id or media ref id).
   * Any failing step rolls every deletion back.
   */
  async cascadePost(post, { actorDid = null } = {}) {
    const networkId = post.originNetworkId;
    const comments = await this.comments.find({ postId: post._id });
    const reactions = await this.reactions.find({ postId: post._id });
    const votes = await this.votes.find({ postId: post._id });
    const notifications = await this.notifications.find({ postId: post._id });
    const derived = await this.derivedData.find({ postId: post._id });
    const keyed = await this.#keyedRows({ networkId, posts: [post] });
    // Link previews (PORCH-052): the post's reference and every reply's
    // reference die with the parent — including each ingest's og:image
    // asset rows, rendition rows, and ledger rows that survive no other
    // reference (the content-addressed bytes die with the last reference).
    const previewIds = [post.previewId, ...comments.map((comment) => comment.previewId)].filter(Boolean);
    const previewCascade = this.previews
      ? await this.previews.cascadeRows({ networkId, previewIds })
      : { parts: [], blobKeys: [] };

    const snapshot = [
      { collection: this.posts, rows: [post] },
      { collection: this.comments, rows: comments },
      { collection: this.reactions, rows: reactions },
      { collection: this.votes, rows: votes },
      { collection: this.notifications, rows: notifications },
      { collection: this.derivedData, rows: derived },
      ...keyed,
      ...previewCascade.parts,
    ];
    await this.runTransactional(snapshot);
    await this.previews?.releaseBlobs(previewCascade.blobKeys);
    await this.audit("post_delete", {
      networkId,
      did: actorDid ?? post.authorId,
      detail: { postId: post._id, comments: comments.length, reactions: reactions.length, votes: votes.length },
    });
    return {
      deleted: true,
      postId: post._id,
      cascadeRows: snapshot.reduce((n, part) => n + part.rows.length, 0),
    };
  }

  /** Recompute one post's rank-input counters from live rows. */
  async recount({ postId, networkId }) {
    void networkId;
    const comments = await this.comments.find({ postId });
    const reactions = await this.reactions.find({ postId });
    const votes = await this.votes.find({ postId });
    await this.posts.updateOne(
      { _id: postId },
      { $set: { interactionCounters: computeCounters({ comments, reactions, votes }) } },
    );
  }

  /**
   * Transactional write over the CollectionLike boundary: snapshot first,
   * mutate second; a mid-flight failure reinstates every already-removed
   * row and rethrows. The store contract exposes no session-based
   * transaction, so snapshot/rollback is the deterministic all-or-nothing
   * mechanism (a failed rollback surfaces — never swallows).
   */
  async runTransactional(snapshot) {
    const placed = [];
    try {
      for (const part of snapshot) {
        for (const row of part.rows) {
          await part.collection.deleteOne({ _id: row._id });
        }
        placed.push(part);
      }
    } catch (error) {
      for (const part of placed) {
        for (const row of part.rows) {
          await part.collection.insertOne(structuredClone(row));
        }
      }
      throw error;
    }
  }

  /** Verify an actor-signed write against the origin enrollment (perimeter). */
  async verifyWrite({ networkId, did, deviceId, payload, signature }) {
    await this.membership.verifyMemberWrite({ networkId, did, deviceId, payload, signature });
  }

  /**
   * Member post view — delegation to the shared postView (vote privacy
   * contract: rank inputs never reach a client through this view).
   */
  view(post) {
    return postView(post);
  }

  /**
   * Attribution (PORCH-034): member post views carry the author's
   * family-facing name, resolved at READ time against the origin's active
   * membership — never a frozen copy on the post document. A DID that holds
   * no active membership at the origin renders the plain nameless fallback
   * (names render for network members only).
   */
  async #withAttribution(views, networkId) {
    const names = await this.membership.attributionNames({ networkId, dids: views.map((view) => view.authorId) });
    return views.map((view) => ({ ...view, authorName: names.get(String(view.authorId)) ?? null }));
  }

  #requireSession(accessToken) {
    if (!accessToken) {
      throw typedError("E_MUST_SIGN_IN", POST_MESSAGES.E_MUST_SIGN_IN);
    }
    return this.membership.verifyAccessToken(accessToken, { surface: "post" }).then((perimeter) => {
      if (!perimeter) {
        // The membership token IS the perimeter: no resolve, no write, no
        // read. It is scoped to exactly one network, so its network is the
        // only origin this request can touch.
        throw typedError("E_NOT_PERMITTED", POST_MESSAGES.E_NOT_PERMITTED);
      }
      // The session projection carries {did, deviceId}; the ORIGIN rides on
      // the membership row (PORCH-005 verifyAccessToken contract).
      return {
        did: perimeter.session.did,
        deviceId: perimeter.session.deviceId,
        networkId: perimeter.membership.networkId,
      };
    });
  }

  #keyedRows({ networkId, posts }) {
    const mediaIds = new Set(posts.flatMap((post) => [post._id, ...(post.mediaRefs ?? [])]));
    return this.artifacts.find({ networkId }).then((rows) => [
      { collection: this.artifacts, rows: rows.filter((row) => mediaIds.has(row.sourceId)) },
    ]);
  }

  /** Validate the payload and build the post document (no client-supplied ids). */
  async #buildPost({ networkId, did, payload, signature }) {
    const type = payload.type;
    if (!POST_TYPES.includes(type)) {
      throw typedError("E_TYPE_REQUIRED", POST_MESSAGES.E_TYPE_REQUIRED);
    }
    const body = payload.body ?? null;
    const mediaRefs = Array.isArray(payload.mediaRefs) ? payload.mediaRefs.filter((ref) => typeof ref === "string" && ref.length > 0) : [];
    if (type === "text" && (typeof body !== "string" || body.trim().length === 0)) {
      throw typedError("E_BODY_REQUIRED", POST_MESSAGES.E_BODY_REQUIRED);
    }
    if (MEDIA_TYPES.includes(type) && mediaRefs.length === 0) {
      throw typedError("E_MEDIA_REQUIRED", POST_MESSAGES.E_MEDIA_REQUIRED);
    }
    const groupId = payload.groupId ?? null;
    if (groupId !== null) {
      await this.#assertGroupContainment({ networkId, did, groupId });
    }
    // Link preview (PORCH-052): one removable reference validated against
    // the origin's rows. An invalid reference degrades to no preview —
    // compose never blocks (ac-3); the URL itself still rides the body as
    // a plain link.
    const preview = payload.previewId ? await this.#attachPreview({ networkId, previewId: payload.previewId }) : null;
    const displayHint =
      typeof payload.crossPostRef === "string" && payload.crossPostRef.length > 0
        ? { crossPostOf: payload.crossPostRef }
        : null;
    return {
      post: {
        _id: `post_${crypto.randomUUID()}`,
        originNetworkId: networkId,
        authorId: did,
        type,
        groupId,
        deviceSignature: signature,
        mediaRefs,
        previewId: preview?._id ?? null,
        caption: typeof payload.caption === "string" ? payload.caption : null,
        body: type === "text" ? body : null,
        visibility: "members-only",
        displayHint,
        interactionCounters: { ...ZERO_COUNTERS },
        createdAt: new Date().toISOString(),
      },
      preview,
    };
  }

  /**
   * Preview attach (PORCH-052): the compose payload carries the reference
   * id the resolve call produced; only that origin's own rows attach, so
   * containment holds and a stale/foreign id degrades to no preview.
   */
  async #attachPreview({ networkId, previewId }) {
    return this.previews?.assertAttachable({ networkId, previewId }) ?? null;
  }

  /** The attach-time preview view for a live-event payload (content only). */
  previewPayload(previewRow) {
    return this.previews?.previewView(previewRow) ?? null;
  }

  /** Groups are within-network containers; membership ⊂ network membership. */
  async #assertGroupContainment({ networkId, did, groupId }) {
    const group = await this.groups.findOne({ _id: groupId });
    if (!group || group.networkId !== networkId) {
      throw typedError("E_GROUP_UNKNOWN", POST_MESSAGES.E_GROUP_UNKNOWN);
    }
    if (!Array.isArray(group.members) || !group.members.includes(did)) {
      throw typedError("E_GROUP_NOT_MEMBER", POST_MESSAGES.E_GROUP_NOT_MEMBER);
    }
  }
}

export default PostService;

/**
 * Member view (vote privacy contract) shared with the feed assembly: rank
 * inputs (interactionCounters) and actor signatures are internal; no count,
 * ratio, or per-member vote record ever reaches a client through this view.
 */
export function postView(post) {
  if (!post) return null;
  return {
    _id: post._id,
    originNetworkId: post.originNetworkId,
    authorId: post.authorId,
    type: post.type,
    groupId: post.groupId,
    mediaRefs: post.mediaRefs,
    previewId: post.previewId ?? null,
    caption: post.caption,
    body: post.body,
    visibility: post.visibility,
    displayHint: post.displayHint,
    createdAt: post.createdAt,
  };
}