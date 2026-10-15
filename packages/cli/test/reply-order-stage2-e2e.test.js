// PORCH-085 stage 2 — deployed-hub shape: real daemons (mongo/redis binaries
// from `porchlight setup`), real hub process (the built apps/server boot the
// supervisor spawns), real HTTP. The client-facing conversation routes,
// re-verified per the Oct 12 verification contract before user-testing:
//   POST /api/social/posts                       (createPost — signed)
//   POST /api/social/posts/:postId/comments      (comment — actor-signed, unchanged write path)
//   GET  /api/social/posts/:postId/comments      (detail thread — the ruled order, deterministic)
//   GET  /api/social/timeline                    (card slice — top four of the ruled sort + total)
//   GET  /api/social/events?since=               (catch-up cursors stay stable; payload order unchanged)
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
const sleep = (ms) => new Promise((wait) => setTimeout(wait, ms));

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

test("reply read order, deployed-hub stage 2: the conversation routes serve the ruled order on the deployed hub", { skip: process.env.PORCHLIGHT_S2 === "1" ? false : "runs only with PORCHLIGHT_S2=1" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "porch085-s2-"));
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
    const ownerToken = await runStep("owner membership session restored", (async () => {
      const res = await fetch(`${base}/api/social/session/restore`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityAccessToken: ownerIdentityToken, deviceId: "dev_a" }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body.sessions[0].accessToken;
    })());

    const ownerPrivJwk = ownerPair.privateKey.export({ format: "jwk" });
    const signed = (path, payload, method = "POST") => ({
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ payload, signature: signNonce(ownerPrivJwk, JSON.stringify(Object.fromEntries(Object.keys(payload).sort().map((key) => [key, payload[key]])))) }),
    });

    const postPayload = { type: "text", body: "the ruled order post" };
    const post = (await runStep("post created (signed)", (async () => {
      const res = await fetch(`${base}/api/social/posts`, signed("/posts", postPayload));
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body.post ?? body;
    })()));

    // Comments ride the unchanged, actor-signed write path: A, B, C (+ three
    // replies), D written chronologically so each createdAt is strictly larger
    // than the last (the write path stamps them; stage 2 cannot backdate) —
    // A oldest, D newest, C the only threaded root.
    const comment = async (body, parentId = null) => {
      const payload = { postId: post._id, body, ...(parentId ? { parentId } : {}) };
      const res = await fetch(`${base}/api/social/posts/${post._id}/comments`, signed("/comments", payload));
      const out = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(out));
      await sleep(8);
      return out.comment ?? out;
    };
    const rootA = await comment("A oldest childless");
    assert.ok(rootA.parentId === null, JSON.stringify(rootA));
    await comment("B middle childless");
    const rootC = await comment("C with replies");
    for (const reply of ["Cr0", "Cr1", "Cr2"]) await comment(reply, rootC._id);
    await comment("D newest childless");

    await runStep("detail thread serves the ruled order, deterministically", (async () => {
      const thread = async () => (await (await fetch(`${base}/api/social/posts/${post._id}/comments`, { headers: { authorization: `Bearer ${ownerToken}` } })).json()).comments;
      const first = await thread();
      const second = await thread();
      assert.deepEqual(first, second, "the same fetch twice returns the identical order");
      assert.deepEqual(
        first.filter((row) => row.parentId == null).map((row) => row.body),
        ["C with replies", "D newest childless", "B middle childless", "A oldest childless"],
        "threaded roots ahead of childless roots; each group newest-first",
      );
      const atC = first.findIndex((row) => row._id === rootC._id);
      assert.deepEqual(first.slice(atC + 1, atC + 4).map((row) => row.body), ["Cr0", "Cr1", "Cr2"], "the tree renders oldest-first right after its root");
      assert.equal(JSON.stringify(first).includes("vote"), false, "no vote-bearing field rides any thread row");
    })());

    await runStep("card slice serves the top four of the ruled sort plus the total", (async () => {
      const timeline = (await (await fetch(`${base}/api/social/timeline`, { headers: { authorization: `Bearer ${ownerToken}` } })).json()).posts;
      const row = timeline.find((p) => p._id === post._id);
      assert.ok(row, JSON.stringify(timeline.map((p) => p.body)));
      assert.deepEqual(row.replySlice.map((reply) => reply.body), ["C with replies", "D newest childless", "B middle childless", "A oldest childless"], "the top four of the ruled sort serve on the card");
      assert.equal(row.replyTotal, 4, "the expander count stays total minus rendered");
    })());

    await runStep("catch-up cursors stay stable across reads (no re-key)", (async () => {
      const first = (await (await fetch(`${base}/api/social/events?since=`, { headers: { authorization: `Bearer ${ownerToken}` } })).json());
      assert.equal(first.stale, false, JSON.stringify({ stale: first.stale, cursor: first.cursor }));
      const second = (await (await fetch(`${base}/api/social/events?since=${encodeURIComponent(first.cursor)}`, { headers: { authorization: `Bearer ${ownerToken}` } })).json());
      assert.equal(second.cursor, first.cursor, "the cursor key is untouched by the read-order change");
      const replyEvent = (first.events ?? []).find((event) => event.type === "reply.created");
      assert.ok(replyEvent?.content?._id, JSON.stringify(replyEvent ?? null), "reply.created still rides content-only envelopes");
    })());

    console.log("STAGE-2 PASSED (porch085)");
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