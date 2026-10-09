// Tunnel identity persistence (PORCH-017): the hub re-binds the same Cloudflare
// tunnel on every start so the public URL (and every member-facing artifact
// that embeds it — configured server URLs, invite/join links) never churns per
// boot. Provisioned credentials live at rest under <home>/tunnel/:
//
//   identity.json     the persisted tunnel identity (mode, tunnelId, hostname)
//   credentials.json  named-tunnel credentials JSON (mode "credentials")
//   token             dashboard tunnel token (mode "token", remote-managed)
//   cert.pem          one-time `cloudflared tunnel login` origin cert (optional;
//                     ~/.cloudflared/cert.pem is also honored)
//
// Fresh provisioning happens only when no identity exists (first bootstrap) or
// through the explicit `porchlight tunnel reset`/`tunnel mint` paths. Once an
// identity is stored, start NEVER re-mints — it re-binds the stored identity
// every time. Pre-provision boots fall back to an ephemeral quick tunnel with
// a printed warning, since a persistent URL without owner-owned credentials
// does not exist.
import { saveConfig } from "@porchlight/shared";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export const NAMED_TUNNEL_NAME = "porchlight";

/** Ephemeral quick-tunnel URL the tunnel child prints at bind time. */
export const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** The line cloudflared prints when a named tunnel's edge connections are up. */
export const NAMED_TUNNEL_READY_PATTERN = /Registered tunnel connection/i;

const TUNNEL_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const CREDENTIALS_PATH_PATTERN = /credentials written to (\S+?\.json)\b/i;

const IDENTITY_MODES = new Set(["credentials", "token"]);

export function tunnelIdentityPath(paths) {
  return join(paths.root, "tunnel", "identity.json");
}

export function tunnelCredentialsPath(paths) {
  return join(paths.root, "tunnel", "credentials.json");
}

export function tunnelTokenPath(paths) {
  return join(paths.root, "tunnel", "token");
}

/** Owner-facing hostname entry: accepts bare host or full URL. */
export function normalizeHostname(input) {
  if (input == null || String(input).trim() === "") return null;
  const host = String(input).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) {
    throw new Error(`invalid tunnel hostname "${input}" — give a public host like hub.example.com`);
  }
  return host;
}

/** Origin cert for minting: <home>/tunnel/cert.pem first, then cloudflared's default. */
export function discoverOriginCertFile(paths) {
  const primary = join(paths.root, "tunnel", "cert.pem");
  if (existsSync(primary)) return primary;
  const fallback = join(homedir(), ".cloudflared", "cert.pem");
  return existsSync(fallback) ? fallback : null;
}

/** The stored identity, or null when nothing provisioned persists. */
export function loadTunnelIdentity(paths) {
  const file = tunnelIdentityPath(paths);
  if (!existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null; // corrupt identity file: treated as unprovisioned, warn caller
  }
  if (!raw || !IDENTITY_MODES.has(raw.mode) || !raw.mintedAt) return null;
  if (raw.mode === "credentials") {
    // Stored credentials gone (manual deletion) means a same-tunnel re-bind is
    // impossible; null re-enters provisioning instead of silently churning.
    if (!existsSync(tunnelCredentialsPath(paths)) || !raw.tunnelId || !TUNNEL_ID_PATTERN.test(raw.tunnelId)) {
      return null;
    }
  }
  if (raw.mode === "token" && !existsSync(tunnelTokenPath(paths))) return null;
  return { mode: raw.mode, tunnelId: raw.tunnelId ?? null, hostname: raw.hostname ?? null, mintedAt: raw.mintedAt };
}

/** Persist the identity at rest; the file itself is not secret but stays 0600. */
export function saveTunnelIdentity(paths, identity) {
  const file = tunnelIdentityPath(paths);
  mkdirSync(join(file, ".."), { recursive: true });
  const cleaned = {
    mode: identity.mode,
    tunnelId: identity.tunnelId ?? null,
    hostname: identity.hostname ?? null,
    mintedAt: identity.mintedAt ?? new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify(cleaned, null, 2) + "\n", { mode: 0o600 });
  return cleaned;
}

/** Explicit reset path: wipes identity + stored credentials + pasted token. */
export function resetTunnelIdentity(paths) {
  rmSync(tunnelIdentityPath(paths), { force: true });
  rmSync(tunnelCredentialsPath(paths), { force: true });
  rmSync(tunnelTokenPath(paths), { force: true });
}

/** Stored token file content (owner supplies it from the dashboard). */
export function readStoredToken(paths) {
  const file = tunnelTokenPath(paths);
  return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
}

