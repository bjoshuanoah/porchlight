// Tunnel identity persistence tests (PORCH-017): the same named tunnel
// re-binds on every start, stored credentials are reused, and a fresh mint
// happens only via the explicit reset path. A scripted fake cloudflared
// stands in for the real binary so the matrix stays deterministic without
// network (the real-network leg needs owner Cloudflare credentials).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

import { DEFAULT_CONFIG, homePaths, loadConfig, saveConfig } from "@porchlight/shared";
import {
  TUNNEL_URL_PATTERN,
  boundTunnelArgs,
  loadTunnelIdentity,
  mintTunnelIdentity,
  resetTunnelIdentity,
  saveTunnelIdentity,
  spawnTunnel,
  tunnelIdentityPath,
  tunnelCredentialsPath,
} from "../src/tunnel-identity.mjs";

const TUNNEL_ID = "63b0e0d1-1111-4222-8333-444455556666";
const HOSTNAME = "hub.family.example";

async function tempHome(t, prefix = "porchlight-tunnel-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => void rm(dir, { recursive: true, force: true }));
  return dir;
}

function tempPaths(dir) {
  return homePaths({ PORCHLIGHT_HOME: dir });
}

/** Fake cloudflared: journals every invocation; behaves per env toggles. */
async function writeFakeCloudflared(dir) {
  const bin = join(dir, "cloudflared");
  const script = `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLOUDFLARED_LOG, JSON.stringify(args) + "\\n");
const mode = process.env.FAKE_CLOUDFLARED_MODE;
const id = process.env.FAKE_TUNNEL_ID;
if (args[0] === "tunnel" && args[1] === "list") {
  const existing = mode === "cert-existing" ? [{ id, name: "porchlight" }] : [];
  process.stdout.write(JSON.stringify(existing) + "\\n");
} else if (args[0] === "tunnel" && args[1] === "create") {
  const file = process.env.FAKE_CLOUDFLARED_DIR + "/" + id + ".json";
  fs.mkdirSync(process.env.FAKE_CLOUDFLARED_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ AccountTag: "acct", TunnelSecret: "c2VjcmV0", TunnelID: id }));
  process.stdout.write("Tunnel credentials written to " + file + "\\nCreated tunnel porchlight with id " + id + "\\n");
} else if (args[0] === "tunnel" && args[1] === "route") {
  process.stdout.write("route dns ok\\n");
} else if (args[0] === "tunnel" && args[1] === "token") {
  process.stdout.write(Buffer.from(JSON.stringify({ t: id })).toString("base64") + "\\n");
} else if (args[0] === "tunnel" && args[1] === "run") {
  process.stdout.write("INF Starting tunnel tunnelID=" + id + "\\n");
  process.stdout.write("INF Registered tunnel connection connIndex=0 ip=198.41.192.67\\n");
  setInterval(() => {}, 9e9);
} else {
  process.stdout.write("https://ephemeral-" + process.pid + ".trycloudflare.com\\n");
  setInterval(() => {}, 9e9);
}`;
  await writeFile(bin, script, { encoding: "utf8", mode: 0o755 });
  return bin;
}

function spawnConfig(dir, hostname = HOSTNAME) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.hub.tunnel.hostname = hostname;
  saveConfig(dir, config);
  return config;
}

async function bindAndReadUrl(paths, config, fakeBinary, identity) {
  const { Supervisor } = await import("../src/supervisor.mjs");
  const { ensureDirs } = await import("../src/state.mjs");
  ensureDirs(paths);
  const supervisor = new Supervisor(paths, loadConfig(paths.root));
  spawnTunnel(supervisor, paths, loadConfig(paths.root), fakeBinary, identity);
  const file = join(paths.root, "state", "tunnel.json");
  for (let waited = 0; waited < 10000; waited += 100) {
    if (existsSync(file)) {
      const record = JSON.parse(readFileSync(file, "utf8"));
      if (record.url !== undefined && record.startedAt) {
        await supervisor.stop();
        return record;
      }
    }
    await new Promise((wait) => setTimeout(wait, 100));
  }
  await supervisor.stop();
  throw new Error("tunnel never became ready within 10s");
}

