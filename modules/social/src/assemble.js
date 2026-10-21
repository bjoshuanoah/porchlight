import { logAuthFailure } from "@porchlight/shared";
import { NetworkService } from "./services/network.service.js";
import { InviteService } from "./services/invite.service.js";
import { MembershipService } from "./services/membership.service.js";
import { QuotaService } from "./services/quota.service.js";
import { AuditService } from "./services/audit.service.js";
import { PostService } from "./services/post.service.js";
import { InteractionService } from "./services/interaction.service.js";
import { EmojiUsageService } from "./services/usage.service.js";
import { NotificationService } from "./services/notification.service.js";
import { PushService } from "./services/push.service.js";
import { RealtimeService, createMemoryEventPlane } from "./services/realtime.service.js";
import { GroupService } from "./services/group.service.js";
import { RankingService, normalizeRankingConfig } from "./services/ranking.service.js";
import { FeedService } from "./services/feed.service.js";
import { MediaService } from "./services/media.service.js";
import { LinkPreviewService } from "./services/link-preview.service.js";
import { ExportService } from "./services/export.service.js";
import { AlbumService } from "./services/album.service.js";
import { BulkOriginalService } from "./services/bulk-original.service.js";
import { MemberAdminService } from "./services/member-admin.service.js";
import { LifecycleService } from "./services/lifecycle.service.js";
import { createMemoryMediaStore, createRelocatableMediaStore, nodeDiskProbe } from "./services/media.store.js";
import { MediaVolumeService } from "./services/media.volume.js";
import { SocialBootstrapController } from "./controllers/social-bootstrap.controller.js";
import { ContentController } from "./controllers/content.controller.js";
import { FeedController } from "./controllers/feed.controller.js";
import { MembershipController } from "./controllers/membership.controller.js";
import { ConsoleController } from "./controllers/console.controller.js";
import { GroupsController } from "./controllers/groups.controller.js";
import { MediaController } from "./controllers/media.controller.js";
import { AlbumController } from "./controllers/album.controller.js";
import { BulkOriginalController } from "./controllers/bulk-original.controller.js";
import { PushController } from "./controllers/push.controller.js";
import { OgController } from "./controllers/og.controller.js";
import { OgService } from "./services/og.service.js";
import { createSocialRouter } from "./routes.js";

