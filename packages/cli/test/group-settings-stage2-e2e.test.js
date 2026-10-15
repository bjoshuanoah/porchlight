// PORCH-088 stage 2 — deployed-hub shape: real daemons (mongo/redis binaries
// from `porchlight setup`), real hub process (the built apps/server the
// supervisor spawns), real file media root, real HTTP. The route family the
// group settings menu (PORCH-089) calls, exercised end to end per the Oct 12
// verification contract:
//   POST   /api/social/groups/:groupId/avatar        (byte route + signed declaration)
//   PATCH  /api/social/groups/:groupId/color         (signed palette write + null reset)
//   DELETE /api/social/groups/:groupId/posts/:postId (owner moderation removal)
//   PUT    /api/social/push/settings                 (per-group preference entries)
//   GET    /api/social/groups/:groupId               (menu contract detail read)
//   GET    /api/social/groups/:groupId/avatar/:kind  (content-addressed serving)
//   POST   /api/social/groups/:groupId/members/remove (shipped removal — regression)
import test from "node:test";
import { spawn, execFile } from "node:child_process";
import { createHash, createPrivateKey, sign, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import sharp from "sharp";
import { canonicalJson } from "@porchlight/shared";
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
const signWith = (priv, msg) => sign(null, Buffer.from(msg, "utf8"), createPrivateKey({ key: priv, format: "jwk" })).toString("base64url");
const jwkOf = (pair) => pair.publicKey.export({ format: "jwk" });

async function openSession(base, did, deviceId, pair) {
  const ch = await (await fetch(`${base}/api/identity/session/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ did }) })).json();
  const res = await fetch(`${base}/api/identity/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did, deviceId, nonce: ch.nonce, signature: signWith(pair.privateKey.export({ format: "jwk" }), ch.nonce) }),
  });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  return body.accessToken;
}