test("stored identity re-binds the same tunnel hostname on every restart (ac-1)", async (t) => {
  const dir = await tempHome(t);
  const paths = tempPaths(dir);
  const log = join(dir, "invocations.log");
  const fakeBinary = await writeFakeCloudflared(dir);
  process.env.FAKE_CLOUDFLARED_LOG = log;
  process.env.FAKE_CLOUDFLARED_DIR = dir;
  process.env.FAKE_CLOUDFLARED_MODE = "cert-existing";
  process.env.FAKE_TUNNEL_ID = TUNNEL_ID;
  const config = spawnConfig(dir);

  const identity = saveTunnelIdentity(paths, { mode: "credentials", tunnelId: TUNNEL_ID, hostname: HOSTNAME });
  mkdirHomeTunnelCreds(paths);

  // Boot 1: bind from the stored identity.
  const first = await bindAndReadUrl(paths, config, fakeBinary, identity);
  assert.equal(first.url, `https://${HOSTNAME}`);
  assert.equal(loadConfig(paths.root).hub.tunnel.url, `https://${HOSTNAME}`);

  // Boot 2 (the restart): a fresh supervisor, identity re-loaded from disk.
  const stored = loadTunnelIdentity(paths);
  assert.equal(stored.tunnelId, TUNNEL_ID, "identity survives the stop");
  const second = await bindAndReadUrl(paths, config, fakeBinary, stored);
  // Same reported public URL hostname as before the restart.
  assert.equal(second.url, first.url, "the reported URL hostname must be unchanged across restart");

  // ac-3: a link minted under the persisted tunnel still resolves to the hub
  // after the restart — minted under boot 1's URL, compared against boot 2's.
  const inviteLinkMintedBeforeRestart = `${first.url}/bootstrap`;
  assert.equal(inviteLinkMintedBeforeRestart.split("/bootstrap")[0], loadConfig(paths.root).hub.tunnel.url, "minted link's host still resolves to the hub");

  // No tunnel re-minted: the binds only invoke `tunnel run`.
  const invocations = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(
    invocations.every((args) => args[0] === "tunnel" && args[1] === "run"),
    `expected only run invocations, got ${JSON.stringify(invocations)}`,
  );
  const args = invocations[0];
  assert.deepEqual(args, ["tunnel", "run", "--url", "http://127.0.0.1:8710", "--credentials-file", tunnelCredentialsPath(paths), TUNNEL_ID, "--no-autoupdate"]);
});

test("stored credentials are reused; fresh mint only via the explicit reset path (ac-2)", async (t) => {
  const dir = await tempHome(t);
  const paths = tempPaths(dir);
  const log = join(dir, "invocations.log");
  const fakeBinary = await writeFakeCloudflared(dir);
  process.env.FAKE_CLOUDFLARED_LOG = log;
  process.env.FAKE_CLOUDFLARED_DIR = dir;
  process.env.FAKE_CLOUDFLARED_MODE = "cert-exists";
  process.env.FAKE_TUNNEL_ID = TUNNEL_ID;
  mkdir(paths);
  // First-ever bootstrap provision: mint the identity (origin cert present).
  mkdirHomeCert(paths);
  const identity = await mintTunnelIdentity(paths, fakeBinary, { hostname: HOSTNAME });
  assert.equal(identity.mode, "credentials");
  assert.equal(identity.tunnelId, TUNNEL_ID);
  assert.equal(identity.hostname, HOSTNAME);
  assert.ok(existsSync(tunnelCredentialsPath(paths)), "credentials.json stored at rest");
  assert.equal(loadTunnelIdentity(paths)?.tunnelId, TUNNEL_ID);

  // Later boots reuse the identity without provisioning again — already
  // covered by the ac-1 restart test's invocation journal (run-only); here the
  // explicit reset path is proven: it wipes identity + credentials, the very
  // next provision mints anew.
  resetTunnelIdentity(paths);
  assert.equal(loadTunnelIdentity(paths), null);
  assert.ok(!existsSync(tunnelCredentialsPath(paths)));
  process.env.FAKE_CLOUDFLARED_MODE = "cert-exists2";
  const reMinted = await mintTunnelIdentity(paths, fakeBinary, { hostname: HOSTNAME });
  assert.notEqual(reMinted.mintedAt, undefined);
  assert.equal(loadTunnelIdentity(paths).tunnelId, TUNNEL_ID);

  // The no-mint invariant at spawn time: with identity present only `tunnel
  // run` is invoked (asserted here via the args-grammar shortcut).
  const args = boundTunnelArgs(paths, spawnConfig(dir), loadTunnelIdentity(paths));
  assert.equal(args[0] + " " + args[1], "tunnel run");
});

test("named-token mode: dashboard token stored at rest re-binds with its own id (ac-2)", async (t) => {
  const dir = await tempHome(t);
  const paths = tempPaths(dir);
  mkdir(paths);
  const tokenPayload = JSON.stringify({ account_tag: "acct", tunnel_secret: "c2VjcmV0", tunnel_id: TUNNEL_ID });
  writeFileSync(join(paths.root, "tunnel", "token"), Buffer.from(tokenPayload).toString("base64") + "\n", { mode: 0o600 });
  const identity = await mintTunnelIdentity(paths, "/nonexistent/cloudflared", { hostname: `https://${HOSTNAME}/` });
  assert.equal(identity.mode, "token");
  assert.equal(identity.tunnelId, TUNNEL_ID); // decoded from the token payload
  assert.equal(identity.hostname, HOSTNAME); // full-URL input normalized
  // args grammar: token mode points at the stored token, never at a fresh mint
  process.env.FAKE_TUNNEL_ID = TUNNEL_ID;
  const args = boundTunnelArgs(paths, spawnConfig(dir), identity);
  assert.deepEqual(args, ["tunnel", "run", "--url", "http://127.0.0.1:8710", "--no-autoupdate", "--token", Buffer.from(tokenPayload).toString("base64")]);

  // Token mode re-binds through the supervisor watcher too.
  const log = join(dir, "invocations.log");
  const fakeBinary = await writeFakeCloudflared(dir);
  process.env.FAKE_CLOUDFLARED_LOG = log;
  process.env.FAKE_CLOUDFLARED_DIR = dir;
  const binding = await bindAndReadUrl(paths, spawnConfig(dir), fakeBinary, loadTunnelIdentity(paths));
  assert.equal(binding.url, `https://${HOSTNAME}`);
  assert.equal(binding.tunnelId, TUNNEL_ID);
});

