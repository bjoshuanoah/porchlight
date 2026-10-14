// PORCH-075 stage 2 — deployed-hub shape: real daemons (mongo/redis binaries
// from `porchlight setup`), real hub process (the built apps/server boot the
// supervisor spawns), real HTTP. The captured switch-user scenario replays
// against it: one device holding registrations for two members, the switch
// route sequence — challenge → session → social/session/restore →
// identity/accounts/me → social/timeline — returns its documented success
// classes (200/201) and the payloads carry exactly the fields the client's
// switchIdentity consumes (sessions[0].{name, accessToken, refreshToken,
// networkId}; accounts/me did). The noah-test-2 trail's false-failure was
// client-side (an orphaned ReferenceError in the switch action, fixed in
// apps/web), NOT this route contract; this harness pins the contract so a
// shape change that would strand the switched member surfaces here instead
// of in a member device browser.
import test from "node:test";
import { spawn, execFile } from "node:child_process";
import { sign, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/porchlight.mjs", import.meta.url));

function runStep(name, promise) {
  return promise.then(
    (value) => { console.log(`✓ ${name}`); return value; },
    (error) => { console.error(`✗ ${name}`); console.error(error && (error.message ?? error)); throw error; });
}

const execFileP = (file, args, opts) => new Promise((resolve, reject) =>
  execFile(file, args, { maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr }))));

async function waitHealthy(base, timeoutMs = 90_000) {
  const startedAt = Date.now();
  for (;;) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`hub not healthy: ${base}`);
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return res.json();
    } catch { /* retry */ }
    await new Promise((wait) => setTimeout(wait, 500));
  }
}

/** The one shared multi-user device: same deviceId, member-held key each. */
const SHARED_DEVICE_ID = "dev-shared-tablet";

