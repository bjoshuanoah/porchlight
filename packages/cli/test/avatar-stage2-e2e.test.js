// PORCH-070 stage 2 — deployed-hub shape: real daemons (mongo/redis binaries
// from `porchlight setup`), real hub process (the built apps/server boot the
// supervisor spawns), real file media root, real HTTP. Every client route
// the avatar feature calls, exercised end to end:
//   GET  /api/identity/accounts/me
//   POST /api/identity/accounts/me/avatar  (ingest / commit / clear)
//   GET  /api/identity/avatars/:did/renditions/:kind         (committed + pending preview)
//   GET  /api/social/timeline                                (authorAvatar hydration)
//   GET  /api/social/console/members                          (owner rows carry the face)
//   DELETE /api/social/console/members/:memberId              (cascade retires the set)
import test from "node:test";
import { spawn, execFile } from "node:child_process";
import { createHash, createPrivateKey, sign, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import sharp from "sharp";
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

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const canonical = (o) => JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])));
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

test("member avatar, deployed-hub stage 2: every client route the Profile flow calls", { skip: process.env.PORCHLIGHT_S2 === "1" ? false : "runs only with PORCHLIGHT_S2=1" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "porch070-s2-"));
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
    const ownerIdentityToken = await runStep("owner identity session", openSession(base, ownerDid, "dev_a", ownerPair));
  
    const driver = await runStep("bootstrap network", execFileP(process.execPath, [BIN, "bootstrap", "--home", home, "--network", "Family"]).then((r) => (process.stdout.write(r.stdout), r)));
    assert.match(driver.stdout, /owner bound/);
    await rm(join(home, "state", "processes", "hub.json"), { force: true });
    // Membership session rides the LIVE row (never admission) — the client path.
    const ownerToken = await runStep("owner membership session restored", (async () => {
      const res = await fetch(`${base}/api/social/session/restore`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityAccessToken: ownerIdentityToken, deviceId: "dev_a" }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body.sessions[0].accessToken;
    })());
  
    // A second member joins through the real surfaces: the console join link,
    // the member's identity birth at the join-member route, then admit.
    const invite = await runStep('console join link minted', (async () => {
      const res = await fetch(`${base}/api/social/console/invites`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ role: 'member', maxUses: 1 }),
      });
      const body = await res.json();
      assert.equal(res.status, 201, JSON.stringify(body));
      return body.invite;
    })());
    const code = invite.code ?? invite.token;
    assert.ok(code, JSON.stringify(invite));
  
    const memberPair = generateKeyPairSync('ed25519');
    const memberPrivJwk = memberPair.privateKey.export({ format: 'jwk' });
    const member = await runStep('member identity birth at the join link (real member path)', (async () => {
      const res = await fetch(`${base}/api/bootstrap/join-member`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, firstName: 'Linda', lastName: 'Brown', device: { deviceId: 'dev_b', label: "Linda's phone", publicKeyJwk: jwkOf(memberPair) } }),
      });
      const body = await res.json();
      assert.equal(res.status, 201, JSON.stringify(body));
      return body;
    })());
    const memberDid = member.account.did;
    const admit = await runStep('member admits through the join link', (async () => {
      const session = await openSession(base, memberDid, 'dev_b', memberPair);
      const res = await fetch(`${base}/api/social/join/admit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          identityAccessToken: session,
          deviceId: 'dev_b',
          devicePublicKeyJwk: jwkOf(memberPair),
          signature: signNonce(memberPrivJwk, `porchlight-join:${code}`),
        }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body;
    })());
    const memberToken = admit.accessToken;
    const memberIdentityToken = await openSession(base, memberDid, 'dev_b', memberPair);
  
    // The member uploads their profile photo from the Profile surface.
    const rect = await sharp({ create: { width: 640, height: 400, channels: 3, noise: { type: "gaussian", sigma: 12 } } }).jpeg().toBuffer();
    const payload = { scope: "identity-avatar", action: "ingest", size: Buffer.byteLength(rect), sha256: sha256(rect), contentType: "image/jpeg" };
    const ingest = await runStep("avatar ingest (real bytes → real file media store)", (async () => {
      const res = await fetch(`${base}/api/identity/accounts/me/avatar`, {
        method: "POST",
        headers: {
          "content-type": "image/jpeg",
          authorization: `Bearer ${memberIdentityToken}`,
          "x-porchlight-avatar-payload": JSON.stringify(payload),
          "x-porchlight-signature": signNonce(memberPrivJwk, canonical(payload)),
        },
        body: rect,
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.pending.renditions.header.width, 72);
      return body;
    })());
    const pending = ingest.pending;
  
    const commit = await runStep("avatar commit after the member confirms", (async () => {
      const cp = { scope: "identity-avatar", action: "commit", token: pending.token };
      const res = await fetch(`${base}/api/identity/accounts/me/avatar`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${memberIdentityToken}` },
        body: JSON.stringify({ payload: cp, signature: signNonce(memberPrivJwk, canonical(cp)) }),
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      return body;
    })());
    assert.equal(commit.avatar.chooser.sha256, pending.renditions.chooser.sha256);
  
    await runStep("member account read carries the face", (async () => {
      const res = await fetch(`${base}/api/identity/accounts/me`, { headers: { authorization: `Bearer ${memberIdentityToken}` } });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.avatar?.chooser?.sha256, pending.renditions.chooser.sha256);
    })());
  
    await runStep("face serves to a member token, immutable + stamped + square", (async () => {
      const res = await fetch(`${base}/api/identity/avatars/${encodeURIComponent(memberDid)}/renditions/chooser?v=${pending.renditions.chooser.sha256}`, { headers: { authorization: `Bearer ${ownerToken}` } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "image/webp");
      assert.equal(res.headers.get("cache-control"), "private, max-age=31536000, immutable");
      assert.equal(res.headers.get("x-porchlight-media-width"), "144");
      assert.equal(res.headers.get("x-porchlight-media-height"), "144");
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.equal(sha256(bytes), pending.renditions.chooser.sha256, "served bytes equal the content address");
    })());
  
    await runStep("no token → no face (perimeter)", (async () => {
      const res = await fetch(`${base}/api/identity/avatars/${encodeURIComponent(memberDid)}/renditions/header?v=${pending.renditions.header.sha256}`);
      assert.equal(res.status, 401);
    })());
  
    // The face rides the family surfaces: the member posts; the feed hydrates
    // the author's avatar stamps (owner's browser reads the timeline).
    await runStep("member posts a photo, timeline hydrates authorAvatar", (async () => {
      const upload = { scope: "media-upload", size: rect.length, contentType: "image/jpeg" };
      const begin = await (await fetch(`${base}/api/social/media/uploads`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ payload: upload, signature: signNonce(memberPrivJwk, canonical(upload)) }),
      })).json();
      const put = await fetch(`${base}/api/social/media/uploads/${begin.uploadId}/chunks/0`, {
        method: "PUT",
        headers: { "content-type": "image/jpeg", "x-chunk-sha256": sha256(rect), authorization: `Bearer ${memberToken}` },
        body: rect,
      });
      assert.ok(put.status >= 200 && put.status < 300, String(put.status));
      const commitDecl = { scope: "media-commit", uploadId: begin.uploadId, sha256: sha256(rect), size: rect.length };
      const done = await (await fetch(`${base}/api/social/media/uploads/${begin.uploadId}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ payload: commitDecl, signature: signNonce(memberPrivJwk, canonical(commitDecl)) }),
      })).json();
      const post = { scope: "post-create", type: "photo", caption: "Aunt Linda at the lake", mediaRefs: [done.mediaId] };
      const createdPost = await (await fetch(`${base}/api/social/posts`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ payload: post, signature: signNonce(memberPrivJwk, canonical(post)) }),
      })).json();
      assert.ok(createdPost.post?._id ?? createdPost._id, JSON.stringify(createdPost));
      const timeline = await (await fetch(`${base}/api/social/timeline`, { headers: { authorization: `Bearer ${ownerToken}` } })).json();
      const postRow = (timeline.posts ?? []).find((p) => (p._id ?? p.id) === (createdPost.post?._id ?? createdPost._id));
      assert.ok(postRow, JSON.stringify(timeline.posts?.length));
      if (postRow.authorAvatar?.chooser?.sha256 !== pending.renditions.chooser.sha256) {
        console.log("postRow keys:", Object.keys(postRow).join(","));
        console.log("authorName:", postRow.authorName, "authorAvatar:", JSON.stringify(postRow.authorAvatar ?? null));
      }
      assert.ok(postRow.authorAvatar?.chooser?.sha256 === pending.renditions.chooser.sha256, JSON.stringify(postRow.authorAvatar ?? null));
    })());
  
    await runStep("owner console member rows carry the face", (async () => {
      const res = await fetch(`${base}/api/social/console/members`, { headers: { authorization: `Bearer ${ownerToken}` } });
      const body = await res.json();
      assert.equal(res.status, 200);
      const row = (body.members ?? []).find((m) => m.did === memberDid);
      assert.ok(row, JSON.stringify(body.members?.map((m) => m.did)));
      assert.ok(row.avatar?.header?.sha256 === pending.renditions.header.sha256, JSON.stringify(row.avatar));
    })());
  
    await runStep("clear reverts to the no-avatar state over the same route", (async () => {
      const cp = { scope: "identity-avatar", action: "clear" };
      const res = await fetch(`${base}/api/identity/accounts/me/avatar`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${memberIdentityToken}` },
        body: JSON.stringify({ payload: cp, signature: signNonce(memberPrivJwk, canonical(cp)) }),
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.avatar, null);
      const gone = await fetch(`${base}/api/identity/avatars/${encodeURIComponent(memberDid)}/renditions/chooser?v=${pending.renditions.chooser.sha256}`, { headers: { authorization: `Bearer ${ownerToken}` } });
      assert.equal(gone.status, 404, "cleared rungs become unreachable");
    })());
  
    await runStep("deployed refusals name their state: PDF and over-cap", (async () => {
      // Re-upload first (the face returns), then refuse a PDF and a big file.
      const upload = { scope: "identity-avatar", action: "ingest", size: rect.length, sha256: sha256(rect), contentType: "image/jpeg" };
      const reing = await (await fetch(`${base}/api/identity/accounts/me/avatar`, {
        method: "POST",
        headers: {
          "content-type": "image/jpeg",
          authorization: `Bearer ${memberIdentityToken}`,
          "x-porchlight-avatar-payload": JSON.stringify(upload),
          "x-porchlight-signature": signNonce(memberPrivJwk, canonical(upload)),
        },
        body: rect,
      })).json();
      assert.ok(reing.pending?.token, JSON.stringify(reing));
      // shape probe discarded; commit the re-upload so the face is back.
      const cp = { scope: "identity-avatar", action: "commit", token: reing.pending.token };
      const recommitted = await (await fetch(`${base}/api/identity/accounts/me/avatar`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${memberIdentityToken}` },
        body: JSON.stringify({ payload: cp, signature: signNonce(memberPrivJwk, canonical(cp)) }),
      })).json();
      assert.ok(recommitted.avatar?.header?.sha256, JSON.stringify(recommitted));
  
      const pdf = Buffer.from("%PDF-1.4 this is not a photograph", "utf8");
      const pdfDecl = { scope: "identity-avatar", action: "ingest", size: pdf.length, sha256: sha256(pdf), contentType: "application/pdf" };
      const pdfRes = await fetch(`${base}/api/identity/accounts/me/avatar`, {
        method: "POST",
        headers: {
          "content-type": "application/pdf",
          authorization: `Bearer ${memberIdentityToken}`,
          "x-porchlight-avatar-payload": JSON.stringify(pdfDecl),
          "x-porchlight-signature": signNonce(memberPrivJwk, canonical(pdfDecl)),
        },
        body: pdf,
      });
      const pdfBody = await pdfRes.json();
      assert.equal(pdfRes.status, 415, JSON.stringify(pdfBody));
      assert.equal(pdfBody.code, "E_AVATAR_UNSUPPORTED_TYPE");
  
      const big = await sharp({ create: { width: 2400, height: 2400, channels: 3, noise: { type: "gaussian", sigma: 40 } } }).png({ compressionLevel: 0 }).toBuffer();
      const bigDecl = { scope: "identity-avatar", action: "ingest", size: big.length, sha256: sha256(big), contentType: "image/png" };
      const bigRes = await fetch(`${base}/api/identity/accounts/me/avatar`, {
        method: "POST",
        headers: {
          "content-type": "image/png",
          authorization: `Bearer ${memberIdentityToken}`,
          "x-porchlight-avatar-payload": JSON.stringify(bigDecl),
          "x-porchlight-signature": signNonce(memberPrivJwk, canonical(bigDecl)),
        },
        body: big,
      });
      const bigBody = await bigRes.json();
      assert.equal(bigRes.status, 413, JSON.stringify(bigBody));
      assert.equal(bigBody.code, "E_AVATAR_TOO_LARGE");
      // And no refusal touched the stored face.
      const me = await (await fetch(`${base}/api/identity/accounts/me`, { headers: { authorization: `Bearer ${memberIdentityToken}` } })).json();
      assert.equal(me.avatar?.chooser?.sha256, recommitted.avatar.chooser.sha256, "no partial write: the face is exactly as confirmed");
    })());
  
    await runStep("cascaded purge retires the face with the member", (async () => {
      const members = (await (await fetch(`${base}/api/social/console/members`, { headers: { authorization: `Bearer ${ownerToken}` } })).json()).members;
      const row = members.find((m) => m.did === memberDid);
      const res = await fetch(`${base}/api/social/console/members/${row._id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ confirmName: row.name }),
      });
      const body = await res.json();
      assert.ok([200, 202].includes(res.status), JSON.stringify(body));
      const me = await fetch(`${base}/api/identity/accounts/me`, { headers: { authorization: `Bearer ${memberIdentityToken}` } });
      // The identity row survives the purge (identity continuity); the face retires with it.
      assert.equal(me.status, 200, String(me.status));
      assert.equal((await me.json()).avatar, null, "the avatar set retired with the member");
      const gone = (await (await fetch(`${base}/api/social/console/members`, { headers: { authorization: `Bearer ${ownerToken}` } })).json()).members;
      const purgedRow = (gone ?? []).find((m) => m.did === memberDid);
      assert.ok(purgedRow, "the member row remains as the purge's trail");
      assert.equal(purgedRow.state, "revoked", "the membership is revoked — content and face cascade done");
    })());
  
    console.log("STAGE-2 PASSED (porch070)");
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