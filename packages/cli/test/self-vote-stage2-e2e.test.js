// PORCH-113 stage 2 — deployed-hub shape: real daemons (mongo/redis binaries
// from `porchlight setup`), real hub process (the built apps/server boot the
// supervisor spawns), real HTTP. The vote route family — cast, change, clear,
// and the creation path's poster self-vote — re-verified per the Oct 12
// verification contract before user-testing:
//   POST   /api/social/posts                    (signed creation — the author's up-vote lands in the same operation, upCount 1 from the first served truth)
//   POST   /api/social/posts/:postId/votes      (signed cast/change — the self-vote is an ordinary vote)
//   DELETE /api/social/posts/:postId/votes      (signed clear ride — the member's own row leaves; nothing held refuses plainly)
//   GET    /api/social/timeline                 (card read — upCount + the viewer's own myVote)
//   GET    /api/social/events?since=            (catch-up — the envelope carries upCount only)
// Payload evidence: no down-count, ratio, or per-member vote record beyond the two ruled values on any surface.
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
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      // the hub starts when it starts
    }
    if (Date.now() - startedAt > timeoutMs) throw new Error(`hub never became healthy at ${base}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const canonical = (o) => JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])));
const signNonce = (privJwk, msg) => sign(null, Buffer.from(msg, "utf8"), createPrivateKey({ key: privJwk, format: "jwk" })).toString("base64url");
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

test("self-vote at publish + un-vote clear ride, deployed-hub stage 2", { skip: process.env.PORCHLIGHT_S2 === "1" ? false : "runs only with PORCHLIGHT_S2=1" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "porch113-s2-"));
  let hub = null;
  try {
    console.log("stage-2 home:", home);
    const setup = await runStep("porchlight setup (real daemons downloaded)", execFileP(process.execPath, [BIN, "setup", "--home", home]));
    process.stdout.write(setup.stdout.split("\n").slice(-4).join("\n") + "\n");

    const seed = 11_000 + (process.pid % 20_000) * 3;
    const httpPort = 40_000 + (seed % 20_000);
    await execFileP(process.execPath, ["-e", `
      const { loadConfig, saveConfig } = await import("@porchlight/shared");
      const config = loadConfig(${JSON.stringify(home)});
      config.daemons.mongoPort = ${50_000 + (seed % 20_000)};
      config.daemons.redisPort = ${50_000 + (seed % 20_000) + 1};
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

    const joinMember = async (firstName, lastName, code, deviceLabel) => {
      const pair = generateKeyPairSync("ed25519");
      const privJwk = pair.privateKey.export({ format: "jwk" });
      const birth = await (await fetch(`${base}/api/bootstrap/join-member`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, firstName, lastName, device: { deviceId: deviceLabel, label: deviceLabel, publicKeyJwk: jwkOf(pair) } }),
      })).json();
      assert.ok(birth.account?.did, JSON.stringify(birth));
      const identityAccessToken = await openSession(base, birth.account.did, deviceLabel, pair);
      const res = await fetch(`${base}/api/social/join/admit`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code,
          identityAccessToken,
          deviceId: deviceLabel,
          devicePublicKeyJwk: jwkOf(pair),
          signature: signNonce(privJwk, `porchlight-join:${code}`),
        }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return { did: birth.account.did, name: `${firstName} ${lastName}`, privJwk, token: body.accessToken };
    };

    const mintCode = async () => {
      const res = await fetch(`${base}/api/social/console/invites`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ role: "member", maxUses: 1 }),
      });
      const body = await res.json();
      assert.equal(res.status, 201, JSON.stringify(body));
      return (body.invite ?? body).code ?? (body.invite ?? body).token;
    };

    const linda = await runStep("Linda joins", (async () => joinMember("Linda", "Brown", await mintCode(), "dev_b"))());
    const meg = await runStep("Meg joins", (async () => joinMember("Meg", "River", await mintCode(), "dev_c"))());

    const cardOf = async (token, postId) => {
      const res = await fetch(`${base}/api/social/timeline`, { headers: { authorization: `Bearer ${token}` } });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      const row = (body.posts ?? []).find((entry) => entry._id === postId);
      assert.ok(row, `timeline serves ${postId}`);
      return row;
    };

    // The creation path's self-vote: zero client action — the composer's
    // one signed write lands the post AND the author's up-vote.
    const postPayload = { type: "text", body: "the raised hand", caption: "the raised hand" };
    const post = (await runStep("post created with its author self-vote (signed creation write)", (async () => {
      const res = await fetch(`${base}/api/social/posts`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ payload: postPayload, signature: signNonce(ownerPrivJwk, canonical(postPayload)) }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      const row = body.post ?? body;
      assert.equal(row.upCount, 1, "the create response resolves upCount 1 from the first served truth");
      return row;
    })()));

    await runStep("the author's card carries the self-vote as their own effective vote", (async () => {
      const ownerCard = await cardOf(ownerToken, post._id);
      assert.equal(ownerCard.upCount, 1);
      assert.equal(ownerCard.myVote, "up", "the author's own vote renders theirs");
      // No vote held by a reader: null — and no down data on any card.
      const megCard = await cardOf(meg.token, post._id);
      assert.equal(megCard.upCount, 1);
      assert.equal(megCard.myVote, null);
      for (const forbidden of ["interactionCounters", "downVolume", "voteVolume", "voteRatio", "downCount", "votes", "deviceSignature"]) {
        assert.equal(forbidden in megCard, false, `no ${forbidden} on the card`);
      }
    })());

    const vote = async (member, method = "POST", value = null) => {
      const payload = { postId: post._id, ...(value ? { value } : {}) };
      return fetch(`${base}/api/social/posts/${post._id}/votes`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${member.token}` },
        body: JSON.stringify({ payload, signature: signNonce(member.privJwk, canonical(payload)) }),
      });
    };

    await runStep("cast: a member's up joins the self-vote as an ordinary vote", (async () => {
      const res = await vote(linda, "POST", "up");
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      assert.deepEqual(body, { vote: { postId: post._id, effective: "up" } });
      const lindaCard = await cardOf(linda.token, post._id);
      assert.equal(lindaCard.upCount, 2);
      assert.equal(lindaCard.myVote, "up");
    })());

    await runStep("change: the ordinary flip re-signs the one effective vote", (async () => {
      await vote(linda, "POST", "down");
      const lindaCard = await cardOf(linda.token, post._id);
      assert.equal(lindaCard.upCount, 1, "Linda's up left the count");
      assert.equal(lindaCard.myVote, "down");
      await vote(linda, "POST", "up");
      const back = await cardOf(linda.token, post._id);
      assert.equal(back.upCount, 2);
    })());

    await runStep("clear: the DELETE ride removes only the member's own row", (async () => {
      const res = await vote(linda, "DELETE");
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.deepEqual(body, { vote: { postId: post._id, effective: null } });
      const lindaCard = await cardOf(linda.token, post._id);
      assert.equal(lindaCard.myVote, null, "myVote resolves null after the clear");
      assert.equal(lindaCard.upCount, 1, "only Linda's row left — the self-vote still counts");
      // Meg's row is untouched: the clear removes ONLY the caller's row.
      const megBefore = await vote(meg, "POST", "up");
      assert.ok([200, 201].includes(megBefore.status));
      await vote(linda, "POST", "up");
      await vote(linda, "DELETE");
      const megCard = await cardOf(meg.token, post._id);
      assert.equal(megCard.myVote, "up", "another member's row survives the clear");
      assert.equal(megCard.upCount, 2, "self-vote + Meg's up");
    })());

    await runStep("the author's self-vote clears like any member's, then refuses plainly", (async () => {
      const res = await vote({ token: ownerToken, privJwk: ownerPrivJwk, did: ownerDid }, "DELETE");
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.deepEqual(body, { vote: { postId: post._id, effective: null } });
      const ownerCard = await cardOf(ownerToken, post._id);
      assert.equal(ownerCard.myVote, null);
      assert.equal(ownerCard.upCount, 1, "only Meg's up counts now");
      // A member with no vote receives the plain refusal — zero mutation,
      // idempotent (the repeated clear resolves the same way).
      for (const attempt of [1, 2]) {
        const refused = await vote(linda, "DELETE");
        const refusedBody = await refused.json();
        assert.equal(refused.status, 400, `attempt ${attempt}: JSON.stringify(refusedBody)`);
        assert.equal(refusedBody.code, "E_VOTE_NOT_HELD");
      }
      const stillZero = await cardOf(linda.token, post._id);
      assert.equal(stillZero.upCount, 1, "the refused clear mutated nothing");
    })());

    await runStep("catch-up envelopes carry upCount only — no myVote, no down data", (async () => {
      const res = await fetch(`${base}/api/social/events?since=`, { headers: { authorization: `Bearer ${linda.token}` } });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      const created = (body.events ?? []).find((event) => event.type === "post.created" && event.postId === post._id);
      assert.ok(created, JSON.stringify((body.events ?? []).map((event) => event.type)));
      assert.equal(created.content.upCount, 1, "the arriving card resolves the self-vote count at publication");
      for (const forbidden of ["myVote", "downVolume", "voteVolume", "voteRatio", "votes", "downCount", "deviceSignature"]) {
        assert.equal(forbidden in created.content, false, `no ${forbidden} on the event payload`);
      }
    })());
  } finally {
    // Deterministic teardown: the supervisor stops the whole group on
    // SIGTERM; the CLI stop is the belt behind it, so the daemons never
    // hold the home directory and the rm never trips ENOTEMPTY.
    hub?.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await execFileP(process.execPath, [BIN, "stop", "--home", home]).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (process.env.PORCHLIGHT_S2_KEEP !== "1") await rm(home, { recursive: true, force: true });
  }
});