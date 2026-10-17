// PORCH-098 stage 2 — deployed-hub shape: real daemons (mongo/redis binaries
// from `porchlight setup`), real hub process (the built apps/server boot the
// supervisor spawns), real HTTP. The comment-reaction route family (the
// comment-reactions amendment, Brian Oct 16 2026), re-verified per the Oct 12
// verification contract before user-testing:
//   POST /api/social/posts/:postId/comments                 (comment create)
//   POST /api/social/posts/:postId/reactions                (signed add —
//        comment subject rides the existing route: subjectType + commentId)
//   GET  /api/social/posts/:postId/comments                 (ordered detail
//        thread — attributed reactor rows per comment)
//   GET  /api/social/timeline                               (feed read — the
//        card slice's comment rows carry their attributed reactor rows)
//   DELETE /api/social/posts/:postId/reactions              (signed leave —
//        comment subject; one row per member per emoji per subject)
//   DELETE /api/social/posts/:postId/comments/:commentId    (tombstone — the
//        live-subject gate; the cascade carries the comment's reaction rows)
//   GET  /api/social/events?since=                          (catch-up —
//        content-only envelopes carrying the subject reference)
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
      // Health is not up yet — the poller keeps waiting for readiness.
    }
    if (Date.now() - startedAt > timeoutMs) throw new Error(`hub never became healthy at ${base}`);
    await new Promise((wait) => setTimeout(wait, 1000));
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

