import { socialModels } from "../models.js";
import { canSeeGroup, postDeliversToViewer, isGroupManager } from "./group.service.js";
import { purgeAtFor } from "./lifecycle.service.js";

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
  E_EDIT_NOT_AUTHOR: "Only the post's author can edit it — ownership never confers edit authority.",
  E_EDIT_MEDIA_IMMUTABLE: "Media is never edited — swap, add, or remove media by deleting this post and posting it again.",
  E_EDIT_TYPE_IMMUTABLE: "A post's type never changes — delete this post and post the new one.",
  E_EDIT_EMPTY: "An edit needs new text or a new caption.",
  E_COMMENT_NOT_FOUND: "That comment doesn't exist in this network.",
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

/** Root-comment read order of record (PORCH-085, paired PRD 6ad13dde89855af1a3cc050b): threaded
 * roots rank ahead of childless roots; within each group roots serve newest-first (createdAt
 * descending, stable otherwise). Replies serve chronological (ascending) inside each tree. */
export function ruledRootCompare(a, b, threadedOf) {
  const threadedA = threadedOf(a) ? 1 : 0;
  const threadedB = threadedOf(b) ? 1 : 0;
  if (threadedA !== threadedB) return threadedB - threadedA;
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
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
   * @param {import("./push.service.js").PushService} [deps.push]
   *   PORCH-059: group posts fan out to the group's members through the
   *   send pipeline (the member-controlled groupPost toggle gates them).
   * @param {import("./media.service.js").MediaService} deps.media
   *   The media pipeline: member views hydrate `mediaMeta` (rendition set
   *   of record, display dims) so clients never fetch rendition metadata
   *   per item (PORCH-044 ac-2).
   * @param {(action: string, payload?: object) => Promise<void>} [deps.audit]
   * @param {import("./link-preview.service.js").LinkPreviewService} [deps.previews]
   *   Link previews (PORCH-052) — compose-time attach validation, view
   *   hydration, and the deletion cascade for ingested og:image artifacts.
   */
  constructor({ posts, comments, reactions, votes, notifications, derivedData, artifacts, groups, membership, media, audit, realtime, previews, push, feed, tombstones }) {
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
    // PORCH-093: the tombstone collection of record — every lifecycle
    // delete rides one (subject attribution + restore window + purge
    // accounting). Absent on bare assemblies that predate the lifecycle.
    this.tombstones = tombstones ?? null;
    this.push = push ?? null;
    this.previews = previews ?? null;
    this.realtime = realtime ?? null;
    this.feed = feed ?? null;
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
    // PORCH-081 client parity: the envelope carries the SAME decorated view
    // the timeline read carries — attribution (PORCH-034), the group chip,
    // the latest-four conversation slice, mediaMeta geometry stamps
    // (PORCH-044), and the attach-time preview — so the arriving post
    // renders as-given and its card never needs a follow-up read (the
    // per-card loader path never fires on arrival). No count-bearing field
    // rides any of it (the privacy assert still holds); feed-less test
    // wiring falls back to the plain member view.
    const [eventView] = this.feed
      ? await this.feed.eventViews([post], networkId)
      : await this.memberViews([post], networkId);
    await this.realtime?.published({
      networkId,
      type: "post.created",
      postId: post._id,
      // PORCH-068: the envelope carries the group target so the delivery
      // layer can hold a private-group post's event out of a non-member's
      // room and catch-up (the envelope is content-only metadata).
      groupId: post.groupId ?? null,
      content: { ...eventView, preview: this.previewPayload(preview) ?? eventView?.preview ?? null },
    });
    // PORCH-059: group posts fan out to the group's own members through the
    // push send pipeline (subset-of-network membership holds); the
    // member-controlled groupPost toggle gates every recipient at send
    // time. The author never receives their own post.
    if (post.groupId) {
      const group = await this.groups.findOne({ _id: post.groupId });
      await this.push?.notify({
        networkId,
        type: "groupPost",
        targetDids: Array.isArray(group?.members) ? group.members : [],
        postId: post._id,
        actorDid: session.did,
        // PORCH-088: the group target rides the trigger so the send
        // pipeline resolves each recipient's per-group preference at send
        // time (the persisted settings row, never cached).
        groupId: post.groupId,
        excerpt: post.caption ?? post.body ?? null,
      });
    }
    return { post: (await this.memberViews([post], networkId))[0], did: session.did };
  }

  /** Read one post as a member view (no counters, no vote data). A
   *  private-group post resolves only for members of that group (PORCH-068
   *  ac-2): for a non-member the read is refused exactly as a post of
   *  another origin — it simply does not exist here. */
  async get({ accessToken, postId } = {}) {
    const session = await this.#requireSession(accessToken);
    const post = await this.posts.findOne({ _id: postId });
    if (!post || post.originNetworkId !== session.networkId || !(await this.#visibleTo(post, session.did))) {
      // Containment: a post of another origin simply does not exist here;
      // a private-group post a non-member asks for reads the same way.
      throw typedError("E_POST_NOT_FOUND", POST_MESSAGES.E_POST_NOT_FOUND);
    }
    return { post: (await this.memberViews([post], session.networkId))[0], did: session.did };
  }

  /**
   * The post's original set of record (PORCH-083): the mediaRefs in stored
   * payload order, resolved for a viewer over the same member-read gates
   * the post read carries — origin containment and private-group visibility
   * (a non-member's read of a post it cannot see reads the same way):
   * simply does not exist here. The bulk zip consumes the ids directly,
   * without the view hydration (no member views, no mediaMeta on this read).
   */
  async setMediaIds({ accessToken, postId } = {}) {
    const session = await this.#requireSession(accessToken);
    const post = await this.posts.findOne({ _id: postId });
    if (!post || post.originNetworkId !== session.networkId || !(await this.#visibleTo(post, session.did))) {
      throw typedError("E_POST_NOT_FOUND", POST_MESSAGES.E_POST_NOT_FOUND);
    }
    return { postId, networkId: session.networkId, did: session.did, deviceId: session.deviceId, mediaIds: [...(post.mediaRefs ?? [])] };
  }

  /** List the origin network's posts, newest first (base timeline read), with
   *  group posts the viewer does not hold membership in removed (PORCH-068
   *  ac-2, refined: delivery is membership-gated for both visibilities). */
  async list({ accessToken } = {}) {
    const session = await this.#requireSession(accessToken);
    const rows = await this.posts.find({ originNetworkId: session.networkId });
    // Base timeline ordering (PORCH-007): newest first by latest activity;
    // reverse-chron pagination only — this read never re-sorts by rank.
    newestFirstByActivity(rows);
    return { posts: await this.memberViews(await this.#deliverableRowsOf(session.networkId, session.did, rows), session.networkId), did: session.did };
  }

  /** The visibility gate for one post document against one viewer did. */
  async #visibleTo(post, did) {
    if (!post?.groupId) return true;
    return canSeeGroup(await this.groups.findOne({ _id: post.groupId }), did);
  }

  /** Origin rows filtered down to the viewer's DELIVERABLE set (PORCH-068
   *  ac-2, refined): a group post rides a member's own feed only for a
   *  member of that group, private and public alike. */
  async #deliverableRowsOf(networkId, did, rows = null) {
    const resolved = rows ?? await this.posts.find({ originNetworkId: networkId });
    const groupsById = new Map((await this.groups.find({ networkId: String(networkId) })).map((group) => [group._id, group]));
    return resolved.filter(
      (post) => !post?.groupId || postDeliversToViewer(post, groupsById, did),
    );
  }

  /** Member views with attribution, mediaMeta (PORCH-044), and previews (PORCH-052). */
  async memberViews(postRows, networkId) {
    const attributed = await this.#withAttribution(postRows.map((post) => this.view(post)), networkId);
    const withMeta = await this.media.withMediaMeta(attributed, networkId);
    return this.previews ? await this.previews.withViews(withMeta, networkId) : withMeta;
  }

  /**
   * Delete a post (ac-5 cascade; PORCH-093 ac-1 authority): the
   * transactional cascade behind the tombstone. The two-role server gate —
   * the AUTHOR (own post) and the NETWORK OWNER (any post within networks
   * they own); ownership never confers edit authority, only this delete.
   * The remover signs the deletion like any write; the post plus every
   * derived artifact keyed to it and every comment, reaction, vote, and
   * notification on it leave every read surface in one all-or-nothing
   * write, tombstoned with the remover's role deletedByRole.
   */
  async deletePost({ accessToken, postId, signature } = {}) {
    const session = await this.#requireSession(accessToken);
    const post = await this.posts.findOne({ _id: postId });
    if (!post || post.originNetworkId !== session.networkId) {
      throw typedError("E_POST_NOT_FOUND", POST_MESSAGES.E_POST_NOT_FOUND);
    }
    const deletedByRole = await this.#deleteAuthorityRole(post, session);
    await this.verifyWrite({
      networkId: session.networkId,
      did: session.did,
      deviceId: session.deviceId,
      payload: { kind: "delete", postId: post._id, networkId: post.originNetworkId },
      signature,
    });
    return this.cascadePost(post, { actorDid: session.did, deletedByRole });
  }

  /**
   * The delete-authority gate of record (PORCH-093 ac-1): author first,
   * then the network owner of the ORIGIN network. Any other member — and
   * a group's managing member (comments never ride group moderation; a
   * manager's authority over posts rides removePost only) — is refused
   * plainly with zero mutation.
   */
  async #deleteAuthorityRole(post, session) {
    if (post.authorId === session.did) return "author";
    const membership = await this.membership.activeMembership({ networkId: session.networkId, did: session.did });
    if (membership?.role === "owner") return "owner";
    throw typedError("E_NOT_PERMITTED", POST_MESSAGES.E_NOT_PERMITTED);
  }

  /**
   * The group's managing-member post removal (PORCH-088 ac-4, superseded
   * Oct 16, 2026 — Brian: "It should be the same tombstone pattern"): the
   * moderation act rides the same tombstone pattern as every lifecycle
   * delete. The write is device-signed; the signed payload shape is
   * { kind: "group_post_remove", postId, groupId, networkId }.
   *
   * Authority (PORCH-093 ac-1): the group's managing member (the creator)
   * over group-origin POSTS ONLY, never comments and never content outside
   * groups they manage; the network owner rides as superuser on their own
   * network. A non-authoritative caller is refused plainly with zero
   * mutation.
   *
   * The removal executes the origin deletion cascade over the same
   * transactional sweep the author's own delete rides (comments, reactions,
   * votes, notifications, derived artifacts, link previews) INTO A
   * TOMBSTONE: renditions purge at delete, the original binaries hold the
   * 30-day restore window via the tombstone's mediaOrigins, and the
   * day-30 reaper purges once. Every delete records the remover:
   * deletedByRole is author when the actor authored the post, owner when
   * the actor is the network owner, group-manager otherwise (the
   * managing-member attribution rides the tombstone, TS 3). One audit
   * record lands (group_post_remove).
   *
   * @param {{ accessToken: string, postId: string, signature: string }} args
   */
  async removePost({ accessToken, postId, signature } = {}) {
    const session = await this.#requireSession(accessToken);
    const post = await this.posts.findOne({ _id: postId });
    if (!post || post.originNetworkId !== session.networkId) {
      throw typedError("E_POST_NOT_FOUND", POST_MESSAGES.E_POST_NOT_FOUND);
    }
    if (!post.groupId) {
      throw typedError("E_GROUP_POST_ONLY", "Only a post in a group can be removed from that group.");
    }
    const group = await this.groups.findOne({ _id: post.groupId });
    if (!group || group.networkId !== session.networkId) {
      throw typedError("E_GROUP_UNKNOWN", "That group doesn't exist in this network.");
    }
    // The managing-member authority check runs IN THE WRITE PATH (TS 17):
    // the group's creator, or the network owner on their own network. A
    // non-authoritative caller is refused plainly with zero mutation.
    const actorMembership = session.did ? await this.membership.activeMembership({ networkId: session.networkId, did: session.did }) : null;
    if (!isGroupManager(group, session.did, actorMembership)) {
      throw typedError(
        "E_GROUP_NOT_CREATOR",
        "Only the group's creator or the network owner can remove a group post.",
      );
    }
    await this.verifyWrite({
      networkId: session.networkId,
      did: session.did,
      deviceId: session.deviceId,
      payload: { kind: "group_post_remove", postId: post._id, groupId: post.groupId, networkId: post.originNetworkId },
      signature,
    });
    // Attribution (TS 3): the author removing their own post is an author
    // delete; the network owner is an owner delete; the managing member
    // (neither) is the group-manager moderation attribution.
    const deletedByRole =
      post.authorId === session.did
        ? "author"
        : actorMembership?.role === "owner"
          ? "owner"
          : "group-manager";
    // The cascade of record first (all-or-nothing over the collection
    // boundary); the media side follows: renditions purge at delete, the
    // originals hold the tombstone's restore window.
    const cascade = await this.cascadePost(post, { actorDid: session.did, action: "group_post_remove", deletedByRole });
    return {
      removed: true,
      postId: post._id,
      tombstoneId: cascade.tombstoneId,
      cascadeRows: cascade.cascadeRows,
      purgedMedia: cascade.purgedMedia,
    };
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

    return this.sweepContentOf({ networkId, did: session.did, actorDid: session.did, action: "member_content_delete" });
  }

  /**
   * The sweep core, authorized above by the caller (PORCH-053): sweeps ALL
   * of one member's authored content at this origin — every authored post
   * (full cascade), plus every comment, reaction, and vote they authored on
   * other posts. The member's own self-service sweep (above) and the
   * owner-only permanent member deletion both ride this one transactional
   * write; `actorDid` records who the trail names, `did` whose content dies.
   */
  async sweepContentOf({ networkId, did, actorDid = null, action = "member_content_delete" } = {}) {

    const authoredPosts = await this.posts.find({ originNetworkId: networkId, authorId: did });
    const theirComments = await this.comments.find({ networkId, authorDid: did });
    const theirReactions = await this.reactions.find({ networkId, memberDid: did });
    const theirVotes = await this.votes.find({ networkId, memberDid: did });
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

    await this.audit(action, {
      networkId,
      did: actorDid ?? did,
      detail: { targetDid: did, postsSwept: authoredPosts.length },
    });
    return { sweptPosts: authoredPosts.length };
  }

  /**
   * Edit a post (PORCH-093 ac-4): the author edits their own post's text
   * and caption. The two-role law is one-directional: ownership NEVER
   * confers edit authority — any other member (the network owner included)
   * is refused loudly. Media is never edited: a write attempting a
   * mediaRefs change (or a type change) is refused with the
   * delete-and-repost direction. Edits are silent by omission: no edit-time
   * field is written, no revision history exists, and the served document
   * stays byte-indistinguishable from the same content authored once.
   *
   * The PUT-class partial accepts `body` (text posts) and `caption`; the
   * event (post.updated) carries the same decorated view as post.created,
   * so connected clients re-render the edited fields in place.
   *
   * @param {{ accessToken: string, postId: string, payload: object, signature: string }} args
   */
  async editPost({ accessToken, postId, payload, signature } = {}) {
    const session = await this.#requireSession(accessToken);
    const post = await this.posts.findOne({ _id: postId });
    if (!post || post.originNetworkId !== session.networkId) {
      throw typedError("E_POST_NOT_FOUND", POST_MESSAGES.E_POST_NOT_FOUND);
    }
    if (post.authorId !== session.did) {
      throw typedError("E_EDIT_NOT_AUTHOR", POST_MESSAGES.E_EDIT_NOT_AUTHOR);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw typedError("E_BODY_REQUIRED", POST_MESSAGES.E_BODY_REQUIRED);
    }
    // Media immutability (TS 3): swapping, adding, or removing media rides
    // delete-and-repost — the edit write refuses the media-ref change with
    // that direction, and a type change refuses beside it.
    if ("mediaRefs" in payload) {
      throw typedError("E_EDIT_MEDIA_IMMUTABLE", POST_MESSAGES.E_EDIT_MEDIA_IMMUTABLE);
    }
    if (payload.type !== undefined && payload.type !== post.type) {
      throw typedError("E_EDIT_TYPE_IMMUTABLE", POST_MESSAGES.E_EDIT_TYPE_IMMUTABLE);
    }
    const hasBody = "body" in payload;
    const hasCaption = "caption" in payload;
    if (!hasBody && !hasCaption) {
      throw typedError("E_EDIT_EMPTY", POST_MESSAGES.E_EDIT_EMPTY);
    }
    const set = {};
    if (hasBody) {
      if (typeof payload.body !== "string" || payload.body.trim().length === 0) {
        throw typedError("E_EDIT_EMPTY", POST_MESSAGES.E_EDIT_EMPTY);
      }
      set.body = payload.body;
    }
    if (hasCaption) {
      set.caption = typeof payload.caption === "string" && payload.caption.trim().length > 0 ? payload.caption : null;
    }
    const verifyPayload = { kind: "post-edit", postId: post._id, networkId: post.originNetworkId, ...(hasBody ? { body: set.body } : {}), ...(hasCaption ? { caption: set.caption } : {}) };
    await this.verifyWrite({ networkId: session.networkId, did: session.did, deviceId: session.deviceId, payload: verifyPayload, signature });
    await this.posts.updateOne({ _id: post._id }, { $set: set });
    const updated = await this.posts.findOne({ _id: post._id });
    // The post.updated envelope carries the SAME decorated view the
    // post.created envelope carries (PORCH-081 client parity): the
    // connected timeline re-renders the changed fields in place, and
    // nothing in the view, the payload, or the envelope reveals an edit
    // occurred (the no-marker contract, enforced by omission).
    const [eventView] = this.feed
      ? await this.feed.eventViews([updated], session.networkId)
      : await this.memberViews([updated], session.networkId);
    await this.realtime?.published({
      networkId: session.networkId,
      type: "post.updated",
      postId: post._id,
      groupId: post.groupId ?? null,
      content: { ...eventView, preview: eventView?.preview ?? null },
    });
    await this.audit("post_edit", {
      networkId: session.networkId,
      did: session.did,
      detail: { postId: post._id, fields: Object.keys(set) },
    });
    return { post: (await this.memberViews([updated], session.networkId))[0], did: session.did };
  }

  /**
   * The deletion cascade for ONE post (ac-5; PORCH-093 tombstone law):
   * everything keyed to it leaves reachable read state in the same
   * all-or-nothing write — comments, nested replies, reactions, votes,
   * notifications, derived-artifact-class rows, and the quota ledger rows
   * for the post's derived media — AND a tombstone records the delete for
   * the restore window: subject attribution (deletedByRole), mediaOrigins
   * (the original binaries held at rest through the window — their ledger
   * rows are retained with them), the held link-preview derivations, and
   * the exact cascade snapshot the restore re-materializes. Renditions
   * purge at delete (store-side, after the commit). The tombstone insert
   * and the cascade sit inside one compensating write: a mid-flight
   * failure removes the tombstone and rolls every deletion back — no
   * half-deleted read state is ever reachable. Any failing step rolls
   * everything back.
   */
  async cascadePost(post, { actorDid = null, action = "post_delete", deletedByRole = "author" } = {}) {
    const networkId = post.originNetworkId;
    const comments = await this.comments.find({ postId: post._id });
    const reactions = await this.reactions.find({ postId: post._id });
    const votes = await this.votes.find({ postId: post._id });
    const notifications = await this.notifications.find({ postId: post._id });
    const derived = await this.derivedData.find({ postId: post._id });
    const keyed = await this.#keyedRows({ networkId, posts: [post] });
    // The ORIGINAL binaries hold the restore window (TS 3): the originals'
    // quota ledger rows are retained beside them; only derived ledger rows
    // (counters keyed to the post) leave with the cascade. Purge removes
    // the held ledger rows at day 30.
    const heldOriginals = new Set(post.mediaRefs ?? []);
    const ledgerRows = keyed
      .flatMap((part) => part.rows)
      .filter((row) => !(row.kind === "original" && heldOriginals.has(row.sourceId)));
    // Link previews (PORCH-052): the post's reference and every reply's
    // reference die with the parent — but their bytes are HELD through the
    // window (heldBlobKeys), so a restore re-materializes them exactly.
    // The day-30 reaper destroys the held bytes one time.
    const previewIds = [post.previewId, ...comments.map((comment) => comment.previewId)].filter(Boolean);
    const previewCascade = this.previews
      ? await this.previews.cascadeRows({ networkId, previewIds })
      : { parts: [], blobKeys: [] };
    const cascadeByKind = {};
    for (const part of previewCascade.parts) {
      cascadeByKind[part.kind] = [...(cascadeByKind[part.kind] ?? []), ...part.rows];
    }

    const snapshot = [
      { collection: this.posts, rows: [post] },
      { collection: this.comments, rows: comments },
      { collection: this.reactions, rows: reactions },
      { collection: this.votes, rows: votes },
      { collection: this.notifications, rows: notifications },
      { collection: this.derivedData, rows: derived },
      { collection: this.artifacts, rows: ledgerRows },
      ...previewCascade.parts,
    ];
    const nowIso = new Date().toISOString();
    const tombstone = {
      _id: `tmb_${crypto.randomUUID()}`,
      subjectType: "post",
      subjectId: post._id,
      originNetworkId: networkId,
      deletedBy: actorDid ?? post.authorId,
      deletedByRole,
      deletedAt: nowIso,
      purgeAt: purgeAtFor(nowIso),
      purgedAt: null,
      mediaOrigins: [...heldOriginals],
      heldBlobKeys: [...new Set(previewCascade.blobKeys)],
      cascade: {
        subject: post,
        comments,
        reactions,
        votes,
        notifications,
        derivedData: derived,
        previews: cascadeByKind.previews ?? [],
        assets: cascadeByKind.assets ?? [],
        artifacts: cascadeByKind.artifacts ?? [],
      },
    };
    // One all-or-nothing write: tombstone + cascade. A failure anywhere
    // removes the tombstone and rolls the deletions back (runTransactional
    // re-installs every already-removed row); no half-deleted read state.
    try {
      await this.tombstones.insertOne(tombstone);
      await this.runTransactional(snapshot);
    } catch (error) {
      await this.tombstones.deleteOne({ _id: tombstone._id });
      throw error;
    }
    // Renditions purge at delete (ac-2): asset rows, blob bytes, ledger
    // rows. The ORIGINAL binaries stay at rest for the tombstone.
    const purgedMedia = this.media
      ? await this.media.purgeRenditionsOf({ networkId, originalIds: [...heldOriginals] })
      : null;
    // PORCH-093: post.deleted rides the shipped vocabulary (ordered and
    // idempotent per origin; content-only). The tree-scoped payload carries
    // the ids of the cascaded children — the deleted post's own view never
    // re-renders, and no read surface ever serves the tombstoned rows.
    await this.realtime?.published({
      networkId,
      type: "post.deleted",
      postId: post._id,
      groupId: post.groupId ?? null,
      content: { cascadeIds: comments.map((comment) => comment._id) },
    });
    await this.audit(action, {
      networkId,
      did: actorDid ?? post.authorId,
      detail: {
        postId: post._id,
        deletedByRole,
        tombstoneId: tombstone._id,
        comments: comments.length,
        reactions: reactions.length,
        votes: votes.length,
        renditionsPurged: purgedMedia?.renditionRowsRemoved ?? 0,
        heldMedia: heldOriginals.size,
      },
    });
    return {
      deleted: true,
      postId: post._id,
      tombstoneId: tombstone._id,
      cascadeRows: snapshot.reduce((n, part) => n + part.rows.length, 0),
      purgedMedia,
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
   * (names render for network members only). PORCH-070: `authorAvatar`
   * rides beside the name — the identity-plane avatar meta passed through
   * verbatim, never mutated here.
   */
  async #withAttribution(views, networkId) {
    const names = await this.membership.attributionNames({ networkId, dids: views.map((view) => view.authorId) });
    return views.map((view) => {
      const resolved = names.get(String(view.authorId)) ?? null;
      return { ...view, authorName: resolved?.name ?? null, authorAvatar: resolved?.avatar ?? null };
    });
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