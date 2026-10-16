// PORCH-091 stage 2 — deployed-hub shape: real daemons (mongo/redis binaries
// from `porchlight setup`), real hub process (the built apps/server boot the
// supervisor spawns), real HTTP. The reaction-chips route family, re-verified
// per the Oct 12 verification contract before user-testing:
//   POST /api/social/posts/:postId/reactions   (signed add — chip join)
//   GET  /api/social/posts/:postId/reactions   (detail read — attributed rows)
//   GET  /api/social/timeline                  (feed read — attributed card rows)
//   DELETE /api/social/posts/:postId/reactions (signed removal — chip leave)
//   GET  /api/social/events?since=             (catch-up — content-only envelopes)
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

test("reaction chips, deployed-hub stage 2: the reaction read/add/remove route family with reactor attribution", { skip: process.env.PORCHLIGHT_S2 === "1" ? false : "runs only with PORCHLIGHT_S2=1" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "porch091-s2-"));
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

    // A second member joins through the real surfaces so the chip shows
    // distinct people with real names.
    const invite = await runStep("console join link minted", (async () => {
      const res = await fetch(`${base}/api/social/console/invites`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ role: "member", maxUses: 1 }),
      });
      const body = await res.json();
      assert.equal(res.status, 201, JSON.stringify(body));
      return body.invite ?? body;
    })());
    const code = invite.code ?? invite.token;
    assert.ok(code, JSON.stringify(invite));

    const memberPair = generateKeyPairSync("ed25519");
    const memberPrivJwk = memberPair.privateKey.export({ format: "jwk" });
    const memberBirth = await runStep("member identity birth at the join link", (async () => {
      const res = await fetch(`${base}/api/bootstrap/join-member`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, firstName: "Linda", lastName: "Brown", device: { deviceId: "dev_b", label: "Linda's phone", publicKeyJwk: jwkOf(memberPair) } }),
      });
      const body = await res.json();
      assert.equal(res.status, 201, JSON.stringify(body));
      return body;
    })());
    const memberDid = memberBirth.account.did;
    // The invite burns on admit; the token from admit serves the reads.
    const memberToken = await runStep("member admits through the join link", (async () => {
      const identityAccessToken = await openSession(base, memberDid, "dev_b", memberPair);
      const res = await fetch(`${base}/api/social/join/admit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code,
          identityAccessToken,
          deviceId: "dev_b",
          devicePublicKeyJwk: jwkOf(memberPair),
          signature: signNonce(memberPrivJwk, `porchlight-join:${code}`),
        }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body.accessToken;
    })());

    const ownerPrivJwk = ownerPair.privateKey.export({ format: "jwk" });
    const writeHeaders = (privJwk, token, payload, method = "POST") => ({
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ payload, signature: signNonce(privJwk, canonical(payload)) }),
    });

    const postPayload = { type: "text", body: "the chip post" };
    const post = (await runStep("post created (signed)", (async () => {
      const res = await fetch(`${base}/api/social/posts`, writeHeaders(ownerPrivJwk, ownerToken, postPayload));
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body.post ?? body;
    })()));

    const react = async (privJwk, token, emoji) => {
      const payload = { postId: post._id, emoji };
      const res = await fetch(`${base}/api/social/posts/${post._id}/reactions`, writeHeaders(privJwk, token, payload));
      return res;
    };

    // Chip join rides the existing signed reaction add, in origin order.
    const lindaReaction = await runStep("Linda's chip join (signed add)", (async () => {
      const res = await react(memberPrivJwk, memberToken, "🫶");
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      assert.deepEqual(Object.keys(body.reaction).sort(), ["_id", "createdAt", "emoji", "memberDid"], "the write response stays member + emoji");
      return body.reaction;
    })());
    const heartPayload = { postId: post._id, emoji: "🫶" };
    const ownerReaction = await runStep("owner's chip join (signed add)", (async () => {
      const res = await react(ownerPrivJwk, ownerToken, "🫶");
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      assert.deepEqual(Object.keys(body.reaction).sort(), ["_id", "createdAt", "emoji", "memberDid"]);
      return body.reaction;
    })());
    await runStep("duplicate same-member same-emoji refused (idempotent class)", (async () => {
      const res = await fetch(`${base}/api/social/posts/${post._id}/reactions`, writeHeaders(ownerPrivJwk, ownerToken, heartPayload));
      assert.equal(res.ok, false, `the write should refuse: ${res.status}`);
    })());

    await runStep("detail reaction read carries reactor attribution in origin order", (async () => {
      const res = await fetch(`${base}/api/social/posts/${post._id}/reactions`, { headers: { authorization: `Bearer ${memberToken}` } });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      const rows = body.reactions;
      assert.deepEqual(
        rows.map((row) => ({ emoji: row.emoji, memberDid: row.memberDid, memberName: row.memberName })),
        [
          { emoji: "🫶", memberDid: lindaReaction.memberDid, memberName: "Linda Brown" },
          { emoji: "🫶", memberDid: ownerReaction.memberDid, memberName: "Brian Noah" },
        ],
        "distinct reactors hold the emoji, names resolved at read time",
      );
      for (const key of Object.keys(rows[0]).sort()) {
        assert.ok(!/count/i.test(key), `no count-bearing field on the read: ${key}`);
      }
      assert.equal(JSON.stringify(rows).includes("Count"), false, "no count field rides the read payload");
    })());

    await runStep("feed read's card reaction rows carry the same attribution", (async () => {
      const res = await fetch(`${base}/api/social/timeline`, { headers: { authorization: `Bearer ${ownerToken}` } });
      assert.equal(res.status, 200);
      const timeline = (await res.json()).posts;
      const card = timeline.find((row) => row._id === post._id);
      assert.ok(card, JSON.stringify(timeline.map((row) => row.body)));
      assert.deepEqual(
        card.reactionRows.map((row) => row.memberName),
        ["Linda Brown", "Brian Noah"],
        "the card serves the same attributed rows in the same order",
      );
      const heartRows = card.reactionRows.filter((row) => row.emoji === "🫶");
      assert.equal(new Set(heartRows.map((row) => row.memberDid)).size, 2, "distinct-people count derives from the rows: two");
      assert.equal(JSON.stringify(card.reactionRows).includes("ount"), false, "no count or aggregate value on the card rows");
    })());

    await runStep("chip leave removes only the member's own row", (async () => {
      const res = await fetch(`${base}/api/social/posts/${post._id}/reactions`, writeHeaders(memberPrivJwk, memberToken, heartPayload, "DELETE"));
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      assert.equal(body.removed, true, JSON.stringify(body));
    })());

    await runStep("idempotent no-op on a chip already clear", (async () => {
      const res = await fetch(`${base}/api/social/posts/${post._id}/reactions`, writeHeaders(memberPrivJwk, memberToken, heartPayload, "DELETE"));
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      assert.deepEqual(body, { removed: false, reaction: null }, "clearing an emoji not currently reacted is a no-op result");
    })());

    await runStep("other members' rows survive the leave; the count re-derives", (async () => {
      const res = await fetch(`${base}/api/social/posts/${post._id}/reactions`, { headers: { authorization: `Bearer ${memberToken}` } });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.deepEqual(
        body.reactions.map((row) => ({ emoji: row.emoji, memberName: row.memberName })),
        [{ emoji: "🫶", memberName: "Brian Noah" }],
        "the owner's row survived; the derived count re-derives to one",
      );
      // Re-join: the count re-derives to two again (nothing stored anywhere).
      const again = await fetch(`${base}/api/social/posts/${post._id}/reactions`, writeHeaders(memberPrivJwk, memberToken, heartPayload));
      assert.ok([200, 201].includes(again.status), JSON.stringify(await again.json()));
      const finalRows = (await (await fetch(`${base}/api/social/posts/${post._id}/reactions`, { headers: { authorization: `Bearer ${memberToken}` } })).json()).reactions;
      assert.equal(new Set(finalRows.filter((row) => row.emoji === "🫶").map((row) => row.memberDid)).size, 2, "re-join re-derives two people");
    })());

    await runStep("catch-up envelopes stay content-only (no count, no roster)", (async () => {
      const res = await fetch(`${base}/api/social/events?since=`, { headers: { authorization: `Bearer ${memberToken}` } });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      const reactionEnvelope = (body.events ?? []).find((event) => event.type === "reaction.applied");
      assert.ok(reactionEnvelope, JSON.stringify((body.events ?? []).map((event) => event.type)));
      assert.deepEqual(Object.keys(reactionEnvelope.content).sort(), ["_id", "createdAt", "emoji", "memberDid"], "reaction.applied carries member + emoji only");
    })());

    console.log("STAGE-2 PASSED (porch091)");
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