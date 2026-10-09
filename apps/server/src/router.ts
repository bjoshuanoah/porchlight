import express, { Router } from "express";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSystemRouter } from "./routes/system.routes.js";
import { createFrontDoorRouter } from "./routes/frontdoor.routes.js";
import type { FrontDoorAccountService, FrontDoorDeviceService } from "./routes/frontdoor.routes.js";
import { assembleIdentityModule } from "@porchlight/identity";
import { assembleSocialModule } from "@porchlight/social";
import { bootstrapPage } from "./bootstrap.page.js";
import { loadConfig } from "@porchlight/shared";
import { HealthService } from "./services/health.service.js";
import type { PorchlightConfig, StoreLike } from "@porchlight/shared";
import type { BootstrapService, BootstrapStep } from "./services/bootstrap.service.js";
import type { Probe } from "./dependencies.js";

export interface ServerOptions {
  store: StoreLike | null;
  readiness: { mongo: Probe; redis: Probe } | null;
  config: PorchlightConfig;
  bootstrap: BootstrapService;
  /** Live tunnel URL; defaults to re-reading the runtime config per call. */
  hubUrl?: () => string | null;
  /** Running hub release version; defaults to the server package's own. */
  version?: string | null;
  /** Built SPA directory; defaults to the files copied into the published server package. */
  webRoot?: string;
}

const DOWN_PROBES: { mongo: Probe; redis: Probe } = {
  mongo: async () => "down",
  redis: async () => "down",
};

/**
 * The /api router aggregates the module routers plus the thin system routes
 * (health, bootstrap orchestration). Server performs no domain logic —
 * routes stay thin, controllers are transport-specific, services own the
 * models (inside the modules). The ledger callback is injected into the
 * module routers so bootstrap progress is recorded without any module
 * depending on the system layer.
 */
export function createServerRouter(options: ServerOptions): { api: Router; wellKnown: Router | null } {
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
      const doc = await options.bootstrap.load();
      const { account, network, invite, quota } = doc.steps;
      return {
        account: { status: account.status },
        network: { status: network.status },
        invite: { status: invite.status },
        quota: { status: quota.status },
      };
    },
  };
  const hub = new HealthService(options.readiness ?? DOWN_PROBES, options.config.mode, hubUrl);
  router.use("/", createSystemRouter(hub, options.bootstrap));
  // Owner-console release/launch surface (PORCH-011 ac-4): the running
  // release identity plus the bootstrap ledger's diagnostics. Owner-run
  // updates (Brian, Oct 13, 2026): this is a static read — no registry
  // polling, no update check, no background machinery anywhere.
  const system = {
    release: { service: "porchlight-server", version: options.version ?? SERVER_PACKAGE_VERSION },
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
  let identityModule: ReturnType<typeof assembleIdentityModule> | null = null;
  let identityAuth: { verifyAccessToken: (token: string) => Promise<{ did: string; sessionId: unknown } | null> } | null = null;
  let socialModule: ReturnType<typeof assembleSocialModule> | null = null;
  if (options.store && options.config.mode.identityServingEnabled) {
    // The identity module assembles its own route → controller → service →
    // model path at its published entry; the server performs no domain logic.
    // Standards discovery surfaces (.well-known/*) mount at the host root, so
    // the app factory mounts them outside the /api prefix.
    // Identity keeps a record-only ledger: its bootstrap surface records
    // progress but carries no era gate (the gate is the social perimeter's).
    const identity = assembleIdentityModule(options.store, { hubUrl, ledger: { record: ledger.record } });
    identityModule = identity;
    router.use("/identity", identity.api);
    wellKnown = identity.wellKnown;
    identityAuth = { verifyAccessToken: (token: string) => identity.authService.verifyAccessToken(token) };
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
      media: { mediaRoot: join(options.bootstrap.configDir, "media") },
    });
    router.use("/social", socialModule.api);
  }
  if (identityModule && socialModule) {
    // PORCH-010: the SPA front door spans both domains (member identity
    // birth + owner-routed device links); composition routes stay transport-
    // level and mount only when both serving domains are enabled.
    frontDoor = createFrontDoorRouter({
      invites: socialModule.inviteService,
      networks: socialModule.networkService,
      membership: socialModule.membershipService,
      audit: (record) => socialModule!.auditService.record(record as never),
      accountService: identityModule.accountService as FrontDoorAccountService,
      deviceService: identityModule.deviceService as FrontDoorDeviceService,
      hubUrl,
    });
    router.use("/", frontDoor);
  }
  return { api: router, wellKnown };
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
  const app = express();
  app.use(express.json());
  const routers = createServerRouter(options);
  if (routers.wellKnown) {
    // RFC-style discovery paths live at the host root, not under /api.
    app.use("/", routers.wellKnown);
  }
  app.use("/api", routers.api);
  app.get("/bootstrap", (_req, res) => {
    res.type("html").send(bootstrapPage());
  });

  // The build copies the private web workspace's output next to dist/router.js.
  // No web package is needed at runtime: published server/dist contains it.
  const webRoot = options.webRoot ?? fileURLToPath(new URL("./web/", import.meta.url));
  const staticFiles = express.static(webRoot, { index: false });
  const reservedPaths = /^\/(?:api|\.well-known|bootstrap)(?:\/|$)/;
  app.use((req, res, next) => {
    if (reservedPaths.test(req.path)) return next();
    staticFiles(req, res, next);
  });
  app.get("*", (req, res, next) => {
    // Missing assets remain real 404s, not successful HTML responses.
    if (reservedPaths.test(req.path) || req.path.startsWith("/assets/") || extname(req.path)) return next();
    res.sendFile(join(webRoot, "index.html"));
  });
  return app;
}