test("LAN bind decoupling (PORCH-025): the tunnel target stays loopback for any bind address", async (t) => {
  const dir = await tempHome(t);
  const paths = tempPaths(dir);
  mkdir(paths);
  const tokenPayload = JSON.stringify({ account_tag: "acct", tunnel_secret: "c2VjcmV0", tunnel_id: TUNNEL_ID });
  writeFileSync(join(paths.root, "tunnel", "token"), Buffer.from(tokenPayload).toString("base64") + "\n", { mode: 0o600 });
  process.env.FAKE_TUNNEL_ID = TUNNEL_ID;
  const config = spawnConfig(dir);
  // The operator's LAN-facing bind (0.0.0.0) must never leak into the
  // cloudflared origin URL: a bind address is not connectable, and loopback
  // is always covered by the wider bind.
  config.hub.host = "0.0.0.0";
  for (const identity of [
    { mode: "token", tunnelId: TUNNEL_ID, hostname: HOSTNAME },
    { mode: "credentials", tunnelId: TUNNEL_ID, hostname: HOSTNAME },
  ]) {
    const args = boundTunnelArgs(paths, config, identity);
    assert.equal(args[3], "http://127.0.0.1:8710");
  }
});

test("pre-provision boots mint an ephemeral quick tunnel and persist no identity (fallback truthfulness)", async (t) => {
  const dir = await tempHome(t);
  const paths = tempPaths(dir);
  const fakeBinary = await writeFakeCloudflared(dir);
  process.env.FAKE_CLOUDFLARED_LOG = join(dir, "invocations.log");
  process.env.FAKE_CLOUDFLARED_DIR = dir;
  process.env.FAKE_CLOUDFLARED_MODE = "none";
  const config = spawnConfig(dir);

  assert.equal(loadTunnelIdentity(paths), null);
  const binding = await bindAndReadUrl(paths, config, fakeBinary, null);
  assert.match(binding.url, TUNNEL_URL_PATTERN, "quick-tunnel URL captured");
  assert.equal(binding.mode, "quick");
  assert.ok(!existsSync(tunnelIdentityPath(paths)), "ephemeral boot must NOT persist an identity");
  assert.match(loadConfig(paths.root).hub.tunnel.url, TUNNEL_URL_PATTERN);
});

test("mint reuses an existing account tunnel and never creates a second one (ac-2 invariant)", async (t) => {
  const dir = await tempHome(t);
  const paths = tempPaths(dir);
  const log = join(dir, "invocations.log");
  const fakeBinary = await writeFakeCloudflared(dir);
  process.env.FAKE_CLOUDFLARED_LOG = log;
  process.env.FAKE_CLOUDFLARED_DIR = dir;
  process.env.FAKE_CLOUDFLARED_MODE = "cert-existing";
  process.env.FAKE_TUNNEL_ID = TUNNEL_ID;
  mkdir(paths);
  mkdirHomeCert(paths);

  const first = await mintTunnelIdentity(paths, fakeBinary, { hostname: HOSTNAME });
  const second = await mintTunnelIdentity(paths, fakeBinary, { hostname: HOSTNAME });
  assert.equal(first.tunnelId, second.tunnelId);
  const invocations = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const creates = invocations.filter((args) => args[1] === "create");
  assert.equal(creates.length, 0, `expected zero tunnel create calls, got ${JSON.stringify(creates)}`);
});

test("invalid hostnames are rejected loudly; corrupt identity falls back to unprovisioned", async (t) => {
  const dir = await tempHome(t);
  const paths = tempPaths(dir);
  mkdir(paths);
  mkdirHomeCert(paths);
  await assert.rejects(() => mintTunnelIdentity(paths, "/nonexistent/cloudflared", { hostname: "not a host!" }), /invalid tunnel hostname/);

  writeFileSync(tunnelIdentityPath(paths), "{ not json", "utf8");
  assert.equal(loadTunnelIdentity(paths), null);
});

function mkdir(paths) {
  mkdirSync(join(paths.root, "tunnel"), { recursive: true });
}

function mkdirHomeCert(paths) {
  mkdirSync(join(paths.root, "tunnel"), { recursive: true });
  writeFileSync(join(paths.root, "tunnel", "cert.pem"), "FAKE ORIGIN CERT\n", "utf8");
}

function mkdirHomeTunnelCreds(paths) {
  mkdirSync(join(paths.root, "tunnel"), { recursive: true });
  writeFileSync(
    tunnelCredentialsPath(paths),
    JSON.stringify({ AccountTag: "acct", TunnelSecret: "c2VjcmV0", TunnelID: TUNNEL_ID }),
    "utf8",
  );
}