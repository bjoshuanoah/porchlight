import { typedError } from "./post.service.js";
import { InteractionService } from "./interaction.service.js";
import { purgeAtFor } from "./lifecycle.time.js";

export { purgeAtFor };

/** Plain-language lifecycle failures for member/owner clients. */
export const LIFECYCLE_MESSAGES = {
  E_TOMBSTONE_NOT_FOUND: "That tombstone doesn't exist in this network.",
  E_TOMBSTONE_PURGED: "The restore window has closed — this deleted content was purged.",
  E_TOMBSTONE_MATERIALIZED: "That content was already restored.",
  E_TOMBSTONE_ORPHANED: "The post this comment belonged to was deleted too — restore the post instead.",
  E_RESTORE_NOT_PERMITTED: "Restoring deleted content belongs to the network owner.",
  E_RESTORE_SIGN_IN: "Sign in to your membership before restoring content.",
};

/**
 * The restore window of record (Brian, Oct 16, 2026) lives in
 * lifecycle.time.js (RESTORE_WINDOW_MS / purgeAtFor) — shared by the
 * write services and this service through the leaf module.
 */

/**
 * Lifecycle service (PORCH-093). Owns the restore-side half of the post
 * and comment lifecycle: the re-materializing restore (owner-console
 * write), the day-30 one-time hard-purge reaper (scheduled sweep), and the
 * tombstone collection's service-level reads. The delete-side tombstone
 * writes live where the cascade lives (PostService / InteractionService);
 * this service never deletes content — it only destroys held originals at
 * purge time and re-materializes captured rows at restore time.
 *
 * Authority and containment: every path resolves within ONE origin
 * network (the token's perimeter; the tombstone's originNetworkId must
 * equal it) and never reads or resolves across origins.
 *
 * The reaper rides the house scheduled-pass pattern: an injectable-clock,
 * idempotent sweep the assemble layer arms daily ([Assumed] daily sweep,
 * build confirm) through an injectable timer (the MediaVolumeService poll
 * seam); every sweep is audited per tombstone claimed.
 */
