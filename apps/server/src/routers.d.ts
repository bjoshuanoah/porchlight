declare module "@porchlight/identity" {
  export interface IdentityModule {
    api: import("express").Router;
    wellKnown: import("express").Router;
    controllers: unknown;
    signing: unknown;
    didService: {
      /** PORCH-065: the DID half of the self-reference re-point. */
      repointAllDocuments(options: { hubUrl: string }): Promise<{ repointed: number; hubUrl: string }>;
      /** PORCH-065: the status surface's residue scan. */
      staleServiceEntries(options: { hubUrl: string }): Promise<Array<{ kind: string; ref: string; endpoint: string | null }>>;
    };
    accountService: {
      /** Member identity birth at the front door (PORCH-010): DID + device binding. Required names (PORCH-024). */
      createMemberAccount(options: { firstName?: string; lastName?: string; device: { deviceId: string; label?: string | null; publicKeyJwk: Record<string, unknown> } | null }): Promise<{
        account: { _id: string; did: string; firstName: string | null; lastName: string | null; displayName: string };
        didDocument: unknown;
        registration: Record<string, unknown>;
      }>;
      /** Member display names by DID for the owner's member directory (PORCH-029); rows carry the avatar stamps (PORCH-070). */
      namesFor(dids: string[]): Promise<Array<{ did: string; displayName: string | null; avatar: Record<string, unknown> | null }>>;
      /** PORCH-138: the existing-identity resolve the grant flow rides (never a mint). */
      resolveByDid(did: string): Promise<{ did: string; displayName: string } | null>;
      /** The hub's first account (bootstrap offer row) — the hub-admin fact resolves against it. */
      get(): Promise<{ _id: string; did: string; [key: string]: unknown } | null>;
    };
    /** PORCH-138: the identity-plane family organizer (family governance ruling). */
    familyService: {
      /** The familyRef resolve of a family grant. */
      familyById(familyId: string): Promise<{ _id: string; name: string; [key: string]: unknown } | null>;
      /** The governed members a family grant resolves against. */
      familiesForMember(did: string): Promise<Array<{ _id: string; name: string; [key: string]: unknown }>>;
    };
    /** PORCH-070: the member avatar plane (service + its routes' controller). */
    avatarService: {
      /** Ingest/upload: treat hub-side and hold the per-identity pending set. */
      ingest(args: Record<string, unknown>): Promise<Record<string, unknown>>;
      /** Commit a pending set as the current avatar; prior set retires. */
      commit(args: Record<string, unknown>): Promise<Record<string, unknown>>;
      /** Clear to the no-avatar state. */
      clear(args: Record<string, unknown>): Promise<Record<string, unknown>>;
      /** Serve one rung (member-token gated; pending previews owner-only). */
      serveRung(args: Record<string, unknown>): Promise<Record<string, unknown>>;
      /** The member-purge cascade hook. */
      retireFor(did: string): Promise<{ removed: number }>;
    };
    authService: {
      /** Opaque-token session verification (identity plane, DID resolution). */
      verifyAccessToken(token: string): Promise<{ did: string; sessionId: unknown } | null>;
      /** The (did, deviceId) pair the session's own device resolves to — the pair a member-issued home write signature verifies against (PORCH-137). */
      verifyAccessTokenWithDevice(token: string | null): Promise<{ did: string; sessionId: unknown; deviceId?: string } | null>;
      /** Active device registration row for (did, deviceId) — the possession-proven public key. */
      activeDeviceRegistration(did: string, deviceId: string): Promise<{ deviceId: string; did: string; publicKeyJwk: Record<string, unknown>; [key: string]: unknown } | null>;
    };
    deviceService: import("./routes/frontdoor.routes.js").FrontDoorDeviceService;
    webfingerService: unknown;
    trustService: unknown;
    migrationService: unknown;
  }
  export function assembleIdentityModule(
    store: { collection(name: string): unknown },
    options?: { hubUrl?: () => string | null; ledger?: { record: (step: string, detail?: { detail?: string; inviteId?: string }) => Promise<void>; hubUrl?: () => string | null }; adoptionEnabled?: boolean; /** PORCH-019: auth-failure capture sink. */ log?: ((line: string) => void) | null; /** PORCH-059: the device-notifications observer (social push wiring). */ onDeviceLinkMinted?: (event: { did: string; grantId: string }) => unknown; /** PORCH-065: the consumed-grant observer (address re-point trigger; awaits the returned promise). */ onDeviceLinkConsumed?: (event: { grantId: string; did: string; purpose: string | null; serveOrigin: string | null }) => unknown; /** PORCH-070: the member avatar plane (byte store + serving verifier; null blobs refuses plainly). */ avatar?: { blobs: { put: (key: string, bytes: Buffer) => Promise<unknown>; get: (key: string) => Promise<Buffer | null>; has: (key: string) => Promise<boolean>; delete: (key: string) => Promise<boolean> } | null; verifyMemberToken?: (token: string | null) => Promise<{ did: string } | null> } },
  ): IdentityModule;
  export function createWellKnownRouter(wellKnownController: unknown): import("express").Router;
  /** PORCH-070/088: the member-avatar ingest treatment of record (the
   *  identity plane's public entry) — wired into the social module's
   *  group-avatar write path. */
  export function treatAvatar(
    bytes: Buffer,
    contentType: string,
  ): Promise<Array<{ kind: string; width: number; height: number; contentType: string; bytes: Buffer }>>;
  export class TrustService {
    /** Receiving-network verification: pinned issuer, fixed EdDSA, fail-closed kid set. */
    verifyMemberToken(
      token: string,
      options: { pinnedIssuer: string; audience: string; nonce?: string | null; pinnedKids?: string[]; transport?: unknown },
    ): Promise<{ did: string; claims: Record<string, unknown> }>;
    verifyHandoff(token: string, options: { oldIssuer: string; transport?: unknown }): Promise<{ header: unknown; payload: Record<string, unknown> }>;
  }
}

