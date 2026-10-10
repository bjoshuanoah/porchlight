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

/**
 * Auth-failure capture (PORCH-019). Every 401 writes ONE auditable line: the
 * failing endpoint, the failing step resolved against the session plane
 * (reason), and the session/device/membership identity state. Token material
 * is NEVER included — tokens are stored as hashes and are never logged.
 * The default sink is console.log: the hub supervisor pipes the hub child's
 * stdout into $PORCHLIGHT_HOME/logs/hub.log, so captured failures persist
 * beside the hub's other logs. Both domain modules call this so the 401
 * evidence shape stays identical across the identity and membership planes.
 *
 * @param {Record<string, unknown>} event - {endpoint, reason, code} plus
 *        whatever session/device identity state the caller resolved.
 * @param {((line: string) => void) | null} [log] - sink override (tests);
 *        defaults to console.log.
 */
export function logAuthFailure(event, log = null) {
  const line = `[${new Date().toISOString()}] hub: auth-failure ${JSON.stringify(event)}`;
  if (log) log(line);
  else console.log(line);
}

export default { DOMAIN, isPresent, logAuthFailure };

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
    /**
     * Operator bind address for the hub listener (PORCH-025). Default
     * "127.0.0.1" keeps the loopback-plus-tunnel posture; "0.0.0.0" adds LAN
     * reachability beside the tunnel. Zero trust on the LAN boundary:
     * membership-token enforcement is identical on every interface, the
     * tunnel target stays pinned to loopback (packages/cli
     * tunnel-identity.mjs), and identity issuance stays pinned to the tunnel
     * issuer regardless of which interface a request arrived on.
     */
    host: "127.0.0.1",
    httpPort: 8710,
    tunnel: {
      enabled: true,
      /** Public hub URL once the tunnel is up; null until captured. */
      url: null,
    },
  },
  /**
   * Identity-plane feature switches. Second-hub identity adoption (Oct 14,
   * 2026 ruling, PORCH-026): flag-hidden in the current build — no adoption
   * entry point is visible anywhere and the capability refuses when hidden.
   * The adoption architecture is unchanged; setting adoptionEnabled re-enters
   * it exactly as before (a flag flip, never a rebuild).
   */
  identity: {
    adoptionEnabled: false,
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
  /**
   * Media pipeline rendition ladder (PORCH-044, media pipeline TS 5). The
   * rungs are owner-readable configuration values, documented here:
   * image rungs are pixel widths for the photo-first treatments —
   * feed-thumb = full-bleed mobile, album = contained desktop cards,
   * detail = the detail view — and video posts carry the poster + playable
   * set. Widths clamp to the original at generation (never upscaled), and
   * the whole ladder generation lands inside the ≤2–4x rendition budget.
   */
  media: {
    /**
     * Configurable media root (PORCH-054, Brian Oct 14, 2026): the mounted
     * POSIX path the family's archive lives on (internal volume, DAS, or a
     * NAS mount — the application never distinguishes protocols). Runtime
     * configuration set at setup and editable later from the owner console;
     * null = the hub's own data directory (the legitimate local install).
     * A root change never moves existing media (owner-run move and repoint).
     */
    root: null,
    /**
     * Volume readiness poll interval (PORCH-054) [Assumed: 10s, tune at
     * build]: a known-good root that dropped pauses media in the
     * ready-and-waiting state and auto-resumes within one poll interval
     * once the volume mounts again — poll-and-recover, never refuse-and-
     * restart.
     */
    volumePollSeconds: 10,
    renditions: {
      image: { "feed-thumb": 640, album: 1080, detail: 1600 },
      video: { poster: 640, playable: 1280 },
    },
  },
  /**
   * Real-time event delivery (PORCH-047): the bounded per-origin replay
   * window held server-side (Redis stream class) behind the reconnect
   * catch-up. Owner-readable configuration value; beyond the window the
   * client falls back to REST with the freshness note.
   */
  realtime: {
    replayHours: 24,
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
  merged.identity = { ...merged.identity, ...src.identity };
  merged.realtime = { ...merged.realtime, ...src.realtime };
  merged.media = {
    ...merged.media,
    ...src.media,
    renditions: {
      image: { ...merged.media.renditions.image, ...src.media?.renditions?.image },
      video: { ...merged.media.renditions.video, ...src.media?.renditions?.video },
    },
  };
  // An incoming schemaVersion is honored, never silently defaulted: a file
  // written by a newer reader must fail loudly at read time (bootstrap
  // diagnostics contract).
  merged.schemaVersion = src.schemaVersion ?? DEFAULT_CONFIG.schemaVersion;
  if (merged.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new Error(`config schemaVersion ${merged.schemaVersion} is not supported (expected ${CONFIG_SCHEMA_VERSION})`);
  }
  const modes = ["self-hosted", "hosted", "identity-only"];
  if (!modes.includes(merged.mode.deploymentMode)) {
    throw new Error(`config mode.deploymentMode must be one of ${modes.join(", ")}`);
  }
  // Configurable media root (PORCH-054): null = the hub data directory
  // default; otherwise it must be an absolute POSIX path the hub could
  // write to — a relative or malformed root would resolve against the
  // process cwd (a silently moving archive) so it fails loudly at boot.
  if (merged.media.root != null) {
    if (typeof merged.media.root !== "string" || !isAbsolute(merged.media.root)) {
      throw new Error("config media.root must be an absolute path (or null for the hub data directory default)");
    }
  }
  // Volume readiness poll (PORCH-054) [Assumed: 10s default]: the one
  // poll-and-recover interval for a dropped known-good root.
  if (!Number.isInteger(merged.media.volumePollSeconds) || merged.media.volumePollSeconds < 1 || merged.media.volumePollSeconds > 3600) {
    throw new Error("config media.volumePollSeconds must be an integer number of seconds between 1 and 3600");
  }
  // Rendition ladder rungs (PORCH-044): the documented configuration values
  // — known kinds only, integer pixel widths inside the generation range.
  // Validation mirrors normalizeRenditionRungs (media.service) at config
  // normalize time so a bad owner edit fails loudly at boot.
  for (const group of ["image", "video"]) {
    for (const [kind, width] of Object.entries(merged.media.renditions[group])) {
      if (!Number.isInteger(width) || width < 16 || width > 8192) {
        throw new Error(`config media.renditions.${group}.${kind} must be an integer width between 16 and 8192`);
      }
    }
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
  // Real-time replay window (PORCH-047): an owner-readable configuration
  // value; a non-integer or absurd window fails loudly at boot rather than
  // degrading reconnect catch-up silently.
  if (!Number.isInteger(merged.realtime.replayHours) || merged.realtime.replayHours < 1 || merged.realtime.replayHours > 720) {
    throw new Error("config realtime.replayHours must be an integer number of hours between 1 and 720");
  }
  // hub.host is the operator bind address (PORCH-025). Like the ports, it is
  // validated at normalize time — a value that could never be a bind host
  // (empty, whitespace, a URL with a scheme/path) fails loudly instead of
  // surfacing later as a boot failure without diagnostics.
  const bindHost = merged.hub.host;
  if (typeof bindHost !== "string" || !bindHost || /[\s/\\:%]/.test(bindHost)) {
    throw new Error("config hub.host must be a bind address (e.g. \"127.0.0.1\" for loopback plus tunnel, or \"0.0.0.0\" for LAN reachability)");
  }
  // Phase-3 mode name is its contract (Porchlight Server TS 6): an
  // identity-only hub hosts accounts with no network attached, so social
  // serving is off and identity serving stays on — derived at runtime,
  // never a build-time fork. Hosted and self-hosted keep the flags
  // owner-choosable (configuration may disable identity serving for hosted
  // network modes).
  if (merged.mode.deploymentMode === "identity-only") {
    merged.mode.socialServingEnabled = false;
    merged.mode.identityServingEnabled = true;
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
        async deleteOne(filter = {}) {
          const target = doc(filter);
          if (!target) return { deletedCount: 0 };
          rows.splice(rows.indexOf(target), 1);
          return { deletedCount: 1 };
        },
        async deleteMany(filter = {}) {
          const doomed = rows.filter((row) => matches(row, filter));
          for (const row of doomed) rows.splice(rows.indexOf(row), 1);
          return { deletedCount: doomed.length };
        },
      };
    },
  };
}