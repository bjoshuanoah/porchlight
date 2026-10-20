// PORCH-103 stage 2 — deployed-hub shape: real daemons (mongo/redis binaries
// from `porchlight setup`), real hub process (the built apps/server boot the
// supervisor spawns), real HTTP. The vote-display route family, re-verified
// per the Oct 12 verification contract before user-testing:
//   POST /api/social/posts/:postId/votes      (signed cast/flip — the changeable vote)
//   GET  /api/social/timeline                 (card read — upCount + the viewer's own myVote)
//   GET  /api/social/posts/:postId            (detail read — the same two values)
//   GET  /api/social/events?since=            (catch-up — the envelope carries upCount only)
// Payload evidence: no down-count, ratio, or per-member vote record beyond those two values on any surface.
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
      const health = await (await fetch(`${base}/api/health`)).json();
      if (health?.status === "ok" && health?.deps?.mongo === "ok" && health?.deps?.redis === "ok") return health;
    } catch {
      // Not healthy yet — keep polling until the deadline.
    }
    if (Date.now() - startedAt > timeoutMs) throw new Error("hub did not go healthy in time");
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

test("vote display, deployed-hub stage 2: upCount and the viewer's own vote, everything else private", { skip: process.env.PORCHLIGHT_S2 === "1" ? false : "runs only with PORCHLIGHT_S2=1" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "porch103-s2-"));
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

    // Two members join through the real surfaces: three up-voters and one
    // down-voter give the count math its shape.
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
      return { did: birth.account.did, name: `${firstName} ${lastName}`, privJwk, token: body.accessToken, jwkOf };
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
    const ann = await runStep("Ann joins", (async () => joinMember("Ann", "Vale", await mintCode(), "dev_d"))());
    const pat = await runStep("Pat joins", (async () => joinMember("Pat", "Mills", await mintCode(), "dev_e"))());

    const vote = async (member, postId, value, method = "POST") => {
      const payload = { postId, value };
      return fetch(`${base}/api/social/posts/${postId}/votes`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${member.token}` },
        body: JSON.stringify({ payload, signature: signNonce(member.privJwk, canonical(payload)) }),
      });
    };

    const postPayload = { type: "text", body: "the vote post", caption: "the vote post" };
    const post = (await runStep("post created (signed)", (async () => {
      const payload = postPayload;
      const res = await fetch(`${base}/api/social/posts`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ payload, signature: signNonce(ownerPrivJwk, canonical(payload)) }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body.post ?? body;
    })()));

    await runStep("three ups and one down cast through the signed route", (async () => {
      for (const [member, value] of [[linda, "up"], [meg, "up"], [ann, "up"], [pat, "down"]]) {
        const res = await vote(member, post._id, value);
        const body = await res.json();
        assert.ok([200, 201].includes(res.status), JSON.stringify(body));
        assert.equal(body.vote.effective, value, JSON.stringify(body));
      }
      // The write response never returns a count or anyone's row.
      const probe = await vote(linda, post._id, "up");
      const probeBody = await probe.json();
      assert.ok([200, 201].includes(probe.status), JSON.stringify(probeBody));
      assert.deepEqual(probeBody, { vote: { postId: post._id, effective: "up" } }, "re-stating a vote is a no-op class response");
    })());

    const assertVoteFields = (surface, card, member, expectMine) => {
      // PORCH-113: the owner's creation self-vote counts from birth — the
      // three member ups ride on top of it (upCount 4).
      assert.equal(card.upCount, 4, `${surface} carries upCount = 4 for ${member.name}`);
      assert.equal(card.myVote, expectMine, `${surface} carries exactly ${member.name}'s own vote`);
      for (const forbidden of ["interactionCounters", "downVolume", "voteVolume", "voteRatio", "voteCount", "downCount", "downvotes", "votes", "deviceSignature"]) {
        assert.equal(forbidden in card, false, `${surface} carries no ${forbidden}`);
      }
    };

    await runStep("card read (timeline) carries the two ruled values for each viewer", (async () => {
      // The owner's creation self-vote is their own effective vote: myVote
      // renders "up" (PORCH-113) — never privileged, but theirs.
      const ownerCard = ((await (await fetch(`${base}/api/social/timeline`, { headers: { authorization: `Bearer ${ownerToken}` } })).json()).posts).find((row) => row._id === post._id);
      assertVoteFields("timeline card", ownerCard, { name: "Brian Noah" }, "up");
      // Linda's own card: myVote "up".
      const lindaCard = ((await (await fetch(`${base}/api/social/timeline`, { headers: { authorization: `Bearer ${linda.token}` } })).json()).posts).find((row) => row._id === post._id);
      assertVoteFields("timeline card (Linda)", lindaCard, linda, "up");
      // Pat's own card: myVote "down" — her own state is served; nobody
      // else's vote record rides anywhere on it.
      const patCard = ((await (await fetch(`${base}/api/social/timeline`, { headers: { authorization: `Bearer ${pat.token}` } })).json()).posts).find((row) => row._id === post._id);
      assertVoteFields("timeline card (Pat)", patCard, pat, "down");
      assert.equal(JSON.stringify(patCard).includes('"myVotes"'), false);
    })());

    await runStep("detail read carries the same two values", (async () => {
      const res = await fetch(`${base}/api/social/posts/${post._id}`, { headers: { authorization: `Bearer ${linda.token}` } });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assertVoteFields("detail", body.post, linda, "up");
    })());

    await runStep("flip up → down: the next payload reflects the change", (async () => {
      await vote(linda, post._id, "down");
      const ownerCard = ((await (await fetch(`${base}/api/social/timeline`, { headers: { authorization: `Bearer ${ownerToken}` } })).json()).posts).find((row) => row._id === post._id);
      assert.equal(ownerCard.upCount, 3, "the self-vote plus Meg's and Ann's ups after Linda's flip");
      const lindaCard = ((await (await fetch(`${base}/api/social/timeline`, { headers: { authorization: `Bearer ${linda.token}` } })).json()).posts).find((row) => row._id === post._id);
      assert.equal(lindaCard.myVote, "down", "Linda's own vote flipped");
      // Flip back: the changeable vote restores the count.
      await vote(linda, post._id, "up");
      const restored = ((await (await fetch(`${base}/api/social/posts/${post._id}`, { headers: { authorization: `Bearer ${linda.token}` } })).json()).post);
      assert.equal(restored.upCount, 4);
      assert.equal(restored.myVote, "up");
    })());

    await runStep("catch-up envelopes carry upCount only — no myVote, no down data", (async () => {
      const res = await fetch(`${base}/api/social/events?since=`, { headers: { authorization: `Bearer ${linda.token}` } });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      const created = (body.events ?? []).find((event) => event.type === "post.created" && event.postId === post._id);
      assert.ok(created, JSON.stringify((body.events ?? []).map((event) => event.type)));
      assert.equal(typeof created.content.upCount, "number", "the post payload carries the public up-count");
      for (const forbidden of ["myVote", "downVolume", "voteVolume", "voteRatio", "votes", "downCount", "deviceSignature"]) {
        assert.equal(forbidden in created.content, false, `no ${forbidden} on the event payload`);
      }
    })());
  } finally {
    hub?.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (process.env.PORCHLIGHT_S2_KEEP !== "1") await rm(home, { recursive: true, force: true });
  }
});