// `porchlight status` — local-only diagnostics: supervisor and child
// processes, tunnel reachability note, runtime config summary, and the
// resumable-bootstrap ledger state (fetched over HTTP from the hub).
import { join } from "node:path";
import { supervisorRunningState, readChildStateByPaths } from "./supervisor.mjs";
import { home, readJson } from "./state.mjs";
import { loadHomeConfig, hubJson } from "./httpx.mjs";

export async function run(args = {}) {
  const paths = home({ PORCHLIGHT_HOME: args.home ?? process.env.PORCHLIGHT_HOME });
  const supervisor = supervisorRunningState(paths);
  process.stdout.write(`home:        ${paths.root}\n`);
  process.stdout.write(`supervisor:  ${supervisor ? `running (pid ${supervisor.pid})` : "not running"}\n`);

  for (const name of ["mongo", "redis", "hub", "tunnel"]) {
    const child = readChildStateByPaths(paths, name);
    if (!child) {
      process.stdout.write(`${name}:\n  (no journaled state — never started since last clear)\n`);
      continue;
    }
    process.stdout.write(
      `${name}: pid=${child.pid ?? "—"} restarts=${child.restarts ?? 0}` +
        `${child.lastExitCode != null ? ` lastExit=${child.lastExitCode}` : ""}` +
        `${child.lastError ? ` lastError="${child.lastError}"` : ""}\n`,
    );
  }

  const tunnel = readJson(join(paths.state, "tunnel.json"));
  const identity = readJson(join(paths.root, "tunnel", "identity.json"));
  if (identity?.mode) {
    process.stdout.write(
      `tunnel:      ${tunnel?.url ?? "not established"} (named ${identity.tunnelId ?? "—"}, ` +
        `host ${identity.hostname ?? "not recorded"}, mode ${identity.mode} — re-bound on every start)\n`,
    );
  } else {
    process.stdout.write(
      `tunnel:      ${tunnel?.url ?? "not established"} (ephemeral quick tunnel — URL churns per boot; ` +
        "bind: `cloudflared tunnel login` once, then `porchlight tunnel mint --hostname <your-host>`)\n",
    );
  }

  try {
    const { config } = loadHomeConfig(args);
    process.stdout.write(
      `mode:        ${config.mode.deploymentMode} (identity=${config.mode.identityServingEnabled} social=${config.mode.socialServingEnabled})\n`,
    );
    process.stdout.write(`quota:       ${JSON.stringify(config.quota)}\n`);
    const state = (await hubJson(config, "/api/bootstrap/state")).body;
    process.stdout.write(
      `bootstrap:   ${Object.entries(state.steps).map(([step, record]) => `${step}=${record.status}`).join(" ")}\n`,
    );
    if (state.lastError) process.stdout.write(`last error:  ${state.lastError}\n`);
  } catch (error) {
    process.stdout.write(`bootstrap:   (unavailable — ${error.message})\n`);
  }
}