declare module "@porchlight/social" {
  export interface SocialModule {
    networkService: NetworkService;
    inviteService: InviteService;
    membershipService: MembershipService;
    quotaService: QuotaService;
    auditService: AuditService;
    groupService: GroupService;
    postService: PostService;
    interactionService: InteractionService;
    notificationService: NotificationService;
    /** PORCH-054: the media pipeline service (ingest/serving/disk guard). */
    mediaService: unknown;
    /** PORCH-054: the pipeline's content-addressed blob store (media root; re-pointable). Identity's avatar plane late-binds to it (PORCH-070). */
    blobs: {
      put: (key: string, bytes: Buffer) => Promise<string>;
      get: (key: string) => Promise<Buffer | null>;
      has: (key: string) => Promise<boolean>;
      delete: (key: string) => Promise<boolean>;
    };
    /** PORCH-054: the media root's readiness state machine (status/changeRoot). */
    mediaVolume: {
      status: () => Promise<{
        root: string | null;
        state: string;
        check: string | null;
        reason: string | null;
        flag: string | null;
      }>;
    };
    /** PORCH-059: the Web Push send pipeline (identity-scoped subscriptions + settings). */
    pushService: PushService;
    /** PORCH-047: the real-time event surface (subscribe/catch-up/revoke). */
    realtimeService: unknown;
    /** PORCH-079: the OG unfurl composer (images + the og: tag resolver). */
    ogService: {
      image(input: { kind: "post" | "invite"; id: string }): Promise<{ bytes: Buffer; key: string; composed: boolean }>;
      tags(input: { kind: "post" | "invite"; id: string; origin?: string | null }): Promise<{ title: string; image: string; url: string } | null>;
    };
    controllers: unknown;
    api: import("express").Router;
  }
  export function canonicalJson(value: object): string;
  export function createSocialRouter(controllers: {
    bootstrap: unknown;
    content: unknown;
    membership: unknown;
    console: unknown;
    media: unknown;
  }): import("express").Router;
  export function assembleSocialModule(
    store: { collection(name: string): unknown },
    options?: {
      hubUrl?: () => string | null;
      ledger?: { record: (step: string, detail?: object) => Promise<void> };
      system?: {
        release: { service: string; version: string | null };
        launch: () => Promise<{
          resumable: boolean;
          lastError: string | null;
          steps: Record<string, { status: string }>;
          diagnostics: Array<{ at: string; source: string; message: string }>;
        }>;
      };
      verifyMemberIdToken?: (idToken: string | null) => Promise<{ did: string } | null>;
      registeredDeviceKey?: (did: string, deviceId: string) => Promise<{ publicKeyJwk: Record<string, unknown> } | null>;
      /** PORCH-029: identity-plane name resolver for the member directory. */
      memberNames?: (dids: string[]) => Promise<Array<{ did: string; displayName: string | null }>>;
      /** PORCH-031: identity-plane device-link mint for the owner-bind handoff. */
      mintOwnerDeviceLink?: (did: string) => Promise<{ grantId: string; token: string; expiresAt: string }>;
      /** PORCH-070: the member-purge cascade step — identity-side avatar retirement (late-bind). */
      purgeAvatar?: (did: string) => Promise<{ removed: number }>;
      /** PORCH-088: the group-avatar write path — the identity plane's
       *  member-avatar ingest treatment, wired from the public entry. */
      groupAvatar?: {
        treatImage?: (
          bytes: Buffer,
          contentType: string,
        ) => Promise<Array<{ kind: string; width: number; height: number; contentType: string; bytes: Buffer }>>;
      };
      /** PORCH-019: auth-failure capture sink. */
      log?: ((line: string) => void) | null;
      media?: {
        /** PORCH-054: the configured media root (runtime configuration). */
        mediaRoot?: string;
        /** PORCH-054: true when the root is the hub data-directory default. */
        mediaRootIsDefault?: boolean;
        /** PORCH-054: persists the owner's media-root edit into the config file. */
        persistRoot?: (root: string) => void;
        /** PORCH-054 [Assumed: 10s]: the ready-and-waiting poll interval. */
        volumePollIntervalMs?: number;
        store?: {
          put: (key: string, bytes: Buffer) => Promise<string>;
          get: (key: string) => Promise<Buffer | null>;
          has: (key: string) => Promise<boolean>;
          delete: (key: string) => Promise<boolean>;
        };
        diskProbe?: () => Promise<{ totalBytes: number; freeBytes: number }>;
        softUsedRatio?: number;
        hardUsedRatio?: number;
        chunkSize?: number;
        /** PORCH-044: the rendition ladder rungs (owner-readable config). */
        renditions?: { image?: Record<string, number>; video?: Record<string, number> };
      };
      /** PORCH-047: the real-time event plane + replay window (hub runtime wiring). */
      realtime?: {
        plane?: unknown | null;
        replayHours?: number;
      };
      /** PORCH-059: the Web Push transport (hub runtime wiring). */
      push?: {
        /** The hub's VAPID material (runtime-setup state); null skips sending. */
        vapid?: { publicKey: string; privateKey: string; subject: string } | null;
        /** Injected send transport; defaults to the web-push client. */
        sender?: (options: { subscription: unknown; plaintext: unknown }) => Promise<unknown>;
      };
    },
  ): SocialModule;
  export function createMemoryEventPlane(options?: { maxEntries?: number }): {
    append(networkId: string, event: Record<string, unknown>): Promise<{ seq: string }>;
    readSince(networkId: string, cursor: string | null): Promise<{
      events: Record<string, unknown>[];
      stale: boolean;
      cursor: string | null;
    }>;
    publish(networkId: string, envelope: Record<string, unknown>): Promise<void>;
    onInbound(handler: (networkId: string, envelope: Record<string, unknown>) => void): () => void;
    close(): void;
  };
  export class PostService {
    create(options?: { accessToken?: string | null; payload?: object; signature?: string }): Promise<{ post: Record<string, unknown> }>;
    get(options?: { accessToken?: string | null; postId?: string }): Promise<{ post: Record<string, unknown> }>;
    list(options?: { accessToken?: string | null }): Promise<{ posts: Array<Record<string, unknown>> }>;
    deletePost(options?: { accessToken?: string | null; postId?: string; signature?: string }): Promise<{ deleted: boolean; postId: string; tombstoneId: string }>;
    /** PORCH-093 ac-4: the author's silent one-text-field edit (PORCH-157). */
    editPost(options?: { accessToken?: string | null; postId?: string; payload?: object; signature?: string }): Promise<{ post: Record<string, unknown> }>;
    memberContentSweep(options?: { accessToken?: string | null; signature?: string }): Promise<{ sweptPosts: number }>;
    cascadePost(post: Record<string, unknown>, options?: { actorDid?: string | null; deletedByRole?: "author" | "owner" | "group-manager" }): Promise<{ deleted: boolean; postId: string; tombstoneId: string }>;
    recount(options?: { postId?: string; networkId?: string }): Promise<void>;
  }
  export class InteractionService {
    comment(options?: { accessToken?: string | null; payload?: object; signature?: string }): Promise<{ comment: Record<string, unknown> }>;
    react(options?: { accessToken?: string | null; payload?: object; signature?: string }): Promise<{ reaction: Record<string, unknown> }>;
    vote(options?: { accessToken?: string | null; payload?: object; signature?: string }): Promise<{ vote: Record<string, unknown> }>;
    commentThread(options?: { accessToken?: string | null; postId?: string }): Promise<{ comments: Array<Record<string, unknown>> }>;
    reactionsFor(options?: { accessToken?: string | null; postId?: string }): Promise<{ reactions: Array<Record<string, unknown>> }>;
    /** PORCH-093 ac-1: author/owner comment delete with the reply-tree cascade. */
    deleteComment(options?: { accessToken?: string | null; postId?: string; commentId?: string; signature?: string }): Promise<{ deleted: boolean; commentId: string; tombstoneId: string; cascadedReplies: number }>;
    /** PORCH-093 ac-4: the author's silent text edit. */
    editComment(options?: { accessToken?: string | null; postId?: string; commentId?: string; payload?: object; signature?: string }): Promise<{ comment: Record<string, unknown> }>;
  }
  /** PORCH-093: the content lifecycle — owner restore + the day-30 reaper. */
  export class LifecycleService {
    sweep(options?: { now?: () => Date }): Promise<{ purged: number; due: number }>;
    restore(options?: { accessToken?: string | null; tombstoneId?: string }): Promise<{ restored: boolean; subjectType: string; subjectId: string; restoredRows: number; renditionsRegenerated: number; renditionFailures: Array<Record<string, unknown>> }>;
  }
  export class NotificationService {
    inbox(options?: { accessToken?: string | null }): Promise<{ notifications: Array<Record<string, unknown>> }>;
  }
  /** PORCH-059: the device-notifications send pipeline. */
  export class PushService {
    vapidKey(): { publicKey: string | null; available: boolean };
    registerSubscription(options?: { accessToken?: string | null; endpoint?: string }): Promise<{ subscription: Record<string, unknown> }>;
    unregisterSubscription(options?: { accessToken?: string | null; endpoint?: string }): Promise<{ removed: boolean }>;
    memberSettings(options?: { accessToken?: string | null }): Promise<{ settings: { enabled: boolean; events: Record<string, boolean>; mutes: string[] } }>;
    updateSettings(options?: { accessToken?: string | null; enabled?: boolean; events?: Record<string, boolean>; mutes?: string[] }): Promise<{ settings: { enabled: boolean; events: Record<string, boolean>; mutes: string[] } }>;
    notify(options?: Record<string, unknown>): Promise<{ sent: number; skipped: number; failed?: boolean }>;
    notifyNewMember(options?: { networkId?: string; did?: string }): Promise<{ sent: number; skipped: number }>;
    notifyDeviceLink(options?: { did?: string }): Promise<{ sent: number; skipped: number }>;
  }
  export class GroupService {
    constructor(deps: { groups: unknown; memberships: unknown });
    create(options?: { networkId?: string; name?: string; members?: string[] }): Promise<Record<string, unknown>>;
    list(options?: { networkId?: string }): Promise<Array<Record<string, unknown>>>;
  }
  export class NetworkService {
    constructor(networks: unknown);
    get(): Promise<unknown>;
    createNetwork(options?: { name?: string; ownerAccountId?: string | null }): Promise<{ created: boolean; network: { _id: string; name: string; [key: string]: unknown } }>;
    /** PORCH-065: the network half of the self-reference re-point. */
    recordHubUrl(url: string): Promise<Record<string, unknown> | null>;
  }
  export class InviteService {
    constructor(invites: unknown);
    issue(options?: { networkId?: string; role?: string; maxUses?: number; hubUrl?: string | null }): Promise<{ _id: string; token: string; state: string; joinUrl?: string; [key: string]: unknown }>;
    revoke(options: { inviteId: string }): Promise<{ revoked: boolean; invite: { _id: string; state: string; [key: string]: unknown } }>;
    list(options?: { networkId?: string }): Promise<Array<Record<string, unknown>>>;
    verify(code: string): Promise<{ valid: boolean; code?: string; message?: string; invite?: Record<string, unknown> }>;
    redeem(code: string): Promise<{ _id: string; networkId: string; useCount: number; [key: string]: unknown }>;
  }
  export class MembershipService {
    constructor(deps: {
      memberships: unknown;
      membershipSessions: unknown;
      deviceKeys: unknown;
      invites: InviteService;
      verifyMemberIdToken?: (idToken: string | null) => Promise<{ did: string } | null>;
      networks?: unknown;
      audit?: (action: string, detail?: object) => void;
      registeredDeviceKey?: (did: string, deviceId: string) => Promise<{ publicKeyJwk: Record<string, unknown> } | null> | null;
    });
    verifyJoinLink(code: string): Promise<{ valid: boolean; code?: string; message?: string; invite?: Record<string, unknown> }>;
    bindFounder(options?: { network?: unknown; did?: string | null }): Promise<Record<string, unknown> | null>;
    admit(options: { code: string; identityAccessToken: string; deviceId: string; devicePublicKeyJwk: Record<string, unknown>; signature: string }): Promise<{
      membership: Record<string, unknown>;
      networkId: string;
      accessToken: string;
      refreshToken: string;
      membershipSessionId: string;
    }>;
    refresh(options?: { refreshToken?: string; now?: () => Date }): Promise<{ accessToken: string; networkId: string; did: string }>;
    verifyAccessToken(token: string, options?: { networkId?: string; now?: () => Date; surface?: string | null }): Promise<{ membership: Record<string, unknown>; session: Record<string, unknown> } | null>;
    /** PORCH-019: failing-step diagnosis for the 401 capture. */
    diagnoseAccessToken(token: string, options?: { networkId?: string | null; now?: () => Date }): Promise<Record<string, unknown> | null>;
    diagnoseRefreshToken(token: string, options?: { now?: () => Date }): Promise<Record<string, unknown> | null>;
    verifyMemberWrite(options: { networkId: string; did: string; deviceId: string; payload: unknown; signature: string }): Promise<{ verified: boolean }>;
    activeMembership(options: { networkId: string; did: string }): Promise<Record<string, unknown> | null>;
    restoreSession(options: { identityAccessToken: string; deviceId?: string | null }): Promise<{ did: string; sessions: Array<{ networkId: string; role: string; accessToken: string; refreshToken: string }> }>;
    revokeMember(options?: { networkId?: string; did?: string; memberId?: string }): Promise<{ revoked: boolean; membership: Record<string, unknown> }>;
    listMembers(options?: { networkId?: string }): Promise<Array<Record<string, unknown>>>;
    /** PORCH-029: membership rows joined with identity display names for the member directory. */
    listMemberViews(options?: { networkId?: string }): Promise<Array<Record<string, unknown>>>;
  }
  export class QuotaService {
    constructor(deps: { artifacts: unknown; networks: unknown; audit?: (action: string, detail?: object) => void });
    limits(options: { networkId: string }): Promise<{ storageCeilingMb: number | null; retentionDays: number | null }>;
    setLimits(options: { networkId: string; storageCeilingMb?: number | null; retentionDays?: number | null }): Promise<{ networkId: string; quota: { storageCeilingMb: number | null; retentionDays: number | null } }>;
    usage(options: { networkId: string }): Promise<{ networkId: string; usedBytes: number; ceilingMb: unknown }>;
    admitUpload(options: { networkId: string; bytes: number; kind?: string }): Promise<{ admitted: boolean; usedBytes: number; ceilingMb: number | null; unset: boolean }>;
    recordArtifact(options: { networkId: string; kind: string; bytes: number; retentionDays?: number | null; sourceId?: string | null }): Promise<Record<string, unknown>>;
    sweep(options?: { networkId?: string; now?: () => Date }): Promise<{ swept: number; bytesFreed: number; at: string }>;
  }
  export class AuditService {
    constructor(auditEvents: unknown, bootstrapLedger?: { record: (step: string, detail?: object) => Promise<void> });
    record(options: { networkId: string; did?: string | null; action: string; detail?: object }): Promise<Record<string, unknown>>;
    /** PORCH-058: newest first, bounded page (?limit= ?offset=). */
    list(options: { networkId: string; limit?: unknown; offset?: unknown }): Promise<{
      events: Array<Record<string, unknown>>; total: number; limit: number; offset: number; hasMore: boolean;
    }>;
  }
}
declare module "@porchlight/home" {
  export interface HomeModule {
    api: import("express").Router;
    homeService: unknown;
    areaService: unknown;
    deviceService: unknown;
    sceneService: unknown;
    automationService: unknown;
    /** PORCH-138: the grant layer of the access model (individual + family grants). */
    grantService: unknown;
    auditService: unknown;
    adapters: unknown;
    /** PORCH-139: the camera bridge and the family event/alert pipeline. */
    cameraService: CameraServiceLike;
    eventService: unknown;
    /** PORCH-149: the session-free actor tool surface the agent registry rides. */
    toolSurface: Record<string, unknown>;
  }
  /** PORCH-141: the camera bridge subset the hub composes against. */
  export interface CameraServiceLike {
    homeForEngineCamera(engineCameraId: string): Promise<{ homeId: string; cameraId: string; cameraName?: string } | null>;
  }
  /** PORCH-139: the engine seam contract (see camera.service.js docs). */
  export interface EngineAdapter {
    validateCamera(input: { url: string }): Promise<{ ok: true; cameraId: string; aspect?: { width: number; height: number } | null; audio?: boolean } | { ok: false; reason: string }>;
    liveFeed(engineCameraId: string): Promise<{ upstreamId: string | null; path: string; audio: boolean }>;
    openMedia(path: string): Promise<{ body: unknown; contentType?: string } | { gap: string }>;
    segments(input: { cameraId: string; from: number; to: number }): Promise<Array<Record<string, unknown>>>;
    segmentAt(input: { cameraId: string; at: number }): Promise<{ ref: string; path: string; kind?: string } | { gap: string }>;
    evidenceAt(input: { cameraId: string; at: number }): Promise<{ kind?: string; ref?: string; path?: string | null } | { gap: string }>;
    health(engineCameraId: string): Promise<{ recording?: { state: string }; playback?: { state: string }; detection?: { state: string } }>;
    serviceHealth(): Promise<{ state: string; detail?: unknown }>;
    storage(): Promise<{ state: string; detail?: unknown }>;
  }
  /** PORCH-139: the engine's MQTT detection-bus consumer (DetectedObject facts). */
  /** PORCH-142: the engine detections topic contract of record (one copy, home-owned). */
  export const ENGINE_DETECTIONS_PREFIX: string;
  export function createMqttEngineConsumer(options: {
    url: string;
    clientId?: string;
    log?: (line: string) => void;
    onEvent: (detection: Record<string, unknown>) => Promise<unknown>;
  }): { status(): Record<string, unknown>; close(): Promise<void> };
  export function createHttpEngineAdapter(options: { baseUrl: string }): EngineAdapter;
  export function assembleHomeModule(
    store: { collection(name: string): unknown },
    options?: {
      /** The identity-plane access-token verifier (with its own device). */
      verifySession: (token: string | null) => Promise<{ did: string; deviceId?: string } | null>;
      /** The possession-proven device key behind member-signed writes. */
      registeredDeviceKey?: ((did: string, deviceId: string) => Promise<{ publicKeyJwk: object } | null>) | null;
      /** Hub installation org of record, stamped on homes. */
      orgId?: (() => string | null) | null;
      /** PORCH-138: the grant flow's identity-plane facts — the existing-identity
       *  resolve and the family facts, always injected, never imported. */
      identityFacts?: {
        /** Grants ride EXISTING Porchlight identities; absent/never a mint. */
        resolveIdentity: (did: string) => Promise<{ did: string; displayName?: string | null } | null>;
        /** The familyRef of a family grant resolves through the family organizer. */
        familyById: (familyId: string) => Promise<{ _id: string; name: string; [key: string]: unknown } | null>;
        /** The governed members a family grant resolves against. */
        familiesForMember: (did: string) => Promise<Array<{ _id: string; [key: string]: unknown }>>;
      };
      /** PORCH-139: the engine adapter seam; null = fail closed. */
      engine?: EngineAdapter | null;
      /** PORCH-139: the shared engine-token secret (must pair with engine). */
      engineSecret?: string | null;
      /** PORCH-139: the engine detection bus subscription (both family consumers). */
      onEngineEvent?: (handler: (detection: Record<string, unknown>) => Promise<unknown>) => void;
      /** PORCH-139: the dedup window seconds override (tests; default 300). */
      dedupWindowSec?: number;
      /** Auth-failure capture sink (PORCH-019 shape). */
      log?: ((line: string) => void) | null;
    },
  ): HomeModule;
  export function createHomeRouter(controllers: unknown): import("express").Router;
}
declare module "@porchlight/overwatch" {
  /** PORCH-140 scope-law constants of record; PORCH-142 adds the derived trained-vocabulary extension. */
  export const TRACKED_CLASSES: string[];
  export const FOLLOWABLE_CLASSES: string[];
  export function extendTrackedVocabulary(labels: string[]): void;
  export function resetTrackedVocabulary(): void;
  /** PORCH-140: the overwatch data-plane services (plain-JS package, typed here). */
  export function createConfigStore(options: {
    path: string;
    now?: () => string;
    defaults?: Record<string, unknown>;
  }): {
    getState(): Record<string, unknown>;
    update(mutation: ((draft: Record<string, unknown>) => void) | object): Record<string, unknown>;
    reload(): Record<string, unknown>;
    setZone(cameraId: string, polygon: number[][], meta?: { authoredBy?: string }): Record<string, unknown>;
    removeZone(cameraId: string): Record<string, unknown>;
    eligibleCameraIds(): string[];
    correlationConfig(): Record<string, unknown>;
  };
  export function createAuditLog(options?: { path?: string | null; now?: () => string }): {
    record(input: { type: string; actorIdentityRef?: string | null; detail?: object; outcome?: string; homeId?: string | null }): Record<string, unknown>;
    list(filters?: { type?: string; homeId?: string; limit?: number }): Array<Record<string, unknown>>;
    path: string | null;
  };
  export function createDial(options: { store: unknown; audit: unknown; now?: () => Date; capFps?: number }): {
    capFps: number;
    set(input: { frameRate: number; actorIdentityRef?: string | null; homeId?: string | null }): { frameRate: number; clamped: boolean; changed: boolean };
    get(): { frameRate: number; capFps: number };
    effectiveFrameRateFor(cameraId: string, activeFollowBumps?: string[] | Set<string>): number;
  };
  export function createTrackedObjectsService(options?: {
    chainsProvider?: () => unknown[];
    followService?: unknown;
  }): {
    list(options?: { at?: number }): { tracked: Array<Record<string, unknown>> };
    get(options: { entityId: string; at?: number }): Record<string, unknown> | null;
  };
  export function createFollowService(options?: {
    audit?: AuditLog | null;
    compositor?: { setFollowBump: (cameraId: string, engaged: boolean) => unknown } | null;
    clipsProvider?: (chain: unknown) => Array<{ cameraId: string; path: string; from: number; to: number }> | undefined;
    resolveState?: (entityId: string, at?: number) => string;
    chainsProvider?: () => unknown[];
    auditBumps?: boolean;
    now?: () => number;
  }): {
    follow(input: { entityId: string; cls: string; activeCameraId?: string; actorIdentityRef?: string }): Record<string, unknown>;
    exit(input: { entityId: string; cameraId?: string; nextCameraId?: string; actorIdentityRef?: string }): Record<string, unknown> | null;
    unfollow(input: { entityId: string; actorIdentityRef?: string }): boolean;
    subscriptions(): Array<Record<string, unknown>>;
    stream(input: { entityId: string; chain?: unknown; at?: number }): Record<string, unknown>;
  };
  export function createVisitService(options?: {
    store?: { eligibleCameraIds?: () => string[] } | null;
    chainsProvider?: () => unknown[];
    clipsProvider?: (chain: unknown) => Array<{ cameraId: string; path: string; from: number; to: number }> | undefined;
    outagesProvider?: () => Array<{ cameraId: string; from: number; to: number }>;
    unexplainedGapSec?: number;
  }): {
    listVisits(options: { from: number; to: number }): Array<Record<string, unknown>>;
    timeline(options: { visitId: string; at?: number }): Array<Record<string, unknown>>;
    openVisitSurface(options: { chain: unknown }): Record<string, unknown>;
  };
}

