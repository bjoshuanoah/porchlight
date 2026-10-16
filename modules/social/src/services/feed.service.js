import { typedError, postView, newestFirstByActivity, ruledRootCompare } from "./post.service.js";
import { InteractionService } from "./interaction.service.js";
import { postDeliversToViewer, postVisibleToViewer, canSeeGroup } from "./group.service.js";
import { socialModels } from "../models.js";

export const FEED_MESSAGES = {
  E_MUST_SIGN_IN: "Sign in to your membership before reading the timeline.",
  E_NOT_PERMITTED: "This action is not available to you in this network.",
  E_GROUP_UNKNOWN: "That group doesn't exist in this network.",
  E_SEARCH_QUERY_REQUIRED: "Search needs a plain-text query.",
};

/** Timeline cards carry the four most recent root comments in reading order. */
export const REPLY_SLICE_LIMIT = 4;

/**
 * Feed service (PORCH-007): timeline ordering and feed assembly.
 *
 * - Base timeline (ac-1): everyone's posts at the origin, newest first by
 *   latest activity (an interaction write bumps `lastActivityAt` on the
 *   post; a post with no interactions keeps its creation time). Reverse-chron
 *   pagination only — the base timeline never re-sorts and never decays.
 * - Group timeline (ac-1): the same assembly restricted to the group's
 *   origin-filtered post set (post.groupId). Group posts ride the same path
 *   with no special weight anywhere.
 * - Ranked section (ac-2): computed by the ranking module (the single
 *   writer of ranked order) over the capped window. This service contributes
 *   only post documents; prominence order comes back from the formula.
 * - Vote privacy (ac-3): member views carry no counters, no ratios, and no
 *   vote records — the feed renders prominence order only. This service
 *   never reads the votes collection; rank inputs live on the post docs.
 * - Hidden lists (ac-4): the server stores no hidden-list state. Members
 *   keep hidden post ids client-side (browser storage keyed by origin) and
 *   apply them at render, across base timeline and ranked section alike.
 * - Search (ac-5): plain text over captions, manual people tags, and album
 *   names, scoped to exactly one origin network (the membership token's).
 */
