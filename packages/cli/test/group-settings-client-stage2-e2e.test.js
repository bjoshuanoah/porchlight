// PORCH-089 stage 2 — deployed-hub shape: real daemons (mongo/redis binaries
// from `porchlight setup`), real hub process, real HTTP — the Oct 12
// verification contract's re-verification of every client call the group
// settings menu rides. The route family (server half merged with PORCH-088):
//   POST   /api/social/groups/:groupId/avatar         (the byte route + header declaration)
//   PATCH  /api/social/groups/:groupId/color          (signed palette write + null reset)
//   POST   /api/social/groups/:groupId/visibility     (the shipped path the privacy row reuses)
//   POST   /api/social/groups/:groupId/members        (the shipped add flow the Members view rides)
//   POST   /api/social/groups/:groupId/members/remove (the shipped removal the Members view rides)
//   POST   /api/social/groups/:groupId/unblock
//   GET/PUT /api/social/push/settings               (the toggle's read-merge-write of the groups entries)
//   GET    /api/social/groups/:groupId              (the detail read the menu renders from)
//   GET    /api/social/groups/:groupId/avatar/:kind (content-addressed serving)
//   DELETE /api/social/groups/:groupId/posts/:postId (the owner's moderation removal)
// The writes build their payloads through the app's own shape builders
// (apps/web/src/member-actions.js: groupAvatarDeclaration, groupColorPayload,
// groupPostRemovePayload) and sign with the device convention the SPA signs
// with (canonical JSON, Ed25519, base64url) — so the shapes delivered here
// are the shapes the menu's actions deliver.
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
// The client's write-shape builders (imported exactly as the app ships them).
import { groupAvatarDeclaration, groupColorPayload, groupPostRemovePayload } from "../../../apps/web/src/member-actions.js";

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

// One join through the real surfaces (the member identity + admit path) —
// the same flow the client's join rides.
async function joinMember(base, ownerToken, { firstName, lastName, deviceId }) {
  const invite = await (async () => {
    const res = await fetch(`${base}/api/social/console/invites`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ role: "member", maxUses: 1 }),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    return body.invite ?? body;
  })();
  const code = invite.code ?? invite.token;
  const pair = generateKeyPairSync("ed25519");
  const privJwk = pair.privateKey.export({ format: "jwk" });
  const joinMemberResult = await (async () => {
    const res = await fetch(`${base}/api/bootstrap/join-member`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, firstName, lastName, device: { deviceId, label: `${firstName}'s device`, publicKeyJwk: jwkOf(pair) } }),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    return body;
  })();
  const identityToken = await openSession(base, joinMemberResult.account.did, deviceId, pair);
  const admit = await (async () => {
    const res = await fetch(`${base}/api/social/join/admit`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        identityAccessToken: identityToken,
        deviceId,
        devicePublicKeyJwk: jwkOf(pair),
        signature: signWith(privJwk, `porchlight-join:${code}`),
      }),
    });
    const body = await res.json();
    assert.ok([200, 201].includes(res.status), JSON.stringify(body));
    return body;
  })();
  return { did: joinMemberResult.account.did, token: admit.accessToken, privJwk };
}

const detailOf = async (base, token, groupId) =>
  (await (await fetch(`${base}/api/social/groups/${groupId}`, { headers: { authorization: `Bearer ${token}` } })).json()).group;

const getSettings = async (base, token) =>
  (await (await fetch(`${base}/api/social/push/settings`, { headers: { authorization: `Bearer ${token}` } })).json()).settings;

