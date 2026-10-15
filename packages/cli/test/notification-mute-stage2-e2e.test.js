// PORCH-087 stage 2 — deployed-hub shape: real daemons (mongo/redis binaries
// from `porchlight setup`), real hub process (the built apps/server boot the
// supervisor spawns), real HTTP. The member notification settings route
// family the notification settings card calls, re-verified per the Oct 12
// verification contract before user-testing:
//   GET /api/social/push/settings           (the card's load)
//   PUT /api/social/push/settings           (the card's save — the mute write)
// The scenario (ac-2): flip the family network's mute state through the real
// routes, reload (a fresh GET after each write), and check that the persisted
// mute flag, the rendered toggle position, and the rendered supporting line
// all agree on the same side (the PORCH-087 convention: ON = receiving,
// OFF = quiet). The persisted flag itself survives the fix untouched (the
// regression note): only the rendered pairing changed.
import test from "node:test";
import { spawn, execFile } from "node:child_process";
import { createPrivateKey, sign, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/porchlight.mjs", import.meta.url));

function runStep(name, promise) {
  return promise.then(
    (value) => { console.log(`✓ ${name}`); return value; },
    (error) => { console.error(`✗ ${name}`); console.error(error && (error.message ?? error)); throw error });
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

const signNonce = (priv, msg) => sign(null, Buffer.from(msg, "utf8"), createPrivateKey({ key: priv, format: "jwk" })).toString("base64url");
const jwkOf = (pair) => pair.publicKey.export({ format: "jwk" });

async function openSession(base, did, deviceId, pair) {
  const ch = await (await fetch(`${base}/api/identity/session/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ did }) })).json();
  const res = await fetch(`${base}/api/identity/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did, deviceId, nonce: ch.nonce, signature: signNonce(pair.privateKey.export({ format: "jwk" }), ch.nonce) }),
  });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  return body.accessToken;
}

/** The mute row's rendered pairing, exactly as notifications.jsx derives it
 * from the served flag (PORCH-087): the toggle position is the mute flag's
 * inverse and the supporting line reads from the flag itself. The literal
 * copy strings pin the corrected side of the pairing. */
const renderedPairing = (servedMutes, networkId) => {
  const muted = savedMutesIncludes(servedMutes, networkId);
  return {
    muted,
    toggleOn: !muted,
    line: muted ? "Quiet: this network's notifications are paused." : "This network's moments reach you as usual.",
  };
};

const savedMutesIncludes = (servedMutes, networkId) => Array.isArray(servedMutes) && servedMutes.includes(networkId);

test("notification mute row, deployed-hub stage 2: flip, reload, and the flag/toggle/line agreement", { skip: process.env.PORCHLIGHT_S2 === "1" ? false : "runs only with PORCHLIGHT_S2=1" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "porch087-s2-"));
  const keep = process.env.PORCHLIGHT_S2_KEEP === "1";
  let hub = null;
  try {
    console.log("stage-2 home:", home);
    const setup = await runStep("porchlight setup (real daemons downloaded)", execFileP(process.execPath, [BIN, "setup", "--home", home]));
    process.stdout.write(setup.stdout.split("\n").slice(-4).join("\n") + "\n");

    const seed = 10_000 + (process.pid % 20_000) * 3;
    const httpPort = 20_000 + (seed % 20_000);
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

    const ownerPair = generateKeyPairSync("ed25519");
    const created = await runStep("bootstrap account", (async () => {
      const res = await fetch(`${base}/api/identity/bootstrap/account`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ firstName: "Brian", lastName: "Noah", device: { deviceId: "dev_a", publicKeyJwk: jwkOf(ownerPair) } }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body;
    })());
    const ownerDid = created.account.did;
    const ownerIdentityToken = await openSession(base, ownerDid, "dev_a", ownerPair);

    await runStep("bootstrap network", execFileP(process.execPath, [BIN, "bootstrap", "--home", home, "--network", "Family"]).then((r) => (process.stdout.write(r.stdout), r)));
    await rm(join(home, "state", "processes", "hub.json"), { force: true });
    const restored = await runStep("owner membership session restored", (async () => {
      const res = await fetch(`${base}/api/social/session/restore`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityAccessToken: ownerIdentityToken, deviceId: "dev_a" }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body;
    })());
    const ownerToken = restored.sessions[0].accessToken;
    const networkId = restored.sessions[0].networkId;
    assert.ok(networkId, "sessions[0].networkId present — the family network the card's mute rows ride");

    const settingsPath = `${base}/api/social/push/settings`;
    const load = async () => {
      const res = await fetch(settingsPath, { headers: { authorization: `Bearer ${ownerToken}` } });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body.settings;
    };
    const save = async (body) => {
      const res = await fetch(settingsPath, {
        method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify(body),
      });
      const out = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(out));
      return out.settings;
    };

    // Receiving default: the fresh row is unmuted — the card renders the
    // family row ON with the receiving line.
    let served = await runStep("load (receiving default)", load());
    let pair = renderedPairing(served.mutes, networkId);
    assert.equal(pair.muted, false, JSON.stringify(served));
    assert.equal(pair.toggleOn, true, "receiving renders the toggle ON");
    assert.equal(pair.line, "This network's moments reach you as usual.", "receiving renders the receiving line");

    // Flip to quiet through the real PUT, then RELOAD (a fresh GET — the
    // post-write read-back): the persisted flag, the toggle position, and
    // the supporting line all agree OFF-side.
    served = await runStep("flip family to quiet (PUT mutes)", save({ enabled: true, events: { reply: true, mention: true, reaction: true, groupPost: true, joined: true, deviceLink: true }, mutes: [networkId] }));
    pair = renderedPairing(served.mutes, networkId);
    assert.equal(pair.muted, true, JSON.stringify(served));

    served = await runStep("reload after the write (fresh GET)", load());
    pair = renderedPairing(served.mutes, networkId);
    assert.equal(pair.muted, true, "the persisted flag survives the reload");
    assert.equal(pair.toggleOn, false, "muted renders the toggle OFF");
    assert.equal(pair.line, "Quiet: this network's notifications are paused.", "muted renders the quiet line");

    // Flip back to receiving and reload: everything agrees ON-side again.
    served = await runStep("flip family back to receiving (PUT mutes cleared)", save({ enabled: true, events: { reply: true, mention: true, reaction: true, groupPost: true, joined: true, deviceLink: true }, mutes: [] }));
    pair = renderedPairing(served.mutes, networkId);
    assert.equal(pair.muted, false, JSON.stringify(served));

    served = await runStep("reload after clearing", load());
    pair = renderedPairing(served.mutes, networkId);
    assert.equal(pair.muted, false, "the cleared flag survives the reload");
    assert.equal(pair.toggleOn, true, "receiving renders the toggle ON after the flip back");
    assert.equal(pair.line, "This network's moments reach you as usual.", "receiving renders the receiving line after the flip back");

    console.log("STAGE-2 PASSED (porch087)");
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