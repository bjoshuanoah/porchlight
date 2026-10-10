import { typedError, postView, newestFirstByActivity } from "./post.service.js";
import { socialModels } from "../models.js";

export const FEED_MESSAGES = {
  E_MUST_SIGN_IN: "Sign in to your membership before reading the timeline.",
  E_NOT_PERMITTED: "This action is not available to you in this network.",
  E_GROUP_UNKNOWN: "That group doesn't exist in this network.",
  E_SEARCH_QUERY_REQUIRED: "Search needs a plain-text query.",
};

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
   *   Post views hydrate `mediaMeta` — the rendition set of record + display
   *   dims — so every feed surface carries what the client's srcset/sizes
   *   and the video poster need (PORCH-044 ac-2).
   */
  constructor({ posts, derivedData, groups, membership, ranking, media }) {
    this.posts = posts;
    this.derivedData = derivedData;
    this.groups = groups;
    this.membership = membership;
    this.ranking = ranking;
    this.media = media;
    this.models = socialModels;
  }

  /** Base timeline read (ac-1): origin posts, newest first by latest activity. */
  async timeline({ accessToken } = {}) {
    const networkId = await this.#originOf(accessToken);
    const rows = await this.posts.find({ originNetworkId: networkId });
    return { posts: await this.#ordered(rows, networkId) };
  }

  /**
   * Group timeline read (ac-1): origin-filtered query on post.groupId. The
   * group must exist inside the token's origin network; the ranked path and
   * ordering are identical to the base timeline (no group rank weight).
   */
  async groupTimeline({ accessToken, groupId } = {}) {
    const networkId = await this.#originOf(accessToken);
    const group = await this.groups.findOne({ _id: groupId });
    if (!group || group.networkId !== networkId) {
      throw typedError("E_GROUP_UNKNOWN", FEED_MESSAGES.E_GROUP_UNKNOWN);
    }
    const rows = await this.posts.find({ originNetworkId: networkId, groupId });
    return { group: { _id: group._id, name: group.name }, posts: await this.#ordered(rows, networkId) };
  }

  /**
   * Ranked section read (ac-2): prominence order from the ranking module,
   * recomputed over the capped window. The result is ordered posts only —
   * no scores, no counters, no vote arithmetic ever reaches the client.
   */
  async ranked({ accessToken } = {}) {
    const networkId = await this.#originOf(accessToken);
    const candidates = await this.posts.find({ originNetworkId: networkId });
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
    const networkId = await this.#originOf(accessToken);
    const q = typeof query === "string" ? query.trim() : "";
    if (q.length === 0) {
      throw typedError("E_SEARCH_QUERY_REQUIRED", FEED_MESSAGES.E_SEARCH_QUERY_REQUIRED);
    }
    const needle = q.toLowerCase();
    const rows = await this.posts.find({ originNetworkId: networkId });
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
    return this.media.withMediaMeta(attributed, networkId);
  }

  /**
   * Attribution (PORCH-034): every member post view carries the author's
   * family-facing name, resolved at READ time against the origin's active
   * membership — never a frozen copy on the post document. A DID that holds
   * no active membership at the origin renders the plain nameless fallback
   * (names render for network members only).
   */
  async #withAttribution(views, networkId) {
    const names = await this.membership.attributionNames({ networkId, dids: views.map((view) => view.authorId) });
    return views.map((view) => ({ ...view, authorName: names.get(String(view.authorId)) ?? null }));
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

  async #originOf(accessToken) {
    if (!accessToken) {
      throw typedError("E_MUST_SIGN_IN", FEED_MESSAGES.E_MUST_SIGN_IN);
    }
    const perimeter = await this.membership.verifyAccessToken(accessToken, { surface: "feed" });
    if (!perimeter) {
      throw typedError("E_NOT_PERMITTED", FEED_MESSAGES.E_NOT_PERMITTED);
    }
    return perimeter.membership.networkId;
  }
}

export default FeedService;