/**
 * Social module assembly. Builds the full route → controller → service →
 * model path from an injected domain store — the same pure-DI shape
 * assembleIdentityModule uses. The social domain owns every social
 * collection; identity is referenced only by DID through the injected
 * verifier callback (`options.verifyMemberIdToken`, wired by apps/server
 * from the identity module's session lookup — social imports no identity
 * source, CI-enforced).
 *
 * @param {import("@porchlight/shared").StoreLike} store
 * @param {{
 *   hubUrl?: () => string | null,
 *   ledger?: {
 *     record: (step: string, detail?: object) => Promise<void>,
 *     steps?: () => Promise<{ account?: { status: string }, network?: { status: string }, invite?: { status: string }, quota?: { status: string } }>,
 *   },
 *   system?: {
 *     release: { service: string, version: string | null },
 *     launch: () => Promise<{ resumable: boolean, lastError: string | null, steps: Record<string, { status: string }>, diagnostics: Array<{ at: string, source: string, message: string }> }>,
 *   },
 *   verifyMemberIdToken?: (idToken: string | null) => Promise<{ did: string } | null>,
 *   registeredDeviceKey?: (did: string, deviceId: string) => Promise<{ publicKeyJwk: object } | null>,
 *   memberNames?: (dids: string[]) => Promise<Array<{ did: string, displayName: string | null, avatar: { header: object, chooser: object } | null }>>,
 *     Identity-plane name resolver for the owner's member directory
 *     (PORCH-029) — wired by apps/server from the identity account rows;
 *     each row carries the member's avatar metas beside the name
 *     (PORCH-070), passed through to social read surfaces verbatim.
 *   purgeAvatar?: (did: string) => Promise<{ removed: number }>,
 *     Identity-plane avatar retire for the member purge cascade (PORCH-070)
 *     — wired by apps/server from the identity account service. Social calls
 *     it once per member purge, after the media store sweep; a failure
 *     never aborts the purge and is recorded in the audit detail
 *     (`avatarRetired: false`). Optional: absent when identity serving is
 *     off or the deployment carries no avatar plane.
 *   mintOwnerDeviceLink?: (did: string) => Promise<{ grantId: string, token: string, expiresAt: string }>,
 *     Identity-plane device-link mint for the owner-bind handoff (PORCH-031) —
 *     wired by apps/server from the identity device service; social imports no
 *     identity source, CI-enforced. Absent when identity serving is off.
 *   log?: ((line: string) => void) | null,
 *     Auth-failure capture sink (PORCH-019); defaults to console.log (the
 *     hub supervisor pipes it into logs/hub.log).
 *   rankingConfig?: object,
 *   media?: {
 *     mediaRoot?: string,
 *     store?: { put: (key: string, bytes: Buffer) => Promise<string>, get: (key: string) => Promise<Buffer | null>, has: (key: string) => Promise<boolean>, delete: (key: string) => Promise<boolean> },
 *     diskProbe?: () => Promise<{ totalBytes: number, freeBytes: number }>,
 *     softUsedRatio?: number,
 *     hardUsedRatio?: number,
 *     chunkSize?: number,
 *     renditions?: { image?: Record<string, number>, video?: Record<string, number> },
 *       The rendition ladder rungs (PORCH-044), forwarded from the hub
 *       config (owner-readable configuration values, packages/shared).
 *   },
 *   realtime?: {
 *     plane?: object,
 *       PORCH-047: the injected event plane for live fan-out + the replay
 *       window (Redis-backed in the hub runtime, apps/server); defaults
 *       to the in-memory plane (tests, daemon-less runs).
 *     replayHours?: number,
 *       The bounded replay window behind the REST catch-up (24h, config
 *       value `realtime.replayHours`, packages/shared).
 *   },
 *   lifecycle?: {
 *     PORCH-093: the day-30 hard-purge reaper's arm settings. Tests pass
 *     timer: null (arm nothing; they call sweep directly); the hub default
 *     arms the idempotent sweep daily [Assumed: daily, build confirm].
 *     sweepIntervalMs?: number,
 *     timer?: { setTimeout: Function, clearTimeout: Function } | null,
 *   },
 *   push?: {
 *     PORCH-059: the Web Push transport (identity-scoped subscriptions +
 *     hub-enforced member settings).
 *     vapid?: { publicKey: string, privateKey: string, subject: string } | null,
 *       The hub's VAPID material, generated at first run by the runtime
 *       setup and held in hub server state (never committed); absent
 *       material only skips sending (log-only).
 *     sender?: ({ statusCode: number }) => Promise<unknown>,
 *       Injected send transport (tests run a local capture server or a
 *       stub); defaults to the web-push Push API client (aes128gcm).
 *   },
 *   groupAvatar?: {
 *     PORCH-088: the group-avatar write path — the identity plane's
 *     member-avatar ingest treatment (deterministic square crop then
 *     compression, geometry stamps, no rectangular original retained)
 *     over the media pipeline's content-addressed blob store. Both wired
 *     by apps/server from the identity module's public entry; social
 *     imports no identity source, CI-enforced. Absent → the group avatar
 *     write and serving refuse plainly (never a silent no-op).
 *     blobs?: { put, get, has, delete } | null,
 *       The content-addressed blob store (the media pipeline's store).
 *     treatImage?: (bytes: Buffer, contentType: string) =>
 *       Promise<Array<{ kind, width, height, contentType, bytes }>> | null,
 *       The member-avatar ingest treatment (identity plane's function of
 *       record, avatar.treatment).
 *   },
 * }} [options]
 */
