// `porchlight start` — bring the hub up: ensure setup state, start Mongo and
// Redis on the installer-managed ports, start the hub server, start the
// tunnel, then print the hub URL prompt (works from any device; bootstrap
// prompts go through the tunnel, not localhost-only). Automatic restart is
// the supervisor's contract; launchd/systemd keep the supervisor alive.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import {
  Supervisor,
  configFromPathsOrThrow,
  serverEntryPath,
  writeSupervisorState,
  supervisorRunningState,
  reclaimStaleChildren,
  hubReadyProbe,
  hubFallbackState,
  clearHubFallbackState,
  readChildStateByPaths,
} from "./supervisor.mjs";
import { ensureDirs, home, clearStateFile } from "./state.mjs";
import { ensureCloudflared, ensureRedis, ensureMongod } from "./binaries.mjs";
import { loadTunnelIdentity, mintTunnelIdentity, spawnTunnel } from "./tunnel-identity.mjs";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

export async function run(args = {}) {
  const paths = home({ PORCHLIGHT_HOME: args.home ?? process.env.PORCHLIGHT_HOME });
  ensureDirs(paths);
  // A fresh start is a fresh cycle: any earlier crash-loop fallback was for
  // the previous run (the owner has acted — stop/reinstall/start).
  clearHubFallbackState(paths);
  const installedVersion = version;
  let running = supervisorRunningState(paths);
  if (running?.version && running.version !== installedVersion) {
    // Release mixing diagnostic (PORCH-016 ac-5): an owner-run npm update
    // lands on disk while the old supervisor still serves the old release.
    // Never silent — the version gap is named at every start until the
    // restart actually applies it.
    process.stdout.write(
      `release update detected: supervisor running v${running.version}, installed v${installedVersion} — ` +
        "complete the update: `porchlight stop`, `porchlight start` (npm's rollback semantics cover a failed install).\n",
    );
  }
  if (running) {
    // A still-running-but-shutting-down predecessor must not wedge a re-run:
    // wait briefly for it to clear (its children hold the ports).
    const startedAt = Date.now();
    while (running && Date.now() - startedAt < 10_000) {
      await new Promise((wait) => setTimeout(wait, 500));
      running = supervisorRunningState(paths);
    }
    if (running) {
      process.stdout.write(
        `porchlight is already running (supervisor pid ${running.pid}). Use \`porchlight status\` or \`porchlight stop\`.\n`,
      );
      return;
    }
  }
  // A supervisor that died outright (SIGKILL) may have left orphaned
  // children holding ports — reclaim them before spawning replacements.
  reclaimStaleChildren(paths);

  const config = configFromPathsOrThrow(paths);
  const mongod = await ensureMongod(paths.root, () => {});
  const redisServer = await ensureRedis(paths.root, () => {});
  const serverEntry = serverEntryPath();
  if (!existsSync(serverEntry)) {
    throw new Error(
      `hub server entry missing at ${serverEntry} — ` +
        "(published installs bundle it; in the repo run `npm run build` first)",
    );
  }
  if (!existsSync(redisServer)) throw new Error(`redis-server missing at ${redisServer} — re-run \`porchlight setup\``);
  if (!existsSync(mongod)) throw new Error(`mongod missing at ${mongod} — re-run \`porchlight setup\``);

  writeSupervisorState(paths, { version, httpPort: config.hub.httpPort });
  const supervisor = new Supervisor(paths, config);

  supervisor.spawnChild(
    "mongo",
    mongod,
    [
      "--dbpath", paths.mongoData,
      "--port", String(config.daemons.mongoPort),
      "--bind_ip", "127.0.0.1",
      "--quiet",
    ],
    { ready: mongodReadyProbe(config.daemons.mongoPort) },
  );

  supervisor.spawnChild(
    "redis",
    redisServer,
    ["--port", String(config.daemons.redisPort), "--dir", paths.redisData],
    { ready: redisReadyProbe(config.daemons.redisPort) },
  );

  supervisor.spawnChild(
    "hub",
    process.execPath,
    [serverEntry, "--serve", "--porchlight-home", paths.root],
    { ready: hubReadyProbe(config) },
  );

  if (args.tunnel && config.hub.tunnel.enabled) {
    const cloudflared = await ensureCloudflared(paths.root, () => {});
    // Tunnel identity persistence (PORCH-017): re-bind the stored tunnel every
    // start; provision only when nothing is stored yet (first bootstrap).
    let identity = loadTunnelIdentity(paths);
    if (!identity) {
      try {
        identity = await mintTunnelIdentity(paths, cloudflared, { hostname: args.tunnelHostname ?? null }, (m) => {
          process.stdout.write(`tunnel: ${m}\n`);
        });
        process.stdout.write(
          `tunnel provisioned and persisted (named ${identity.tunnelId ?? "id not decodable"}); it re-binds identically on every future start.\n`,
        );
      } catch (error) {
        process.stdout.write(
          `warning: persistent tunnel unavailable (${error.message}). Booting an ephemeral quick tunnel — ` +
            "its URL churns per boot and every member-facing link embedding it breaks. " +
            "Bind once: run `cloudflared tunnel login` (one-time), then `porchlight tunnel mint --hostname <your-host>`.\n",
        );
      }
    }
    spawnTunnel(supervisor, paths, config, cloudflared, identity);
  }

  // The bind address (PORCH-025) is reported whenever it widens the default
  // loopback posture; the loopback URL stays the always-valid local one.
  const bind =
    config.hub.host && config.hub.host !== "127.0.0.1"
      ? `, bind ${config.hub.host} (LAN reachable)`
      : "";
  process.stdout.write(
    `porchlight hub starting on http://127.0.0.1:${config.hub.httpPort}${bind} ` +
      `(mongo :${config.daemons.mongoPort}, redis :${config.daemons.redisPort})\n`,
  );
  process.stdout.write(
    "Process supervision active: crashed children restart automatically. " +
      "Run `porchlight service install` to keep the hub alive across reboots (launchd-class).\n",
  );

  await waitForPostStartVerification(supervisor, paths, installedVersion);
  await runSupervisorLoop(supervisor, paths);
}

