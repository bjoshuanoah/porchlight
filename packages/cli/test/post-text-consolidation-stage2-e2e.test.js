// PORCH-157 stage 2 — deployed-hub shape (the Oct 12 verification
// contract): real daemons, real hub process, real HTTP. The post-text
// consolidation's route family, re-verified before user-testing:
//   POST /api/social/posts        (signed create — the ONE text field, legacy keys refused)
//   PUT  /api/social/posts/:id    (signed edit — text + target, legacy keys refused)
//   GET  /api/social/timeline     (card read)
//   GET  /api/social/posts/:id    (detail read)
//   GET  /api/social/search?q=    (search over the one text field)
//   GET  /api/social/events?since= (catch-up envelopes carry one text value)
//   the notification excerpt      (a real reaction send composes from the one field)
import test from "node:test";
import { spawn, execFile, execFileSync } from "node:child_process";
import { createDecipheriv, createECDH, createHmac, sign, createPrivateKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import https from "node:https";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const pExecFile = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/porchlight.mjs", import.meta.url));

function runStep(name, promise) {
  return promise.then(
    (value) => { console.log(`✓ ${name}`); return value; },
    (error) => { console.error(`✗ ${name}`); console.error(error && (error.message ?? error)); throw error });
}

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
const signPayload = (priv, payload) => signNonce(priv, canonical(payload));
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

/** The vendor-relay stand-in over real TLS: captures the push records. */
async function tlsRelay(captured) {
  const handler = (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      captured.push({ endpoint: req.url, body: Buffer.concat(chunks) });
      res.writeHead(201, { location: "https://web.push.apple.com/" });
      res.end();
    });
  };
  const dir = await mkdtemp(join(tmpdir(), "porch157-relay-"));
  execFileSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-days", "2", "-nodes", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")]);
  const server = https.createServer({ key: await readFile(join(dir, "key.pem"), "utf8"), cert: await readFile(join(dir, "cert.pem"), "utf8") }, handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, okEndpoint: `https://127.0.0.1:${server.address().port}/push/ok`, certPath: join(dir, "cert.pem") };
}

