// `porchlight setup` — the dependency-complete bring-up prep (ac-1).
// Idempotent, re-runnable: creates the porchlight home, writes the runtime
// config the server later consumes (no extensive first-use config step),
// and downloads the installer-managed daemon + tunnel binaries. Every step
// reports progress; a failed step is re-run without redoing satisfied ones.
import { loadConfig, saveConfig } from "@porchlight/shared";
import {
  ensureCloudflared,
  ensureMongod,
  ensureRedis,
} from "./binaries.mjs";
import { ensureDirs, home, logsPath } from "./state.mjs";
import { appendFileSync } from "node:fs";

const log = (paths, message) => {
  const line = `[${new Date().toISOString()}] setup: ${message}`;
  process.stdout.write(line + "\n");
  appendFileSync(logsPath(paths, "setup"), line + "\n");
};

export async function run(args = {}) {
  const paths = home({ PORCHLIGHT_HOME: args.home ?? process.env.PORCHLIGHT_HOME });
  ensureDirs(paths);

  let config = loadConfig(paths.root);
  if (!config) {
    config = saveConfig(paths.root, {});
    log(paths, `runtime config written to ${paths.root}/config.json (defaults; the bootstrap page can change quota/mode later)`);
  } else {
    log(paths, `runtime config found at ${paths.root}/config.json — keeping existing settings`);
  }

  log(paths, "ensuring daemons (Mongo, Redis) and tunnel binary…");
  const mongod = await ensureMongod(paths.root, (m) => log(paths, m));
  log(paths, `mongod ready: ${mongod}`);
  const redisServer = await ensureRedis(paths.root, (m) => log(paths, m));
  log(paths, `redis-server ready: ${redisServer}`);
  const cloudflared = args.tunnel ? await ensureCloudflared(paths.root, (m) => log(paths, m)) : null;
  log(paths, `cloudflared ready: ${cloudflared}`);

  process.stdout.write(
    `setup complete.\nNext: run \`porchlight start\` — the server starts with this config and prints the hub URL for remote bootstrap.\n` +
      `Tunnel: \`start\` re-binds the persisted tunnel identity on every boot (PORCH-017). Before binding a persistent one: ` +
      "`cloudflared tunnel login` once, then `porchlight tunnel mint --hostname <your-host>`; until then a fresh ephemeral URL is minted per boot.\n",
  );
  return config;
}