export class LifecycleService {
  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} deps.tombstones
   * @param {import("@porchlight/shared").CollectionLike} deps.posts
   * @param {import("@porchlight/shared").CollectionLike} deps.comments
   * @param {import("@porchlight/shared").CollectionLike} deps.reactions
   * @param {import("@porchlight/shared").CollectionLike} deps.votes
   * @param {import("@porchlight/shared").CollectionLike} deps.notifications
   * @param {import("@porchlight/shared").CollectionLike} deps.derivedData
   * @param {import("@porchlight/shared").CollectionLike} deps.assets
   *   The media pipeline's asset rows (restore re-inserts cascade-captured
   *   link-preview og:image assets; purge removes held originals).
   * @param {import("@porchlight/shared").CollectionLike} deps.artifacts
   * @param {import("./membership.service.js").MembershipService} deps.membership
   * @param {import("./media.service.js").MediaService} [deps.media]
   *   The media pipeline: held-original destruction at purge time and
   *   on-demand rendition regeneration at restore time.
   * @param {import("./link-preview.service.js").LinkPreviewService} [deps.previews]
   *   The preview read decoration for restored rows (absent on bare fixtures).
   * @param {(action: string, payload?: object) => Promise<void>} [deps.audit]
   * @param {import("./realtime.service.js").RealtimeService} [deps.realtime]
   *   A restored subject re-enters the live rooms through post.updated /
   *   comment.updated — the shipped vocabulary, ordered and idempotent.
   * @param {import("./feed.service.js").FeedService} [deps.feed]
   *   The timeline-shaped decoration for post.updated envelopes (PORCH-081).
   */
  constructor({ tombstones, posts, comments, reactions, votes, notifications, derivedData, assets, artifacts, membership, media, previews, audit, realtime, feed, groups }) {
    this.tombstones = tombstones;
    this.posts = posts;
    this.comments = comments;
    this.reactions = reactions;
    this.votes = votes;
    this.notifications = notifications;
    this.derivedData = derivedData;
    // The link-preview record rows and og:image assets captured in a
    // tombstone's cascade re-insert through the collections below.
    this.previewRows = previews?.previews ?? null;
    this.assets = assets;
    this.artifacts = artifacts;
    this.membership = membership;
    this.media = media ?? null;
    this.previews = previews ?? null;
    this.groups = groups ?? null;
    this.audit = audit ?? (async () => {});
    this.realtime = realtime ?? null;
    this.feed = feed ?? null;
    // Late-bound write services (assembled after this service): a restored
    // post's post.updated envelope carries the same timeline-shaped view a
    // timeline read serves (PORCH-081 client parity).
    this.postService = null;
    this.interactions = null;
    this.#sweepHandle = null;
    this.timer = null;
    this.sweepIntervalMs = null;
  }

  /** Non-serializable field (class private state). */
  #sweepHandle;

  /** Wire the late-bound post/interaction services (assemble-time seam). */
  bindServices({ postService = null, interactions = null } = {}) {
    this.postService = postService;
    this.interactions = interactions;
  }

  /**
   * The day-30 reaper sweep [Assumed: daily cadence, armed at assemble]:
   * every tombstone whose purgeAt has passed and whose purgedAt is still
   * null has its held originals destroyed and is then claimed (purgedAt
   * set in the same pass). The claim's equality filter (purgedAt: null)
   * makes a concurrent sweep a no-op loser — the purge runs once per
   * tombstone and retries never double-destroy (blob destruction is
   * survivor-guarded inside the media service; a re-sweep deletes nothing
   * twice). A crash between destruction and the claim re-runs the same
   * idempotent destruction on the next pass — the state never lies.
   *
   * @param {{ now?: () => Date }} [args] the injectable clock of record
   *   (every scheduled pass in this module rides it).
   */
  async sweep({ now = () => new Date() } = {}) {
    const nowIso = now().toISOString();
    const due = (await this.tombstones.find({})).filter((row) => row.purgedAt == null && row.purgeAt <= nowIso);
    let purged = 0;
    for (const tombstone of due) {
      if (this.media) {
        await this.media.purgeHeldLifecycleMedia({
          networkId: tombstone.originNetworkId,
          originalIds: tombstone.mediaOrigins ?? [],
          heldBlobKeys: tombstone.heldBlobKeys ?? [],
        });
      }
      const claim = await this.tombstones.updateOne(
        { _id: tombstone._id, purgedAt: null },
        { $set: { purgedAt: nowIso } },
      );
      if (!claim?.matchedCount) continue;
      purged += 1;
      await this.audit("lifecycle_purge", {
        networkId: tombstone.originNetworkId,
        detail: { tombstoneId: tombstone._id, subjectType: tombstone.subjectType, subjectId: tombstone.subjectId },
      });
    }
    return { purged, due: due.length };
  }

  /**
   * Restore (TS 3 lifecycle write paths): the owner-console write over a
   * tombstone. Owner-only; origin containment resolves the tombstone
   * against the token's single network. Within the window (purgedAt still
   * null) the re-materialization re-inserts EXACTLY the rows captured in
   * the cascade at delete time — subject plus every cascaded child — the
   * restore never fabricates state. Renditions regenerate on demand from
   * the held originals; a paused archive volume regenerates later (the
   * failure is recorded in the audit detail, never silent) and never
   * blocks the re-materialization itself. The tombstone leaves scope after
   * the commit; the purged tombstone refuses loudly (410 class).
   *
   * @param {{ accessToken: string, tombstoneId: string }} args
   */
  async restore({ accessToken, tombstoneId } = {}) {
    if (!accessToken) {
      throw typedError("E_RESTORE_SIGN_IN", LIFECYCLE_MESSAGES.E_RESTORE_SIGN_IN);
    }
    const perimeter = await this.membership.verifyAccessToken(accessToken, { surface: "console" });
    if (!perimeter) {
      throw typedError("E_RESTORE_NOT_PERMITTED", LIFECYCLE_MESSAGES.E_RESTORE_NOT_PERMITTED);
    }
    if (perimeter.membership.role !== "owner") {
      // Restore is owner-only and owner-console-only (PRD 3): no member,
      // delegate, or other role re-materializes deleted content.
      throw typedError("E_RESTORE_NOT_PERMITTED", LIFECYCLE_MESSAGES.E_RESTORE_NOT_PERMITTED);
    }
    const networkId = perimeter.membership.networkId;
    const tombstone = await this.tombstones.findOne({ _id: tombstoneId });
    if (!tombstone || tombstone.originNetworkId !== networkId) {
      // Containment: another origin's tombstone simply does not exist here.
      throw typedError("E_TOMBSTONE_NOT_FOUND", LIFECYCLE_MESSAGES.E_TOMBSTONE_NOT_FOUND);
    }
    if (tombstone.purgedAt) {
      // Loud refusal after the window: no partial re-materialization
      // attempt, no quiet no-op (the purged state is audit-only).
      throw typedError("E_TOMBSTONE_PURGED", LIFECYCLE_MESSAGES.E_TOMBSTONE_PURGED);
    }
    if (tombstone.subjectType === "comment") {
      // The comment's post row rides the cascade snapshot; if the post was
      // deleted after the comment was, the comment is unreachable.
      const postRow = tombstone.cascade?.post ?? null;
      const livePost = await this.posts.findOne({ _id: postRow?._id ?? "" });
      if (!livePost) {
        throw typedError("E_TOMBSTONE_ORPHANED", LIFECYCLE_MESSAGES.E_TOMBSTONE_ORPHANED);
      }
    }
    const cascade = tombstone.cascade ?? {};
    const subject = cascade.subject;
    if (!subject) {
      throw typedError("E_TOMBSTONE_NOT_FOUND", LIFECYCLE_MESSAGES.E_TOMBSTONE_NOT_FOUND);
    }
    const existing =
      tombstone.subjectType === "post"
        ? await this.posts.findOne({ _id: subject._id })
        : await this.comments.findOne({ _id: subject._id });
    if (existing) {
      throw typedError("E_TOMBSTONE_MATERIALIZED", LIFECYCLE_MESSAGES.E_TOMBSTONE_MATERIALIZED);
    }
    // Re-materialize: subject first, then the cascade children by class. A
    // mid-flight failure rolls the partial re-insertion back (the inverse
    // of the delete cascade's snapshot discipline).
    const inserted = [];
    try {
      const parts = this.#restoreParts(tombstone);
      for (const part of parts) {
        for (const row of part.rows) {
          await part.collection.insertOne(structuredClone(row));
          inserted.push({ collection: part.collection, _id: row._id });
        }
      }
    } catch (error) {
      for (const step of inserted.reverse()) {
        await step.collection.deleteOne({ _id: step._id });
      }
      throw error;
    }
    // Renditions regenerate on demand from the held originals. A paused
    // archive volume defers regeneration (recorded, silent never) — the
    // re-materialization itself is done.
    const renditionsRegenerated = [];
    const renditionFailures = [];
    for (const originalId of tombstone.mediaOrigins ?? []) {
      try {
        const rows = this.media ? await this.media.generateRenditions(originalId) : [];
        renditionsRegenerated.push(...(rows ?? []).map((row) => row._id));
      } catch (error) {
        renditionFailures.push({ originalId, code: error?.code ?? "E_RENDITION_REGENERATION_FAILED" });
      }
    }
    await this.tombstones.deleteOne({ _id: tombstone._id });
    // The restored subject re-enters every room through the shipped
    // vocabulary: post.updated / comment.updated carry the same shape the
    // creation events carry — content only, no edit- or restore-revealing
    // field anywhere.
    const networkIdOut = tombstone.originNetworkId;
    if (tombstone.subjectType === "post") {
      await this.realtime?.published({
        networkId: networkIdOut,
        type: "post.updated",
        postId: subject._id,
        groupId: subject.groupId ?? null,
        content: await this.#postUpdatedView(subject, networkIdOut),
      });
    } else {
      await this.realtime?.published({
        networkId: networkIdOut,
        type: "comment.updated",
        postId: subject.postId,
        groupId: subject.groupId ?? null,
        content: await this.#commentUpdatedView({ ...subject, groupId: subject.groupId ?? null }, networkIdOut),
      });
    }
    await this.audit("lifecycle_restore", {
      networkId: networkIdOut,
      did: perimeter.session.did,
      detail: {
        tombstoneId: tombstone._id,
        subjectType: tombstone.subjectType,
        subjectId: subject._id,
        restoredRows: inserted.length,
        renditionsRegenerated,
        renditionFailures,
      },
    });
    return {
      restored: true,
      subjectType: tombstone.subjectType,
      subjectId: subject._id,
      restoredRows: inserted.length,
      renditionsRegenerated: renditionsRegenerated.length,
      renditionFailures,
    };
  }

  /**
   * Arm the scheduled reaper ([Assumed] daily sweep). The interval and the
   * timer are injectable (build seams like the volume poll's); the armed
   * handle never holds the process open. A pass that throws never stops
   * the schedule — the next tick retries (sweeps are idempotent).
   */
  start({ sweepIntervalMs = 24 * 60 * 60 * 1000, timer = null } = {}) {
    if (this.#sweepHandle != null) return;
    this.timer = timer && typeof timer.setTimeout === "function" ? timer : null;
    this.sweepIntervalMs = sweepIntervalMs;
    this.#scheduleSweep();
  }

  /** Stop the reaper (tests / shutdown). */
  stop() {
    const clear = this.timer?.clearTimeout ?? ((h) => clearTimeout(h));
    if (this.#sweepHandle != null && typeof this.#sweepHandle === "object") {
      clear(this.#sweepHandle);
    }
    this.#sweepHandle = null;
  }

  /* Internals */

  #scheduleSweep() {
    if (this.#sweepHandle != null) return;
    const schedule = this.timer?.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    const handle = schedule(
      () => {
        this.#sweepHandle = null;
        void this.sweep().catch(() => {});
        this.#scheduleSweep();
      },
      this.sweepIntervalMs,
    );
    // Never hold the process open for the reaper.
    handle?.unref?.();
    this.#sweepHandle = handle ?? true;
  }

  /** The re-insertion plan: subject first, then every captured child class. */
  #restoreParts(tombstone) {
    const cascade = tombstone.cascade ?? {};
    const subjectCollection = tombstone.subjectType === "post" ? this.posts : this.comments;
    const parts = [{ collection: subjectCollection, rows: [cascade.subject] }];
    const classMap = [
      ["comments", this.comments],
      ["reactions", this.reactions],
      ["votes", this.votes],
      ["notifications", this.notifications],
      ["derivedData", this.derivedData],
      ["previews", this.previewRows],
      ["assets", this.assets],
      ["artifacts", this.artifacts],
    ];
    for (const [key, collection] of classMap) {
      const rows = cascade[key];
      if (collection && Array.isArray(rows) && rows.length) parts.push({ collection, rows });
    }
    return parts;
  }

  /** The post.updated view (same decorated shape the post.created rides). */
  async #postUpdatedView(post, networkId) {
    if (this.feed) {
      const [view] = await this.feed.eventViews([post], networkId);
      if (view) return view;
    }
    if (this.postService) {
      const [view] = await this.postService.memberViews([post], networkId);
      return view;
    }
    return post;
  }

  /** The comment.updated view (same decorated shape the reply.created rides). */
  async #commentUpdatedView(comment, networkId) {
    let view = InteractionService.commentView(comment);
    if (this.previews) {
      [view] = await this.previews.withViews([view], networkId);
    }
    const names = await this.membership.attributionNames({
      networkId,
      dids: [view.authorDid, ...(view.mentions ?? [])],
    });
    return {
      ...view,
      authorName: names.get(String(view.authorDid))?.name ?? null,
      authorAvatar: names.get(String(view.authorDid))?.avatar ?? null,
      mentionNames: (view.mentions ?? []).map((did) => names.get(String(did))?.name ?? null),
    };
  }
}

export default LifecycleService;