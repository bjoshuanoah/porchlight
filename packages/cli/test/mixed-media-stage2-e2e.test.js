// PORCH-143 stage 2 — deployed-hub shape: real daemons (mongo/redis binaries
// from `porchlight setup`), real hub process (the built apps/server boot the
// supervisor spawns), real HTTP, real media volume + rendition pipeline. The
// mixed-media route family, re-verified per the Oct 12 verification contract
// before user-testing:
//   POST /api/social/media/uploads           (signed begin — per-reference admission)
//   PUT  /api/social/media/uploads/:id/chunks/:i  (chunk transfer)
//   POST /api/social/media/uploads/:id/complete   (signed commit, read-back verified)
//   POST /api/social/posts                   (signed mixed create — atomicity gate)
//   GET  /api/social/timeline                (card read — mixed projection, kind stamps)
//   GET  /api/social/posts/:postId           (detail read — same payload law)
//   GET  /api/social/events?since=           (catch-up — content-only envelopes)
//   PUT  /api/social/console/limits          (owner quantity-only storage ceiling)
import test from "node:test";
import { spawn, execFile } from "node:child_process";
import { createPrivateKey, sign, generateKeyPairSync, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import ffmpegStatic from "ffmpeg-static";

const pExecFile = promisify(execFileCb);
const BIN = fileURLToPath(new URL("../bin/porchlight.mjs", import.meta.url));

function runStep(name, promise) {
  return promise.then(
    (value) => { console.log(`✓ ${name}`); return value; },
    (error) => { console.error(`✗ ${name}`); console.error(error && (error.message ?? error)); throw error });
}

const execFileP = (file, args, opts) => new Promise((resolve, reject) =>
  execFile(file, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr }))));

// A free HTTP port at pick time: stale supervisors from crashed runs of
// this suite (or others) can still hold pid-derived ports — a collision
// poisons the whole run with another home's keys (observed: a stale hub
// answered a foreign membership with E_SIGNATURE_INVALID).
const net = (await import("node:net")).default;
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

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

const canonical = (o) => JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])));
const signNonce = (priv, msg) => sign(null, Buffer.from(msg, "utf8"), createPrivateKey({ key: priv, format: "jwk" })).toString("base64url");
const jwkOf = (pair) => pair.publicKey.export({ format: "jwk" });
const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

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

const writeHeaders = (privJwk, token, payload, method = "POST") => ({
  method,
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ payload, signature: signNonce(privJwk, canonical(payload)) }),
});

/** Real, decodable sample media rendered by ffmpeg (the pipeline's probe must decode both). */
async function samplePhotoBytes() {
  const out = await pExecFile(ffmpegStatic, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=480x320:rate=1:duration=0.2,scale=480:320",
    "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "3",
    "-f", "image2", "pipe:1",
  ], { encoding: "buffer" });
  return out.stdout;
}
async function sampleVideoBytes() {
  // The mp4 muxer needs a seekable output: render to a temp file, read it.
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(join(os.tmpdir(), "porch143-vid-"));
  const target = path.join(dir, "sample.mp4");
  try {
    await execFileP(ffmpegStatic, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24:duration=1",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p",
      target,
    ], { maxBuffer: 0 });
    return await readFile(target);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function uploadMedia(base, token, privJwk, bytes, contentType) {
  const declare = { scope: "media-upload", size: bytes.length, contentType };
  const beginRes = await fetch(`${base}/api/social/media/uploads`, writeHeaders(privJwk, token, declare));
  const begin = await beginRes.json();
  assert.ok([200, 201].includes(beginRes.status), JSON.stringify(begin));
  const count = Math.ceil(bytes.length / begin.chunkSize);
  for (let index = 0; index < count; index += 1) {
    const chunk = bytes.subarray(index * begin.chunkSize, (index + 1) * begin.chunkSize);
    const res = await fetch(`${base}/api/social/media/uploads/${begin.uploadId}/chunks/${index}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", authorization: `Bearer ${token}`, "x-chunk-sha256": sha256Hex(chunk) },
      body: chunk,
    });
    assert.ok(res.ok, `chunk ${index} refused: ${res.status}`);
  }
  const commit = { scope: "media-commit", uploadId: begin.uploadId, sha256: sha256Hex(bytes), size: bytes.length };
  // The commit signature covers {scope, uploadId, sha256, size} — the body
  // payload carries the bare declaration; the uploadId rides the URL and
  // the scope is the declared write class.
  const res = await fetch(`${base}/api/social/media/uploads/${begin.uploadId}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ payload: { sha256: commit.sha256, size: commit.size }, signature: signNonce(privJwk, canonical(commit)) }),
  });
  const body = await res.json();
  assert.ok([200, 201].includes(res.status), JSON.stringify(body));
  const committed = body.media ?? body;
  assert.ok(committed.mediaId?.startsWith("med_"), JSON.stringify(committed));
  assert.equal(committed.bytes, bytes.length, "the committed original is the uploaded bytes, read back from the volume");
  return committed.mediaId;
}

