declare module "@porchlight/identity" {
  export function createIdentityRouter(options?: {
    store?: { collection(name: string): unknown };
    ledger?: { record: (step: string, detail?: { detail?: string; inviteId?: string }) => Promise<void>; hubUrl?: () => string | null };
  }): import("express").Router;
  export class AccountService {
    constructor(accounts: unknown);
    get(): Promise<unknown>;
    hasAccount(): Promise<boolean>;
    createFirstAccount(options?: { email?: string | null; displayName?: string | null }): Promise<{ created: boolean; account: { _id: string; kind: string; [key: string]: unknown } }>;
    adoptIdentity(options: { sourceHubUrl?: string; externalIdentityId?: string; displayName?: string }): Promise<{ adopted: boolean; alreadyAdopted?: boolean; account?: { _id: string; kind: string; adoptedIdentity: { sourceHubUrl: string; externalId: string }; [key: string]: unknown } }>;
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