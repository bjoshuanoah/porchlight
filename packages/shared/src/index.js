/**
 * Shared, domain-agnostic surface. By definition this package contains no
 * domain models — it carries types/helpers used across the module boundary.
 * It does NOT contain identity or social models.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const DOMAIN = "porchlight";

export function isPresent(value) {
  return value !== undefined && value !== null && value !== "";
}

export default { DOMAIN, isPresent };

/**
 * Runtime-config schema version (phase-configuration architecture, Porchlight
 * Server TS 6: deployment modes are runtime configuration, never forks).
 */
export const CONFIG_SCHEMA_VERSION = 1;

/**
 * Default runtime configuration for the phase-1 self-hosted hub. Quota
 * ceilings are owner-set (quantity-only limits rule) — null means unset and
 * is reported, never silently defaulted, so the owner dashboard can prompt.
 */
export const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: CONFIG_SCHEMA_VERSION,
  /** Product phase configuration: one codebase, modes via config only. */
  mode: {
    /** self-hosted | hosted | identity-only (Porchlight Server TS 6). */
    deploymentMode: "self-hosted",
    identityServingEnabled: true,
    socialServingEnabled: true,
  },
  /** Hub listener + tunnel binding. */
  hub: {
    /** Binds the local listener; the tunnel terminates at this port. */
    host: "127.0.0.1",
    httpPort: 8710,
    tunnel: {
      enabled: true,
      /** Public hub URL once the tunnel is up; null until captured. */
      url: null,
    },
  },
  /** Installer-managed daemon bindings (local-only, not the app surface). */
  daemons: {
    mongoPort: 27217,
    redisPort: 27379,
  },
  /** Quantity-only owner limits. null = owner has not set a ceiling. */
  quota: {
    storageCeilingMb: null,
    retentionDays: null,
  },
});

export function configPath(root) {
  return join(root, "config.json");
}

/**
 * Normalize + validate a raw config object against the defaults. Unknown
 * top-level mode values and out-of-range ports fail loudly (bootstrap
 * diagnostics contract: no silent half-configured state).
 */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const merged = structuredClone(DEFAULT_CONFIG);
  merged.mode = { ...merged.mode, ...src.mode };
  merged.daemons = { ...merged.daemons, ...src.daemons };
  merged.quota = { ...merged.quota, ...src.quota };
  merged.hub = { ...merged.hub, ...src.hub, tunnel: { ...merged.hub.tunnel, ...src.hub?.tunnel } };
  if (merged.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new Error(`config schemaVersion ${merged.schemaVersion} is not supported (expected ${CONFIG_SCHEMA_VERSION})`);
  }
  const modes = ["self-hosted", "hosted", "identity-only"];
  if (!modes.includes(merged.mode.deploymentMode)) {
    throw new Error(`config mode.deploymentMode must be one of ${modes.join(", ")}`);
  }
  for (const portField of [
    ["hub.httpPort", merged.hub.httpPort],
    ["daemons.mongoPort", merged.daemons.mongoPort],
    ["daemons.redisPort", merged.daemons.redisPort],
  ]) {
    const [name, value] = portField;
    if (!Number.isInteger(value) || value <= 0 || value > 65535) {
      throw new Error(`config ${name} must be an integer TCP port`);
    }
  }
  if (merged.mode.deploymentMode === "identity-only") {
    merged.mode.socialServingEnabled = false;
  }
  return merged;
}

/** Load the runtime config from <root>/config.json; null when none exists. */
export function loadConfig(root) {
  const path = configPath(root);
  if (!existsSync(path)) return null;
  return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
}

/** Save the runtime config to <root>/config.json (validated, pretty). */
export function saveConfig(root, config) {
  const normalized = normalizeConfig(config);
  mkdirSync(root, { recursive: true });
  writeFileSync(configPath(root), JSON.stringify(normalized, null, 2) + "\n");
  return normalized;
}

/** Porchlight home filesystem layout (installer-managed state). */
export function homePaths(env = {}) {
  const root = env.PORCHLIGHT_HOME
    ? (isAbsolute(env.PORCHLIGHT_HOME) ? env.PORCHLIGHT_HOME : join(process.cwd(), env.PORCHLIGHT_HOME))
    : join(homedir(), ".porchlight");
  return {
    root,
    bin: join(root, "bin"),
    state: join(root, "state"),
    logs: join(root, "logs"),
    data: join(root, "data"),
    mongoData: join(root, "data", "mongo"),
    redisData: join(root, "data", "redis"),
    pidfiles: join(root, "state", "processes"),
  };
}

/**
 * In-memory store exposing the mongodb-driver collection surface used by
 * services (findOne, insertOne, updateOne with upsert, plus counts). Real
 * dependency-free substitute for tests and for running without a daemon.
 */
export function createMemoryStore() {
  const collections = new Map();
  const byName = (name) => {
    if (!collections.has(name)) collections.set(name, []);
    return collections.get(name);
  };
  return {
    collection(name) {
      const rows = byName(name);
      const matches = (row, filter = {}) =>
        Object.entries(filter).every(([k, v]) => row[k] === v);
      const doc = (filter = {}) =>
        rows.find((row) => matches(row, filter)) ?? null;
      return {
        async findOne(filter = {}) {
          return doc(filter);
        },
        /** All matching rows as shallow copies (flat equality filter). */
        async find(filter = {}) {
          return rows.filter((row) => matches(row, filter)).map((row) => ({ ...row }));
        },
        async insertOne(document) {
          rows.push({ ...document });
          return { insertedId: document._id };
        },
        async updateOne(filter, update) {
          const target = doc(filter);
          const $set = update.$set ?? {};
          if (target) {
            Object.assign(target, structuredClone($set));
            return { matchedCount: 1, upsertedId: null };
          }
          if (update.upsert) {
            return this.insertOne({ ...filter, ...structuredClone($set) });
          }
          return { matchedCount: 0, upsertedId: null };
        },
      };
    },
  };
}