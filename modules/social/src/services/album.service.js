import { randomUUID } from "node:crypto";
import { typedError, newestFirstByActivity, postView } from "./post.service.js";
import { socialModels } from "../models.js";

/** Plain-language album-surface failures for member clients. */
export const ALBUM_MESSAGES = {
  E_MUST_SIGN_IN: "Sign in to your membership before using the albums surface.",
  E_NOT_PERMITTED: "This action is not available to you in this network.",
  E_POST_NOT_FOUND: "That post doesn't exist in this network.",
  E_ALBUM_NOT_FOUND: "That album doesn't exist in this network.",
  E_ALBUM_ITEM_NOT_FOUND: "That album item isn't in this album.",
  E_ALBUM_NAME_REQUIRED: "An album needs a name.",
  E_SIGNATURE_REQUIRED: "This write must be signed by your device key.",
};

const ALBUM_CLASS = "album_membership";

/**
 * Default album-serving rendition: albums serve the hub-generated "album"
 * rendition (PORCH-008 rendition kinds); the original-quality retrieval is
 * the explicit member action against the archive (media fidelity ruling,
 * Brian, Oct 7).
 */
export const ALBUM_DEFAULT_RENDITION = "album";

/**
 * Album service (PORCH-013). Albums are manual, deterministic organization:
 * an album is the aggregate of its member-added items — derived-artifact-
 * class records (class "album_membership" in the derived-data container)
 * keyed to the original post id, carrying the member-authored album name as
 * the searchable value. There is no separate byte-bearing album document in
 * V1; an album exists from its first item and disappears when its last
 * item's cascade removes the album's rows. All origin containment rides the
 * membership token: exactly one origin per album per the content model.
 *
 * Deletion cascade (ac-1): rows are keyed by postId, and the post deletion
 * cascade (PostService.cascadePost / memberContentSweep) removes every
 * derived-data row keyed to the post in the same transactional write — so a
 * member's deletion removes THEIR album memberships while another member's
 * rows on the same album name are untouched. Deleting a whole album
 * (member-managed cleanup) removes the album's rows for this origin in one
 * all-or-nothing write over the same transactional snapshot mechanism.
 *
 * Album serving (ac-3): the album surface composes album → items → media
 * refs and serves renditions (default kind "album"); original-quality
 * retrieval delegates to the media pipeline's explicit, audited
 * original-download action. Quota accounting rides the pipeline: rendition
 * bytes are recorded against the network's ceiling at generation; the
 * membership rows themselves are zero-byte derived artifacts that consume
 * no byte budget.
 */