declare module "@porchlight/overwatch/server" {
  /**
   * PORCH-140: the zero-framework overwatch REST plane (packages/overwatch).
   * The services block is the plane's design of record — see server.js.
   */
  /** The audit-log seam the plane and the follow service share. */
  type AuditLog = {
    record: (input: { type: string; actorIdentityRef?: string | null; detail?: object; outcome?: string; homeId?: string | null }) => unknown;
    list: (filters?: object) => Array<Record<string, unknown>>;
  };

  export function createOverwatchHandler(parts: {
    services: {
      store: unknown;
      dial: unknown;
      audit: AuditLog;
      trackedService: unknown;
      followService: unknown;
      visitService: unknown;
      now?: () => number;
      entityService?: { vetoPair: (signature: string) => unknown } | null;
    };
    authorize?: ((args: { req: unknown; action: string; resource: string }) => Promise<unknown> | unknown) | null;
    log?: ((line: string) => void) | null;
  }): (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    prepared?: { body?: object | null },
  ) => Promise<void>;
  export function createOverwatchServer(parts: Parameters<typeof createOverwatchHandler>[0]): import("node:http").Server;
}
declare module "@porchlight/recognition" {
  /** PORCH-141: the People & Things services (plain-JS package, typed here). */
  /** The recognition audit-log seam (overwatch's AuditLog shape + homeId). */
  export interface VisionProvider {
    name: string;
    describeFaces(frame: unknown): Promise<Array<{ descriptor: number[]; conf?: number; box?: number[] }>>;
    readPlates?(frame: unknown): Promise<Array<{ text: string; conf?: number; box?: number[] }>>;
    /** PORCH-142: the watchlist exemplar embedder stage (qwen3-embedding-class). */
    embedImage?(frame: unknown): Promise<number[][]>;
    status?(): { engine: string; [key: string]: unknown };
    close?(): Promise<void>;
  }
  export function createAuditLog(options?: { path?: string | null; now?: () => string }): {
    record(input: { type: string; actorIdentityRef?: string | null; detail?: object; outcome?: string; homeId?: string | null }): Record<string, unknown>;
    list(filters?: { type?: string; homeId?: string; limit?: number }): Array<Record<string, unknown>>;
    path: string | null;
  };
  export class VisionProviderRegistry {
    register(name: string, factory: () => VisionProvider): { replaced: boolean };
    has(name: string): boolean;
    names(): string[];
    create(name: string, opts?: { provider?: VisionProvider }): VisionProvider;
  }
  export function createRecognitionPipeline(options?: {
    registry?: VisionProviderRegistry;
    metrics?: unknown;
  }): {
    registry: VisionProviderRegistry;
    metrics: { snapshot(): { descriptorComputations: number; plateReads: number; recognitionRuns: number; refusedDisabled: number } };
    computeDescriptor(req: { enabled: boolean; provider: VisionProvider; frame: unknown }): Promise<{ provider: string; embeddings: Array<{ descriptor: number[]; conf?: number }> }>;
    computePlates(req: { enabled: boolean; provider: VisionProvider; frame: unknown }): Promise<{ provider: string; plates: Array<{ text: string; conf?: number }> }>;
  };
  export function createRegistryService(options: { store: unknown; audit?: unknown | null; now?: () => number }): {
    settingsOf(homeId: string): Promise<{ homeId: string; enabled: boolean; assertThreshold: number | null; updatedAt: string | null; updatedBy: string | null }>;
    setEnabled(input: { homeId: string; enabled: boolean; actorDid?: string | null }): Promise<Record<string, unknown>>;
    setThreshold(input: { homeId: string; assertThreshold: number | null; actorDid?: string | null }): Promise<Record<string, unknown>>;
    listEntries(homeId: string, kind?: "face" | "vehicle"): Promise<Array<Record<string, unknown>>>;
    getEntry(homeId: string, entryId: string): Promise<Record<string, unknown>>;
    enroll(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    updateEntry(input: { homeId: string; entryId: string; name?: string; plateText?: string }): Promise<Record<string, unknown>>;
    purgeEntry(input: { homeId: string; entryId: string; actorDid?: string | null }): Promise<{ purged: Record<string, number | string> }>;
    recordSighting(homeId: string, entryId: string, sighting: Record<string, unknown>): Promise<void>;
    annotate(note: Record<string, unknown>): Promise<Record<string, unknown>>;
    listAnnotations(filters: Record<string, string | undefined>): Promise<Array<Record<string, unknown>>>;
    exportRegistry(homeId: string): Promise<Record<string, unknown>>;
  };
  export function createRecognitionService(options: { registry: unknown; pipeline: unknown; providerName?: string }): {
    enabled(homeId: string): Promise<boolean>;
    enroll(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    matchFace(input: { homeId: string; descriptor: number[] }): Promise<{ decision: string; entryId: string | null; name: string | null; confidence: number }>;
    matchVehicle(input: { homeId: string; descriptor?: number[]; plateText?: string }): Promise<{ decision: string; entryId: string | null; name: string | null; confidence: number }>;
    recognize(intake: Record<string, unknown>): Promise<{ outcome: { decision: string; entryId: string | null; name: string | null; confidence: number }; annotated: boolean; annotationId: string | null }>;
    metrics(): { descriptorComputations: number; plateReads: number; recognitionRuns: number; refusedDisabled: number };
  };
  /** PORCH-142: the household-trained few-shot classifier (see watchlists.js). */
  export function createWatchlistService(options: {
    store: unknown;
    audit?: unknown | null;
    trackedClasses?: string[];
    providerRef?: (() => Promise<VisionProvider>) | null;
    providerName?: string;
    now?: () => number;
  }): {
    createClass(req: Record<string, unknown>): Promise<{ view: Record<string, unknown>; expectedAccuracy: Record<string, unknown>; heldReplay: Record<string, unknown> | null }>;
    retrain(req: Record<string, unknown>): Promise<{ view: Record<string, unknown>; heldReplay: Record<string, unknown> }>;
    classify(req: { homeId: string; descriptor?: number[]; cameraId?: string; trackId?: string; eventId?: string; t?: number }): Promise<{ decision: "asserted" | "looks-like"; label: string; classId: string; confidence: number; similarity: number; shouldEmit: boolean } | null>;
    correct(req: Record<string, unknown>): Promise<{ view: Record<string, unknown>; correction: Record<string, unknown> }>;
    setClassThreshold(req: Record<string, unknown>): Promise<Record<string, unknown>>;
    getClass(homeId: string, classId: string): Promise<Record<string, unknown>>;
    listClasses(homeId: string): Promise<Array<Record<string, unknown>>>;
    listDetections(req: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
    deleteClass(req: Record<string, unknown>): Promise<{ purged: Record<string, number | string> }>;
    vocabulary(homeId: string): Promise<{ builtIn: Array<Record<string, unknown>>; trained: Array<Record<string, unknown>> }>;
    trackedTrainedLabels(homeId?: string): Promise<string[]>;
  };
}
declare module "@porchlight/recognition/server" {
  /**
   * PORCH-141: the zero-framework People & Things REST plane
   * (packages/recognition). The services block is the plane's design of
   * record — see server.js.
   */
  export function createRecognitionHandler(parts: {
    services: {
      registry: unknown;
      recognition: unknown;
      /** PORCH-142: the household-trained few-shot classifier (required). */
      watchlists: unknown;
      /** Fire-and-forget mutation side-channel (the derived vocabulary refresh). */
      hooks?: { onWatchlistMutated?: () => unknown } | null;
    };
    authorize?: ((args: { req: unknown; action: string; resource: string; homeId?: string | null }) => Promise<unknown> | unknown) | null;
    log?: ((line: string) => void) | null;
  }): (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    prepared?: { body?: object | null },
  ) => Promise<void>;
  export function createRecognitionServer(parts: Parameters<typeof createRecognitionHandler>[0]): import("node:http").Server;
}

declare module "@porchlight/agent-runtime" {
	/** PORCH-147: the MIT-licensed runtime library the agent registry consumes. */
	export class ToolRegistry {
		register(tool: object): ToolRegistry;
		has(name: string): boolean;
		list(): Array<{ name: string; description?: string }>;
		execute(name: string, args?: unknown, authority?: { memberId: string; scopes: string[] }): Promise<unknown>;
	}
	export class MapBackend {
		constructor(seed?: Map<string, string>);
	}
	export interface RuntimeEntity {
		runTurn(input: { text: string; topic?: string; maxToolTurns?: number }): Promise<{ text: string; provenance: object; toolsUsed: string[] }>;
		memory: { all(): Promise<Array<{ role: string; text: string; tool?: string }>> };
		lastProvenance: object | null;
	}
	export class AgentRuntime {
		constructor(opts: {
			backend?: unknown;
			inference: { name: string; providerClass?: string; providerClasses?: string[]; complete(request: object): Promise<object> };
			tools?: unknown;
			authority?: ((memberId: string) => Promise<{ memberId: string; scopes: string[] }>) | null;
			onRefusal?: ((entry: object) => void) | null;
			sessionId?: string;
		});
		agentFor(memberId: string): RuntimeEntity;
	}
}

declare module "@porchlight/agent" {
  /** PORCH-148: the agent module's model-profile machinery. */
  export const agentModels: Record<string, unknown>;
  /** PORCH-149: the five MCP-for-the-home tool descriptors of record. */
  export const HOME_TOOLS: Record<string, { name: string; description: string; uiRoute: string }>;
  export function assembleAgentModule(
    store: { collection(name: string): unknown },
    options?: {
      /** The identity-plane access-token verifier (with its own device). */
      verifySession?: (token: string | null) => Promise<{ did: string; deviceId?: string } | null>;
      /** The hub-admin fact of record (resolution's availability gate rides it). */
      adminFacts?: { isAdmin: (did: string) => Promise<boolean> | boolean };
      /** The identity-plane family facts the parental narrowing composes against. */
      familyFacts?: { familiesForMember?: (did: string) => Promise<Array<{ _id: string; parentIdentityRefs?: string[]; memberIdentityRefs?: string[]; [key: string]: unknown }>> };
      /** The live-apply change seam (every profile write publishes). */
      onProfileChange?: (event: object) => void;
      /** The member's agent type resolver; default the household-member agent. */
      agentTypeFor?: (memberId: string) => string | Promise<string>;
      /** PORCH-149: the home module's toolSurface — the MCP-for-the-home seams. */
      homeSurface?: Record<string, unknown>;
      now?: () => string;
    },
  ): {
    api: import("express").Router;
    controllers: unknown;
    profileService: unknown;
    assignmentService: {
      list(input: { agentType?: string | null }): Promise<{ state?: string; detail?: string; rows: Array<Record<string, unknown>> }>;
      resolvesAdmin(did: string): Promise<boolean>;
    };
    resolutionService: unknown;
    provenanceService: unknown;
    auditService: unknown;
    /** The profile-routed inference seam consumer (composition seam 1). */
    createProfileInference(input: { providers?: Record<string, { name: string; providerClass: string; complete(r: object): Promise<object> }>; log?: (memberId: string, line: string) => void }): unknown;
    /** PORCH-149: the MCP-for-the-home registry (null without homeSurface). */
    toolRegistry: import("@porchlight/agent-runtime").ToolRegistry | null;
    delegationService: unknown;
    /** Composition seam 2: (memberId) => { memberId, scopes }. */
    authorityResolver: ((memberId: string) => Promise<{ memberId: string; scopes: string[] }>) | null;
  };
}
