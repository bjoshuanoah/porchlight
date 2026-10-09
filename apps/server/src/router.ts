import express, { Router } from "express";
import { createSystemRouter } from "./routes/system.routes.js";
import { createIdentityRouter } from "@porchlight/identity";
import { createSocialRouter } from "@porchlight/social";
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
export function createServerRouter(options: ServerOptions): Router {
  const router: Router = Router();
  // The tunnel URL is captured by the supervisor after the server booted, so
  // health/bootstrap surfaces re-read the runtime config instead of holding
  // a stale copy (config file stays the single source of truth).
  const hubUrl = options.hubUrl ?? readTunnelUrl(options);
  const ledger = {
    record: (step: string, detail?: { detail?: string; inviteId?: string }) =>
      options.bootstrap.record(step as BootstrapStep, detail),
    hubUrl,
  };
  const hub = new HealthService(options.readiness ?? DOWN_PROBES, options.config.mode, hubUrl);
  router.use("/", createSystemRouter(hub, options.bootstrap));
  if (options.store && options.config.mode.identityServingEnabled) {
    router.use("/identity", createIdentityRouter({ store: options.store, ledger }));
  }
  if (options.store && options.config.mode.socialServingEnabled) {
    router.use("/social", createSocialRouter({ store: options.store, ledger }));
  }
  return router;
}

function readTunnelUrl(options: ServerOptions): () => string | null {
  // The supervisor rewrites the runtime config when the tunnel binds, so the
  // server re-reads it per call instead of holding a stale copy — the config
  // file remains the single source of truth (never a fork).
  return () => loadConfig(options.bootstrap.configDir)?.hub.tunnel.url ?? null;
}

/** App factory. Null store/readiness = system surfaces only (dependency-less use). */
export function createServer(options: ServerOptions) {
  const app = express();
  app.use(express.json());
  app.use("/api", createServerRouter(options));
  app.get("/bootstrap", (_req, res) => {
    res.type("html").send(bootstrapPage());
  });
  return app;
}