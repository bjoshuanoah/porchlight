import express, { Router } from "express";
import type { Express } from "express-serve-static-core";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSystemRouter } from "./routes/system.routes.js";
import { createFrontDoorRouter } from "./routes/frontdoor.routes.js";
import type { FrontDoorAccountService, FrontDoorDeviceService } from "./routes/frontdoor.routes.js";
import { assembleIdentityModule, treatAvatar } from "@porchlight/identity";
import { assembleSocialModule } from "@porchlight/social";
import { loadConfig, saveConfig } from "@porchlight/shared";
import { HealthService } from "./services/health.service.js";
import { UpdateService, npmInstaller, npmRegistry } from "./services/update.service.js";
import { ReauthService } from "./services/reauth.service.js";
import { loadVapidKeys } from "./services/push-keys.js";
import type { PorchlightConfig, StoreLike } from "@porchlight/shared";
import type { BootstrapService, BootstrapStep } from "./services/bootstrap.service.js";
import type { Probe } from "./dependencies.js";
import type { RealtimeEndpointLike } from "./realtime-gateway.js";

/**
 * The running hub's Express app carries its assembled real-time surface so
 * the boot attaches the socket gateway exactly once, to the hub's own
 * HTTP server (PORCH-047). Undefined when social serving is disabled.
 */
export interface ExpressWithRealtime extends Express {
  realtime?: RealtimeEndpointLike;
}

export interface ServerOptions {
  store: StoreLike | null;
  readiness: { mongo: Probe; redis: Probe } | null;
  config: PorchlightConfig;
  bootstrap: BootstrapService;
  /** Live tunnel URL; defaults to re-reading the runtime config per call. */
  hubUrl?: () => string | null;
  /** Running hub release version; defaults to the server package's own. */
  version?: string | null;
  /**
   * Hub home root (PORCH-040 update surface). The machine-local ops token
   * for `porchlight update` lives under <homeRoot>/state (0600).
   */
  homeRoot?: string | null;
  /**
   * Graceful self-restart after a successful update apply (PORCH-040) —
   * the hub's own shutdown; the supervisor respawns the new release.
   * Defaults to exiting the process.
   */
  restart?: (() => void) | null;
  /** Built SPA directory; defaults to the files copied into the published server package. */
  webRoot?: string;
  /** PORCH-019: 401 capture sink; defaults to console.log (the supervisor
   *  pipes the hub child's stdout into logs/hub.log).
   */
  log?: ((line: string) => void) | null;
  /**
   * PORCH-065: the pre-commit verification's cross-origin fetch seam for the
   * console address action (stage-1 test hook). Defaults to globalThis.fetch.
   */
  verifyFetchImpl?: typeof fetch | null;
  /**
   * Real-time event plane (PORCH-047): the Redis-backed fan-out + replay
   * window adapter, created from deps.redis by the boot. Optional —
   * tests and daemon-less runs leave it unset and the social module's
   * in-memory plane serves (an event plane is never required to run the
   * REST hub: the degrade path IS the REST reads).
   */
  eventPlane?: unknown;
}

const DOWN_PROBES: { mongo: Probe; redis: Probe } = {
  mongo: async () => "down",
  redis: async () => "down",
};

/**
 * The og: tag set (PORCH-079) the shared-route HTML injection carries —
 * content-free by construction (fixed template frame + network name + the
 * composed image route + the canonical link, opaque ids only).
 */
export interface OgTagSet {
  title: string;
  image: string;
  url: string;
}

/**
 * The /api router aggregates the module routers plus the thin system routes
 * (health, bootstrap orchestration). Server performs no domain logic —
 * routes stay thin, controllers are transport-specific, services own the
 * models (inside the modules). The ledger callback is injected into the
 * module routers so bootstrap progress is recorded without any module
 * depending on the system layer.
 */
