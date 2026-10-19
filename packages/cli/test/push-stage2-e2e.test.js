// PORCH-059 stage 2 — deployed-hub shape: real daemons (mongo/redis binaries
// from `porchlight setup`), real hub process (the built apps/server boot the
// supervisor spawns), real media root, real HTTP, and the production
// web-push sender carrying real VAPID + RFC 8291 ciphertext to a local TLS
// capture relay (the vendor-relay stand-in). Every push route the client
// calls, every send pipeline outcome line, exercised end to end:
//   GET  /api/social/push/vapid             (key byte-equal to state/vapid-keys.json)
//   GET/PUT /api/social/push/settings       (opt-in default vs the walked enable)
//   POST/DELETE /api/social/push/subscriptions
//   triggers through real write routes: POST /posts, /comments (reply),
//   /posts/:id/reactions, /groups + a group-targeted post
//   outcomes: push.send.ok, push.subscription.expired (410, row deleted),
//   push.send.dropped (bounded retry), push.send.skipped
//   (switch_off / no_subscription / event_disabled) — in <home>/logs/hub.log,
//   the file the supervisor pipes.
import test from "node:test";
import { spawn, execFile } from "node:child_process";
import {
  createDecipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import https from "node:https";
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

const canonical = (o) => JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])));
const signNonce = (priv, msg) => sign(null, Buffer.from(msg, "utf8"), createPrivateKey({ key: priv, format: "jwk" })).toString("base64url");
const jwkOf = (pair) => pair.publicKey.export({ format: "jwk" });
const signPayload = (priv, payload) => signNonce(priv, canonical(payload));

async function openSession(base, did, deviceId, pair) {
  const ch = await (await fetch(`${base}/api/identity/session/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ did }) })).json();
  const res = await fetch(`${base}/api/identity/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did, deviceId, nonce: ch.nonce, signature: signNonce(pair.privateKey.export({ format: "jwk" }), ch.nonce) }),
  });
  const body = await res.json();
  assert.ok([200, 201].includes(res.status), JSON.stringify(body));
  return body.accessToken;
}

/** A device-held Web Push keypair: the client half of RFC 8291 (real ECDH). */
function pushClientKeys() {
  const client = createECDH("prime256v1");
  client.generateKeys();
  return { client, p256dh: client.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
}

/** Decrypt a captured aes128gcm record with the device's private half. */
function decryptRecord(client, p256dh, auth, body) {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const senderPub = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const hkdfExpand = (prk, info, length) => {
    const blocks = [];
    let t = Buffer.alloc(0);
    let counter = 1;
    while (Buffer.concat(blocks).length < length) {
      t = createHmac("sha256", prk).update(Buffer.concat([t, info, Uint8Array.of(counter)])).digest();
      blocks.push(t);
      counter += 1;
    }
    return Buffer.concat(blocks).subarray(0, length);
  };
  const ek = createHmac("sha256", Buffer.from(auth, "base64url")).update(client.computeSecret(senderPub)).digest();
  const secret = hkdfExpand(ek, Buffer.concat([Buffer.from("WebPush: info\0"), Buffer.from(p256dh, "base64url"), senderPub]), 32);
  const prk = createHmac("sha256", salt).update(secret).digest();
  const cek = hkdfExpand(prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdfExpand(prk, Buffer.from("Content-Encoding: nonce\0"), 12);
  const decipher = createDecipheriv("aes-128-gcm", cek, Buffer.from(nonce));
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (padded[end] === 0 && end > 0) end -= 1;
  assert.equal(padded[end], 2, "the aes128gcm padding delimiter");
  return JSON.parse(Buffer.from(padded.subarray(0, end)).toString("utf8"));
}

/** The vendor-relay stand-in over real TLS: per-path response classes. */
function tlsRelay() {
  const captured = [];
  const handler = (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const statusCode = req.url.endsWith("/gone") ? 410 : req.url.endsWith("/flaky") ? 503 : 201;
      captured.push({ endpoint: req.url, body: Buffer.concat(chunks) });
      res.writeHead(statusCode, { location: "https://web.push.apple.com/" });
      res.end();
    });
  };
  return { captured, handler };
}