export class AlbumService {
  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} deps.derivedData
   * @param {import("@porchlight/shared").CollectionLike} deps.posts
   * @param {import("./membership.service.js").MembershipService} deps.membership
   * @param {import("./media.service.js").MediaService} deps.media
   * @param {import("./post.service.js").PostService} deps.postsService
   *   borrowed only for the shared transactional cascade mechanism.
   * @param {(action: string, payload?: object) => Promise<void>} [deps.audit]
   */
  constructor({ derivedData, posts, membership, media, postsService, audit }) {
    this.derivedData = derivedData;
    this.posts = posts;
    this.membership = membership;
    this.media = media;
    this.postsService = postsService;
    this.audit = audit ?? (async () => {});
    this.models = socialModels;
  }

  /** List this origin's albums: item counts, covers, latest activity. */
  async list({ accessToken } = {}) {
    const session = await this.#requireSession(accessToken);
    const rows = await this.derivedData.find({ networkId: session.networkId, class: ALBUM_CLASS });
    const postsById = await this.#originPostsById(session.networkId);
    const albums = new Map();
    for (const row of rows) {
      const post = postsById.get(row.postId);
      if (!post) {
        continue;
      }
      const entry = this.#albumEntry(albums, row.value);
      entry.itemCount += 1;
      if (!entry.coverMediaId && (post.mediaRefs ?? []).length > 0) {
        entry.coverMediaId = post.mediaRefs[0];
      }
      const latest = post.lastActivityAt ?? post.createdAt;
      if (latest > entry.lastActivityAt) {
        entry.lastActivityAt = latest;
      }
    }
    // Deterministic order: newest album activity first, then name.
    const list = [...albums.values()].sort((a, b) => {
      if (a.lastActivityAt !== b.lastActivityAt) return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
      return a.name < b.name ? -1 : 1;
    });
    return { albums: list, did: session.did };
  }

  /** Read one album's items as member post views (origin-contained). */
  async get({ accessToken, name } = {}) {
    const session = await this.#requireSession(accessToken);
    const normalized = this.#normalizeName(name);
    const rows = await this.#albumRows(session.networkId, normalized);
    if (rows.length === 0) {
      throw typedError("E_ALBUM_NOT_FOUND", ALBUM_MESSAGES.E_ALBUM_NOT_FOUND);
    }
    const postsById = await this.#originPostsById(session.networkId);
    const items = rows.map((row) => postsById.get(row.postId)).filter((post) => post);
    newestFirstByActivity(items);
    return {
      album: { name: normalized, itemCount: items.length },
      posts: items.map((post) => postView(post)),
      did: session.did,
    };
  }

  /**
   * Add an item (ac-1): writes ONE derived-artifact-class record keyed to
   * the original post id, with the album name as the member-authored value
   * (verbatim — the plain-text search index reads it). The canonical write
   * payload is constructed here and must verify against the origin's
   * enrolled device key; a write claiming another origin never resolves
   * because the token IS the origin. Idempotent: re-adding the same post
   * resolves the existing row (no duplicate memberships).
   */
  async addItem({ accessToken, name, postId, signature } = {}) {
    const session = await this.#requireSession(accessToken);
    const normalized = this.#normalizeName(name);
    const targetId = typeof postId === "string" ? postId : null;
    await this.#verifyWrite({
      session,
      payload: { kind: "album.add", networkId: session.networkId, postId: targetId, album: normalized },
      signature,
    });
    const post = await this.#originPost(targetId, session.networkId);
    if (!post) {
      throw typedError("E_POST_NOT_FOUND", ALBUM_MESSAGES.E_POST_NOT_FOUND);
    }
    const existing = await this.derivedData.findOne({
      networkId: session.networkId,
      postId: targetId,
      class: ALBUM_CLASS,
      value: normalized,
    });
    if (existing) {
      return { album: { name: normalized }, postId: targetId, membershipId: existing._id, created: false, did: session.did };
    }
    const row = {
      _id: `dd_${randomUUID()}`,
      networkId: session.networkId,
      postId: targetId,
      class: ALBUM_CLASS,
      value: normalized,
      createdAt: new Date().toISOString(),
    };
    await this.derivedData.insertOne(row);
    await this.audit("album_item_add", {
      networkId: session.networkId,
      did: session.did,
      detail: { postId: targetId, album: normalized },
    });
    return { album: { name: normalized }, postId: targetId, membershipId: row._id, created: true, did: session.did };
  }

  /**
   * Remove one item (ac-1): deletes exactly that keyed row for this album;
   * other members' rows on the same album or other albums are untouched.
   * Device-signed like every write.
   */
  async removeItem({ accessToken, name, postId, signature } = {}) {
    const session = await this.#requireSession(accessToken);
    const normalized = this.#normalizeName(name);
    const targetId = typeof postId === "string" ? postId : null;
    await this.#verifyWrite({
      session,
      payload: { kind: "album.remove", networkId: session.networkId, postId: targetId, album: normalized },
      signature,
    });
    const post = await this.#originPost(targetId, session.networkId);
    if (!post) {
      throw typedError("E_POST_NOT_FOUND", ALBUM_MESSAGES.E_POST_NOT_FOUND);
    }
    const row = await this.derivedData.findOne({
      networkId: session.networkId,
      postId: targetId,
      class: ALBUM_CLASS,
      value: normalized,
    });
    if (!row) {
      throw typedError("E_ALBUM_ITEM_NOT_FOUND", ALBUM_MESSAGES.E_ALBUM_ITEM_NOT_FOUND);
    }
    await this.derivedData.deleteOne({ _id: row._id });
    await this.audit("album_item_remove", {
      networkId: session.networkId,
      did: session.did,
      detail: { postId: targetId, album: normalized },
    });
    return { album: { name: normalized }, postId: targetId, removed: true, did: session.did };
  }

  /**
   * Delete a whole album (member management): removes every membership row
   * for this album in the origin — and nothing else — in one all-or-nothing
   * write over the shared cascading mechanism. The keyed originals (posts
   * and their media) are untouched: memberships are derived artifacts.
   */
  async deleteAlbum({ accessToken, name, signature } = {}) {
    const session = await this.#requireSession(accessToken);
    const normalized = this.#normalizeName(name);
    await this.#verifyWrite({
      session,
      payload: { kind: "album.delete", networkId: session.networkId, album: normalized },
      signature,
    });
    const rows = await this.#albumRows(session.networkId, normalized);
    if (rows.length === 0) {
      throw typedError("E_ALBUM_NOT_FOUND", ALBUM_MESSAGES.E_ALBUM_NOT_FOUND);
    }
    await this.postsService.runTransactional([{ collection: this.derivedData, rows }]);
    await this.audit("album_delete", {
      networkId: session.networkId,
      did: session.did,
      detail: { album: normalized, itemsRemoved: rows.length },
    });
    return { album: { name: normalized }, itemsRemoved: rows.length, deleted: true, did: session.did };
  }

  /**
   * Album serving list (ac-3): one entry per distinct media of the album's
   * origin-contained posts. The DEFAULT serve target for every entry is the
   * hub-generated "album" rendition; the original is never listed as the
   * default — its retrieval is the explicit per-media action (audited
   * original_download in the media pipeline).
   */
  async listMedia({ accessToken, name } = {}) {
    const session = await this.#requireSession(accessToken);
    const normalized = this.#normalizeName(name);
    const rows = await this.#albumRows(session.networkId, normalized);
    if (rows.length === 0) {
      throw typedError("E_ALBUM_NOT_FOUND", ALBUM_MESSAGES.E_ALBUM_NOT_FOUND);
    }
    const postsById = await this.#originPostsById(session.networkId);
    const seen = new Set();
    const entries = [];
    for (const row of rows) {
      const post = postsById.get(row.postId);
      if (!post) continue;
      for (const mediaId of post.mediaRefs ?? []) {
        if (typeof mediaId !== "string" || seen.has(mediaId)) continue;
        seen.add(mediaId);
        const described = await this.media.describe({ accessToken, mediaId });
        entries.push({
          mediaId: described.mediaId,
          contentType: described.contentType,
          renditionKinds: described.renditions,
          defaultRendition: ALBUM_DEFAULT_RENDITION,
        });
      }
    }
    return { album: { name: normalized }, media: entries, did: session.did };
  }

  /**
   * Serve a rendition of album media (ac-3): the media must belong to a
   * post that is an item of THIS album, beyond the network containment the
   * media pipeline already enforces. Delegation keeps the media pipeline's
   * single serve path (bytes, content type, integrity headers).
   */
  async serveRendition({ accessToken, name, mediaId, renditionKind } = {}) {
    await this.#albumMediaContainment({ accessToken, name, mediaId });
    return this.media.serveRendition({ accessToken, mediaId, renditionKind });
  }

  /**
   * Original-quality retrieval for album media (ac-3): the explicit member
   * action against the archive — signed in, album-contained, and audited by
   * the media pipeline (original_download). Never the default serve path.
   */
  async serveOriginal({ accessToken, name, mediaId } = {}) {
    await this.#albumMediaContainment({ accessToken, name, mediaId });
    return this.media.serveOriginal({ accessToken, mediaId });
  }

  #albumEntry(albums, name) {
    let entry = albums.get(name);
    if (!entry) {
      entry = { name, itemCount: 0, coverMediaId: null, lastActivityAt: "" };
      albums.set(name, entry);
    }
    return entry;
  }

  async #albumRows(networkId, name) {
    const rows = await this.derivedData.find({ networkId, class: ALBUM_CLASS });
    return rows.filter((row) => row.value === name);
  }

  async #originPostsById(networkId) {
    const rows = await this.posts.find({ originNetworkId: networkId });
    return new Map(rows.map((post) => [post._id, post]));
  }

  async #originPost(postId, networkId) {
    if (!postId) return null;
    const post = await this.posts.findOne({ _id: postId });
    return post && post.originNetworkId === networkId ? post : null;
  }

  #normalizeName(name) {
    const normalized = typeof name === "string" ? name.trim() : "";
    if (normalized.length === 0) {
      throw typedError("E_ALBUM_NAME_REQUIRED", ALBUM_MESSAGES.E_ALBUM_NAME_REQUIRED);
    }
    return normalized;
  }

  /**
   * Verify an actor-signed album write against the origin enrollment. The
   * payload is the canonical document constructed by THIS service — the
   * client signs exactly {kind, networkId, postId?, album} and nothing on
   * the wire can move the write to another origin (networkId comes from the
   * perimeter session, never the request body).
   */
  async #verifyWrite({ session, payload, signature }) {
    if (!signature) {
      throw typedError("E_SIGNATURE_REQUIRED", ALBUM_MESSAGES.E_SIGNATURE_REQUIRED);
    }
    await this.membership.verifyMemberWrite({
      networkId: session.networkId,
      did: session.did,
      deviceId: session.deviceId,
      payload,
      signature,
    });
  }

  async #albumMediaContainment({ accessToken, name, mediaId }) {
    const session = await this.#requireSession(accessToken);
    const normalized = this.#normalizeName(name);
    const rows = await this.#albumRows(session.networkId, normalized);
    const postIds = new Set(rows.map((row) => row.postId));
    const rowsOfPosts = await this.posts.find({ originNetworkId: session.networkId });
    const contained = rowsOfPosts.some(
      (post) => postIds.has(post._id) && (post.mediaRefs ?? []).includes(mediaId),
    );
    if (!contained) {
      // A media that is not an item of this album simply doesn't exist on
      // this album's surface — the same not-found contract as the pipeline.
      throw typedError("E_MEDIA_NOT_FOUND", "That media doesn't exist in this album.");
    }
    return session;
  }

  /** The membership token IS the perimeter (same contract as every service). */
  #requireSession(accessToken) {
    if (!accessToken) {
      throw typedError("E_MUST_SIGN_IN", ALBUM_MESSAGES.E_MUST_SIGN_IN);
    }
    return this.membership.verifyAccessToken(accessToken, { surface: "album" }).then((perimeter) => {
      if (!perimeter) {
        throw typedError("E_NOT_PERMITTED", ALBUM_MESSAGES.E_NOT_PERMITTED);
      }
      return {
        did: perimeter.session.did,
        deviceId: perimeter.session.deviceId,
        networkId: perimeter.membership.networkId,
      };
    });
  }
}

export default AlbumService;