export function createServerRouter(options: ServerOptions): { api: Router; wellKnown: Router | null; realtime: unknown; ogTags: ((path: string) => Promise<OgTagSet | null>) | null } {
  const router: Router = Router();
  // Auth-scoped JSON is never cacheable: a browser-conditional revalidation
  // (304) carries no body, and a member's cached read would otherwise
  // silently degrade to empty on every revisit.
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  // The tunnel URL is captured by the supervisor after the server booted, so
  // health/bootstrap surfaces re-read the runtime config instead of holding
  // a stale copy (config file stays the single source of truth).
  const hubUrl = options.hubUrl ?? readTunnelUrl(options);
  const ledger = {
    record: (step: string, detail?: { detail?: string; inviteId?: string }) =>
      options.bootstrap.record(step as BootstrapStep, detail),
    hubUrl,
    // Bootstrap-era gate: the social module reads the ledger's step statuses
    // to decide whether a bootstrap write's era is still open. Fail-closed
    // is the module's rule — an unreadable ledger reads as a closed era.
    steps: async (): Promise<{
      account?: { status: string };
      network?: { status: string };
      invite?: { status: string };
      quota?: { status: string };
    }> => {
      // PORCH-020 narrowed the flow to account + network; legacy hubs may
      // still carry invite/quota rows recorded by the older flow, so every
      // row is passed through when present and omitted when absent — the
      // module-side era gate treats an absent row as an open era.
      const doc = await options.bootstrap.load();
      const rows: {
        account?: { status: string };
        network?: { status: string };
        invite?: { status: string };
        quota?: { status: string };
      } = {};
      for (const [step, record] of Object.entries(doc.steps) as [BootstrapStep, { status: string }][]) {
        rows[step] = { status: record.status };
      }
      return rows;
    },
  };
  const hub = new HealthService(options.readiness ?? DOWN_PROBES, options.config.mode, hubUrl);
  router.use("/", createSystemRouter(hub, options.bootstrap));
  // Owner-console release/launch surface (PORCH-011 ac-4): the running
  // release identity plus the bootstrap ledger's diagnostics. Update surface
  // (PORCH-040, Brian Oct 14, 2026): the same `system` injection carries the
  // ONE shared npm-backed update service behind both owner-initiated surfaces
  // (the console's update action and `porchlight update`). Still no registry
  // polling, no background update check, no background machinery anywhere:
  // the service fetches and applies ONLY inside an owner-initiated request.
  const update = new UpdateService({
    version: options.version ?? SERVER_PACKAGE_VERSION,
    registry: npmRegistry(),
    installer: npmInstaller(),
    opsTokenFile: options.homeRoot ? join(options.homeRoot, "state", "ops-token.json") : null,
    restart: options.restart ?? (() => process.exit(0)),
    log: options.log ?? null,
  });
  const system = {
    release: { service: "porchlight-server", version: options.version ?? SERVER_PACKAGE_VERSION },
    update,
    launch: async () => {
      const status = await options.bootstrap.status();
      return {
        resumable: status.resumable,
        lastError: status.lastError,
        steps: status.steps,
        diagnostics: status.diagnostics,
      };
    },
  };
  let wellKnown: Router | null = null;
  let frontDoor: Router | null = null;
  let ogTags: ((path: string) => Promise<OgTagSet | null>) | null = null;
  let identityModule: ReturnType<typeof assembleIdentityModule> | null = null;
  let identityAuth: {
    verifyAccessToken: (token: string) => Promise<{ did: string; sessionId: unknown } | null>;
    activeDeviceRegistration: (did: string, deviceId: string) => Promise<{ publicKeyJwk: Record<string, unknown>; [key: string]: unknown } | null>;
  } | null = null;
  let socialModule: ReturnType<typeof assembleSocialModule> | null = null;
  // PORCH-070: the member avatar plane — identity stores its rendition bytes
  // through the media pipeline's content-addressed blob store (same root,
  // same re-point) and SERVES to a member token of this hub; social
  // assembles after identity, so both adapters late-bind, and a hub running
  // identity alone refuses avatar storage plainly (never a silent no-op).
  let socialBlobs: {
    put: (key: string, bytes: Buffer) => Promise<unknown>;
    get: (key: string) => Promise<Buffer | null>;
    has: (key: string) => Promise<boolean>;
    delete: (key: string) => Promise<boolean>;
  } | null = null;
  /** The avatar store is unwired (no social serving): refuse plainly, never silently. */
  const avatarStoreDown = () => {
    const error: Error & { code?: string } = new Error("The hub's media storage isn't available, so photos can't be stored right now.");
    error.code = "E_AVATAR_UNAVAILABLE";
    return error;
  };
  interface AvatarBlobStore {
    put: (key: string, bytes: Buffer) => Promise<unknown>;
    get: (key: string) => Promise<Buffer | null>;
    has: (key: string) => Promise<boolean>;
    delete: (key: string) => Promise<boolean>;
  }
  const avatarBlobStore = (): AvatarBlobStore =>
    new Proxy({} as AvatarBlobStore, {
      get: (_target, method: string) => {
        if (method === "put") {
          return (key: string, bytes: Buffer) => (socialBlobs ? socialBlobs.put(String(key), bytes) : Promise.reject(avatarStoreDown()));
        }
        if (method === "get") return (key: string) => socialBlobs?.get(String(key)) ?? Promise.resolve(null);
        if (method === "has") return (key: string) => socialBlobs?.has(String(key)) ?? Promise.resolve(false);
        if (method === "delete") return (key: string) => socialBlobs?.delete(String(key)) ?? Promise.resolve(false);
        return undefined;
      },
    });
  /** Any member token of this hub opens the faces: identity session token, or the open turn's social membership token. */
  const avatarPerimeter = (): ((token: string | null) => Promise<{ did: string } | null>) => async (token) => {
    const identity = await identityAuth?.verifyAccessToken(token ?? "");
    const did: string | undefined | null =
      identity?.did
      ?? (await socialModule?.membershipService.verifyAccessToken(token ?? "", { surface: "avatar" }) as { session?: { did?: string }; membership?: { did?: string } } | null | undefined)?.session?.did
      ?? null;
    return did ? { did } : null;
  };
  // PORCH-065: the re-auth orchestration (system vertical). Declared before
  // the modules assemble so the identity consume-observer can late-bind to
  // it — social assembles after identity, and the reauth service needs both.
  let reauthService: ReauthService | null = null;
  if (options.store && options.config.mode.identityServingEnabled) {
    // The identity module assembles its own route → controller → service →
    // model path at its published entry; the server performs no domain logic.
    // Standards discovery surfaces (.well-known/*) mount at the host root, so
    // the app factory mounts them outside the /api prefix.
    // Identity keeps a record-only ledger: its bootstrap surface records
    // progress but carries no era gate (the gate is the social perimeter's).
    const identity = assembleIdentityModule(options.store, {
      hubUrl,
      ledger: { record: ledger.record },
      // PORCH-070: the avatar plane rides the media pipeline's blob store
      // (late-bound above — social assembles after identity) and serves to
      // any member token of this hub (identity sessions always; social
      // membership tokens once social is up).
      avatar: {
        blobs: avatarBlobStore(),
        // The serving perimeter (one verifier, both token planes): the
        // social perimeter resolves {membership, session}; the session
        // carries the did.
        verifyMemberToken: avatarPerimeter(),
      },
      // PORCH-026: second-hub identity adoption is flag-hidden (default off);
      // the runtime config flip re-enables the unchanged architecture.
      adoptionEnabled: options.config.identity.adoptionEnabled,
      // PORCH-019: 401 auth-failure capture.
      log: options.log ?? null,
      // PORCH-059: device notifications observe every owner-routed
      // device-link mint; the social push pipeline resolves downstream
      // (late-bound — social assembles after identity).
      onDeviceLinkMinted: (event) => socialModule?.pushService.notifyDeviceLink(event),
      // PORCH-065: the self-reauth grant's consumption triggers the
      // idempotent re-point, deriving the origin from the serving bind of
      // the consume request (transport-side, never owner-typed input);
      // ordinary device links flow unchanged. Late-bound — the reauth
      // service needs both modules.
      onDeviceLinkConsumed: (event: { did: string; purpose: string | null; serveOrigin?: string | null }) =>
        reauthService?.handleSelfGrantConsumed({ did: event.did, purpose: event.purpose, serveOrigin: event.serveOrigin ?? null }) ?? null,
    });
    identityModule = identity;
    router.use("/identity", identity.api);
    wellKnown = identity.wellKnown;
    identityAuth = {
      verifyAccessToken: (token: string) => identity.authService.verifyAccessToken(token),
      // The possession-proven device key (identity plane) — the social
      // founder binding copies it for write verification (PORCH-018).
      activeDeviceRegistration: (did: string, deviceId: string) => identity.authService.activeDeviceRegistration(did, deviceId),
    };
  }
  if (options.store && options.config.mode.socialServingEnabled) {
    // The social module assembles the full membership perimeter; identity is
    // referenced only by DID through the injected verifier callback — the
    // modules share zero code and the boundary check enforces it. The media
    // pipeline's content-addressed blob store roots under the hub config
    // directory (PORCH-008); its disk guard probes the same filesystem.
    socialModule = assembleSocialModule(options.store, {
      hubUrl,
      ledger,
      system,
      verifyMemberIdToken: identityAuth ? (token: string | null) => (token ? identityAuth!.verifyAccessToken(token) : Promise.resolve(null)) : undefined,
      registeredDeviceKey: identityAuth ? (did: string, deviceId: string) => identityAuth!.activeDeviceRegistration(did, deviceId) : undefined,
      // PORCH-029: the member directory joins membership rows with the
      // identity-plane display names through this injected callback — the
      // same DI boundary shape as the two resolvers above.
      memberNames: identityModule ? (dids: string[]) => identityModule.accountService.namesFor(dids) : undefined,
      // PORCH-031: the owner-bind handoff mints the single-use device-link
      // grant at founder binding through the identity device service —
      // same injected-callback boundary, no identity import anywhere.
      mintOwnerDeviceLink: identityModule
        ? (did: string) => identityModule.deviceService.mintDeviceLink({ did })
        : undefined,
      // PORCH-070: the member purge calls the identity-plane avatar
      // retirement in the same cascade — the avatar set dies with the
      // account record.
      purgeAvatar: identityModule
        ? (did: string) => identityModule.avatarService.retireFor(did)
        : undefined,
      // PORCH-088: the group-avatar write rides the identity plane's
      // member-avatar ingest treatment (the same deterministic square crop
      // then compression, geometry stamps, no rectangular original
      // retained) — the media pipeline's blob store binds below through
      // the media root.
      groupAvatar: identityModule
        ? { treatImage: (bytes: Buffer, contentType: string) => treatAvatar(bytes, contentType) }
        : undefined,
      media: {
        // PORCH-054: the media root is runtime configuration — the config
        // file's media.root (set at setup, editable post-install from the
        // owner console); null keeps the hub data-directory default
        // (created by the gate: the legitimate local install). The
        // owner's edit persists through persistRoot — the config file
        // stays the single source of truth — and re-points the running
        // pipeline without moving any bytes.
        mediaRoot: options.config.media.root ?? join(options.bootstrap.configDir, "media"),
        mediaRootIsDefault: options.config.media.root == null,
        persistRoot: (root: string) => {
          const current = loadConfig(options.bootstrap.configDir);
          if (!current) {
            throw new Error("the hub runtime config could not be re-read for the media root edit");
          }
          saveConfig(options.bootstrap.configDir, { ...current, media: { ...current.media, root } });
        },
        volumePollIntervalMs: options.config.media.volumePollSeconds * 1000,
        // PORCH-044: the rendition ladder rungs are owner-readable config.
        renditions: options.config.media.renditions,
      },
      // PORCH-047: the real-time event plane (Redis-backed in the hub
      // runtime) plus the replay window from the owner-readable config.
      realtime: {
        plane: options.eventPlane ?? null,
        replayHours: options.config.realtime.replayHours,
      },
      // PORCH-059: the hub's VAPID material — generated at first run by the
      // runtime setup, held in hub server state (never committed). Every
      // push carries the same VAPID identity across restarts, so member
      // subscriptions never churn per boot. The hub origin names the VAPID
      // subject (Apple's relay rejects non-DNS subjects; push-keys.ts).
      push: {
        vapid: loadVapidKeys(
          options.homeRoot ?? null,
          options.config.hub.tunnel?.url ?? null,
          options.log ?? undefined,
        ),
      },
      // PORCH-019: 401 auth-failure capture.
      log: options.log ?? null,
    });
    router.use("/social", socialModule.api);
    // PORCH-079: the og: tag resolver behind the shared-route HTML injection —
    // transport-level only. It matches the shareable deep-link paths (the
    // post detail route and the join-link route, exactly; every other path
    // yields null and the plain SPA document serves) and asks the social og
    // service for the content-free tag set. No credentials are consulted
    // anywhere in the chain, so a credentialed member's served HTML carries
    // the identical tags (ac-4) — no personalized variant exists.
    const ogTagMatcher: Array<{ pattern: RegExp; kind: "post" | "invite" }> = [
      { pattern: /^\/posts\/([^/]+)$/, kind: "post" },
      { pattern: /^\/join\/([^/]+)$/, kind: "invite" },
    ];
    ogTags = async (path: string): Promise<OgTagSet | null> => {
      const match = ogTagMatcher.find(({ pattern }) => pattern.test(path));
      if (!match || !socialModule) return null;
      let id: string | null = null;
      try {
        id = decodeURIComponent(path.replace(match.pattern, "$1"));
      } catch {
        id = null;
      }
      if (id === null || id.length === 0) return null;
      // The live tunnel URL of record rides in as the origin fallback: the
      // og service prefers the network row's re-pointed hub URL, then this.
      return socialModule.ogService.tags({ kind: match.kind, id, origin: hubUrl() });
    };
    // PORCH-070: the identity avatar plane's byte storage binds to the
    // media pipeline's store (same content-addressed root, same re-point —
    // the owner's media-root edit moves avatar bytes exactly as it moves
    // renditions).
    socialBlobs = socialModule.blobs;
    // PORCH-054 (ac-1): the health surface names the configured media root
    // and its readiness state (ready / volume not ready) — late-bound to
    // the social module's volume status, never a stale copy.
    hub.setMediaStatus(() => socialModule!.mediaVolume.status());
  }
  if (identityModule && socialModule) {
    // PORCH-065: the owner re-auth orchestration — the system-vertical
    // service behind both minting surfaces. The re-point writes the config
    // halves directly (the config file is the single source of truth, the
    // persistRoot pattern), composes the identity DID service and device
    // grant mint, and the social network row + audit surface through the
    // injected boundaries below; it owns no domain logic itself.
    reauthService = new ReauthService({
      configDir: options.bootstrap.configDir,
      networks: {
        get: () => socialModule!.networkService.get() as Promise<{ _id: string; ownerDid?: string | null; hubUrl?: string | null } | null>,
        recordHubUrl: (url: string) => socialModule!.networkService.recordHubUrl(url),
      },
      deviceService: identityModule.deviceService,
      didService: identityModule.didService,
      audit: (record) => socialModule!.auditService.record(record as never),
      hubUrl,
      // PORCH-065: the instance identity rides the health doc — the instance
      // provider wired here (late: the service exists only when both domains
      // serve; the identity mint persists once into the runtime config).
      // PORCH-019: 401 auth-failure capture.
      log: options.log ?? null,
      // PORCH-065: the pre-commit verification's cross-origin fetch seam.
      fetchImpl: options.verifyFetchImpl ?? null,
    });
    hub.setInstanceProvider(() => reauthService?.instanceId() ?? null);
    // PORCH-010: the SPA front door spans both domains (member identity
    // birth + owner-routed device links); composition routes stay transport-
    // level and mount only when both serving domains are enabled. The
    // re-auth console surfaces ride the same front door (identity refuses
    // cross-identity reads; the social perimeter authorizes the owner).
    frontDoor = createFrontDoorRouter({
      invites: socialModule.inviteService,
      networks: socialModule.networkService,
      membership: socialModule.membershipService,
      audit: (record) => socialModule!.auditService.record(record as never),
      accountService: identityModule.accountService as FrontDoorAccountService,
      deviceService: identityModule.deviceService as FrontDoorDeviceService,
      // PORCH-065: the re-auth orchestration + the machine-local ops-token
      // check (the CLI escape hatch's authentication, shared with the
      // update surface — one minted token, one compare).
      reauth: reauthService,
      verifyOpsToken: (token: string | null) => (token ? update.verifyToken(token) : false),
      hubUrl,
      // PORCH-019: 401 auth-failure capture.
      log: options.log ?? null,
    });
    router.use("/", frontDoor);
  }
  return { api: router, wellKnown, realtime: socialModule?.realtimeService ?? null, ogTags };
}

