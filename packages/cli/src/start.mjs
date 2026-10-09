// `porchlight start` — bring the hub up: ensure setup state, start Mongo and
// Redis on the installer-managed ports, start the hub server, start the
// tunnel, then print the hub URL prompt (works from any device; bootstrap
// prompts go through the tunnel, not localhost-only). Automatic restart is
// the supervisor's contract; launchd/systemd keep the supervisor alive.
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { saveConfig } from "@porchlight/shared";
import { Supervisor, configFromPathsOrThrow, serverEntryPath, writeSupervisorState, supervisorRunningState, reclaimStaleChildren } from "./supervisor.mjs";
import { ensureDirs, home, clearStateFile } from "./state.mjs";
import { ensureCloudflared, ensureRedis, ensureMongod } from "./binaries.mjs";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

export async function run(args = {}) {
  const paths = home({ PORCHLIGHT_HOME: args.home ?? process.env.PORCHLIGHT_HOME });
  ensureDirs(paths);
  let running = supervisorRunningState(paths);
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

  supervisor.spawnChild("hub", process.execPath, [serverEntry, "--serve", "--porchlight-home", paths.root], {});

  if (args.tunnel && config.hub.tunnel.enabled) {
    const cloudflared = await ensureCloudflared(paths.root, () => {});
    spawnTunnel(supervisor, paths, config, cloudflared);
  }

  process.stdout.write(
    `porchlight hub starting on http://127.0.0.1:${config.hub.httpPort} ` +
      `(mongo :${config.daemons.mongoPort}, redis :${config.daemons.redisPort})\n`,
  );
  process.stdout.write(
    "Process supervision active: crashed children restart automatically. " +
      "Run `porchlight service install` to keep the hub alive across reboots (launchd-class).\n",
  );

  await runSupervisorLoop(supervisor, paths);
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

const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function spawnTunnel(supervisor, paths, config, cloudflared) {
  supervisor.spawnChild(
    "tunnel",
    cloudflared,
    ["tunnel", "--url", `http://127.0.0.1:${config.hub.httpPort}`, "--no-autoupdate"],
    { ready: tunnelReadyWatcher(paths, config) },
  );
}

function tunnelReadyWatcher(paths, config) {
  return (_name, proc, signalReady) => {
    for (const channel of ["stderr", "stdout"]) {
      proc[channel].on("data", (chunk) => {
        const match = TUNNEL_URL_PATTERN.exec(chunk.toString());
        if (!match) return;
        const url = match[0];
        const updated = structuredClone(config);
        updated.hub.tunnel.url = url;
        writeTunnelState(paths, url);
        // The tunnel binding is runtime config the hub health surface reads.
        saveConfig(paths.root, updated);
        process.stdout.write(
          `\nHub is tunnel-reachable: ${url}\n` +
            `Remote bootstrap: open ${url}/bootstrap on any device (phone on cellular works).\n` +
            "From a terminal here: `porchlight bootstrap` drives setup on the owner's behalf.\n",
        );
        signalReady();
      });
    }
    void proc;
  };
}

function writeTunnelState(paths, url) {
  const { mkdirSync, writeFileSync } = require("node:fs");
  const file = join(paths.state, "tunnel.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ url, startedAt: new Date().toISOString() }, null, 2) + "\n");
}