declare module "@porchlight/identity" {
  export interface IdentityModule {
    api: import("express").Router;
    wellKnown: import("express").Router;
    controllers: unknown;
    signing: unknown;
    didService: unknown;
    accountService: {
      /** Member identity birth at the front door (PORCH-010): DID + device binding. Required names (PORCH-024). */
      createMemberAccount(options: { firstName?: string; lastName?: string; device: { deviceId: string; label?: string | null; publicKeyJwk: Record<string, unknown> } | null }): Promise<{
        account: { _id: string; did: string; firstName: string | null; lastName: string | null; displayName: string };
        didDocument: unknown;
        registration: Record<string, unknown>;
      }>;
    };
    authService: {
      /** Opaque-token session verification (identity plane, DID resolution). */
      verifyAccessToken(token: string): Promise<{ did: string; sessionId: unknown } | null>;
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
    options?: { hubUrl?: () => string | null; ledger?: { record: (step: string, detail?: { detail?: string; inviteId?: string }) => Promise<void>; hubUrl?: () => string | null } },
  ): IdentityModule;
  export function createWellKnownRouter(wellKnownController: unknown): import("express").Router;
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
      media?: {
        mediaRoot?: string;
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
      };
    },
  ): SocialModule;
  export class PostService {
    create(options?: { accessToken?: string | null; payload?: object; signature?: string }): Promise<{ post: Record<string, unknown> }>;
    get(options?: { accessToken?: string | null; postId?: string }): Promise<{ post: Record<string, unknown> }>;
    list(options?: { accessToken?: string | null }): Promise<{ posts: Array<Record<string, unknown>> }>;
    deletePost(options?: { accessToken?: string | null; postId?: string; signature?: string }): Promise<{ deleted: boolean; postId: string }>;
    memberContentSweep(options?: { accessToken?: string | null; signature?: string }): Promise<{ sweptPosts: number }>;
    cascadePost(post: Record<string, unknown>, options?: { actorDid?: string | null }): Promise<{ deleted: boolean; postId: string }>;
    recount(options?: { postId?: string; networkId?: string }): Promise<void>;
  }
  export class InteractionService {
    comment(options?: { accessToken?: string | null; payload?: object; signature?: string }): Promise<{ comment: Record<string, unknown> }>;
    react(options?: { accessToken?: string | null; payload?: object; signature?: string }): Promise<{ reaction: Record<string, unknown> }>;
    vote(options?: { accessToken?: string | null; payload?: object; signature?: string }): Promise<{ vote: Record<string, unknown> }>;
    commentThread(options?: { accessToken?: string | null; postId?: string }): Promise<{ comments: Array<Record<string, unknown>> }>;
    reactionsFor(options?: { accessToken?: string | null; postId?: string }): Promise<{ reactions: Array<Record<string, unknown>> }>;
  }
  export class NotificationService {
    inbox(options?: { accessToken?: string | null }): Promise<{ notifications: Array<Record<string, unknown>> }>;
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
    verifyAccessToken(token: string, options?: { networkId?: string; now?: () => Date }): Promise<{ membership: Record<string, unknown>; session: Record<string, unknown> } | null>;
    verifyMemberWrite(options: { networkId: string; did: string; deviceId: string; payload: unknown; signature: string }): Promise<{ verified: boolean }>;
    activeMembership(options: { networkId: string; did: string }): Promise<Record<string, unknown> | null>;
    restoreSession(options: { identityAccessToken: string; deviceId?: string | null }): Promise<{ did: string; sessions: Array<{ networkId: string; role: string; accessToken: string; refreshToken: string }> }>;
    revokeMember(options?: { networkId?: string; did?: string; memberId?: string }): Promise<{ revoked: boolean; membership: Record<string, unknown> }>;
    listMembers(options?: { networkId?: string }): Promise<Array<Record<string, unknown>>>;
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
    list(options: { networkId: string }): Promise<Array<Record<string, unknown>>>;
  }
}