test("mixed photo/video posts, deployed-hub stage 2: the mixed create route family with ordered kind+geometry stamps", { skip: process.env.PORCHLIGHT_S2 === "1" ? false : "runs only with PORCHLIGHT_S2=1" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "porch143-s2-"));
  const keep = process.env.PORCHLIGHT_S2_KEEP === "1";
  let hub = null;
  try {
    console.log("stage-2 home:", home);
    const setup = await runStep("porchlight setup (real daemons downloaded)", execFileP(process.execPath, [BIN, "setup", "--home", home]));
    process.stdout.write(setup.stdout.split("\n").slice(-4).join("\n") + "\n");

    const httpPort = await pickFreePort();
    const mongoPort = await pickFreePort();
    const redisPort = await pickFreePort();
    await execFileP(process.execPath, ["-e", `
      const { loadConfig, saveConfig } = await import("@porchlight/shared");
      const config = loadConfig(${JSON.stringify(home)});
      config.daemons.mongoPort = ${mongoPort};
      config.daemons.redisPort = ${redisPort};
      config.hub.httpPort = ${httpPort};
      saveConfig(${JSON.stringify(home)}, config);
    `], { cwd: process.cwd() });
    const base = `http://127.0.0.1:${httpPort}`;

    hub = spawn(process.execPath, [BIN, "start", "--foreground", "--no-tunnel", "--home", home], { stdio: ["ignore", "pipe", "pipe"] });
    const health = await runStep("hub healthy (mongo ok, redis ok)", waitHealthy(base));
    assert.equal(health.deps?.mongo, "ok");
    assert.equal(health.deps?.redis, "ok");

    const ownerPair = generateKeyPairSync("ed25519");
    const ownerPrivJwk = ownerPair.privateKey.export({ format: "jwk" });
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
    const ownerToken = await runStep("owner membership session restored", (async () => {
      const res = await fetch(`${base}/api/social/session/restore`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityAccessToken: ownerIdentityToken, deviceId: "dev_a" }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body.sessions[0].accessToken;
    })());

    const photoId = await runStep("real photo upload through the resumable route (read-back verified)", uploadMedia(base, ownerToken, ownerPrivJwk, await samplePhotoBytes(), "image/jpeg"));
    const videoId = await runStep("real video upload through the resumable route", uploadMedia(base, ownerToken, ownerPrivJwk, await sampleVideoBytes(), "video/mp4"));

    const mixedPayload = { type: "photo", mediaRefs: [photoId, videoId], text: "the lake day" };
    const mixedPost = await runStep("mixed post created (signed, ordered photo→video)", (async () => {
      const res = await fetch(`${base}/api/social/posts`, writeHeaders(ownerPrivJwk, ownerToken, mixedPayload));
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body.post ?? body;
    })());

    await runStep("timeline card carries the mixed projection and per-reference stamps in attachment order", (async () => {
      const res = await fetch(`${base}/api/social/timeline`, { headers: { authorization: `Bearer ${ownerToken}` } });
      assert.equal(res.status, 200);
      const timeline = (await res.json()).posts;
      const card = timeline.find((row) => row._id === mixedPost._id);
      assert.ok(card, JSON.stringify(timeline.map((row) => row.text)));
      assert.equal(card.type, "mixed");
      assert.deepEqual(card.mediaRefs, [photoId, videoId]);
      assert.equal(card.mediaMeta[videoId].kind, "video");
      assert.ok(card.mediaMeta[videoId].durationMs > 0, "the video stamp carries durationMs");
      assert.equal(card.mediaMeta[photoId].kind, "photo");
      assert.equal(card.mediaMeta[photoId].durationMs, null);
      const serial = JSON.stringify(card);
      // No media bytes ride the card read: the payload carries stamps and
      // content addresses, never binary (rendition `bytes` fields are the
      // rung sizes — PORCH-044 geometry, not media bytes).
      assert.equal(/data:image/.test(serial), false);
      assert.equal(/base64,/.test(serial), false);
    })());

    await runStep("detail read carries the same ordered stamps", (async () => {
      const res = await fetch(`${base}/api/social/posts/${mixedPost._id}`, { headers: { authorization: `Bearer ${ownerToken}` } });
      assert.equal(res.status, 200);
      const post = (await res.json()).post;
      assert.equal(post.type, "mixed");
      assert.equal(post.mediaMeta[videoId].kind, "video");
      assert.ok(post.mediaMeta[videoId].durationMs > 0);
      assert.equal(post.mediaMeta[photoId].kind, "photo");
    })());

    await runStep("catch-up envelopes carry the per-reference kind + geometry + durationMs, never bytes", (async () => {
      const res = await fetch(`${base}/api/social/events?since=`, { headers: { authorization: `Bearer ${ownerToken}` } });
      assert.equal(res.status, 200);
      const body = await res.json();
      const created = (body.events ?? []).find((event) => event.type === "post.created" && event.postId === mixedPost._id);
      assert.ok(created, JSON.stringify((body.events ?? []).map((event) => event.type)));
      assert.equal(created.content.type, "mixed");
      assert.equal(created.content.mediaMeta[videoId].kind, "video");
      assert.ok(created.content.mediaMeta[videoId].durationMs > 0);
      assert.equal(created.content.mediaMeta[photoId].kind, "photo");
      assert.equal(/base64,/.test(JSON.stringify(created.content)), false);
    })());

    await runStep("atomicity: an uncommitted reference creates nothing (422, E_MEDIA_UNCOMMITTED)", (async () => {
      const payload = { type: "photo", mediaRefs: [photoId, "med_never_uploaded"], text: "half staged" };
      const res = await fetch(`${base}/api/social/posts`, writeHeaders(ownerPrivJwk, ownerToken, payload));
      assert.equal(res.status, 422, `expected 422, got ${res.status}`);
      const body = await res.json();
      assert.equal(body.code, "E_MEDIA_UNCOMMITTED");
      assert.equal(body.error, "Nothing was created: one of the attached files never finished uploading. Re-attach the missing file and try again.");
      const timeline = (await (await fetch(`${base}/api/social/timeline`, { headers: { authorization: `Bearer ${ownerToken}` } })).json()).posts;
      assert.equal(timeline.some((row) => row.text === "half staged"), false, "no read surface serves the half-state");
    })());

    await runStep("quota class: an item over the owner storage ceiling is refused at its upload admission", (async () => {
      const put = await fetch(`${base}/api/social/console/limits`, {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ storageCeilingMb: 1, retentionDays: null }),
      });
      assert.ok([200, 201].includes(put.status), JSON.stringify(await put.json()));
      const declare = { scope: "media-upload", size: 2 * 1024 * 1024, contentType: "video/mp4" };
      const res = await fetch(`${base}/api/social/media/uploads`, writeHeaders(ownerPrivJwk, ownerToken, declare));
      assert.equal(res.status, 429, `expected the quota refusal (429), got ${res.status}`);
      const body = await res.json();
      assert.equal(body.code, "E_STORAGE_QUOTA_EXCEEDED");
      assert.equal(
        body.error,
        "This network is full: the owner has set a storage limit and it has been reached. Free up space or ask the owner to raise the limit.",
      );
    })());

    await runStep("legacy: a single-shaped photo post keeps type photo through the same projection", (async () => {
      const legacyPayload = { type: "photo", mediaRefs: [photoId], text: "plain photo" };
      const res = await fetch(`${base}/api/social/posts`, writeHeaders(ownerPrivJwk, ownerToken, legacyPayload));
      assert.ok([200, 201].includes(res.status), JSON.stringify(await res.json()));
      const timeline = (await (await fetch(`${base}/api/social/timeline`, { headers: { authorization: `Bearer ${ownerToken}` } })).json()).posts;
      const card = timeline.find((row) => row.text === "plain photo");
      assert.equal(card.type, "photo");
      assert.equal(card.mediaMeta[photoId].kind, "photo");
    })());

    console.log("✓ PORCH-143 deployed-hub stage 2 complete");
  } finally {
    if (hub) hub.kill();
    if (!keep) await rm(home, { recursive: true, force: true }).catch(() => {});
  }
});