/**
 * Post-start verification (PORCH-016 ac-1/ac-2): once the hub child passes
 * its health ready probe, the verification is journaled (named, local-only);
 * if the child exhausts its restart budget instead, the named crash-loop
 * fallback is printed with its diagnosis and recovery line. Either way the
 * supervisor loop keeps the process idling — under launchd KeepAlive an
 * exited start would just respawn into the same failures.
 */
async function waitForPostStartVerification(supervisor, paths, installedVersion, timeoutMs = 600_000) {
  const startedAt = Date.now();
  for (;;) {
    const fallback = supervisor.fallbackState() ?? hubFallbackState(paths);
    if (fallback) {
      process.stdout.write(
        `named fallback: ${fallback.state} — ${fallback.child} failed ${fallback.failedAttempts} ` +
          `consecutive starts without readiness\n` +
          `  diagnosis: ${fallback.lastError}\n` +
          `  hub log: ${fallback.log}\n` +
          `  recovery: reinstall the previous release (npm install -g porchlight@<previous>), ` +
          "then `porchlight stop` and `porchlight start`\n",
      );
      return;
    }
    const hubState = readChildStateByPaths(paths, "hub");
    if (hubState?.running && hubState.lastError == null) {
      process.stdout.write(`post-start verification passed: hub healthy (release v${installedVersion})\n`);
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      const message =
        "post-start health smoke check failed: the hub did not report healthy within 600s (check: post-start health smoke check)";
      supervisor.journalFailure("hub", message);
      process.stdout.write(`post-start verification failed: ${message}\n`);
      return;
    }
    await new Promise((wait) => setTimeout(wait, 500));
  }
}

/** Foreground supervisor; SIGINT/SIGTERM stop the whole group. */
async function runSupervisorLoop(supervisor, paths) {
  const shutdown = async (signal) => {
    process.stdout.write(`porchlight: ${signal} — stopping the hub process group\n`);
    await supervisor.stop();
    clearStateFile(paths, "supervisor");
    clearStateFile(paths, "tunnel");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // Idle keepalive (composition finding, PORCH-016): once the crash-loop
  // fallback stops the whole process group, no child handles hold the event
  // loop — an idle foreground supervisor would silently exit, and under
  // launchd KeepAlive launchd would immediately respawn it into the same
  // crash-loop. The running-but-idle supervisor process is the stable,
  // nameable fallback state, so the loop stays alive until a signal.
  setInterval(() => {}, 30_000);
  await new Promise(() => {}); // run until signaled
}

function mongodReadyProbe(port) {
  return async (name, proc, signalReady) => {
    const { MongoClient } = await import("mongodb");
    const startedAt = Date.now();
    for (;;) {
      const client = new MongoClient(`mongodb://127.0.0.1:${port}/admin?directConnection=true&serverSelectionTimeoutMS=1000`);
      try {
        await client.connect();
        await client.db("admin").command({ ping: 1 });
        await client.close();
        signalReady(name);
        return;
      } catch {
        await client.close().catch(() => {});
        if (proc.exitCode != null) return; // daemon failed to start; supervisor restarts
        if (Date.now() - startedAt > 60_000) return;
        await new Promise((wait) => setTimeout(wait, 500));
      }
    }
  };
}

function redisReadyProbe(port) {
  return async (name, _proc, signalReady) => {
    const { createClient } = await import("redis");
    const client = createClient({ url: `redis://127.0.0.1:${port}` });
    const startedAt = Date.now();
    for (;;) {
      try {
        await client.connect();
        await client.ping();
        await client.quit();
        signalReady(name);
        return;
      } catch {
        if (Date.now() - startedAt > 60_000) {
          await client.disconnect().catch(() => {});
          return;
        }
        await new Promise((wait) => setTimeout(wait, 500));
      }
    }
  };
}