/** Decode the tunnel id embedded in a Cloudflare tunnel token, when parseable. */
export function decodeTokenTunnelId(token) {
  try {
    const json = JSON.parse(Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return String(json.tunnel_id ?? json.t ?? "") || null;
  } catch {
    return null;
  }
}

/** cloudflared subprocess runner; the origin cert rides TUNNEL_ORIGINCERT. */
function cloudflaredRun(binary, args, originCert = undefined) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...(originCert ? { TUNNEL_ORIGINCERT: originCert } : {}) };
    execFile(binary, args, { timeout: 120_000, env }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`cloudflared ${args[0]} ${args[1] ?? ""} failed: ${(stderr || error.message).trim()}`));
        return;
      }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/**
 * Provisioning = explicit mint ("porchlight tunnel mint") or the first
 * bootstrap provision (no identity yet at start). A stored token file wins
 * over cert minting. With an origin cert, the named tunnel "porchlight" is
 * REUSED when it already exists on the account (tunnel list first) — mint
 * never creates a second tunnel on top of an existing one.
 */
export async function mintTunnelIdentity(paths, cloudflaredBinary, { hostname = null, log = () => {} } = {}) {
  const token = readStoredToken(paths);
  if (token) {
    const identity = saveTunnelIdentity(paths, {
      mode: "token",
      tunnelId: decodeTokenTunnelId(token),
      hostname: normalizeHostname(hostname),
    });
    log(`tunnel identity stored from the dashboard token (named ${identity.tunnelId ?? "id not decodable"})`);
    return identity;
  }

  const originCert = discoverOriginCertFile(paths);
  if (!originCert) {
    throw new Error(
      `no tunnel credentials to persist — run \`cloudflared tunnel login\` once and retry, or place the dashboard tunnel token at ${tunnelTokenPath(paths)}`,
    );
  }
  hostname = normalizeHostname(hostname);

  log("checking for an existing named tunnel…");
  const { stdout: listOut } = await cloudflaredRun(
    cloudflaredBinary,
    ["tunnel", "list", "-o", "json", "--origincert", originCert],
    originCert,
  );
  const existing = findNamedTunnel(listOut);
  let tunnelId;
  if (existing) {
    tunnelId = existing.id;
    log(`reusing existing named tunnel ${NAMED_TUNNEL_NAME} (${tunnelId})`);
  } else {
    const { stdout: created } = await cloudflaredRun(
      cloudflaredBinary,
      ["tunnel", "create", "--origincert", originCert, NAMED_TUNNEL_NAME],
      originCert,
    );
    tunnelId = pickTunnelId(created);
    if (!tunnelId) throw new Error("cloudflared tunnel create did not report a tunnel id");
    storeCredentials(paths, pickCredentialsPath(created, tunnelId, homedir()), originCert);
    log(`named tunnel created: ${tunnelId}`);
  }

  if (!existsSync(tunnelCredentialsPath(paths))) {
    // Pre-existing account tunnel whose local credentials file is absent:
    // fetch its run token from the account cert and bind in token mode.
    const { stdout: tokenOut } = await cloudflaredRun(cloudflaredBinary, ["tunnel", "token", tunnelId], originCert);
    mkdirSync(join(tunnelTokenPath(paths), ".."), { recursive: true });
    writeFileSync(tunnelTokenPath(paths), `${tokenOut.trim()}\n`, { mode: 0o600 });
    const identity = saveTunnelIdentity(paths, { mode: "token", tunnelId, hostname });
    log("run token stored for the existing tunnel (credentials file unavailable)");
    return identity;
  }

  if (hostname) {
    try {
      await cloudflaredRun(
        cloudflaredBinary,
        ["tunnel", "route", "dns", "--origincert", originCert, NAMED_TUNNEL_NAME, hostname],
        originCert,
      );
    } catch (error) {
      // A route that already exists (or points elsewhere) must not block the
      // bind — the hostname is served from the owner's Cloudflare DNS config.
      log(`DNS route for ${hostname} not (re)created: ${error.message}`);
    }
  }
  return saveTunnelIdentity(paths, { mode: "credentials", tunnelId, hostname });
}

/** Bind argv for the stored identity — same tunnel every boot, no fresh mint. */
export function boundTunnelArgs(paths, config, identity) {
  const local = `http://${config.hub.host ?? "127.0.0.1"}:${config.hub.httpPort}`;
  if (identity.mode === "token") {
    return ["tunnel", "run", "--url", local, "--no-autoupdate", "--token", readStoredToken(paths)];
  }
  return [
    "tunnel",
    "run",
    "--url",
    local,
    "--credentials-file",
    tunnelCredentialsPath(paths),
    identity.tunnelId,
    "--no-autoupdate",
  ];
}

