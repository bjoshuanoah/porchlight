declare module "@porchlight/identity" {
  interface IdentityModule {
    api: import("express").Router;
    wellKnown: import("express").Router;
    controllers: unknown;
    signing: unknown;
    didService: unknown;
    accountService: unknown;
    authService: unknown;
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
  export function createSocialRouter(options?: {
    store?: { collection(name: string): unknown };
    ledger?: { record: (step: string, detail?: { detail?: string; inviteId?: string }) => Promise<void>; hubUrl?: () => string | null };
  }): import("express").Router;
  export class NetworkService {
    constructor(networks: unknown);
    get(): Promise<unknown>;
    createNetwork(options?: { name?: string; ownerAccountId?: string | null }): Promise<{ created: boolean; network: { _id: string; name: string; [key: string]: unknown } }>;
  }
  export class InviteService {
    constructor(invites: unknown);
    issue(options?: { networkId?: string; role?: string; maxUses?: number; hubUrl?: string | null }): Promise<{ _id: string; token: string; state: string; [key: string]: unknown }>;
    revoke(options: { inviteId: string }): Promise<{ revoked: boolean; invite: { _id: string; state: string; [key: string]: unknown } }>;
  }
}