import type { Server } from "node:http";
import type { Express } from "express";
import { connectDependencies, type Dependencies } from "./dependencies.js";
import { mongoStore } from "./store-adapter.js";
import { createServer } from "./router.js";
import { BootstrapService } from "./services/bootstrap.service.js";
import { homePaths, loadConfig } from "@porchlight/shared";

export interface BootResult {
  app: Express;
  deps: Dependencies;
  listen: () => Promise<Server>;
}

/**
 * Hub boot: load the runtime configuration the setup process created
 * (missing config = refuse loudly; no half-configured hub without
 * diagnostics), bind Mongo + Redis on the installer-managed daemon ports,
 * and assemble the app. The supervisor (porchlight start / launchd) is the
 * only supported runner; this module is the process entrypoint it spawns.
 */
export async function bootServer(): Promise<BootResult> {
  const home = homePaths(process.env);
  const config = loadConfig(home.root);
  if (!config) {
    throw new Error(
      "No porchlight runtime config at " + home.root + " — run `porchlight setup` first (a hub never starts half-configured).",
    );
  }
  const deps = await connectDependencies(config);
  const store = mongoStore(deps.db);
  const bootstrap = new BootstrapService(store, config, home.root);
  const app = createServer({ store, readiness: deps.readiness, config, bootstrap });
  const httpPort = config.hub.httpPort;
  const host = config.hub.host;
  return {
    app,
    deps,
    listen: () =>
      new Promise<Server>((resolve, reject) => {
        const server: Server = app.listen(httpPort, host, () => resolve(server));
        server.on("error", reject);
      }),
  };
}

export async function start(): Promise<void> {
  let boot: BootResult;
  try {
    boot = await bootServer();
  } catch (error) {
    // Diagnose loudly (exit 1); the supervisor restarts with backoff.
    process.stderr.write(`porchlight hub boot failed: ${(error as Error).message}\n`);
    process.exit(1);
  }
  const { deps, listen } = boot;
  let server: Server;
  try {
    server = await listen();
  } catch (error) {
    process.stderr.write(`porchlight hub listen failed: ${(error as Error).message}\n`);
    process.exit(1);
  }
  const shutdown = async () => {
    server.close();
    // The redis client can already be closed/reconnecting — quitting must
    // never turn a clean shutdown into a crash report.
    await deps.redis.quit().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  process.stdout.write("porchlight-server listening\n");
}

export default start;

// Entry detection: the supervisor spawns this file with `--serve`; imports
// from tests and the CLI never trigger a listener. (Symlinked workspace
// installs break import.meta.url comparisons, so the flag is explicit.)
if (process.argv.includes("--serve")) {
  void start();
}