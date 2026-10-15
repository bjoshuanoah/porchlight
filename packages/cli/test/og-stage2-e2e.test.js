// PORCH-079 stage 2 — deployed-hub shape: real daemons (mongo/redis binaries
// from `porchlight setup`), real hub process (the built apps/server boot the
// supervisor spawns), real file media root, real HTTP. Every client call the
// unfurl surface depends on, exercised end to end (unauthenticated
// unfetchers included):
//   GET /api/social/og/post/:postId      (composed, immutable headers)
//   GET /api/social/og/invite/:token     (composed, immutable headers)
//   GET /posts/:postId                   (SPA HTML + the og: tag set)
//   GET /join/:token                     (SPA HTML + the og: tag set)
//   the 404 class and the no-tag plain-document path
import test from "node:test";
import { spawn, execFile } from "node:child_process";
import { generateKeyPairSync, sign, createPrivateKey } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "@porchlight/shared";

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

test("OG unfurl surface, deployed-hub stage 2: every route the shared links ride", { skip: process.env.PORCHLIGHT_S2 === "1" ? false : "runs only with PORCHLIGHT_S2=1" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "porch079-s2-"));
  let hub = null;
  try {
    console.log("stage-2 home:", home);
    const setup = await runStep("porchlight setup (real daemons downloaded)", execFileP(process.execPath, [BIN, "setup", "--home", home]));

    const seed = 10_000 + (process.pid % 20_000) * 3;
    const httpPort = 23_000 + (seed % 20_000);
    await execFileP(process.execPath, ["-e", `
      const { loadConfig, saveConfig } = await import("@porchlight/shared");
      const config = loadConfig(${JSON.stringify(home)});
      config.daemons.mongoPort = ${33_000 + (seed % 20_000)};
      config.daemons.redisPort = ${33_000 + (seed % 20_000) + 1};
      config.hub.httpPort = ${httpPort};
      // The hub URL of record rides the tunnel state; the stage-2 hub binds
      // its own local origin here (no external tunnel), so the og: tags
      // resolve absolute exactly as a tunneled hub resolves them.
      config.hub.tunnel = { url: "http://127.0.0.1:${httpPort}", enabled: false };
      saveConfig(${JSON.stringify(home)}, config);
    `], { cwd: process.cwd() });
    await Promise.resolve(setup);
    const base = `http://127.0.0.1:${httpPort}`;

    hub = spawn(process.execPath, [BIN, "start", "--foreground", "--no-tunnel", "--home", home], { stdio: ["ignore", "pipe", "pipe"] });
    hub.stdout.on("data", () => {});
    hub.stderr.on("data", (c) => process.stdout.write(`[hub:err] ${c}`));
    const health = await runStep("hub healthy (mongo ok, redis ok)", waitHealthy(base));
    assert.equal(health.deps?.mongo, "ok");
    assert.equal(health.deps?.redis, "ok");

    // Owner bootstrap: first account with a device-held key, then the network.
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

    const driver = await runStep("bootstrap network", execFileP(process.execPath, [BIN, "bootstrap", "--home", home, "--network", "Family"]).then((r) => (process.stdout.write(r.stdout), r)));
    assert.match(driver.stdout, /owner bound/);
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

    // The owner posts a real post through the real write path (device-signed).
    const post = await runStep("owner posts a real post (device-signed write)", (async () => {
      const payload = { type: "text", body: "Sunday dinner at the lake, everyone bring a chair", caption: null, mediaRefs: [] };
      const res = await fetch(`${base}/api/social/posts`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ payload, signature: signNonce(ownerPair.privateKey.export({ format: "jwk" }), canonicalJson(payload)) }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body;
    })());
    const postId = post.post?._id ?? post.post?.id;
    assert.ok(postId, JSON.stringify(post).slice(0, 200));

    // A real join link minted from the console surface.
    const invite = await runStep("console join link minted", (async () => {
      const res = await fetch(`${base}/api/social/console/invites`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ role: "member", maxUses: 1 }),
      });
      const body = await res.json();
      assert.equal(res.status, 201, JSON.stringify(body));
      return body.invite ?? body;
    })());
    const code = invite.code ?? invite.token;
    assert.ok(code, JSON.stringify(invite).slice(0, 300));

    // Checklist: the composed OG images serve publicly with immutable headers.
    const postImage = await runStep("GET /api/social/og/post/:postId (unauthenticated)", fetch(`${base}/api/social/og/post/${postId}`));
    assert.equal(postImage.status, 200, "the composed post image serves without credentials");
    assert.match(postImage.headers.get("content-type") ?? "", /^image\/jpeg/);
    assert.equal(postImage.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.match(postImage.headers.get("etag") ?? "", /^"[0-9a-f]{64}"$/);
    const postImageBytes = Buffer.from(await postImage.arrayBuffer());
    assert.ok(postImageBytes.length > 100_000, "the composed image carries the real base artwork");
    const postImageAgain = await fetch(`${base}/api/social/og/post/${postId}`);
    assert.equal(postImageAgain.headers.get("etag"), postImage.headers.get("etag"), "the repeat request rides the same cache key");

    const inviteImage = await runStep("GET /api/social/og/invite/:token (unauthenticated)", fetch(`${base}/api/social/og/invite/${code}`));
    assert.equal(inviteImage.status, 200);
    assert.match(inviteImage.headers.get("content-type") ?? "", /^image\/jpeg/);
    assert.equal(inviteImage.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.notEqual(inviteImage.headers.get("etag"), postImage.headers.get("etag"), "the invite key differs from the post key");
    await Buffer.from(await inviteImage.arrayBuffer());

    // Checklist: the shared-route HTML carries the og: tag set (unauthenticated).
    const postPage = await fetch(`${base}/posts/${postId}`);
    assert.equal(postPage.status, 200);
    const postHtml = await postPage.text();
    assert.match(postHtml, /<meta property="og:title" content="view this post on the Family network" \/>/);
    assert.match(postHtml, new RegExp(`<meta property="og:image" content="${base}/api/social/og/post/${postId}" \\/>`));
    assert.match(postHtml, new RegExp(`<meta property="og:url" content="${base}/posts/${postId}" \\/>`));
    // The og surface carries none of the post's content.
    assert.ok(!postHtml.includes("Sunday dinner at the lake"), "no post body in the unfurl surface");
    const memberPage = await fetch(`${base}/posts/${postId}`, { headers: { authorization: `Bearer ${ownerToken}` } });
    assert.equal(await memberPage.text(), postHtml, "the credentialed request serves the identical HTML");

    const joinPage = await fetch(`${base}/join/${code}`);
    assert.equal(joinPage.status, 200);
    const joinHtml = await joinPage.text();
    assert.match(joinHtml, /<meta property="og:title" content="join the Family network" \/>/);

    // The 404 class and the plain-document path.
    const unknownImage = await fetch(`${base}/api/social/og/post/p_nope`);
    assert.equal(unknownImage.status, 404);
    const plainPage = await fetch(`${base}/timeline`);
    assert.equal(plainPage.status, 200);
    assert.ok(!(await plainPage.text()).includes('property="og:'), "a non-shared route serves the plain document");
  } finally {
    if (hub) hub.kill();
    if (process.env.PORCHLIGHT_S2_KEEP !== "1") await rm(home, { recursive: true, force: true });
  }
});