/** The hub's structured push lines, as the supervisor pipes them into logs/hub.log. */
const kindsOf = (logText) =>
  logText
    .split("\n")
    .filter((line) => line.includes('"kind":"push"'))
    .map((line) => JSON.parse(line.slice(line.indexOf("{"))));

test("device notifications, deployed-hub stage 2: every push route + every send outcome", {
  skip: process.env.PORCHLIGHT_S2 === "1" ? false : "runs only with PORCHLIGHT_S2=1",
  timeout: 900_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), "porch059-s2-"));
  let hub = null;
  let relay = null;
  try {
    console.log("stage-2 home:", home);
    await runStep("porchlight setup (real daemons)", execFileP(process.execPath, [BIN, "setup", "--home", home]));

    // The vendor-relay stand-in: self-signed TLS so the hub's real sender
    // (web-push, https-only) ships its exact ciphertext to the capture.
    const relayDir = join(home, "relay");
    await mkdir(relayDir, { recursive: true });
    const keyPath = join(relayDir, "key.pem");
    const certPath = join(relayDir, "cert.pem");
    await runStep("relay cert", execFileP("/usr/bin/openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-keyout", keyPath, "-out", certPath, "-days", "2", "-nodes",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
    ]));
    const [key, cert] = await Promise.all([readFile(keyPath, "utf8"), readFile(certPath, "utf8")]);
    const { captured, handler } = tlsRelay();
    relay = https.createServer({ key, cert }, handler);
    await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const relayBase = `https://127.0.0.1:${relay.address().port}`;
    const okEndpoint = `${relayBase}/push/ok`;
    const goneEndpoint = `${relayBase}/push/gone`;
    const flakyEndpoint = `${relayBase}/push/flaky`;

    const seed = 11_000 + (process.pid % 20_000) * 3;
    const httpPort = 21_000 + (seed % 20_000);
    await execFileP(process.execPath, ["-e", `
      const { loadConfig, saveConfig } = await import("@porchlight/shared");
      const config = loadConfig(${JSON.stringify(home)});
      config.daemons.mongoPort = ${31_000 + (seed % 20_000)};
      config.daemons.redisPort = ${31_000 + (seed % 20_000) + 1};
      config.hub.httpPort = ${httpPort};
      saveConfig(${JSON.stringify(home)}, config);
    `], { cwd: process.cwd() });
    const base = `http://127.0.0.1:${httpPort}`;

    // The relay cert is machine-local test material, trusted by this hub
    // boot only through the node CA env — the production sender path itself
    // (web-push over https) runs unmodified.
    hub = spawn(process.execPath, [BIN, "start", "--foreground", "--no-tunnel", "--home", home], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const health = await runStep("hub healthy (mongo ok, redis ok)", waitHealthy(base));
    assert.equal(health.deps?.mongo, "ok");
    assert.equal(health.deps?.redis, "ok");

    // Owner bootstrap, network, member join — the real surfaces (as the
    // avatar stage-2 pass rides them).
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
    const ownerIdentityToken = await runStep("owner identity session", openSession(base, ownerDid, "dev_a", ownerPair));

    await runStep("bootstrap network", execFileP(process.execPath, [BIN, "bootstrap", "--home", home, "--network", "Family"]).then((r) => process.stdout.write(r.stdout)));
    await rm(join(home, "state", "processes", "hub.json"), { force: true });
    const ownerToken = await runStep("owner membership session", (async () => {
      const res = await fetch(`${base}/api/social/session/restore`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityAccessToken: ownerIdentityToken, deviceId: "dev_a" }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body.sessions[0].accessToken;
    })());

    const invite = await runStep("console join link minted", (async () => {
      const res = await fetch(`${base}/api/social/console/invites`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ role: "member", maxUses: 1 }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body.invite;
    })());
    const code = invite.code ?? invite.token;
    const memberPair = generateKeyPairSync("ed25519");
    const memberPrivJwk = memberPair.privateKey.export({ format: "jwk" });
    const member = await runStep("member identity birth at the join link", (async () => {
      const res = await fetch(`${base}/api/bootstrap/join-member`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, firstName: "Linda", lastName: "Brown", device: { deviceId: "dev_b", label: "Linda's phone", publicKeyJwk: jwkOf(memberPair) } }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body;
    })());
    const memberDid = member.account.did;
    const admit = await runStep("member admits through the join link", (async () => {
      const session = await openSession(base, memberDid, "dev_b", memberPair);
      const res = await fetch(`${base}/api/social/join/admit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code,
          identityAccessToken: session,
          deviceId: "dev_b",
          devicePublicKeyJwk: jwkOf(memberPair),
          signature: signNonce(memberPrivJwk, `porchlight-join:${code}`),
        }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body;
    })());
    const memberToken = admit.accessToken;

    const social = `${base}/api/social`;
    const call = async (path, token, body, method = "POST") => {
      const res = await fetch(`${social}${path}`, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(method === "GET" || method === "HEAD" ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };

    // ---- Route family: the calls PORCH-060's screen rides ---------------
    const vapid = await runStep("GET /push/vapid", call("/push/vapid", null, {}, "GET"));
    assert.ok([200, 201].includes(vapid.status));
    assert.equal(vapid.body.available, true);
    const stateKeys = JSON.parse(await readFile(join(home, "state", "vapid-keys.json"), "utf8"));
    assert.equal(vapid.body.publicKey, stateKeys.publicKey, "the served key is byte-equal to the runtime-setup state file");

    // Opt-in default over the wire: the PUT-persisted off row reads back.
    const putOff = await runStep("Linda PUT settings enabled:false", call("/push/settings", memberToken, { enabled: false }, "PUT"));
    assert.ok([200, 201].includes(putOff.status));
    const readBackOff = await call("/push/settings", memberToken, null, "GET");
    assert.ok([200, 201].includes(readBackOff.status));
    assert.equal(readBackOff.body.settings.enabled, false);

    // ---- Triggers through the real write routes -------------------------
    const post = (payload) => (token, priv) => call("/posts", token, { payload, signature: signPayload(priv, payload) });
    const mkPost = async (token, priv, payload) => {
      const res = await runStep(`post: ${payload.body ?? "…"}`, post(payload)(token, priv));
      assert.ok([200, 201].includes(res.status), JSON.stringify(res.body));
      return res.body.post;
    };
    const ownerPostA = await mkPost(ownerToken, ownerPrivJwk, { type: "text", body: "Sunday dinner at six" });
    const react = (member, emoji, targetPost) => call(`/posts/${targetPost._id}/reactions`, member.token, {
      payload: { postId: targetPost._id, emoji },
      signature: signPayload(member.priv, { postId: targetPost._id, emoji }),
    });

    const owner = { token: ownerToken, priv: ownerPrivJwk, did: ownerDid };
    const linda = { token: memberToken, priv: memberPrivJwk, did: memberDid };

    // Default-off identity: the owner never enabled — the reaction resolve
    // skips with a switch_off line, no send anywhere.
    const silentReact = await runStep("reaction at an opted-out target", react(linda, "⭐", ownerPostA));
    assert.ok([200, 201].includes(silentReact.status), JSON.stringify(silentReact.body));

    // Linda walks the enable flow over the real routes, then registers.
    const putOn = await runStep("Linda PUT settings enabled:true", call("/push/settings", memberToken, { enabled: true }, "PUT"));
    assert.ok([200, 201].includes(putOn.status));
    const lindaKeys = pushClientKeys();
    const register = (token, endpoint, keys) => call("/push/subscriptions", token, { endpoint, keys });
    const regLinda = await runStep("Linda registers (relay /ok)", register(memberToken, okEndpoint, { p256dh: lindaKeys.p256dh, auth: lindaKeys.auth }));
    assert.ok([200, 201].includes(regLinda.status), JSON.stringify(regLinda.body));

    // Reaction → the real production sender → the relay ciphertext →
    // content-only plaintext under the device's own keys. Linda's own post
    // makes Linda the reaction target.
    const lindaPost = await mkPost(memberToken, memberPrivJwk, { type: "text", body: "Lake morning was cold" });
    const deliveredReact = await runStep("reaction at an enabled pair", react(owner, "🌅", lindaPost));
    assert.ok([200, 201].includes(deliveredReact.status), JSON.stringify(deliveredReact.body));
    const reactionCaptures = captured.filter((c) => c.endpoint === "/push/ok");
    assert.equal(reactionCaptures.length, 1, "the relay received exactly one real push");
    const reactionPlaintext = decryptRecord(lindaKeys.client, lindaKeys.p256dh, lindaKeys.auth, reactionCaptures[0].body);
    assert.deepEqual(Object.keys(reactionPlaintext).sort(), ["authorName", "commentId", "excerpt", "networkName", "postId", "type"], "content-only envelope");
    assert.equal(reactionPlaintext.type, "reaction");
    assert.equal(reactionPlaintext.postId, lindaPost._id);
    assert.equal(reactionPlaintext.authorName, "Brian Noah");
    assert.equal(reactionPlaintext.networkName, "Family");

    // 410 expiry through the real sender: an owner registration riding a
    // dead endpoint expires the row at the next owner-targeted trigger.
    const ownerKeys = pushClientKeys();
    await runStep("owner PUT settings enabled:true", call("/push/settings", ownerToken, { enabled: true }, "PUT"));
    const regOwnerGone = await runStep("owner registers (relay /gone)", register(ownerToken, goneEndpoint, { p256dh: ownerKeys.p256dh, auth: ownerKeys.auth }));
    assert.ok([200, 201].includes(regOwnerGone.status), JSON.stringify(regOwnerGone.body));
    const ownerRoot = await runStep("owner root comment", call(`/posts/${ownerPostA._id}/comments`, ownerToken, {
      payload: { postId: ownerPostA._id, parentId: null, body: "Root" },
      signature: signPayload(ownerPrivJwk, { postId: ownerPostA._id, parentId: null, body: "Root" }),
    }));
    assert.ok([200, 201].includes(ownerRoot.status));
    const reply = await runStep("Linda replies to the owner's root comment", call(`/posts/${ownerPostA._id}/comments`, memberToken, {
      payload: { postId: ownerPostA._id, parentId: ownerRoot.body.comment._id, body: "We'll bring pie" },
      signature: signPayload(memberPrivJwk, { postId: ownerPostA._id, parentId: ownerRoot.body.comment._id, body: "We'll bring pie" }),
    }));
    assert.ok([200, 201].includes(reply.status));
    assert.equal(captured.filter((c) => c.endpoint === "/push/gone").length, 1, "the dead endpoint took exactly one attempt, no retry (410 class)");

    // The expired row is gone: the next owner-targeted trigger skips with
    // no_subscription, never a second relay call.
    const afterExpiry = await runStep("reaction at the expired-row identity", react(linda, "💗", ownerPostA));
    assert.ok([200, 201].includes(afterExpiry.status));
    assert.equal(captured.filter((c) => c.endpoint === "/push/gone").length, 1, "no second send to the expired endpoint");

    // Transient failure: one bounded retry, then drop — the row survives.
    const regOwnerFlaky = await runStep("owner re-registers (relay /flaky)", register(ownerToken, flakyEndpoint, { p256dh: ownerKeys.p256dh, auth: ownerKeys.auth }));
    assert.ok([200, 201].includes(regOwnerFlaky.status));
    const transientReact = await runStep("reaction at the flaky endpoint", react(linda, "🎉", ownerPostA));
    assert.ok([200, 201].includes(transientReact.status));
    assert.equal(captured.filter((c) => c.endpoint === "/push/flaky").length, 2, "exactly the one bounded retry");

    // Group posts: the shipped default-ON toggle (PORCH-108, Brian Oct 19,
    // 2026) delivers through the routes; the member's explicit OFF gates
    // them again.
    const group = (await runStep("Linda creates a group", call("/groups", memberToken, { name: "Picnic", members: [ownerDid, memberDid] }))).body.group;
    // The /flaky row died of the bounded-retry drop; re-registration
    // replaces it with a live one (the same walked flow the client runs).
    await runStep("owner re-registers (relay /ok)", register(ownerToken, okEndpoint, { p256dh: ownerKeys.p256dh, auth: ownerKeys.auth }));
    await runStep("group post rides the shipped default ON", (async () => {
      const res = await call("/posts", memberToken, {
        payload: { type: "text", groupId: group._id, body: "Picnic planning" },
        signature: signPayload(memberPrivJwk, { type: "text", groupId: group._id, body: "Picnic planning" }),
      });
      assert.ok([200, 201].includes(res.status), JSON.stringify(res.body));
      // The owner enabled with no per-event write: the absent groupPost
      // key resolved the shipped ON default — no toggle leg was needed.
      const okCaptures = captured.filter((c) => c.endpoint === "/push/ok");
      assert.equal(okCaptures.length, 2, "the groupPost push landed beside the earlier reaction push");
      const groupPlaintext = decryptRecord(ownerKeys.client, ownerKeys.p256dh, ownerKeys.auth, okCaptures[1].body);
      assert.equal(groupPlaintext.type, "groupPost");
      assert.equal(groupPlaintext.networkName, "Family");
      assert.deepEqual(Object.keys(groupPlaintext).sort(), ["authorName", "commentId", "excerpt", "networkName", "postId", "type"], "content-only envelope, no counts anywhere");
    })());
    await runStep("owner toggles groupPost off", call("/push/settings", ownerToken, { enabled: true, events: { groupPost: false } }, "PUT"));
    await runStep("group post at the toggled-off member", (async () => {
      const res = await call("/posts", memberToken, {
        payload: { type: "text", groupId: group._id, body: "Potluck list" },
        signature: signPayload(memberPrivJwk, { type: "text", groupId: group._id, body: "Potluck list" }),
      });
      assert.ok([200, 201].includes(res.status), JSON.stringify(res.body));
      assert.equal(captured.filter((c) => c.endpoint === "/push/ok").length, 2, "the explicit OFF produced no further push");
    })());

    // DELETE: the device retracts its registration; the next Linda-targeted
    // trigger skips with no_subscription and no relay call.
    const deleted = await runStep("Linda DELETE subscription", call("/push/subscriptions", memberToken, { endpoint: okEndpoint }, "DELETE"));
    assert.ok([200, 201].includes(deleted.status), JSON.stringify(deleted.body));
    const afterDelete = await runStep("reaction at the deleted-row identity", react(owner, "👋", lindaPost));
    assert.ok([200, 201].includes(afterDelete.status));
    assert.equal(captured.filter((c) => c.endpoint === "/push/ok").length, 2, "no relay call after the delete");

    // ---- The deployed-hub log discriminator (logs/hub.log) --------------
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const logText = await readFile(join(home, "logs", "hub.log"), "utf8");
    const pushLines = kindsOf(logText);
    const line = (predicate, why) => {
      const found = pushLines.find(predicate);
      assert.ok(found, `${why} — the line the supervisor pipes into logs/hub.log`);
      return found;
    };
    const okLine = line((l) => l.event === "push.send.ok", "push.send.ok");
    assert.ok(okLine.subscriptionId, "the ok line carries the subscription id");
    const expiredLine = line((l) => l.event === "push.subscription.expired", "push.subscription.expired");
    assert.equal(expiredLine.statusCode, 410);
    const droppedLine = line((l) => l.event === "push.send.dropped", "push.send.dropped");
    assert.ok(droppedLine.identityId, "the drop carries the identity");
    line((l) => l.event === "push.send.skipped" && l.reason === "switch_off", "switch_off skip");
    line((l) => l.event === "push.send.skipped" && l.reason === "no_subscription", "no_subscription skip");
    line((l) => l.event === "push.send.skipped" && l.reason === "event_disabled", "event_disabled skip");
  } finally {
    relay?.close();
    if (hub) {
      hub.kill("SIGTERM");
      await new Promise((resolve) => hub.once("exit", resolve));
      // The supervisor's daemon children outlive the hub process: reclaim
      // them so the machine never carries orphan mongod/redis after the run.
      await new Promise((resolve) => execFile("pkill", ["-f", home], () => resolve()));
    }
    if (process.env.PORCHLIGHT_S2_KEEP !== "1") await rm(home, { recursive: true, force: true });
  }
});