test("group settings menu, deployed-hub stage 2: the route family the client calls", { skip: process.env.PORCHLIGHT_S2 === "1" ? false : "runs only with PORCHLIGHT_S2=1" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "porch089-s2-"));
  const keep = process.env.PORCHLIGHT_S2_KEEP === "1";
  let hub = null;
  try {
    console.log("stage-2 home:", home);
    await runStep("porchlight setup (real daemons downloaded)", execFileP(process.execPath, [BIN, "setup", "--home", home]));

    const seed = 10_000 + (process.pid % 20_000) * 3;
    const httpPort = 25_000 + (seed % 20_000);
    await execFileP(process.execPath, ["-e", `
      const { loadConfig, saveConfig } = await import("@porchlight/shared");
      const config = loadConfig(${JSON.stringify(home)});
      config.daemons.mongoPort = ${35_000 + (seed % 20_000)};
      config.daemons.redisPort = ${35_000 + (seed % 20_000) + 1};
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

    // Owner bootstrap + network (the production way).
    const ownerPair = generateKeyPairSync("ed25519");
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
    await runStep("bootstrap network", execFileP(process.execPath, [BIN, "bootstrap", "--home", home, "--network", "Family"]));
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

    const linda = await runStep("member joined (Linda)", joinMember(base, ownerToken, { firstName: "Linda", lastName: "Brown", deviceId: "dev_linda" }));
    const pip = await runStep("member joined (Pip)", joinMember(base, ownerToken, { firstName: "Pip", lastName: "Larkin", deviceId: "dev_pip" }));

    // The managing member creates the group on the member plane (the
    // client's createGroup write, shipped shape).
    const groupId = await runStep("POST /groups (Linda creates Picnic)", (async () => {
      const res = await fetch(`${base}/api/social/groups`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${linda.token}` },
        body: JSON.stringify({ name: "Picnic", visibility: "private" }),
      });
      const body = await res.json();
      assert.equal(res.status, 201, JSON.stringify(body));
      return body.group._id;
    })());
    assert.match(groupId, /^grp_/);

    // The privacy row's write (shipped visibility path, the client's body).
    await runStep("POST /groups/:groupId/visibility (the privacy row commits)", (async () => {
      const res = await fetch(`${base}/api/social/groups/${groupId}/visibility`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${linda.token}` },
        body: JSON.stringify({ visibility: "public" }),
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      // The detail read agrees with the committed state.
      assert.equal((await detailOf(base, linda.token, groupId)).visibility, "public");
      // A plain member with no authority: refused, zero mutation.
      await (async () => {
        const res = await fetch(`${base}/api/social/groups/${groupId}/visibility`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${pip.token}` },
          body: JSON.stringify({ visibility: "private" }),
        });
        const body = await res.json();
        assert.equal(res.status, 403, JSON.stringify(body));
      })();
    })());

    // The Members view's writes ride the shipped add + removal lifecycle.
    await runStep("members/add then members/remove (the Members view's acts)", (async () => {
      const add = await fetch(`${base}/api/social/groups/${groupId}/members`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${linda.token}` },
        body: JSON.stringify({ dids: [pip.did] }),
      });
      assert.equal(add.status, 200, JSON.stringify(await add.json()));
      let detail = await detailOf(base, linda.token, groupId);
      assert.ok(detail.members.includes(pip.did), "the roster carries the added member");
      // Removal names its consequence on the client; the shipped write atomically.
      const remove = await fetch(`${base}/api/social/groups/${groupId}/members/remove`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${linda.token}` },
        body: JSON.stringify({ did: pip.did }),
      });
      assert.equal(remove.status, 200, JSON.stringify(await remove.json()));
      detail = await detailOf(base, linda.token, groupId);
      assert.ok(!detail.members.includes(pip.did));
      assert.ok((detail.blockedMemberIds ?? []).includes(pip.did), "the blocked entry stands (they cannot rejoin unless re-invited)");
      // Unblock lifts it (the Members view's unblock act).
      const unblock = await fetch(`${base}/api/social/groups/${groupId}/unblock`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${linda.token}` },
        body: JSON.stringify({ did: pip.did }),
      });
      assert.equal(unblock.status, 200, JSON.stringify(await unblock.json()));
      assert.ok(!((await detailOf(base, linda.token, groupId)).blockedMemberIds ?? []).includes(pip.did));
    })());

    // The color view's write + reset + refusal (the client's payload shape).
    await runStep("PATCH /groups/:groupId/color (the color view commits)", (async () => {
      const payload = groupColorPayload("#C4674B");
      const res = await fetch(`${base}/api/social/groups/${groupId}/color`, {
        method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${linda.token}` },
        body: JSON.stringify({ color: "#C4674B", payload, signature: signWith(linda.privJwk, canonicalJson(payload)) }),
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.group.color, "#C4674B");
      // The no-color swatch: the null reset through the same shape.
      const neutral = groupColorPayload(null);
      const reset = await fetch(`${base}/api/social/groups/${groupId}/color`, {
        method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${linda.token}` },
        body: JSON.stringify({ color: null, payload: neutral, signature: signWith(linda.privJwk, canonicalJson(neutral)) }),
      });
      const resetBody = await reset.json();
      assert.equal(reset.status, 200, JSON.stringify(resetBody));
      assert.equal(resetBody.group.color, null, "the no-color swatch resets to neutral");
      // Off-palette: refused in plain language.
      const bad = groupColorPayload("#FF00FF");
      const refused = await fetch(`${base}/api/social/groups/${groupId}/color`, {
        method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${linda.token}` },
        body: JSON.stringify({ color: "#FF00FF", payload: bad, signature: signWith(linda.privJwk, canonicalJson(bad)) }),
      });
      const refusedBody = await refused.json();
      assert.equal(refused.status, 400, JSON.stringify(refusedBody));
      assert.equal(refusedBody.code, "E_GROUP_COLOR_INVALID");
    })());

    // The avatar view's commit (the client's byte route + declaration).
    const rect = await sharp({ create: { width: 640, height: 400, channels: 3, noise: { type: "gaussian", sigma: 12 } } }).jpeg().toBuffer();
    await runStep("POST /groups/:groupId/avatar (the avatar view commits)", (async () => {
      const payload = groupAvatarDeclaration({ size: Buffer.byteLength(rect), sha256: sha256(rect), contentType: "image/jpeg" });
      const res = await fetch(`${base}/api/social/groups/${groupId}/avatar`, {
        method: "POST",
        headers: {
          "content-type": "image/jpeg",
          authorization: `Bearer ${linda.token}`,
          "x-porchlight-avatar-payload": JSON.stringify(payload),
          "x-porchlight-signature": signWith(linda.privJwk, canonicalJson(payload)),
        },
        body: rect,
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.group.avatar.header.width, 72, "square rung stamps on the committed set");
      assert.equal(body.group.avatar.header.height, 72);
    })());

    // The group avatar's serving (the identity block's loader path) —
    // content-addressed, immutable, hub origin only.
    await runStep("GET /groups/:groupId/avatar/:kind (serving with stamps)", (async () => {
      const rung = (await detailOf(base, linda.token, groupId)).avatar.header;
      const served = await fetch(`${base}/api/social/groups/${groupId}/avatar/${rung.kind}?v=${rung.sha256}`, { headers: { authorization: `Bearer ${linda.token}` } });
      assert.equal(served.status, 200);
      assert.equal(served.headers.get("cache-control"), "private, max-age=31536000, immutable");
      assert.equal(served.headers.get("x-porchlight-media-width"), "72");
      const bytes = Buffer.from(await served.arrayBuffer());
      assert.ok(bytes.length > 0 && bytes.length < 1024 * 1024, "the served face is avatar-class weight");
    })());

    // The detail read the menu renders from (the flags + presentation +
    // resolved notification state ride one fetch).
    await runStep("GET /groups/:groupId (the menu's detail read)", (async () => {
      const manager = await detailOf(base, linda.token, groupId);
      assert.equal(manager.isManagingMember, true);
      assert.equal(manager.isNetworkOwner, false);
      assert.ok(manager.avatar?.header?.sha256, "presentation rides the same fetch");
      assert.equal(manager.notifications.perGroup, true, "no stored preference resolves ON");
      const superuser = await detailOf(base, ownerToken, groupId);
      assert.equal(superuser.isNetworkOwner, true, "the owner's flag (no membership needed)");
    })());

    // The notification row's read-merge-write (exact shapes setGroupNotification sends).
    await runStep("GET/PUT /push/settings (the toggle's write lands and persists)", (async () => {
      // A second group with no preference: unset resolves ON.
      const second = await (async () => {
        const res = await fetch(`${base}/api/social/groups`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${linda.token}` },
          body: JSON.stringify({ name: "Cleanup", visibility: "private" }),
        });
        const body = await res.json();
        assert.equal(res.status, 201, JSON.stringify(body));
        return body.group._id;
      })();
      assert.equal((await detailOf(base, linda.token, second)).notifications.perGroup, true, "unset resolves ON (no backfill)");

      const row = await getSettings(base, linda.token);
      assert.equal(row.groups[second], undefined, "no entry for the untouched group");
      // The member turns Picnic off: the whole row rides (full-row replace).
      const merged = { enabled: row.enabled === true, events: row.events ?? {}, mutes: Array.isArray(row.mutes) ? row.mutes : [], groups: { ...(row.groups ?? {}), [groupId]: false } };
      const put = await fetch(`${base}/api/social/push/settings`, {
        method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${linda.token}` },
        body: JSON.stringify(merged),
      });
      const putBody = await put.json();
      assert.equal(put.status, 200, JSON.stringify(putBody));
      assert.equal(putBody.settings.groups[groupId], false, "the OFF entry persisted");
      assert.equal((await detailOf(base, linda.token, groupId)).notifications.perGroup, false, "the detail read agrees (survives reload)");
      assert.equal((await getSettings(base, linda.token)).groups[groupId], false, "the GET agrees");
      // An entry for a group she no longer holds: refused in plain language.
      const refused = await fetch(`${base}/api/social/push/settings`, {
        method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${linda.token}` },
        body: JSON.stringify({ ...merged, groups: { grp_nope: false } }),
      });
      assert.equal(refused.status, 403, JSON.stringify(await refused.json()));
      // Restore.
      const restore = await fetch(`${base}/api/social/push/settings`, {
        method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${linda.token}` },
        body: JSON.stringify({ ...merged, groups: {} }),
      });
      assert.equal(restore.status, 200, JSON.stringify(await restore.json()));
    })());

    // The owner remove-post flow (the card ··· entry's write, the client's
    // payload shape built through groupPostRemovePayload).
    await runStep("DELETE /groups/:groupId/posts/:postId (the card's Remove commits)", (async () => {
      const payload = { type: "text", body: "the picnic table by the lake", caption: null, mediaRefs: [], groupId };
      const createPost = await fetch(`${base}/api/social/posts`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${linda.token}` },
        body: JSON.stringify({ payload, signature: signWith(linda.privJwk, canonicalJson(payload)) }),
      });
      const createdPost = await createPost.json();
      assert.ok([200, 201].includes(createPost.status), JSON.stringify(createdPost));
      const postId = createdPost.post._id;
      const timeline = await (await fetch(`${base}/api/social/timeline/groups/${groupId}`, { headers: { authorization: `Bearer ${linda.token}` } })).json();
      assert.ok(timeline.posts.some((row) => row._id === postId), "the post served before removal");
      const originNetworkId = timeline.posts.find((row) => row._id === postId).originNetworkId;

      const removalBody = groupPostRemovePayload({ _id: postId, groupId, originNetworkId });
      const removal = await fetch(`${base}/api/social/groups/${groupId}/posts/${postId}`, {
        method: "DELETE", headers: { "content-type": "application/json", authorization: `Bearer ${linda.token}` },
        body: JSON.stringify({ signature: signWith(linda.privJwk, canonicalJson(removalBody)) }),
      });
      const removed = await removal.json();
      assert.equal(removal.status, 200, JSON.stringify(removed));
      const gone = await (await fetch(`${base}/api/social/timeline/groups/${groupId}`, { headers: { authorization: `Bearer ${linda.token}` } })).json();
      assert.ok(!gone.posts.some((row) => row._id === postId), "the group timeline never serves it again");
      const feed = await (await fetch(`${base}/api/social/timeline`, { headers: { authorization: `Bearer ${linda.token}` } })).json();
      assert.ok(!feed.posts.some((row) => row._id === postId), "the main feed never serves it again");
      const unknown = await fetch(`${base}/api/social/posts/${postId}`, { headers: { authorization: `Bearer ${linda.token}` } });
      assert.equal(unknown.status, 404, "the removed post is simply gone");
      // One audit record (the removed-everywhere consequence, fully landed).
      const audit = await (await fetch(`${base}/api/social/console/audit?limit=100`, { headers: { authorization: `Bearer ${ownerToken}` } })).json();
      const removalRows = audit.events.filter((row) => row.action === "group_post_remove" && row.detail?.postId === postId);
      assert.equal(removalRows.length, 1);
    })());
  } finally {
    if (hub) hub.kill();
    if (!keep) await rm(home, { recursive: true, force: true });
  }
});