function readTunnelUrl(options: ServerOptions): () => string | null {
  // The supervisor rewrites the runtime config when the tunnel binds, so
  // the server re-reads it per call instead of holding a stale copy — the
  // config file remains the single source of truth (never a fork).
  return () => loadConfig(options.bootstrap.configDir)?.hub.tunnel.url ?? null;
}

/**
 * The running release version of this hub process — read from the server
 * package file that carries it (owner-run updates, Brian Oct 13, 2026, mean
 * npm swaps the package between restarts; the version is static for the
 * life of the process and no call ever consults a registry).
 */
const SERVER_PACKAGE_VERSION: string | null = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
})();

/** App factory. Null store/readiness = system surfaces only (dependency-less use). */
export function createServer(options: ServerOptions) {
  const app = express() as ExpressWithRealtime;
  app.use(express.json());
  const routers = createServerRouter(options);
  // PORCH-047: the assembled real-time surface rides the app so the boot
  // (index.ts) attaches the socket gateway to the hub's own HTTP server.
  app.realtime = (routers.realtime as RealtimeEndpointLike | null) ?? undefined;
  if (routers.wellKnown) {
    // RFC-style discovery paths live at the host root, not under /api.
    app.use("/", routers.wellKnown);
  }
  app.use("/api", routers.api);
  // Legacy bring-up URL (PORCH-020): the old server-rendered bootstrap page
  // is gone; every owner surfaces lands in the SPA's setup wizard. Keeping
  // the redirect preserves pre-printed instructions and old tunnel copy.
  app.get("/bootstrap", (_req, res) => {
    res.redirect("/setup");
  });

  // The build copies the private web workspace's output next to dist/router.js.
  // No web package is needed at runtime: published server/dist contains it.
  const webRoot = options.webRoot ?? fileURLToPath(new URL("./web/", import.meta.url));
  // The first-paint boot icon is tiny and stable across routine visits.
  // Reuse it without a round trip, but let replaced installs refresh within
  // an hour (the public filename is not content-addressed).
  const staticFiles = express.static(webRoot, {
    index: false,
    setHeaders(res, path) {
      if (path === join(webRoot, "icon-192.png")) {
        res.setHeader("Cache-Control", "public, max-age=3600");
      }
    },
  });
  const reservedPaths = /^\/(?:api|\.well-known|bootstrap)(?:\/|$)/;
  app.use((req, res, next) => {
    if (reservedPaths.test(req.path)) return next();
    staticFiles(req, res, next);
  });
  app.get("*", async (req, res, next) => {
    // Missing assets remain real 404s, not successful HTML responses.
    if (reservedPaths.test(req.path) || req.path.startsWith("/assets/") || extname(req.path)) return next();
    // PORCH-079: shareable routes (post deep links, join links) serve the SPA
    // document with the og: metas the unauthenticated unfetchers read — the
    // tag set is content-free, resolved from the path alone, so a
    // credentialed member request carries the identical HTML (ac-4). Any
    // other client route serves the plain document.
    try {
      const tags = routers.ogTags ? await routers.ogTags(req.path).catch(() => null) : null;
      if (!tags) return res.sendFile(join(webRoot, "index.html"));
      const html = await readFile(join(webRoot, "index.html"), "utf8");
      // Tag-bearing HTML must not cache (network renames change the tags; the
      // og IMAGES are the content-addressed, immutable layer).
      res.set("Content-Type", "text/html; charset=utf-8");
      res.set("Cache-Control", "no-store");
      return res.send(injectOgMetas(html, tags));
    } catch (error) {
      return next(error as Error);
    }
  });
  return app;
}

/** HTML-attribute escaping (og: meta content values are data-derived text). */
function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : char === '"' ? "&quot;" : "&#39;",
  );
}

/** The three required og: metas (PORCH-079 ac-4), injected at the top of <head>. */
export function injectOgMetas(html: string, tags: OgTagSet): string {
  const metas =
    `<meta property="og:title" content="${escapeHtmlAttribute(tags.title)}" />` +
    `<meta property="og:image" content="${escapeHtmlAttribute(tags.image)}" />` +
    `<meta property="og:url" content="${escapeHtmlAttribute(tags.url)}" />`;
  return html.replace(/<head[^>]*>/, (head) => `${head}${metas}`);
}