test("comment reactions, deployed-hub stage 2: the comment-subject reaction route family with attribution and the live gate", { skip: process.env.PORCHLIGHT_S2 === "1" ? false : "runs only with PORCHLIGHT_S2=1" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "porch098-s2-"));
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

    // A second member joins through the real surfaces so the comment chip
    // carries a distinct person with a real name.
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

    const postPayload = { type: "text", body: "the comment chip post" };
    const post = (await runStep("post created (signed)", (async () => {
      const res = await fetch(`${base}/api/social/posts`, writeHeaders(ownerPrivJwk, ownerToken, postPayload));
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body.post ?? body;
    })()));

    const commentPayload = { postId: post._id, body: "the response Linda reacted to" };
    const comment = (await runStep("Linda comments (signed)", (async () => {
      const res = await fetch(`${base}/api/social/posts/${post._id}/comments`, writeHeaders(memberPrivJwk, memberToken, commentPayload));
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body.comment;
    })()));

    const memberSubject = { postId: post._id, emoji: "🎉", subjectType: "comment", commentId: comment._id };
    const reactComment = async (privJwk, token, payload, method = "POST") =>
      fetch(`${base}/api/social/posts/${post._id}/reactions`, writeHeaders(privJwk, token, payload, method));

    // Chip join on a comment rides the existing signed add path.
    await runStep("Linda's comment chip join (signed add, comment subject)", reactComment(memberPrivJwk, memberToken, memberSubject).then(async (res) => {
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      assert.deepEqual(Object.keys(body.reaction).sort(), ["_id", "createdAt", "emoji", "memberDid"], "the write response stays member + emoji");
    }));

    await runStep("duplicate same-member same-emoji same-subject refused (idempotent class)", (async () => {
      const res = await reactComment(memberPrivJwk, memberToken, memberSubject);
      const body = await res.json();
      assert.equal(res.ok, false, `the duplicate write should refuse: ${res.status}`);
      assert.equal(body.code, "E_REACTION_EXISTS", JSON.stringify(body));
    })());

    // Reacting to the comment and to its parent post: two separate rows.
    const postSubject = { postId: post._id, emoji: "🎉" };
    const ownerCommentSubject = { postId: post._id, emoji: "🎈", subjectType: "comment", commentId: comment._id };
    await runStep("owner's comment chip join + owner's post chip join (same emoji, two subjects)", (async () => {
      for (const payload of [ownerCommentSubject, postSubject]) {
        const res = await reactComment(ownerPrivJwk, ownerToken, payload);
        const body = await res.json();
        assert.ok([200, 201].includes(res.status), `${res.status}: ${JSON.stringify(body)}`);
      }
    })());

    await runStep("ordered detail thread carries attributed reactor rows per comment", (async () => {
      const res = await fetch(`${base}/api/social/posts/${post._id}/comments`, { headers: { authorization: `Bearer ${ownerToken}` } });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      const row = body.comments.find((entry) => entry._id === comment._id);
      assert.ok(row, JSON.stringify(body.comments.map((entry) => entry._id)));
      assert.deepEqual(
        row.reactionRows.map((entry) => ({ emoji: entry.emoji, memberName: entry.memberName })),
        [
          { emoji: "🎉", memberName: "Linda Brown" },
          { emoji: "🎈", memberName: "Brian Noah" },
        ],
        "each emoji's reactor rows carry the reactors in the origin's served order",
      );
      for (const key of Object.keys(row.reactionRows[0]).sort()) {
        assert.ok(!/count|roster/i.test(key), `no count-bearing or roster field on the read: ${key}`);
      }
      assert.equal(JSON.stringify(row.reactionRows).includes("Count"), false, "no count field rides the thread payload");
      // The distinct-people count derives at render from the rows: 🎉 = 1.
      assert.equal(new Set(row.reactionRows.filter((entry) => entry.emoji === "🎉").map((entry) => entry.memberDid)).size, 1);
      // The owner's 🎉 reacted to the PARENT post — it never joins the
      // comment's rows; the post's own endpoint read carries it.
      const postRows = (await (await fetch(`${base}/api/social/posts/${post._id}/reactions`, { headers: { authorization: `Bearer ${ownerToken}` } })).json()).reactions;
      assert.deepEqual(
        postRows.map((entry) => [entry.emoji, entry.memberName]),
        [["🎉", "Brian Noah"]],
        "one row per member per emoji per subject: the comment and its parent post hold separate reactions",
      );
    })());

    await runStep("the card slice's comment rows carry the same attributed rows; the post's chips stay comment-free", (async () => {
      const res = await fetch(`${base}/api/social/timeline`, { headers: { authorization: `Bearer ${ownerToken}` } });
      assert.equal(res.status, 200);
      const posts = (await res.json()).posts;
      assert.ok(posts.length > 0, "the timeline carries the post");
      const card = posts.find((row) => row._id === post._id);
      assert.ok(card, JSON.stringify(posts.map((row) => row.body)));
      assert.equal(JSON.stringify(card.reactionRows).includes(comment._id), false, "comment-subject rows never decorate the post's chips");
      assert.deepEqual(
        card.replySlice.find((row) => row._id === comment._id).reactionRows.map((row) => row.memberName),
        ["Linda Brown", "Brian Noah"],
        "the slice comment serves the same attributed rows in the same order",
      );
      const sliceRowStrings = JSON.stringify(card.replySlice.map((row) => ({ reactionRows: row.reactionRows })));
      assert.equal(sliceRowStrings.includes("Count"), false, "no count field rides the slice's reaction rows");
    })());

    await runStep("comment chip leave removes only the member's own row on that comment", (async () => {
      const res = await reactComment(memberPrivJwk, memberToken, memberSubject, "DELETE");
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      assert.equal(body.removed, true, JSON.stringify(body));
    })());

    await runStep("idempotent no-op on a comment chip already clear", (async () => {
      const res = await reactComment(memberPrivJwk, memberToken, memberSubject, "DELETE");
      const body = await res.json();
      assert.deepEqual(body, { removed: false, reaction: null });
    })());

    await runStep("other members' rows survive the leave; parent-post rows untouched", (async () => {
      const res = await fetch(`${base}/api/social/posts/${post._id}/comments`, { headers: { authorization: `Bearer ${memberToken}` } });
      const row = (await res.json()).comments.find((entry) => entry._id === comment._id);
      assert.deepEqual(
        row.reactionRows.map((entry) => [entry.memberName, entry.emoji]),
        [["Brian Noah", "🎈"]],
        "the owner's comment row survived the leave, one row per member per emoji per subject",
      );
    })());

    // The live-subject gate: a tombstoned comment refuses any reaction.
    await runStep("tombstoned comment refuses reactions with zero mutation", (async () => {
      const deletePayload = { kind: "comment-delete", postId: post._id, commentId: comment._id, networkId: post.originNetworkId };
      const res = await fetch(`${base}/api/social/posts/${post._id}/comments/${comment._id}`, writeHeaders(memberPrivJwk, memberToken, deletePayload, "DELETE"));
      const body = await res.json();
      assert.ok([200, 201, 204].includes(res.status), `${res.status}: ${JSON.stringify(body)} (the delete must succeed for the gate to verify)`);
      const gate = await fetch(`${base}/api/social/posts/${post._id}/reactions`, writeHeaders(ownerPrivJwk, ownerToken, { postId: post._id, emoji: "🌟", subjectType: "comment", commentId: comment._id }));
      const gateBody = await gate.json();
      assert.equal(gate.ok, false, `the dead comment must refuse: ${gate.status}`);
      assert.equal(gateBody.code, "E_COMMENT_NOT_FOUND", JSON.stringify(gateBody));
    })());

    await runStep("catch-up: reaction.applied carries the subject reference, content-only", (async () => {
      const res = await fetch(`${base}/api/social/events?since=`, { headers: { authorization: `Bearer ${memberToken}` } });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      const envelopes = (body.events ?? []).filter((event) => event.type === "reaction.applied");
      const commentEnvelope = envelopes.find((event) => event.content?.subjectType === "comment");
      assert.ok(commentEnvelope, JSON.stringify((body.events ?? []).map((event) => event.type)));
      assert.deepEqual(
        Object.keys(commentEnvelope.content).sort(),
        ["_id", "commentId", "createdAt", "emoji", "memberDid", "postId", "subjectType"],
        "the subject reference rides: commentId present, postId null",
      );
      assert.deepEqual(commentEnvelope.content.postId, null);
      assert.equal(commentEnvelope.content.commentId, comment._id);
    })());

    console.log("STAGE-2 PASSED (porch098)");
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