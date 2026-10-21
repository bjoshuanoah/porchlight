// PORCH-120 stage 2 — deployed-hub shape, per the Oct 12 verification
// contract: real daemons (mongo/redis binaries from `porchlight setup`),
// real hub process (the built apps/server boot the supervisor spawns),
// real static SPA serving, real HTTP. The member surfaces this task adds,
// exercised as a family member's browser meets them on a deployed hub:
//   GET  /assets/emoji-picker-*.js   (the lazy picker chunk: Frequently
//                                     Used tab, mobile viewport contract,
//                                     the 💯 search aliases)
//   GET  /api/social/usage           (the account-level usage read — the
//                                     Frequently Used route family)
// and the full route family over the deployed hub: signed reaction write →
// usage recorded → usage read most-first, identity-scoped 401 at the edge.
// Run: npm run build && PORCHLIGHT_S2=1 node --test test/picker-stage2-e2e.test.js
import test from "node:test";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { canonicalJson } from "@porchlight/shared";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

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

const call = async (base, path, init) => {
  const res = await fetch(`${base}${path}`, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
};

test("emoji picker + frequently used, deployed-hub stage 2: picker chunk serves and the usage route family answers", { skip: process.env.PORCHLIGHT_S2 === "1" ? false : "runs only with PORCHLIGHT_S2=1" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "porch120-s2-"));
  const keep = process.env.PORCHLIGHT_S2_KEEP === "1";
  let hub = null;
  try {
    console.log("stage-2 home:", home);
    await runStep("porchlight setup (real daemons downloaded)", execFileP(process.execPath, [BIN, "setup", "--home", home]));

    const seed = 10_000 + (process.pid % 20_000) * 3;
    const httpPort = 40_000 + (seed % 20_000);
    await execFileP(process.execPath, ["-e", `
      const { loadConfig, saveConfig } = await import("@porchlight/shared");
      const config = loadConfig(${JSON.stringify(home)});
      config.daemons.mongoPort = ${50_000 + (seed % 20_000)};
      config.daemons.redisPort = ${50_000 + (seed % 20_000) + 1};
      config.hub.httpPort = ${httpPort};
      saveConfig(${JSON.stringify(home)}, config);
    `], { cwd: process.cwd() });
    const base = `http://127.0.1:${httpPort}`.replace("127.0.1", "127.0.0.1");

    hub = spawn(process.execPath, [BIN, "start", "--foreground", "--no-tunnel", "--home", home], { stdio: ["ignore", "pipe", "pipe"] });
    hub.stdout.on("data", (c) => process.env.PORCHLIGHT_S2_VERBOSE && process.stdout.write(`[hub] ${c}`));
    hub.stderr.on("data", (c) => process.env.PORCHLIGHT_S2_VERBOSE && process.stderr.write(`[hub!] ${c}`));

    await runStep("hub healthy", waitHealthy(base));

    // The lazy picker chunk serves from the deployed SPA: the Frequently
    // Used tab, its cold state, the mobile keyboard contract, and the 💯
    // search aliases all ride that chunk (the catalog travels with it).
    await runStep("GET picker chunk", (async () => {
      const shell = await fetch(base);
      assert.equal(shell.status, 200, `the SPA shell serves (${shell.status})`);
      const html = await shell.text();
      const bundleMatch = [...(html).matchAll(/src="(\/assets\/index-[^"]+\.js)"/g)].map((m) => m[1]);
      assert.ok(bundleMatch.length, "the index bundle is referenced");
      const bundleRes = await fetch(base + bundleMatch[0]);
      assert.equal(bundleRes.status, 200, `the index bundle serves (${bundleRes.status})`);
      const bundleJs = await bundleRes.text();
      // The member data layer rides the eager bundle (the usage read is an
      // app action, the picker never blocks first paint).
      assert.match(bundleJs, /social\/usage/, "the account-level usage read route rides the app bundle");
      // The picker chunk is dynamic (code-split, PORCH-036).
      const chunkMatch = bundleJs.match(/(\.\/)?(assets\/)?(emoji-picker[^"']*\.js)/);
      assert.ok(chunkMatch, "the index bundle references the lazy emoji-picker chunk");
      const chunkName = chunkMatch[3].replace(/^\.\//, "");
      const chunkRes = await fetch(`${base}/assets/${chunkName}`);
      assert.equal(chunkRes.status, 200, `the lazy picker chunk serves (${chunkRes.status})`);
      const chunk = await chunkRes.text();
      assert.match(chunk, /Frequently Used/, "the Frequently Used tab rides the lazy chunk");
      assert.match(chunk, /React a few times and your favorites will appear here\./, "the family-copy cold state rides the chunk");
      assert.match(chunk, /visualViewport/, "the mobile keyboard contract rides the chunk");
      assert.match(chunk, /perfect score/, "the 💯 search aliases ride the chunk");
      assert.doesNotMatch(chunk, /react-colorful|emoji-mart|framer-motion|gsap/i, "no third-party picker/keyboard/animation runtime rides the chunk");
      return html;
    })());

    // The usage route family over the deployed hub — member join → post →
    // signed reactions → identity-scoped usage read, exactly the surfaces
    // the picker's tab consumes.
    await runStep("usage route family", (async () => {
      // The owner: account → session → network → invite → admit.
      const ownerDevice = generateKeyPairSync("ed25519");
      const ownerJwk = ownerDevice.publicKey.export({ format: "jwk" });
      const account = await call(base, "/api/identity/bootstrap/account", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ firstName: "Brian", lastName: "Noah", device: { deviceId: "s2_dev_1", publicKeyJwk: ownerJwk } }),
      });
      assert.equal(account.status, 201);
      const did = account.body.account.did;
      const challenge = await call(base, "/api/identity/session/challenge", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ did }),
      });
      assert.equal(challenge.status, 200);
      const session = await call(base, "/api/identity/session", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ did, deviceId: "s2_dev_1", nonce: challenge.body.nonce, signature: cryptoSign(null, Buffer.from(challenge.body.nonce, "utf8"), ownerDevice.privateKey).toString("base64url") }),
      });
      assert.equal(session.status, 201);
      const identityToken = session.body.accessToken;

      const network = await call(base, "/api/social/bootstrap/network", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Family" }) });
      assert.ok(network.status === 200 || network.status === 201, `network bootstrap answers (${network.status})`);
      const invite = await call(base, "/api/social/bootstrap/invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
      assert.ok(invite.body.joinUrl, `invite issuance answers (${invite.status})`);
      const code = String(invite.body.joinUrl).split("/join/")[1];
      const admitRes = await call(base, "/api/social/join/admit", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, identityAccessToken: identityToken, deviceId: "s2_dev_1", devicePublicKeyJwk: ownerJwk, signature: cryptoSign(null, Buffer.from(`porchlight-join:${code}`, "utf8"), ownerDevice.privateKey).toString("base64url") }),
      });
      assert.equal(admitRes.status, 201, `admission closes (${admitRes.status})`);
      const token = admitRes.body.accessToken;
      const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };
      const signPayload = (payload) => cryptoSign(null, Buffer.from(canonicalJson(payload), "utf8"), ownerDevice.privateKey).toString("base64url");

      // The tab's cold state over the deployed hub: an identity with no
      // usage history reads an empty list — never an error surface.
      const cold = await call(base, "/api/social/usage", { headers: auth });
      assert.equal(cold.status, 200, `the usage read answers on the deployed hub (${cold.status})`);
      assert.deepEqual(cold.body.emoji, [], "the cold-state tab reads an empty account list");

      // A picker add (the signed reaction write the picker's grid makes):
      const postPayload = { type: "text", body: "stage-2 picker route family" };
      const created = await call(base, "/api/social/posts", { method: "POST", headers: auth, body: JSON.stringify({ payload: postPayload, signature: signPayload(postPayload) }) });
      assert.equal(created.status, 200, `the post write closes (${created.status})`);
      const postId = created.body.post._id;
      const firstAdd = { postId, emoji: "👍" };
      assert.equal((await call(base, `/api/social/posts/${postId}/reactions`, { method: "POST", headers: auth, body: JSON.stringify({ payload: firstAdd, signature: signPayload(firstAdd) }) })).status, 200);
      // Un-react never decrements; the re-add records the second use.
      assert.equal((await call(base, `/api/social/posts/${postId}/reactions`, { method: "DELETE", headers: auth, body: JSON.stringify({ payload: firstAdd, signature: signPayload(firstAdd) }) })).status, 200);
      assert.equal((await call(base, `/api/social/posts/${postId}/reactions`, { method: "POST", headers: auth, body: JSON.stringify({ payload: firstAdd, signature: signPayload(firstAdd) }) })).status, 200);
      const secondAdd = { postId, emoji: "🌞" };
      assert.equal((await call(base, `/api/social/posts/${postId}/reactions`, { method: "POST", headers: auth, body: JSON.stringify({ payload: secondAdd, signature: signPayload(secondAdd) }) })).status, 200);

      // The Frequently Used read: most-first, glyphs only.
      const warm = await call(base, "/api/social/usage", { headers: auth });
      assert.equal(warm.status, 200);
      assert.deepEqual(warm.body.emoji, ["👍", "🌞"], "the account list orders most-used first over the deployed hub");
      const serial = JSON.stringify(warm.body);
      assert.ok(!serial.includes("count") && !serial.includes("memberDid"), "no count fields ride the usage wire on the deployed hub");

      // The perimeter edge: a tokenless read never resolves a list.
      const tokenless = await call(base, "/api/social/usage");
      assert.equal(tokenless.status, 401, "the tokenless usage read stays at the edge");
    })());

    console.log("✓ picker + usage route family served by the deployed hub");
  } finally {
    if (hub && !hub.killed) hub.kill("SIGTERM");
    // The daemons need their shutdown beat before the home dir releases;
    // retry the rm so a still-dying daemon's file grip can't wedge the run.
    await new Promise((wait) => setTimeout(wait, 1_500));
    for (let attempt = 0; attempt < 5 && keep === false; attempt += 1) {
      try {
        await rm(home, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((wait) => setTimeout(wait, 1_000));
      }
    }
  }
});