/** Spawn the tunnel child: stored identity re-binds same tunnel; else quick fallback. */
export function spawnTunnel(supervisor, paths, config, cloudflared, identity) {
  if (identity?.mode) {
    // Stored identity: the same named tunnel re-binds on every start — the
    // public URL and every minted invite link survive the restart.
    supervisor.spawnChild("tunnel", cloudflared, boundTunnelArgs(paths, config, identity), {
      ready: namedTunnelReadyWatcher(paths, config, identity),
    });
    return;
  }
  // Pre-provision fallback: ephemeral quick tunnel (URL churns per boot).
  supervisor.spawnChild(
    "tunnel",
    cloudflared,
    ["tunnel", "--url", `http://127.0.0.1:${config.hub.httpPort}`, "--no-autoupdate"],
    { ready: quickTunnelReadyWatcher(paths, config) },
  );
}

function namedTunnelReadyWatcher(paths, config, identity) {
  return (_name, proc, signalReady) => {
    for (const channel of ["stderr", "stdout"]) {
      proc[channel].on("data", (chunk) => {
        if (!NAMED_TUNNEL_READY_PATTERN.test(chunk.toString())) return;
        const url = identity.hostname ? `https://${identity.hostname}` : null;
        persistTunnelBinding(paths, config, url, identity);
        if (url) {
          process.stdout.write(
            `\nHub is tunnel-reachable: ${url} (named tunnel ${identity.tunnelId} re-bound from stored credentials — no fresh tunnel is minted on restart).\n` +
              `Remote bootstrap: open ${url} in any browser (phone on cellular works) — the setup wizard asks for the network's name and who you are.\n` +
              "From a terminal here: `porchlight bootstrap` drives setup on the owner's behalf.\n",
          );
        } else {
          process.stdout.write(
            `\nNamed tunnel ${identity.tunnelId} is connected, but no public hostname is recorded, so no public URL is known yet.\n` +
              "Set the hostname: `porchlight tunnel mint --hostname <your-host>` (reuses the same tunnel).\n",
          );
        }
        signalReady();
      });
    }
  };
}

function quickTunnelReadyWatcher(paths, config) {
  return (_name, proc, signalReady) => {
    for (const channel of ["stderr", "stdout"]) {
      proc[channel].on("data", (chunk) => {
        const match = TUNNEL_URL_PATTERN.exec(chunk.toString());
        if (!match) return;
        const url = match[0];
        persistTunnelBinding(paths, config, url, null);
        process.stdout.write(
          `\nHub is tunnel-reachable: ${url} (EPHEMERAL quick tunnel — this URL churns per boot; bind a persistent one: ` +
            "`cloudflared tunnel login` once, then `porchlight tunnel mint --hostname <your-host>`).\n" +
            `Remote bootstrap: open ${url} in any browser (phone on cellular works) — the setup wizard asks for the network's name and who you are.\n` +
            "From a terminal here: `porchlight bootstrap` drives setup on the owner's behalf.\n",
        );
        signalReady();
      });
    }
  };
}

/** One write path for the binding the hub health/bootstrap surfaces read. */
function persistTunnelBinding(paths, config, url, identity) {
  const updated = structuredClone(config);
  updated.hub.tunnel.url = url;
  writeTunnelState(paths, {
    url,
    mode: identity?.mode ?? "quick",
    tunnelId: identity?.tunnelId ?? null,
    hostname: identity?.hostname ?? null,
  });
  // The tunnel binding is runtime config the hub health surface reads.
  saveConfig(paths.root, updated);
}

function writeTunnelState(paths, record) {
  const file = join(paths.state, "tunnel.json");
  mkdirSync(paths.state, { recursive: true });
  writeFileSync(file, JSON.stringify({ ...record, startedAt: new Date().toISOString() }, null, 2) + "\n");
}

function findNamedTunnel(jsonOut) {
  const start = jsonOut.indexOf("[");
  if (start === -1) return null;
  try {
    const tunnels = JSON.parse(jsonOut.slice(start));
    return Array.isArray(tunnels) ? (tunnels.find((t) => t?.name === NAMED_TUNNEL_NAME) ?? null) : null;
  } catch {
    return null;
  }
}

function pickTunnelId(output) {
  return output.match(TUNNEL_ID_PATTERN)?.[0] ?? null;
}

function pickCredentialsPath(output, tunnelId, cloudflaredDefaultDir) {
  const match = output.match(CREDENTIALS_PATH_PATTERN);
  if (match) return match[1];
  // Older builds print only the id; the credentials file lands next to the cert.
  const guess = join(cloudflaredDefaultDir, ".cloudflared", `${tunnelId}.json`);
  return existsSync(guess) ? guess : null;
}

/** Store the provisioning credentials locally; the file carries the secret. */
function storeCredentials(paths, sourcePath, _originCert) {
  if (!sourcePath || !existsSync(sourcePath)) {
    throw new Error("cloudflared tunnel create did not report a readable credentials file");
  }
  const target = tunnelCredentialsPath(paths);
  mkdirSync(join(target, ".."), { recursive: true });
  // credentials.json carries the tunnel secret — never world-readable.
  writeFileSync(target, readFileSync(sourcePath, "utf8"), { mode: 0o600 });
}