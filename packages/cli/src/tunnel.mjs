// `porchlight tunnel` — tunnel identity management (PORCH-017):
//
//   porchlight tunnel            identity + last-bound URL diagnostics
//   porchlight tunnel mint       provision/refresh the stored identity (explicit)
//   porchlight tunnel reset      wipe identity + credentials; next start provisions
//                                anew (the only fresh-mint path besides first run)
//
// mint sources, in order: a dashboard tunnel token dropped at
// <home>/tunnel/token, then a `cloudflared tunnel login` origin cert (which
// reuses the existing named tunnel "porchlight" when one already exists on
// the account and only creates one when it does not).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { supervisorRunningState } from "./supervisor.mjs";
import { home, readJson } from "./state.mjs";
import { ensureCloudflared } from "./binaries.mjs";
import {
  mintTunnelIdentity,
  normalizeHostname,
  resetTunnelIdentity,
  tunnelCredentialsPath,
  tunnelTokenPath,
} from "./tunnel-identity.mjs";

export async function run(args = {}) {
  const paths = home({ PORCHLIGHT_HOME: args.home ?? process.env.PORCHLIGHT_HOME });
  const [sub = "status"] = args._;

  if (sub === "status") return tunnelStatus(paths);
  if (sub === "mint") return mint(paths, args);
  if (sub === "reset") return reset(paths);
  process.stderr.write(
    `porchlight tunnel: unknown subcommand "${sub}" (expected status, mint, reset)\n`,
  );
  process.exit(1);
}

function tunnelStatus(paths) {
  const identity = identitySummary(paths);
  const binding = readJson(join(paths.state, "tunnel.json"));
  if (identity) {
    process.stdout.write(
      `tunnel identity: named ${identity.tunnelId ?? "—"} (mode ${identity.mode}, host ${identity.hostname ?? "not recorded"}, minted ${identity.mintedAt}) — ` +
        "re-bound from these credentials on every start; fresh mint only via `porchlight tunnel reset`.\n",
    );
  } else {
    process.stdout.write(
      "tunnel identity: none persisted — every boot mints an ephemeral quick tunnel (URL churns per boot).\n" +
        "Bind once for a stable hostname: `cloudflared tunnel login` (one-time), then `porchlight tunnel mint --hostname <your-host>`, " +
        `or drop a dashboard tunnel token at ${tunnelTokenPath(paths)}.\n`,
    );
  }
  process.stdout.write(
    `tunnel binding: ${binding?.url ?? "not established since last start"}` +
      `${binding?.mode ? ` (${binding.mode}${binding.tunnelId ? `, tunnel ${binding.tunnelId}` : ""})` : ""}\n`,
  );
}

function identitySummary(paths) {
  const file = join(paths.root, "tunnel", "identity.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { mode: "corrupt", tunnelId: null, hostname: null, mintedAt: null };
  }
}

async function mint(paths, args) {
  if (supervisorRunningState(paths)) {
    process.stdout.write("porchlight is running — `porchlight stop` before re-minting the tunnel.\n");
    process.exit(1);
  }
  const hostname = normalizeHostname(args.hostname); // errors loudly on a bad value
  const cloudflared = await ensureCloudflared(paths.root, (m) => process.stdout.write(`tunnel: ${m}\n`));
  const identity = await mintTunnelIdentity(paths, cloudflared, { hostname }, (m) =>
    process.stdout.write(`tunnel: ${m}\n`),
  );
  process.stdout.write(
    `tunnel identity stored (mode ${identity.mode}, named ${identity.tunnelId ?? "—"}, host ${identity.hostname ?? "not recorded"}).\n` +
      "Next start re-binds exactly this tunnel; run `porchlight start`.\n",
  );
}

function reset(paths) {
  if (supervisorRunningState(paths)) {
    process.stdout.write("porchlight is running — `porchlight stop` before resetting the tunnel identity.\n");
    process.exit(1);
  }
  const credentials = tunnelCredentialsPath(paths);
  resetTunnelIdentity(paths);
  process.stdout.write(
    `tunnel identity reset (identity, ${credentials} and the stored token wiped). ` +
      "The next `porchlight start` provisions a fresh tunnel; member-facing URLs minted under the old tunnel will stop resolving.\n",
  );
}