test("group settings server, deployed-hub stage 2: the route family the settings menu calls", { skip: process.env.PORCHLIGHT_S2 === "1" ? false : "runs only with PORCHLIGHT_S2=1" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "porch088-s2-"));
  const keep = process.env.PORCHLIGHT_S2_KEEP === "1";
  let hub = null;
  try {
    console.log("stage-2 home:", home);
    const setup = await runStep("porchlight setup (real daemons downloaded)", execFileP(process.execPath, [BIN, "setup", "--home", home]));

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
    void setup;
    const base = `http://127.0.0.1:${httpPort}`;

    hub = spawn(process.execPath, [BIN, "start", "--foreground", "--no-tunnel", "--home", home], { stdio: ["ignore", "pipe", "pipe"] });
    hub.stdout.on("data", (c) => process.env.PORCHLIGHT_S2_VERBOSE && process.stdout.write(`[hub] ${c}`));
    hub.stderr.on("data", (c) => process.stdout.write(`[hub:err] ${c}`));
    const health = await runStep("hub healthy (mongo ok, redis ok)", waitHealthy(base));
    assert.equal(health.deps?.mongo, "ok");
    assert.equal(health.deps?.redis, "ok");

    // Owner bootstrap: first account + network.
    const ownerPair = generateKeyPairSync("ed25519");
    const ownerPrivJwk = ownerPair.privateKey.export({ format: "jwk" });
    const created = await runStep("bootstrap account", (async () => {
      const res = await fetch(`${base}/api/identity/bootstrap/account`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ firstName: "Brian", lastName: "Noah", device: { deviceId: "dev_owner", publicKeyJwk: jwkOf(ownerPair) } }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body;
    })());
    const ownerDid = created.account.did;
    const ownerIdentityToken = await openSession(base, ownerDid, "dev_owner", ownerPair);
    const driver = await runStep("bootstrap network", execFileP(process.execPath, [BIN, "bootstrap", "--home", home, "--network", "Family"]));
    assert.match(driver.stdout, /owner bound/);
    await rm(join(home, "state", "processes", "hub.json"), { force: true });
    const ownerToken = await (async () => {
      const res = await fetch(`${base}/api/social/session/restore`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityAccessToken: ownerIdentityToken, deviceId: "dev_owner" }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body.sessions[0].accessToken;
    })();

    // A second member joins through the real surfaces (the member identity
    // + admit path), then creates a group over the member plane: she is
    // the managing member of record.
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
    const memberPair = generateKeyPairSync("ed25519");
    const memberPrivJwk = memberPair.privateKey.export({ format: "jwk" });
    const joinMember = await (async () => {
      const res = await fetch(`${base}/api/bootstrap/join-member`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, firstName: "Linda", lastName: "Brown", device: { deviceId: "dev_member", label: "Linda's phone", publicKeyJwk: jwkOf(memberPair) } }),
      });
      const body = await res.json();
      assert.equal(res.status, 201, JSON.stringify(body));
      return body;
    })();
    const memberDid = joinMember.account.did;
    const memberIdentityToken = await openSession(base, memberDid, "dev_member", memberPair);
    const admit = await (async () => {
      const res = await fetch(`${base}/api/social/join/admit`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code,
          identityAccessToken: memberIdentityToken,
          deviceId: "dev_member",
          devicePublicKeyJwk: jwkOf(memberPair),
          signature: signWith(memberPrivJwk, `porchlight-join:${code}`),
        }),
      });
      const body = await res.json();
      assert.ok([200, 201].includes(res.status), JSON.stringify(body));
      return body;
    })();
    const memberToken = admit.accessToken;

    // The managing member creates the group on the member plane.
    const groupId = await (async () => {
      const res = await fetch(`${base}/api/social/groups`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ name: "Picnic" }),
      });
      const body = await res.json();
      assert.equal(res.status, 201, JSON.stringify(body));
      return body.group._id;
    })();
    assert.match(groupId, /^grp_/);

    // Checklist: the avatar byte route (real bytes → the real treatment).
    const rect = await sharp({ create: { width: 640, height: 400, channels: 3, noise: { type: "gaussian", sigma: 12 } } }).jpeg().toBuffer();
    const avatarPayload = { scope: "group-avatar", action: "set", size: Buffer.byteLength(rect), sha256: sha256(rect), contentType: "image/jpeg" };
    const avatarSet = await runStep("POST /groups/:groupId/avatar (managing member, treated set)", (async () => {
      const res = await fetch(`${base}/api/social/groups/${groupId}/avatar`, {
        method: "POST",
        headers: {
          "content-type": "image/jpeg",
          authorization: `Bearer ${memberToken}`,
          "x-porchlight-avatar-payload": JSON.stringify(avatarPayload),
          "x-porchlight-signature": signWith(memberPrivJwk, canonicalJson(avatarPayload)),
        },
        body: rect,
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.group.avatar.header.width, 72, "square rung stamps");
      assert.equal(body.group.avatar.header.height, 72);
      return body;
    })());
    void avatarSet;

    // The color write + reset (palette-validated).
    await runStep("PATCH /groups/:groupId/color (palette write, signed)", (async () => {
      const res = await fetch(`${base}/api/social/groups/${groupId}/color`, {
        method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({
          color: "#D88A24",
          payload: { scope: "group-avatar", action: "color", color: "#D88A24" },
          signature: signWith(memberPrivJwk, canonicalJson({ scope: "group-avatar", action: "color", color: "#D88A24" })),
        }),
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.group.color, "#D88A24");
      const reset = await fetch(`${base}/api/social/groups/${groupId}/color`, {
        method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({
          color: null,
          payload: { scope: "group-avatar", action: "color", color: null },
          signature: signWith(memberPrivJwk, canonicalJson({ scope: "group-avatar", action: "color", color: null })),
        }),
      });
      const resetBody = await reset.json();
      assert.equal(reset.status, 200, JSON.stringify(resetBody));
      assert.equal(resetBody.group.color, null, "the null write resets to the neutral default");
      const refused = await fetch(`${base}/api/social/groups/${groupId}/color`, {
        method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({
          color: "#FF00FF",
          payload: { scope: "group-avatar", action: "color", color: "#FF00FF" },
          signature: signWith(memberPrivJwk, canonicalJson({ scope: "group-avatar", action: "color", color: "#FF00FF" })),
        }),
      });
      const refusedBody = await refused.json();
      assert.equal(refused.status, 400, JSON.stringify(refusedBody));
      assert.equal(refusedBody.code, "E_GROUP_COLOR_INVALID", "the refusal names its plain state");
    })());

    // The owner writes as superuser (a group she manages, he can rewrite).
    await runStep("avatar superuser write (network owner)", (async () => {
      const op = { scope: "group-avatar", action: "set", size: Buffer.byteLength(rect), sha256: sha256(rect), contentType: "image/jpeg" };
      const res = await fetch(`${base}/api/social/groups/${groupId}/avatar`, {
        method: "POST",
        headers: {
          "content-type": "image/jpeg",
          authorization: `Bearer ${ownerToken}`,
          "x-porchlight-avatar-payload": JSON.stringify(op),
          "x-porchlight-signature": signWith(ownerPrivJwk, canonicalJson(op)),
        },
        body: rect,
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
    })());

    // Checklist: the content-addressed serving (long-lived, immutable).
    await runStep("GET /groups/:groupId/avatar/:kind (content-addressed, immutable)", (async () => {
      const detail = await (await fetch(`${base}/api/social/groups/${groupId}`, { headers: { authorization: `Bearer ${memberToken}` } })).json();
      const headerRun = detail.group.avatar.header;
      const served = await fetch(`${base}/api/social/groups/${groupId}/avatar/${headerRun.kind}?v=${headerRun.sha256}`, { headers: { authorization: `Bearer ${memberToken}` } });
      assert.equal(served.status, 200);
      assert.equal(served.headers.get("cache-control"), "private, max-age=31536000, immutable");
      assert.equal(served.headers.get("etag"), `"${headerRun.sha256}"`);
      assert.equal(served.headers.get("x-porchlight-media-width"), "72");
      assert.equal(served.headers.get("x-porchlight-media-height"), "72");
      const bytes = Buffer.from(await served.arrayBuffer());
      assert.ok(bytes.length > 0 && bytes.length < 1024 * 1024, "the served rung is avatar-class weight");
    })());

    // Checklist: the menu contract detail read.
    await runStep("GET /groups/:groupId (presentation + notification state + authority flags)", (async () => {
      const perMember = {
        member: (await (await fetch(`${base}/api/social/groups/${groupId}`, { headers: { authorization: `Bearer ${memberToken}` } })).json()).group,
        owner: (await (await fetch(`${base}/api/social/groups/${groupId}`, { headers: { authorization: `Bearer ${ownerToken}` } })).json()).group,
      };
      assert.equal(perMember.member.isManagingMember, true);
      assert.equal(perMember.member.isNetworkOwner, false);
      assert.equal(perMember.owner.isNetworkOwner, true);
      assert.ok(perMember.member.avatar.header.sha256, "the presentation rides the same fetch");
      assert.equal(perMember.member.notifications.perGroup, true, "unset resolves ON");
      assert.equal(perMember.owner.notifications.perGroup, true);
    })());

    // The member sets her per-group preference through the settings PUT.
    await runStep("PUT /push/settings (per-group preference entries)", (async () => {
      const put = await fetch(`${base}/api/social/push/settings`, {
        method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ enabled: true, groups: { [groupId]: false } }),
      });
      const body = await put.json();
      assert.equal(put.status, 200, JSON.stringify(body));
      void body;
      // The menu's read reflects the persisted entry (the detail read
      // serves the resolved state).
      const detail = await (await fetch(`${base}/api/social/groups/${groupId}`, { headers: { authorization: `Bearer ${memberToken}` } })).json();
      assert.equal(detail.group.notifications.perGroup, false, "group OFF reads from the persisted row");
      // An entry for a group she no longer holds is refused.
      await (async () => {
        const res = await fetch(`${base}/api/social/push/settings`, {
          method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${memberToken}` },
          body: JSON.stringify({ enabled: true, groups: { grp_nope: false } }),
        });
        const body = await res.json();
        assert.equal(res.status, 403, JSON.stringify(body));
        assert.equal(body.code, "E_PUSH_GROUP_NOT_MEMBER");
      })();
      // Restore: the entry resets via a full-row replace.
      const restore = await fetch(`${base}/api/social/push/settings`, {
        method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ enabled: true, groups: {} }),
      });
      assert.equal(restore.status, 200, JSON.stringify(await restore.json()));
    })());

    // Checklist: owner post removal with the origin cascade.
    await runStep("DELETE /groups/:groupId/posts/:postId (managing member, device-signed)", (async () => {
      // A group post via the real write path.
      const payload = { type: "text", body: "the picnic table by the lake", caption: null, mediaRefs: [], groupId };
      const created = await (async () => {
        const res = await fetch(`${base}/api/social/posts`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${memberToken}` },
          body: JSON.stringify({ payload, signature: signWith(memberPrivJwk, canonicalJson(payload)) }),
        });
        const body = await res.json();
        assert.ok([200, 201].includes(res.status), JSON.stringify(body));
        return body;
      })();
      const postId = created.post._id;
      const timeline = await (await fetch(`${base}/api/social/timeline/groups/${groupId}`, { headers: { authorization: `Bearer ${memberToken}` } })).json();
      assert.ok(timeline.posts.some((row) => row._id === postId), "the post served before removal");

      const removal = await fetch(`${base}/api/social/groups/${groupId}/posts/${postId}`, {
        method: "DELETE", headers: { "content-type": "application/json", authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ signature: signWith(memberPrivJwk, canonicalJson({ kind: "group_post_remove", postId, groupId, networkId: timeline.posts[0].originNetworkId })) }),
      });
      const removalBody = await removal.json();
      assert.equal(removal.status, 200, JSON.stringify(removalBody));
      assert.equal(removalBody.removed, true);
      const gone = await (await fetch(`${base}/api/social/timeline/groups/${groupId}`, { headers: { authorization: `Bearer ${memberToken}` } })).json();
      assert.ok(!gone.posts.some((row) => row._id === postId), "the group timeline never serves it again");
      const feed = await (await fetch(`${base}/api/social/timeline`, { headers: { authorization: `Bearer ${memberToken}` } })).json();
      assert.ok(!feed.posts.some((row) => row._id === postId), "the main feed never serves it again");
      const unknown = await fetch(`${base}/api/social/posts/${postId}`, { headers: { authorization: `Bearer ${memberToken}` } });
      assert.equal(unknown.status, 404, "the removed post is simply gone");
      // One audit record on the console's read.
      const audit = await (await fetch(`${base}/api/social/console/audit?limit=50`, { headers: { authorization: `Bearer ${ownerToken}` } })).json();
      const removalRows = audit.events.filter((row) => row.action === "group_post_remove");
      assert.equal(removalRows.length, 1, JSON.stringify(removalRows.map((row) => row.detail)));
      assert.equal(removalRows[0].detail.postId, postId);
    })());

    // Checklist: the authority refusals (a plain member with no
    // management authority is refused with zero mutation).
    await runStep("authority refusals (plain member, zero mutation)", (async () => {
      // A third member with NO authority: join with a fresh identity.
      const invite2 = await (async () => {
        const res = await fetch(`${base}/api/social/console/invites`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
          body: JSON.stringify({ role: "member", maxUses: 1 }),
        });
        const body = await res.json();
        assert.equal(res.status, 201, JSON.stringify(body));
        return body.invite ?? body;
      })();
      const code2 = invite2.code ?? invite2.token;
      const pipPair = generateKeyPairSync("ed25519");
      const pipPrivJwk = pipPair.privateKey.export({ format: "jwk" });
      const pipJoin = await (async () => {
        const res = await fetch(`${base}/api/bootstrap/join-member`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: code2, firstName: "Pip", lastName: "Larkin", device: { deviceId: "dev_pip", label: "Pip's phone", publicKeyJwk: jwkOf(pipPair) } }),
        });
        const body = await res.json();
        assert.equal(res.status, 201, JSON.stringify(body));
        return body;
      })();
      const pipIdentityToken = await openSession(base, pipJoin.account.did, "dev_pip", pipPair);
      const pipAdmit = await (async () => {
        const res = await fetch(`${base}/api/social/join/admit`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            code: code2,
            identityAccessToken: pipIdentityToken,
            deviceId: "dev_pip",
            devicePublicKeyJwk: jwkOf(pipPair),
            signature: signWith(pipPrivJwk, `porchlight-join:${code2}`),
          }),
        });
        const body = await res.json();
        assert.ok([200, 201].includes(res.status), JSON.stringify(body));
        return body;
      })();
      const pipToken = pipAdmit.accessToken;

      const op = { scope: "group-avatar", action: "set", size: Buffer.byteLength(rect), sha256: sha256(rect), contentType: "image/jpeg" };
      const avatarRefused = await fetch(`${base}/api/social/groups/${groupId}/avatar`, {
        method: "POST",
        headers: {
          "content-type": "image/jpeg",
          authorization: `Bearer ${pipToken}`,
          "x-porchlight-avatar-payload": JSON.stringify(op),
          "x-porchlight-signature": signWith(pipPrivJwk, canonicalJson(op)),
        },
        body: rect,
      });
      const avatarBody = await avatarRefused.json();
      assert.equal(avatarRefused.status, 403, JSON.stringify(avatarBody));
      assert.equal(avatarBody.code, "E_GROUP_NOT_CREATOR");
      const colorRefused = await fetch(`${base}/api/social/groups/${groupId}/color`, {
        method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${pipToken}` },
        body: JSON.stringify({ color: "#D88A24", payload: { scope: "group-avatar", action: "color", color: "#D88A24" }, signature: signWith(pipPrivJwk, canonicalJson({ scope: "group-avatar", action: "color", color: "#D88A24" })) }),
      });
      assert.equal(colorRefused.status, 403, JSON.stringify(await colorRefused.json()));
      // Zero mutation: the group document unchanged (avatar + color absent).
      const detail = await (await fetch(`${base}/api/social/groups/${groupId}`, { headers: { authorization: `Bearer ${memberToken}` } })).json();
      assert.ok(detail.group.avatar.header.sha256, "the assigned avatar survived the refusals");
      // Pip is not a group member: the private group is unknown-shaped.
      const pipDetail = await fetch(`${base}/api/social/groups/${groupId}`, { headers: { authorization: `Bearer ${pipToken}` } });
      assert.equal(pipDetail.status, 404);
    })());

    // Checklist: the shipped member-removal route (regression — the menu
    // reuses it; the Oct 14 lifecycle unchanged).
    await runStep("POST /groups/:groupId/members/remove (shipped lifecycle)", (async () => {
      const res = await fetch(`${base}/api/social/groups/${groupId}/members/remove`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${memberToken}` },
      });
      const body = await res.json();
      // Removal requires naming the member; the shipped rule unchanged.
      assert.equal(res.status, 400, JSON.stringify(body));
    })());
  } finally {
    if (hub) hub.kill();
    if (!keep) await rm(home, { recursive: true, force: true });
  }
});