export function assembleSocialModule(store, options = {}) {
  const ledger = options.ledger ?? { record: async () => {} };
  // Bootstrap-era gating rides the ledger: `steps` reports each bootstrap
  // step's system-ledger status; absent → fail-closed (era shut).
  const bootstrapLedger = { ...ledger, steps: options.ledger?.steps ?? null };
  const collection = store.collection.bind(store);
  const networks = collection("networks");
  const invites = collection("invites");
  const memberships = collection("memberships");
  const membershipSessions = collection("membership_sessions");
  const deviceKeys = collection("device_keys");
  const artifacts = collection("artifacts");
  const auditEvents = collection("audit_events");
  const posts = collection("posts");
  const comments = collection("comments");
  // Content lifecycle (PORCH-093): the tombstone of record — one row per
  // lifecycle delete riding the restore window to its one-time hard purge.
  const tombstones = collection("tombstones");
  const reactions = collection("reactions");
  const votes = collection("votes");
  // Emoji usage memory (PORCH-120): one row per (memberDid, emoji) — the
  // account-level Frequently Used record, incremented by the reaction add
  // path and read through the member's own usage route only.
  const emojiUsage = collection("emoji_usage");
  const notifications = collection("notifications");
  const derivedData = collection("derived_data");
  const groups = collection("groups");
  const mediaUploads = collection("media_uploads");
  const mediaAssets = collection("media_assets");
  // PORCH-054: the served-root history markers — the record that a
  // configured root is known-good for this hub (ready-and-waiting's
  // poll-and-recover distinguishes itself from the five-check refusal
  // through exactly this marker).
  const mediaVolumeMarkers = collection("media_volume_markers");
  // Link previews (PORCH-052): per-attach reference rows + the URL-level
  // metadata cache (quantity-only, no engagement data).
  const linkPreviews = collection("link_previews");
  const linkPreviewCache = collection("link_preview_cache");
  // Device notifications (PORCH-059): identity-scoped push subscriptions +
  // the hub-enforced member settings (read at send time, never cached).
  const pushSubscriptions = collection("push_subscriptions");
  const pushSettings = collection("push_settings");
  // OG unfurl images (PORCH-079): the composed-image cache's mapping rows
  // (inputKey → content-addressed blob key), the same derived-ephemeral
  // class as the URL-level link-preview cache (never a models schema).
  const ogImages = collection("og_images");

  const auditService = new AuditService(auditEvents, ledger);
  const audit = auditService.recorderFor(null);
  const networkService = new NetworkService(networks);
  const inviteService = new InviteService(invites);
  const membershipService = new MembershipService({
    memberships,
    membershipSessions,
    deviceKeys,
    invites: inviteService,
    verifyMemberIdToken: options.verifyMemberIdToken ?? (async () => null),
    registeredDeviceKey: options.registeredDeviceKey ?? null,
    // PORCH-029: identity-plane name resolver for the member directory —
    // DIDs in, display names out; wired by apps/server from the account rows.
    memberNames: options.memberNames ?? null,
    // PORCH-019: member surfaces' 401 capture rides the shared sink
    // (default console.log — the supervisor pipes it into logs/hub.log).
    authFailureSink: (event) => logAuthFailure(event, options.log ?? undefined),
    networks,
    // PORCH-047: the real-time surface closes the revoked member's live
    // subscriptions in the same write that kills the sessions (late-bound
    // ref — the realtime service is assembled after the membership service).
    onRevoked: (event) => realtimeService?.killMembership(event.membershipId),
    // PORCH-059: the push surface notifies the owner and delegates in the
    // same write a membership lands (late-bound ref — the push service is
    // assembled after the membership service).
    onJoined: (event) => pushService?.notifyNewMember(event),
    audit,
  });
  const quotaService = new QuotaService({ artifacts, networks, audit });
  // Device notifications (PORCH-059): the Web Push send pipeline. The
  // VAPID material is injected by the hub runtime (generated at first run
  // by the runtime setup, held in hub server state — never committed);
  // absent material only skips sending (log-only), it never breaks writes.
  // The sender is injectable: tests run a local capture server (or a stub);
  // production defaults to the web-push Push API client (aes128gcm).
  const pushService = new PushService({
    subscriptions: pushSubscriptions,
    settings: pushSettings,
    memberships,
    networks,
    membership: membershipService,
    // PORCH-088: the per-group preference PUT validates every entry
    // against the member's LIVE group membership.
    groups,
    vapid: options.push?.vapid ?? null,
    sender: options.push?.sender ?? null,
    log: options.log ?? null,
  });
  const notificationService = new NotificationService({ notifications, membership: membershipService, push: pushService, groups });
  // Real-time event delivery (PORCH-047): the event plane is injected by
  // the hub runtime (Redis-backed fan-out + replay window) and defaults to
  // the in-memory plane (tests, daemon-less runs). The service needs only
  // the membership perimeter (subscribe/catch-up verification) and is
  // constructed before the write services so the injection is live from
  // the first write; the revocation kill rides the membership service
  // through the same late-bound ref (membership assembles first).
  const realtimeService = new RealtimeService({
    membership: membershipService,
    plane: options.realtime?.plane ?? createMemoryEventPlane(),
    // PORCH-068: the private-group event gate resolves the group's live
    // roster at delivery/replay time (member-added events reach new
    // members from their add onward).
    groups,
    // PORCH-088: hard-deleted posts leave the replay window immediately.
    posts,
    replayHours: options.realtime?.replayHours ?? 24,
  });
  // Media pipeline (PORCH-008): the blob store is content-addressed —
  // filesystem-backed for the real hub at the configured media root
  // (PORCH-054: re-pointable at runtime, never re-homed), memory for
  // tests and daemon-less runs. The disk probe reads the live filesystem
  // unless a test injects its own; it follows the CURRENT root so the
  // guard rides the same volume the pipeline writes to. The rendition
  // ladder rungs (PORCH-044) are owner-readable configuration forwarded
  // from the hub config.
  const mediaConfig = options.media ?? {};
  const relocatable = !mediaConfig.store && Boolean(mediaConfig.mediaRoot);
  const blobs = relocatable
    ? createRelocatableMediaStore(mediaConfig.mediaRoot)
    : (mediaConfig.store ?? createMemoryMediaStore());
  // Group containers (PORCH-030) + the group settings' write paths
  // (PORCH-088): the group-avatar bytes share the media pipeline's
  // content-addressed blob store (the same media root), and the identity
  // plane's member-avatar ingest treatment arrives through the hub
  // assembly's injected callback (social imports no identity source,
  // CI-enforced; absent wiring refuses plainly, never a silent no-op).
  // The menu contract's resolved per-group notification state reads the
  // persisted settings row at read time through the push service's
  // adapter — late-bound (the push service assembles just below).
  const groupService = new GroupService({
    groups,
    memberships,
    membership: membershipService,
    blobs: options.groupAvatar?.blobs ?? blobs,
    treatImage: options.groupAvatar?.treatImage ?? null,
    push: {
      resolveGroupPreference: ({ did, groupId }) => pushService.resolveGroupPreference({ did, groupId }),
    },
  });
  const volumeService = new MediaVolumeService(
    { markers: mediaVolumeMarkers, uploads: mediaUploads, blobs },
    {
      root: relocatable ? mediaConfig.mediaRoot : null,
      rootIsDefault: relocatable ? (mediaConfig.mediaRootIsDefault ?? false) : false,
      persistRoot: relocatable ? (mediaConfig.persistRoot ?? null) : null,
      pollIntervalMs: mediaConfig.volumePollIntervalMs ?? 10_000,
      fs: mediaConfig.volumeFs ?? null,
      timer: mediaConfig.volumeTimer ?? null,
      relocatable,
      // The five-check startup gate (PORCH-054 ac-2) runs now, from the
      // constructor's gatePromise: media ingest/serving await the settled
      // gate while auth, timelines, and chat come up untouched.
    },
  );
  const diskProbe = mediaConfig.diskProbe ?? (() => {
    const root = volumeService.root;
    return root ? nodeDiskProbe(root) : Promise.resolve({ totalBytes: 0, freeBytes: 0 });
  });
  const mediaService = new MediaService(
    {
      uploads: mediaUploads,
      assets: mediaAssets,
      artifacts,
      membership: membershipService,
      quota: quotaService,
      blobs,
      diskProbe,
      audit,
      realtime: realtimeService,
      volume: volumeService,
      tombstones,
    },
    {
      softUsedRatio: mediaConfig.softUsedRatio,
      hardUsedRatio: mediaConfig.hardUsedRatio,
      chunkSize: mediaConfig.chunkSize,
      renditionRungs: mediaConfig.renditions,
    },
  );
  const linkPreviewService = new LinkPreviewService(
    {
      previews: linkPreviews,
      cache: linkPreviewCache,
      assets: mediaAssets,
      artifacts,
      membership: membershipService,
      media: mediaService,
      quota: quotaService,
      audit,
      realtime: realtimeService,
    },
    {
      // Tests inject their own fetch + DNS resolver + bounds; production
      // defaults to global fetch + node:dns (modules/social, no CI network).
      fetch: options.previews?.fetch ?? null,
      resolveHost: options.previews?.resolveHost ?? null,
      timeoutMs: options.previews?.timeoutMs,
      maxRedirects: options.previews?.maxRedirects,
      maxMetadataBytes: options.previews?.maxMetadataBytes,
      maxImageBytes: options.previews?.maxImageBytes,
    },
  );
  const rankingService = new RankingService({ config: options.rankingConfig ? normalizeRankingConfig(options.rankingConfig) : undefined });
  const feedService = new FeedService({
    posts,
    derivedData,
    groups,
    membership: membershipService,
    ranking: rankingService,
    media: mediaService,
    comments,
    reactions,
    // PORCH-103: the votes collection behind the viewer's own effective
    // vote (`myVote`) on every feed-served card.
    votes,
    previews: linkPreviewService,
  });
  const postService = new PostService({
    posts,
    comments,
    reactions,
    votes,
    notifications,
    derivedData,
    artifacts,
    groups,
    membership: membershipService,
    media: mediaService,
    audit,
    realtime: realtimeService,
    previews: linkPreviewService,
    push: pushService,
    // PORCH-081: the feed's timeline-shaped decoration for post.created
    // envelopes (the arriving card renders exactly what a timeline read
    // row renders — no follow-up read).
    feed: feedService,
    tombstones,
  });
  // Emoji usage memory (PORCH-120): constructed before the interaction
  // service — the reaction add path records into it, the usage read route
  // serves from it.
  const emojiUsageService = new EmojiUsageService({ emojiUsage, membership: membershipService });
  const interactionService = new InteractionService({
    posts,
    comments,
    reactions,
    votes,
    membership: membershipService,
    notifications: notificationService,
    audit,
    realtime: realtimeService,
    previews: linkPreviewService,
    push: pushService,
    groups,
    tombstones,
    notificationRows: notifications,
    emojiUsage: emojiUsageService,
  });
  // Content lifecycle (PORCH-093): the restore + day-30 reaper half. The
  // write services own the delete-side tombstone writes; this service owns
  // the re-materializing restore (owner-console write) and the scheduled
  // hard-purge sweep ([Assumed] daily, armed below unless a test disables
  // it). The re-materialization needs the same collections the cascade
  // removed — the link-preview record rows ride the preview service's
  // collection, the og:image assets the pipeline's.
  const lifecycleService = new LifecycleService({
    tombstones,
    posts,
    comments,
    reactions,
    votes,
    notifications,
    derivedData,
    assets: mediaAssets,
    artifacts,
    membership: membershipService,
    media: mediaService,
    previews: linkPreviewService,
    audit,
    realtime: realtimeService,
    feed: feedService,
    groups,
  });
  // Late-bound write services (the same late-binding the revocation kill
  // rides): a restored subject's updated envelope carries the same
  // decorated view the creation events carry.
  lifecycleService.bindServices({ postService, interactions: interactionService });
  // The reaper arms at assemble ([Assumed] daily sweep) — the injectable
  // timer seam (tests pass timer: null to arm nothing; they call sweep
  // directly). The armed handle never holds the process open.
  lifecycleService.start({
    sweepIntervalMs: options.lifecycle?.sweepIntervalMs ?? 24 * 60 * 60 * 1000,
    timer: options.lifecycle?.timer ?? null,
  });
  const exportService = new ExportService({
    posts,
    comments,
    reactions,
    assets: mediaAssets,
    blobs,
    membership: membershipService,
    audit,
  });
  // Albums (PORCH-013): derived-artifact-class memberships keyed by original
  // post id; shares the transactional cascade mechanism and the media
  // pipeline's serve/quota paths.
  const albumService = new AlbumService({
    derivedData,
    posts,
    membership: membershipService,
    // PORCH-103: the votes collection behind the album card's `myVote`.
    votes,
    media: mediaService,
    postsService: postService,
    audit,
    groups,
  });
  // Bulk original download (PORCH-083): the set-scoped convenience zip on
  // the audited original path — album and multi-image post sets stream as
  // one archive of original bytes (export's no-staging streaming pattern;
  // distinct from the signed archive export, which stays untouched).
  const bulkOriginalService = new BulkOriginalService({
    membership: membershipService,
    albums: albumService,
    posts: postService,
    assets: mediaAssets,
    blobs,
    volume: volumeService,
    audit,
  });
  // Member administration (PORCH-053): the owner-only permanent deletion —
  // the typed-confirmation gate plus the sovereignty purge (content sweep,
  // media store cascade) over the same membership revocation path.
  const memberAdminService = new MemberAdminService({
    memberships,
    membership: membershipService,
    postsService: postService,
    media: mediaService,
    memberNames: options.memberNames ?? null,
    // PORCH-070 purge cascade: the identity-plane avatar rendition retire,
    // wired from the account service by apps/server.
    purgeAvatar: options.purgeAvatar ?? null,
    audit,
  });
  // OG unfurl images (PORCH-079): the composed, cached template frames for
  // shared post and invite links. Composited from the bundled base artwork +
  // bundled Roboto face (glyph outlines — no host font dependency); the
  // cache rides the pipeline's content-addressed blob store, so the og
  // surface shares the media root and its volume readiness pauses it like
  // every other media surface. Content-free by construction (ac-5): the
  // composer reads only the origin network and the entity's content version.
  const ogService = new OgService(
    { posts, invites, networks, ogImages, blobs },
    { log: options.log ?? null },
  );

  const controllers = {
    bootstrap: new SocialBootstrapController(networkService, inviteService, membershipService, bootstrapLedger, options.mintOwnerDeviceLink ?? null),
    content: new ContentController({ posts: postService, interactions: interactionService, notifications: notificationService, realtime: realtimeService, previews: linkPreviewService, usage: emojiUsageService }),
    feed: new FeedController({ feed: feedService }),
    membership: new MembershipController(membershipService, networkService, options.log ?? null),
    console: new ConsoleController({
      networks: networkService,
      invites: inviteService,
      membership: membershipService,
      quota: quotaService,
      audit: auditService,
      groups: groupService,
      ranking: rankingService,
      media: mediaService,
      memberAdmin: memberAdminService,
      lifecycle: lifecycleService,
      system: options.system ?? null,
      hubUrl: options.hubUrl ?? null,
      log: options.log ?? null,
    }),
    media: new MediaController({ media: mediaService, export: exportService }),
    albums: new AlbumController({ albums: albumService }),
    originals: new BulkOriginalController({ originals: bulkOriginalService }),
    push: new PushController({ push: pushService }),
    og: new OgController(ogService, options.log ?? null),
    groups: new GroupsController({
      groups: groupService,
      membership: membershipService,
      audit: auditService,
      // PORCH-088: the owner post-removal's service — the moderation write
      // lives where the deletion cascade lives (the post service).
      postsService: postService,
      log: options.log ?? null,
    }),
  };

  return {
    networkService,
    inviteService,
    membershipService,
    quotaService,
    auditService,
    groupService,
    postService,
    interactionService,
    notificationService,
    pushService,
    realtimeService,
    rankingService,
    feedService,
    mediaService,
    mediaVolume: volumeService,
    // PORCH-070: the pipeline's blob store, late-bound by the hub router to
    // the identity avatar plane — avatar bytes share the media root.
    blobs,
    linkPreviewService,
    exportService,
    albumService,
    bulkOriginalService,
    memberAdminService,
    lifecycleService,
    ogService,
    controllers,
    api: createSocialRouter(controllers),
  };
}

export default assembleSocialModule;