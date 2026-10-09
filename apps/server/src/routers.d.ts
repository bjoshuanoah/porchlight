declare module "@porchlight/identity" {
  interface IdentityModule {
    api: import("express").Router;
    wellKnown: import("express").Router;
    controllers: unknown;
    signing: unknown;
    didService: unknown;
    accountService: unknown;
    authService: {
      /** Opaque-token session verification (identity plane, DID resolution). */
      verifyAccessToken(token: string): Promise<{ did: string; sessionId: unknown } | null>;
    };
    deviceService: unknown;
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
  export function createSocialRouter(controllers: {
    bootstrap: unknown;
    feed: unknown;
    membership: unknown;
    console: unknown;
  }): import("express").Router;
  export function assembleSocialModule(
    store: { collection(name: string): unknown },
    options?: {
      hubUrl?: () => string | null;
      ledger?: { record: (step: string, detail?: object) => Promise<void> };
      verifyMemberIdToken?: (idToken: string | null) => Promise<{ did: string } | null>;
    },
  ): {
    networkService: NetworkService;
    inviteService: InviteService;
    membershipService: MembershipService;
    quotaService: QuotaService;
    auditService: AuditService;
    controllers: unknown;
    api: import("express").Router;
  };
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
    });
    verifyJoinLink(code: string): Promise<{ valid: boolean; code?: string; message?: string; invite?: Record<string, unknown> }>;
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