test("post-text consolidation, deployed-hub stage 2: the create/edit/read/search/excerpt route family with the one text field", {
  skip: process.env.PORCHLIGHT_S2 === "1" ? false : "runs only with PORCHLIGHT_S2=1",
  timeout: 900_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), "porch157-s2-"));
  const keep = process.env.PORCHLIGHT_S2_KEEP === "1";
  let hub = null;
  let relay = null;
  const captured = [];
  try {
    console.log("stage-2 home:", home);
    await runStep("porchlight setup (real daemons downloaded)", pExecFile(process.execPath, [BIN, "setup", "--home", home]));

    const httpPort = await pickFreePort();
    const mongoPort = await pickFreePort();
    const redisPort = await pickFreePort();
    await pExecFile(process.execPath, ["-e", `
      const { loadConfig, saveConfig } = await import("@porchlight/shared");
      const config = loadConfig(${JSON.stringify(home)});
      config.daemons.mongoPort = ${mongoPort};
      config.daemons.redisPort = ${redisPort};
      config.hub.httpPort = ${httpPort};
      saveConfig(${JSON.stringify(home)}, config);
    `]);
    const base = `http://127.0.0.1:${httpPort}`;
    relay = await tlsRelay(captured);
    const okEndpoint = relay.okEndpoint;

    hub = spawn(process.execPath, [BIN, "start", "--foreground", "--no-tunnel", "--home", home], {
      // The relay's self-signed cert rides the node CA env — the production
      // sender path (web-push over https) runs unmodified.
      env: { ...process.env, NODE_EXTRA_CA_CERTS: relay.certPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    const ownerIdentityToken = await runStep("owner identity session", openSession(base, ownerDid, "dev_a", ownerPair));

    await runStep("bootstrap network", pExecFile(process.execPath, [BIN, "bootstrap", "--home", home, "--network", "Family"]).then((r) => (process.stdout.write(r.stdout), r)));
    const ownerToken = await runStep("owner membership session restored", (async () => {
      const res = await fetch(`${base}/api/social/session/restore`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityAccessToken: ownerIdentityToken, deviceId: "dev_a" }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body.sessions[0].accessToken;
    })());

    // A member joins (real console invite + join surfaces) — the excerpt leg
    // needs a live push subscriber who is not the author. THE POST is owned
    // by the member, so the owner's reaction composes and delivers there.
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
    const memberSession = await runStep("member identity session", openSession(base, member.account.did, "dev_b", memberPair));
    const memberToken = await runStep("member admits through the join link", (async () => {
      const res = await fetch(`${base}/api/social/join/admit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code,
          identityAccessToken: memberSession,
          deviceId: "dev_b",
          devicePublicKeyJwk: jwkOf(memberPair),
          signature: signNonce(memberPrivJwk, `porchlight-join:${code}`),
        }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body.accessToken;
    })());

    const social = `${base}/api/social`;
    const writeHeaders = (privJwk, token, payload, method = "POST") => ({
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ payload, signature: signPayload(privJwk, payload) }),
    });

    // ---- Create: the one text field on the wire and the document --------
    const textPayload = { type: "text", text: "Sunday dinner at six" };
    const textPost = await runStep("text post created with the one text field", (async () => {
      const res = await fetch(`${social}/posts`, writeHeaders(memberPrivJwk, memberToken, textPayload));
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body.post;
    })());
    for (const legacy of ["caption", "body"]) {
      assert.equal(legacy in textPost, false, `no ${legacy} key on the create response`);
    }

    await runStep("create refusing a legacy caption key (400, nothing created)", (async () => {
      const payload = { type: "text", caption: "stale shape" };
      const res = await fetch(`${social}/posts`, writeHeaders(memberPrivJwk, memberToken, payload));
      const body = await res.json();
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(body.code, "E_LEGACY_TEXT_KEY");
    })());

    // ---- Edit: the one text field in place, legacy keys refused ---------
    const edited = await runStep("edit changes the one text field in place", (async () => {
      const editBody = "Sunday dinner at six, bring the picnic blanket";
      const res = await fetch(`${social}/posts/${textPost._id}`, {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({
          payload: { text: editBody },
          signature: signPayload(memberPrivJwk, { kind: "post-edit", postId: textPost._id, networkId: textPost.originNetworkId, text: editBody }),
        }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body.post;
    })());
    assert.equal(edited.text, "Sunday dinner at six, bring the picnic blanket");
    for (const legacy of ["caption", "body"]) {
      assert.equal(legacy in edited, false, `no ${legacy} key on the edited view`);
    }

    await runStep("edit refusing a legacy caption key (400, nothing written)", (async () => {
      const editPayload = { caption: "the old field" };
      const res = await fetch(`${social}/posts/${textPost._id}`, writeHeaders(memberPrivJwk, memberToken, editPayload, "PUT"));
      const body = await res.json();
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(body.code, "E_EDIT_LEGACY_TEXT_KEY");
    })());

    // ---- Reads + search + catch-up: one text value, the key sweep -------
    await runStep("timeline, detail, search, and catch-up sweeps prove zero caption-bearing keys", (async () => {
      const timeline = await (await fetch(`${social}/timeline`, { headers: { authorization: `Bearer ${memberToken}` } })).json();
      const detail = await (await fetch(`${social}/posts/${textPost._id}`, { headers: { authorization: `Bearer ${memberToken}` } })).json();
      const search = await (await fetch(`${social}/search?q=${encodeURIComponent("picnic blanket")}`, { headers: { authorization: `Bearer ${memberToken}` } })).json();
      const events = await (await fetch(`${social}/events?since=`, { headers: { authorization: `Bearer ${memberToken}` } })).json();
      const sweep = JSON.stringify({ timeline, detail, search, events });
      for (const legacy of ["caption", "body"]) {
        assert.equal(sweep.includes(`"${legacy}"`), false, `zero ${legacy}-bearing keys across reads and envelopes`);
      }
      assert.equal((timeline.posts ?? []).some((row) => row._id === textPost._id), true);
      assert.equal(detail.post.text, edited.text);
      assert.equal(search.posts.some((row) => row._id === textPost._id), true, "search matches the one text field");
      const updatedEvent = (events.events ?? []).find((event) => event.type === "post.updated" && event.postId === textPost._id);
      assert.ok(updatedEvent, "post.updated rode catch-up with the edited view");
      assert.equal(updatedEvent.content.text, edited.text);
    })());

    // ---- The notification excerpt composes from the one field -----------
    const putOn = await runStep("member PUT push settings enabled:true", (async () => {
      const res = await fetch(`${social}/push/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ enabled: true }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body;
    })());
    assert.ok(putOn, "the enable write persisted");
    const memberKeys = pushClientKeys();
    const register = await runStep("member registers a live subscription (relay /push/ok)", (async () => {
      const res = await fetch(`${social}/push/subscriptions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ endpoint: okEndpoint, keys: { p256dh: memberKeys.p256dh, auth: memberKeys.auth } }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body;
    })());

    // The owner's reaction to the member's post: the excerpt composition
    // reads the post's ONE text field, decrypted at the relay stand-in.
    void register;
    const reactionRes = await runStep("owner reacts to the member's post", (async () => {
      const res = await fetch(`${social}/posts/${textPost._id}/reactions`, writeHeaders(ownerPrivJwk, ownerToken, { postId: textPost._id, emoji: "🌅" }));
      assert.ok([200, 201].includes(res.status), JSON.stringify(await res.json()));
      return res.status;
    })());
    void reactionRes;
    const deadline = Date.now() + 30_000;
    while (captured.length === 0 && Date.now() < deadline) await new Promise((w) => setTimeout(w, 250));
    assert.ok(captured.length > 0, "the reaction push reached the relay stand-in");
    const reactionPlaintext = decryptRecord(memberKeys.client, memberKeys.p256dh, memberKeys.auth, captured[captured.length - 1].body);
    assert.equal(reactionPlaintext.type, "reaction");
    assert.equal(reactionPlaintext.postId, textPost._id);
    assert.equal(reactionPlaintext.title, "Family", "the main line is the origin network's authored name");
    assert.equal(reactionPlaintext.body, "Brian Noah: 🌅\nSunday dinner at six, bring the picnic blanket");
    assert.equal(/caption/.test(JSON.stringify(reactionPlaintext)), false, "no caption-bearing key survives the excerpt");

    console.log("✓ PORCH-157 deployed-hub stage 2 complete");
  } finally {
    if (hub) hub.kill();
    if (relay) relay.server.close();
    if (!keep) await rm(home, { recursive: true, force: true }).catch(() => {});
  }
});