export class FeedService {
  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} deps.posts
   * @param {import("@porchlight/shared").CollectionLike} deps.derivedData
   * @param {import("@porchlight/shared").CollectionLike} deps.groups
   * @param {import("./membership.service.js").MembershipService} deps.membership
   * @param {import("./ranking.service.js").RankingService} deps.ranking
   * @param {import("./media.service.js").MediaService} deps.media
   * @param {import("@porchlight/shared").CollectionLike} deps.comments
   *   Conversation previews: feed views carry the latest four root comments,
   *   their nested response counts, and the root total without per-card reads.
   * @param {import("@porchlight/shared").CollectionLike} deps.reactions
   *   Reaction rows ride the member view as authored (PORCH-046): cards
   *   reflect arriving reactions in place from the same feed read.
   * @param {import("./link-preview.service.js").LinkPreviewService} [deps.previews]
   *   Link previews (PORCH-052): feed views and their reply slices hydrate
   *   `preview` at read time — the card/embed metadata + og:image geometry
   *   ride the same single feed read (no per-card requests).
   *   Post views hydrate `mediaMeta` — the rendition set of record + display
   *   dims — so every feed surface carries what the client's srcset/sizes
   *   and the video poster need (PORCH-044 ac-2).
   */
  constructor({ posts, derivedData, groups, membership, ranking, media, comments, reactions, previews }) {
    this.posts = posts;
    this.derivedData = derivedData;
    this.groups = groups;
    this.membership = membership;
    this.ranking = ranking;
    this.media = media;
    this.comments = comments;
    this.reactions = reactions;
    this.previews = previews ?? null;
    this.models = socialModels;
  }

  /**
   * Base timeline read (ac-1): origin posts, newest first by latest
   * activity. Group-post delivery is membership-gated for both
   * visibilities (PORCH-068 ac-2, refined): a group post the viewer does
   * not hold membership in never rides their own timeline.
   */
  async timeline({ accessToken } = {}) {
    const { networkId, did } = await this.#perimeterOf(accessToken);
    return { posts: await this.#ordered(await this.#deliverableRows(networkId, did), networkId) };
  }

  /**
   * Group timeline read (ac-1): origin-filtered query on post.groupId. The
   * group must exist inside the token's origin network; the ranked path and
   * ordering are identical to the base timeline (no group rank weight). A
   * private group's timeline renders only for its members (PORCH-068 ac-2):
   * a non-member is refused exactly as for a group that does not exist in
   * this network.
   */
  async groupTimeline({ accessToken, groupId } = {}) {
    const { networkId, did } = await this.#perimeterOf(accessToken);
    const group = await this.groups.findOne({ _id: groupId });
    if (!group || group.networkId !== networkId || !canSeeGroup(group, did)) {
      throw typedError("E_GROUP_UNKNOWN", FEED_MESSAGES.E_GROUP_UNKNOWN);
    }
    const rows = await this.posts.find({ originNetworkId: networkId, groupId });
    return { group: { _id: group._id, name: group.name }, posts: await this.#ordered(rows, networkId) };
  }

  /**
   * Ranked section read (ac-2): prominence order from the ranking module,
   * recomputed over the capped window. The result is ordered posts only —
   * no scores, no counters, no vote arithmetic ever reaches the client.
   * Group-post delivery is membership-gated for both visibilities
   * (PORCH-068 ac-2, refined): the ranked path is fed the same set the
   * base timeline feeds.
   */
  async ranked({ accessToken } = {}) {
    const { networkId, did } = await this.#perimeterOf(accessToken);
    const candidates = await this.#deliverableRows(networkId, did);
    const ranked = this.ranking.rank(candidates);
    const views = ranked.map(({ post }) => postView(post));
    return { posts: await this.#decorate(views, networkId) };
  }

  /**
   * Plain-text search (ac-5): captions, manual people tags, and album
   * names, scoped to the token's origin network. Tags and album names are
   * manual-organization surfaces stored as derived-artifact-class rows
   * (class "tag" / "album_membership" with the member-authored value on the
   * row); a tag or album name match surfaces its keyed post, and a caption
   * match surfaces its post. Ordering is the base timeline's (newest first
   * by latest activity).
   */
  async search({ accessToken, query } = {}) {
    const { networkId, did } = await this.#perimeterOf(accessToken);
    const q = typeof query === "string" ? query.trim() : "";
    if (q.length === 0) {
      throw typedError("E_SEARCH_QUERY_REQUIRED", FEED_MESSAGES.E_SEARCH_QUERY_REQUIRED);
    }
    const needle = q.toLowerCase();
    const rows = await this.#visibleRows(networkId, did);
    const byId = new Map(rows.map((post) => [post._id, post]));
    const matches = new Set();
    // Captions are a manual-organization search surface (ac-5).
    for (const post of rows) {
      if (typeof post.caption === "string" && post.caption.toLowerCase().includes(needle)) {
        matches.add(post._id);
      }
    }
    // Manual people tags and album names key into posts via the
    // derived-artifact container (deletion-cascade bound to the original).
    const manual = await this.derivedData.find({ networkId });
    const tagHits = new Set(
      manual
        .filter(
          (row) =>
            (row.class === "tag" || row.class === "album_membership") &&
            typeof row.value === "string" &&
            row.value.toLowerCase().includes(needle) &&
            byId.has(row.postId),
        )
        .map((row) => row.postId),
    );
    for (const postId of tagHits) {
      matches.add(postId);
    }
    const hits = [...matches].map((_id) => byId.get(_id));
    return { query: q, posts: await this.#ordered(hits, networkId) };
  }

  /**
   * The hidden-list contract lives entirely client-side: this service
   * writes nothing, reads nothing, and exposes no endpoint for hidden
   * post ids. The `hiddenPostIds` a client received from local browser
   * storage are applied at render after any feed read.
   */
  static applyHidden(posts, hiddenPostIds = new Set()) {
    return posts.filter((post) => !hiddenPostIds.has(post._id));
  }

  /** Reverse-chron by latest activity, then creation time, then id, as member views. */
  static order(rows) {
    return newestFirstByActivity(rows).map((post) => postView(post));
  }

  /** Reverse-chron member views, each group post carrying its group chip. */
  async #ordered(rows, networkId) {
    return this.#decorate(FeedService.order(rows), networkId);
  }

  /** Member views plus read-time member attribution (PORCH-034) and mediaMeta (PORCH-044). */
  async #decorate(views, networkId) {
    const attributed = await this.#withAttribution(await this.#withGroupChips(views, networkId), networkId);
    const withConversation = await this.#withConversationPreviews(attributed, networkId);
    const withMeta = await this.media.withMediaMeta(withConversation, networkId);
    return this.previews ? await this.previews.withViews(withMeta, networkId) : withMeta;
  }

  /**
   * One arrival's timeline-shaped view (PORCH-081): the EXACT decoration
   * the base timeline read rides — attribution (PORCH-034), the group chip,
   * the latest-four conversation slice, mediaMeta geometry stamps
   * (PORCH-044), and the link preview. Used by post.created envelopes so
   * the arriving post renders as-given and its card never needs a
   * follow-up read (the feed read's per-card loader path never fires).
   */
  async eventViews(postRows, networkId) {
    return this.#decorate((postRows ?? []).map((post) => postView(post)), networkId);
  }

  /**
   * Attribution (PORCH-034): every member post view carries the author's
   * family-facing name, resolved at READ time against the origin's active
   * membership — never a frozen copy on the post document. A DID that holds
   * no active membership at the origin renders the plain nameless fallback
   * (names render for network members only). PORCH-070: `authorAvatar`
   * rides beside the name on every fed post view — timeline, group
   * timelines, ranked, and search share this one copy — the identity-plane
   * avatar meta passed through verbatim, never mutated here.
   */
  async #withAttribution(views, networkId) {
    const names = await this.membership.attributionNames({ networkId, dids: views.map((view) => view.authorId) });
    return views.map((view) => ({ ...view, authorName: names.get(String(view.authorId))?.name ?? null, authorAvatar: names.get(String(view.authorId))?.avatar ?? null }));
  }

  /**
   * Group chip (PORCH-030 ac-4): a group post rides the main feed with its
   * group's name attached (`groupName`), so the network timeline renders
   * the chip without a follow-up lookup. Groups stay the same origin-
   * filtered containers; group posts gain no rank weight and no counters —
   * this only decorates the member view already carried by postView.
   */
  async #withGroupChips(views, networkId) {
    const groups = await this.groups.find({ networkId: String(networkId) });
    const names = new Map(groups.map((group) => [group._id, group.name]));
    return views.map((view) =>
      view.groupId && names.has(view.groupId) ? { ...view, groupName: names.get(view.groupId) } : view,
    );
  }

  /**
   * Conversation previews: one origin-scoped read of comments and reactions
   * decorates every post view with the top four roots of the ruled order
   * (PORCH-085), the root total, nested response counts, and authored
   *
   * - The root total is conversation content quantity for the expander,
   *   never an engagement or reaction count; reaction rows render as given
   *   without numbers (PORCH-036), and votes never enter any read.
   * - Origin containment applies to the decoration itself: only the token's
   *   network rows are read, so a foreign-network reply never rides a view,
   *   live or cached (PORCH-046 ac-4).
   */
  async #withConversationPreviews(views, networkId) {
    if (!views.length) return views;
    const [comments, reactions] = await Promise.all([
      this.comments.find({ networkId }),
      this.reactions.find({ networkId }),
    ]);
    const names = await this.membership.attributionNames({
      networkId,
      dids: [
        ...new Set([
          ...comments.map((comment) => comment.authorDid),
          ...(reactions ?? []).map((row) => row.memberDid),
        ]),
      ],
    });
    return FeedService.withConversationPreviews(views, comments, reactions, names);
  }

  /**
   * Pure decoration: group origin comments and reactions by post. Cards show
   * the top four roots of the ruled read order (PORCH-085: threaded roots
   * ahead of childless roots, each group newest-first); each visible root
   * carries the count of all descendants, not their content.
   */
  static withConversationPreviews(views, comments, reactions, names) {
    const commentsByPost = new Map();
    for (const comment of comments ?? []) {
      if (!commentsByPost.has(comment.postId)) commentsByPost.set(comment.postId, []);
      commentsByPost.get(comment.postId).push(comment);
    }
    const rowsByPost = new Map();
    for (const row of reactions ?? []) {
      if (!rowsByPost.has(row.postId)) rowsByPost.set(row.postId, []);
      // Reactor attribution (PORCH-091 ac-1): each chip row carries the
      // reactor's display name + avatar rendering data in the origin's
      // served order — the origin-scoped find keeps foreign-network rows
      // and non-members (names resolve for active origin members only)
      // off every payload. Content only: no count, no roster field.
      rowsByPost.get(row.postId).push(InteractionService.attributedReactionView(row, names));
    }
    return views.map((view) => {
      const mine = commentsByPost.get(view._id) ?? [];
      const children = new Map();
      for (const comment of mine) {
        if (comment.parentId == null) continue;
        if (!children.has(comment.parentId)) children.set(comment.parentId, []);
        children.get(comment.parentId).push(comment);
      }
      // Ruled read order (PORCH-085): the slice window serves the top four
      // of the ruled sort, not the four newest chronologically.
      const roots = mine
        .filter((comment) => comment.parentId == null)
        .sort((a, b) => ruledRootCompare(a, b, (root) => (children.get(root._id)?.length ?? 0) > 0));
      const visibleRoots = roots.slice(0, REPLY_SLICE_LIMIT);
      const slice = visibleRoots.map((comment) => {
        let responseCount = 0;
        const pending = [...(children.get(comment._id) ?? [])];
        while (pending.length) {
          const child = pending.pop();
          responseCount += 1;
          for (const next of children.get(child._id) ?? []) pending.push(next);
        }
        return {
          ...InteractionService.commentView(comment),
          authorName: names.get(String(comment.authorDid))?.name ?? null,
          responseCount,
        };
      });
      return {
        ...view,
        replySlice: slice,
        replyTotal: roots.length,
        reactionRows: rowsByPost.get(view._id) ?? [],
      };
    });
  }

  /**
   * The origin's rows filtered down to what the viewer may be SHOWN
   * (PORCH-068 ac-2, view surfaces): a private-group post renders only for
   * members of that group; posts outside every group pass unchanged (the
   * standing base-feed rule), and a dangling groupId keeps rendering.
   */
  async #visibleRows(networkId, did) {
    return this.#filteredRows(networkId, did, postVisibleToViewer);
  }

  /**
   * The origin's rows filtered down to what may be DELIVERED to the
   * viewer's own feed (PORCH-068 ac-2, refined Brian Oct 14: "A public
   * group should also never show up on any non-member timeline unless they
   * go to the group and join the group"): a group post rides the timeline
   * and ranked section only for a member of that group, private and
   * public alike.
   */
  async #deliverableRows(networkId, did) {
    return this.#filteredRows(networkId, did, postDeliversToViewer);
  }

  /** One read of the origin's posts and groups, filtered by one predicate. */
  async #filteredRows(networkId, did, predicate) {
    const rows = await this.posts.find({ originNetworkId: networkId });
    const groupsById = new Map((await this.groups.find({ networkId: String(networkId) })).map((group) => [group._id, group]));
    return rows.filter((post) => predicate(post, groupsById, did));
  }

  async #perimeterOf(accessToken) {
    if (!accessToken) {
      throw typedError("E_MUST_SIGN_IN", FEED_MESSAGES.E_MUST_SIGN_IN);
    }
    const perimeter = await this.membership.verifyAccessToken(accessToken, { surface: "feed" });
    if (!perimeter) {
      throw typedError("E_NOT_PERMITTED", FEED_MESSAGES.E_NOT_PERMITTED);
    }
    return { networkId: perimeter.membership.networkId, did: perimeter.session.did };
  }
}

export default FeedService;