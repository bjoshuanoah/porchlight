import { logAuthFailure } from "@porchlight/shared";
import { NetworkService } from "./services/network.service.js";
import { InviteService } from "./services/invite.service.js";
import { MembershipService } from "./services/membership.service.js";
import { QuotaService } from "./services/quota.service.js";
import { AuditService } from "./services/audit.service.js";
import { PostService } from "./services/post.service.js";
import { InteractionService } from "./services/interaction.service.js";
import { NotificationService } from "./services/notification.service.js";
import { RealtimeService, createMemoryEventPlane } from "./services/realtime.service.js";
import { GroupService } from "./services/group.service.js";
import { RankingService, normalizeRankingConfig } from "./services/ranking.service.js";
import { FeedService } from "./services/feed.service.js";
import { MediaService } from "./services/media.service.js";
import { LinkPreviewService } from "./services/link-preview.service.js";
import { ExportService } from "./services/export.service.js";
import { AlbumService } from "./services/album.service.js";
import { createMemoryMediaStore, createFileMediaStore, nodeDiskProbe } from "./services/media.store.js";
import { SocialBootstrapController } from "./controllers/social-bootstrap.controller.js";
import { ContentController } from "./controllers/content.controller.js";
import { FeedController } from "./controllers/feed.controller.js";
import { MembershipController } from "./controllers/membership.controller.js";
import { ConsoleController } from "./controllers/console.controller.js";
import { GroupsController } from "./controllers/groups.controller.js";
import { MediaController } from "./controllers/media.controller.js";
import { AlbumController } from "./controllers/album.controller.js";
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
 *   memberNames?: (dids: string[]) => Promise<Array<{ did: string, displayName: string | null }>>,
 *     Identity-plane name resolver for the owner's member directory
 *     (PORCH-029) — wired by apps/server from the identity account rows.
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
  const reactions = collection("reactions");
  const votes = collection("votes");
  const notifications = collection("notifications");
  const derivedData = collection("derived_data");
  const groups = collection("groups");
  const mediaUploads = collection("media_uploads");
  const mediaAssets = collection("media_assets");
  // Link previews (PORCH-052): per-attach reference rows + the URL-level
  // metadata cache (quantity-only, no engagement data).
  const linkPreviews = collection("link_previews");
  const linkPreviewCache = collection("link_preview_cache");

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
    audit,
  });
  const quotaService = new QuotaService({ artifacts, networks, audit });
  const groupService = new GroupService({ groups, memberships, membership: membershipService });
  const notificationService = new NotificationService({ notifications, membership: membershipService });
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
    replayHours: options.realtime?.replayHours ?? 24,
  });
  // Media pipeline (PORCH-008): the blob store is content-addressed —
  // filesystem-backed for the real hub (mediaRoot), memory for tests and
  // daemon-less runs. The disk probe reads the live filesystem unless a
  // test injects its own. The rendition ladder rungs (PORCH-044) are
  // owner-readable configuration forwarded from the hub config.
  const mediaConfig = options.media ?? {};
  const blobs = mediaConfig.store ?? (mediaConfig.mediaRoot ? createFileMediaStore(mediaConfig.mediaRoot) : createMemoryMediaStore());
  const diskProbe = mediaConfig.diskProbe ?? (() => {
    const root = mediaConfig.mediaRoot;
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
  });
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
  });
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
    previews: linkPreviewService,
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
    media: mediaService,
    postsService: postService,
    audit,
  });

  const controllers = {
    bootstrap: new SocialBootstrapController(networkService, inviteService, membershipService, bootstrapLedger, options.mintOwnerDeviceLink ?? null),
    content: new ContentController({ posts: postService, interactions: interactionService, notifications: notificationService, realtime: realtimeService, previews: linkPreviewService }),
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
      system: options.system ?? null,
      hubUrl: options.hubUrl ?? null,
      log: options.log ?? null,
    }),
    media: new MediaController({ media: mediaService, export: exportService }),
    albums: new AlbumController({ albums: albumService }),
    groups: new GroupsController({
      groups: groupService,
      membership: membershipService,
      audit: auditService,
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
    realtimeService,
    rankingService,
    feedService,
    mediaService,
    linkPreviewService,
    exportService,
    albumService,
    controllers,
    api: createSocialRouter(controllers),
  };
}

export default assembleSocialModule;