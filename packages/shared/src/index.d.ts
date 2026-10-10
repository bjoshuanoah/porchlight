export declare const DOMAIN: string;
export declare function isPresent(value: unknown): boolean;

export declare const CONFIG_SCHEMA_VERSION: number;

export interface PorchlightConfig {
  schemaVersion: number;
  mode: {
    deploymentMode: "self-hosted" | "hosted" | "identity-only";
    identityServingEnabled: boolean;
    socialServingEnabled: boolean;
  };
  hub: {
    host: string;
    httpPort: number;
    tunnel: { enabled: boolean; url: string | null };
  };
  /** PORCH-026: second-hub identity adoption is flag-hidden (default off). */
  identity: {
    adoptionEnabled: boolean;
  };
  daemons: { mongoPort: number; redisPort: number };
  quota: { storageCeilingMb: number | null; retentionDays: number | null };
  /** PORCH-044: the rendition ladder rungs (owner-readable configuration). */
  media: {
    renditions: {
      image: Record<string, number>;
      video: Record<string, number>;
    };
  };
  /** PORCH-047: the bounded per-origin replay window (owner-readable configuration). */
  realtime: {
    replayHours: number;
  };
}

export declare const DEFAULT_CONFIG: Readonly<PorchlightConfig>;

export interface HomePaths {
  root: string;
  bin: string;
  state: string;
  logs: string;
  data: string;
  mongoData: string;
  redisData: string;
  pidfiles: string;
}

export declare function homePaths(env?: Record<string, string | undefined>): HomePaths;

export declare function configPath(root: string): string;

export declare function normalizeConfig(raw: unknown): PorchlightConfig;
export declare function loadConfig(root: string): PorchlightConfig | null;
export declare function saveConfig(root: string, config: PorchlightConfig): PorchlightConfig;

export interface CollectionLike {
  findOne(filter?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  /** All matching rows (flat equality filter), shallow copies. */
  find(filter?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  insertOne(document: Record<string, unknown>): Promise<{ insertedId: unknown }>;
  updateOne(
    filter: Record<string, unknown>,
    update: { $set?: Record<string, unknown>; upsert?: boolean },
  ): Promise<{ matchedCount: number; upsertedId?: unknown }>;
  deleteOne(filter?: Record<string, unknown>): Promise<{ deletedCount: number }>;
  deleteMany(filter?: Record<string, unknown>): Promise<{ deletedCount: number }>;
}

export interface StoreLike {
  collection(name: string): CollectionLike;
}

export declare function createMemoryStore(): StoreLike;

/** PORCH-019: one captured 401's diagnosis payload. Token material never rides it. */
export type AuthFailureEvent = Record<string, unknown>;

export declare function logAuthFailure(event: AuthFailureEvent, log?: ((line: string) => void) | null): void;