/** challenge 200 → session 201; asserts the exact fields openDeviceSession consumes. */
async function openSession(base, did, device) {
  const ch = await (await fetch(`${base}/api/identity/session/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ did }) })).json();
  assert.ok(ch?.nonce, `challenge carried a nonce: ${JSON.stringify(ch)}`);
  const res = await fetch(`${base}/api/identity/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      did, deviceId: SHARED_DEVICE_ID,
      nonce: ch.nonce,
      signature: sign(null, Buffer.from(ch.nonce), device.privateKeyObject).toString("base64url"),
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.ok(body.accessToken && body.refreshToken, JSON.stringify(body));
  return body;
}

test("switch-user, deployed-hub stage 2: one device, two members, the captured route sequence", { skip: process.env.PORCHLIGHT_S2 === "1" ? false : "runs only with PORCHLIGHT_S2=1" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "porch075-s2-"));
  const keep = process.env.PORCHLIGHT_S2_KEEP === "1";
  let hub = null;
  try {
    console.log("stage-2 home:", home);
    await runStep("porchlight setup (real daemons downloaded)", execFileP(process.execPath, [BIN, "setup", "--home", home]));

    const seed = 10_000 + (process.pid % 20_000) * 3;
    const httpPort = 20_000 + ((seed + 7) % 20_000);
    await execFileP(process.execPath, ["-e", `
      const { loadConfig, saveConfig } = await import("@porchlight/shared");
      const config = loadConfig(${JSON.stringify(home)});
      config.daemons.mongoPort = ${30_000 + (seed % 20_000)};
      config.daemons.redisPort = ${30_000 + (seed % 20_000) + 1};
      config.hub.httpPort = ${httpPort};
      saveConfig(${JSON.stringify(home)}, config);
    `], { cwd: process.cwd() });
    const base = `http://127.0.0.1:${httpPort}`;

    hub = spawn(process.execPath, [BIN, "start", "--foreground", "--no-tunnel", "--home", home], { stdio: ["ignore", "pipe", "pipe"] });
    hub.stdout.on("data", (c) => process.env.PORCHLIGHT_S2_VERBOSE && process.stdout.write(`[hub] ${c}`));
    hub.stderr.on("data", (c) => process.stdout.write(`[hub:err] ${c}`));
    const health = await runStep("hub healthy (mongo ok, redis ok)", waitHealthy(base));
    assert.equal(health.deps?.mongo, "ok");
    assert.equal(health.deps?.redis, "ok");

    // Owner bootstrap: first account, bound to the SHARED device.
    const ownerPair = generateKeyPairSync("ed25519");
    const ownerKeys = { privateKeyObject: ownerPair.privateKey };
    const created = await runStep("owner account birth on the shared device", (async () => {
      const res = await fetch(`${base}/api/identity/bootstrap/account`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ firstName: "Brian", lastName: "Noah", device: { deviceId: SHARED_DEVICE_ID, publicKeyJwk: ownerPair.publicKey.export({ format: "jwk" }) } }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body;
    })());
    const ownerDid = created.account.did;

    const driver = await runStep("bootstrap network", execFileP(process.execPath, [BIN, "bootstrap", "--home", home, "--network", "Family"]).then((r) => (process.stdout.write(r.stdout), r)));
    assert.match(driver.stdout, /owner bound/);
    await rm(join(home, "state", "processes", "hub.json"), { force: true });

    const ownerRestored = await runStep("owner membership restore (social/session/restore 201)", (async () => {
      const session = await openSession(base, ownerDid, ownerKeys);
      const res = await fetch(`${base}/api/social/session/restore`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityAccessToken: session.accessToken, deviceId: SHARED_DEVICE_ID }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body;
    })());

    const invite = await runStep("console join link minted", (async () => {
      const ownerToken = ownerRestored.sessions[0].accessToken;
      const res = await fetch(`${base}/api/social/console/invites`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ role: "member", maxUses: 9 }),
      });
      const body = await res.json();
      assert.equal(res.status, 201, JSON.stringify(body));
      return body.invite;
    })());
    const code = invite.code ?? invite.token;

    const memberPair = generateKeyPairSync("ed25519");
    const memberKeys = { privateKeyObject: memberPair.privateKey };
    const member = await runStep("member identity birth on the shared device", (async () => {
      const res = await fetch(`${base}/api/bootstrap/join-member`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, firstName: "Linda", lastName: "Brown", device: { deviceId: SHARED_DEVICE_ID, label: "The family tablet", publicKeyJwk: memberPair.publicKey.export({ format: "jwk" }) } }),
      });
      const body = await res.json();
      assert.equal(res.status, 201, JSON.stringify(body));
      return body;
    })());
    const memberDid = member.account.did;

    await runStep("member admits through the join link on the shared device", (async () => {
      const session = await openSession(base, memberDid, memberKeys);
      const res = await fetch(`${base}/api/social/join/admit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code,
          identityAccessToken: session.accessToken,
          deviceId: SHARED_DEVICE_ID,
          devicePublicKeyJwk: memberPair.publicKey.export({ format: "jwk" }),
          signature: sign(null, Buffer.from(`porchlight-join:${code}`), memberKeys.privateKeyObject).toString("base64url"),
        }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body;
    })());

    // The captured switch-user sequence, both directions. Each step mirrors
    // the client's switchIdentity call order (apps/web/src/main.jsx) and
    // asserts the exact payload fields the client consumes.
    async function replaySwitch(from, to) {
      const identitySession = await runStep(`switch replay ${from.name} → ${to.name}: challenge 200 → session 201`, openSession(base, to.did, to.keys));
      const restored = await runStep(`switch replay ${from.name} → ${to.name}: social/session/restore 201 with the client-consumed shape`, (async () => {
        const res = await fetch(`${base}/api/social/session/restore`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ identityAccessToken: identitySession.accessToken, deviceId: SHARED_DEVICE_ID }),
        });
        const body = await res.json();
        assert.ok([200, 201].includes(res.status), JSON.stringify(body));
        const row = body.sessions?.[0];
        assert.ok(row, `restore carries sessions[0]: ${JSON.stringify(body)}`);
        assert.equal(row.name, to.name, `restore returns the switched member's family-facing name (got ${JSON.stringify(row.name)})`);
        assert.ok(row.accessToken, "sessions[0].accessToken present");
        assert.ok(row.refreshToken, "sessions[0].refreshToken present");
        assert.ok(row.networkId, "sessions[0].networkId present");
        return body;
      })());
      await runStep(`switch replay ${from.name} → ${to.name}: identity/accounts/me 200`, (async () => {
        const res = await fetch(`${base}/api/identity/accounts/me`, { headers: { authorization: `Bearer ${identitySession.accessToken}` } });
        const body = await res.json();
        assert.equal(res.status, 200, JSON.stringify(body));
        assert.equal(String(body.did).toLowerCase(), to.did.toLowerCase(), "accounts/me carries the switched member's DID");
        return body;
      })());
      await runStep(`switch replay ${from.name} → ${to.name}: social/timeline 200 on the switched membership token`, (async () => {
        const res = await fetch(`${base}/api/social/timeline`, { headers: { authorization: `Bearer ${restored.sessions[0].accessToken}` } });
        assert.equal(res.status, 200, String(res.status));
      })());
    }

    const owner = { name: "Brian Noah", did: ownerDid, keys: ownerKeys };
    const linda = { name: "Linda Brown", did: memberDid, keys: memberKeys };
    await replaySwitch(linda, owner);
    await replaySwitch(owner, linda);

    console.log("STAGE-2 PASSED (porch075)");
  } catch (error) {
    console.error("STAGE-2 FAILED:", error?.stack ?? error);
    throw error;
  } finally {
    if (hub) hub.kill("SIGTERM");
    await new Promise((wait) => setTimeout(wait, 3000));
    if (!keep) await rm(home, { recursive: true, force: true }).catch(() => {});
    else console.log("kept:", home);
  }
});