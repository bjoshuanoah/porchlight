/**
 * Member avatar (PORCH-070): upload (ingest → confirm commit), replace,
 * clear, plain-language refusals, square-compressed treated set, cross-
 * identity binding, and the member-purge retirement hook — HTTP-level over
 * the assembled identity module (memory store, no external daemons).
 */
import test from "node:test";
import express from "express";
import assert from "node:assert/strict";
import sharp from "sharp";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { createMemoryStore } from "@porchlight/shared";
import { assembleIdentityModule } from "../src/assemble.js";
import { newEd25519Jwks } from "../src/util/jwt.js";

const HUB_A = "https://hub-a.test";

function memoryBlobs() {
  const map = new Map();
  return {
    put: async (key, bytes) => (map.set(key, bytes), key),
    get: async (key) => map.get(key) ?? null,
    has: async (key) => map.has(key),
    delete: async (key) => map.delete(key),
    size: () => map.size,
  };
}

async function call(base, path, { method = "GET", body, token, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body,
  });
  const type = res.headers.get("content-type") ?? "";
  return {
    status: res.status,
    headers: res.headers,
    body: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()),
  };
}

function signNonce(privateKeyJwk, nonce) {
  return sign(null, Buffer.from(nonce, "utf8"), createPrivateKey({ key: privateKeyJwk, format: "jwk" })).toString("base64url");
}

function signPayload(privateKeyJwk, payload) {
  const canonical = JSON.stringify(Object.fromEntries(Object.keys(payload).sort().map((k) => [k, payload[k]])));
  return signNonce(privateKeyJwk, canonical);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A hub with the avatar plane wired to a memory byte store, one member
 * identity (did A, dev_1) with an open session, and a second identity's
 * device session (did B) for cross-identity cases.
 */
async function hub({ wireBlobs = true } = {}) {
  const blobs = memoryBlobs();
  const store = createMemoryStore();
  const identity = assembleIdentityModule(store, {
    hubUrl: () => HUB_A,
    avatar: wireBlobs ? { blobs } : {},
  });
  const app = express();
  app.use(express.json());
  app.use(identity.api);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const jwksA = newEd25519Jwks();
  const created = await call(base, "/bootstrap/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ firstName: "Brian", lastName: "Noah", device: { deviceId: "dev_1", publicKeyJwk: jwksA.publicKeyJwk } }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const didA = created.body.account.did;

  const jwksB = newEd25519Jwks();
  const didB = "did:porch:" + "b".repeat(40);
  await store.collection("device_registrations").insertOne({
    _id: "reg_dev2",
    did: didB,
    deviceId: "dev_2",
    label: null,
    publicKeyJwk: jwksB.publicKeyJwk,
    createdBy: "member",
    status: "active",
    revokedAt: null,
    createdAt: new Date().toISOString(),
  });
  const chB = await call(base, "/session/challenge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ did: didB }) });
  const sessB = await call(base, "/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did: didB, deviceId: "dev_2", nonce: chB.body.nonce, signature: signNonce(jwksB.privateKeyJwk, chB.body.nonce) }),
  });
  assert.equal(sessB.status, 201, JSON.stringify(sessB.body));

  const chA = await call(base, "/session/challenge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ did: didA }) });
  const sessA = await call(base, "/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did: didA, deviceId: "dev_1", nonce: chA.body.nonce, signature: signNonce(jwksA.privateKeyJwk, chA.body.nonce) }),
  });
  assert.equal(sessA.status, 201);

  const jpeg = await sharp({ create: { width: 220, height: 120, channels: 3, background: { r: 40, g: 90, b: 200 } } }).jpeg().toBuffer();
  const png = await sharp({ create: { width: 300, height: 100, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();

  async function ingest(token, bytes, jwks, overrides = {}) {
    const payload = {
      scope: "identity-avatar",
      action: "ingest",
      size: Buffer.byteLength(bytes),
      sha256: sha256(bytes),
      contentType: bytes.contentType ?? "image/jpeg",
      ...overrides,
    };
    return call(base, "/accounts/me/avatar", {
      method: "POST",
      token,
      body: bytes,
      headers: {
        "content-type": payload.contentType,
        "x-porchlight-avatar-payload": JSON.stringify(payload),
        "x-porchlight-signature": signPayload(jwks.privateKeyJwk, payload),
      },
    });
  }

  async function commit(token, pendingToken, jwks) {
    const payload = { scope: "identity-avatar", action: "commit", token: pendingToken };
    return call(base, "/accounts/me/avatar", {
      method: "POST",
      token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload, signature: signPayload(jwks.privateKeyJwk, payload) }),
    });
  }

  async function clearAvatar(token, jwks) {
    const payload = { scope: "identity-avatar", action: "clear" };
    return call(base, "/accounts/me/avatar", {
      method: "POST",
      token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload, signature: signPayload(jwks.privateKeyJwk, payload) }),
    });
  }

  return {
    store,
    base,
    identity,
    avatarService: identity.avatarService,
    blobs,
    didA,
    didB,
    jwksB,
    tokenA: sessA.body.accessToken,
    tokenB: sessB.body.accessToken,
    jwksA,
    jpeg,
    png,
    ingest,
    commit,
    clearAvatar,
    close: () => {
      server.closeIdleConnections();
      server.close();
    },
  };
}

test("ingest → pending preview → commit completes in place: the treated face serves under the immutable cache contract", async (t) => {
  const f = await hub();
  t.after(f.close);

  const ingest = await f.ingest(f.tokenA, f.jpeg, f.jwksA);
  assert.equal(ingest.status, 200, JSON.stringify(ingest.body));
  const pend = ingest.body.pending;
  assert.ok(pend?.token, "a one-time pending token rides the response");
  // Square stamps on every rung; avatar-class weight (KB scale).
  assert.equal(pend.renditions.header.kind, "header");
  assert.equal(pend.renditions.header.width, 72);
  assert.equal(pend.renditions.header.height, 72);
  assert.equal(pend.renditions.chooser.width, 144);
  assert.equal(pend.renditions.chooser.height, 144);
  assert.equal(pend.renditions.chooser.contentType, "image/webp");

  // The pending (pre-confirm) preview serves ONLY to the member's own session.
  const preview = await call(
    f.base,
    `/avatars/${encodeURIComponent(f.didA)}/renditions/chooser?pending=${encodeURIComponent(pend.token)}&v=${pend.renditions.chooser.sha256}`,
    { token: f.tokenA },
  );
  assert.equal(preview.status, 200, String(Buffer.isBuffer(preview.body) ? "" : preview.body.error));
  assert.equal(preview.headers.get("content-type"), "image/webp");
  assert.equal(preview.headers.get("cache-control"), "private, no-store", "pending faces cache nowhere");
  assert.ok(preview.body.length > 0 && preview.body.length < 100 * 1024, `preview is avatar-class weight (${preview.body.length} bytes)`);
  const other = await call(
    f.base,
    `/avatars/${encodeURIComponent(f.didA)}/renditions/chooser?pending=${encodeURIComponent(pend.token)}&v=${pend.renditions.chooser.sha256}`,
    { token: f.tokenB },
  );
  assert.equal(other.status, 403, "a face nobody confirmed yet is nobody's to see");

  const commit = await f.commit(f.tokenA, pend.token, f.jwksA);
  assert.equal(commit.status, 200, JSON.stringify(commit.body));
  assert.equal(commit.body.avatar.header.sha256, pend.renditions.header.sha256, "the preview shown before confirm matches the stored result");

  // The committed rungs serve content-addressed + immutable; stamps ride the response.
  const served = await call(f.base, `/avatars/${encodeURIComponent(f.didA)}/renditions/header?v=${commit.body.avatar.header.sha256}`, { token: f.tokenB });
  assert.equal(served.status, 200, "a member of the hub sees faces committed by another member");
  assert.equal(served.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(served.headers.get("etag"), `"${commit.body.avatar.header.sha256}"`);
  assert.equal(served.headers.get("x-porchlight-media-width"), "72");
  assert.equal(served.headers.get("x-porchlight-media-height"), "72");
  const stale = await call(f.base, `/avatars/${encodeURIComponent(f.didA)}/renditions/header?v=${"0".repeat(64)}`, { token: f.tokenB });
  assert.equal(stale.status, 404, "a mismatched content address never serves stale bytes");
  const unauthed = await call(f.base, `/avatars/${encodeURIComponent(f.didA)}/renditions/header?v=${commit.body.avatar.header.sha256}`);
  assert.equal(unauthed.status, 401, "faces stay behind a member token");
});

test("GET /accounts/me carries the avatar stamps after commit — no re-login, no re-bind", async (t) => {
  const f = await hub();
  t.after(f.close);
  const ingest = await f.ingest(f.tokenA, f.jpeg, f.jwksA);
  const commit = await f.commit(f.tokenA, ingest.body.pending.token, f.jwksA);
  assert.equal(commit.status, 200);
  const me = await call(f.base, "/accounts/me", { token: f.tokenA });
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.did, f.didA);
  assert.equal(me.body.avatar?.chooser?.sha256, commit.body.avatar.chooser.sha256);
  assert.ok(!me.body.avatar?.chooser?.blobKey, "byte-store internals never reach the client");
});

test("one avatar per identity was written to the account record (the rides-across-networks field)", async (t) => {
  const f = await hub();
  t.after(f.close);
  const ingest = await f.ingest(f.tokenA, f.jpeg, f.jwksA);
  await f.commit(f.tokenA, ingest.body.pending.token, f.jwksA);
  const row = await f.identity.avatarService.identities.findOne({ did: f.didA });
  assert.ok(row.avatar?.renditions?.length === 2, "the treated set lives on the account record");
  assert.ok(row.avatar.renditions.every((rung) => rung.width === rung.height), "square geometry stamps on every rung");
});

test("replacing retires the prior set whole (no unbounded accumulation, no cache-poison risk); clearing reverts", async (t) => {
  const f = await hub();
  t.after(f.close);
  const first = await f.ingest(f.tokenA, f.jpeg, f.jwksA);
  const commitA = await f.commit(f.tokenA, first.body.pending.token, f.jwksA);
  const firstShas = [commitA.body.avatar.header.sha256, commitA.body.avatar.chooser.sha256];

  const second = await f.ingest(f.tokenA, f.png, f.jwksA, { contentType: "image/png" });
  const commitB = await f.commit(f.tokenA, second.body.pending.token, f.jwksA);
  assert.notEqual(commitB.body.avatar.chooser.sha256, commitA.body.avatar.chooser.sha256);
  for (const oldSha of firstShas) {
    assert.equal(await f.avatarService.blobs.has(oldSha), false, `replaced blob ${oldSha.slice(0, 8)} retires`);
    const gone = await call(f.base, `/avatars/${encodeURIComponent(f.didA)}/renditions/header?v=${oldSha}`, { token: f.tokenA });
    assert.equal(gone.status, 404, "replaced renditions become unreachable content");
  }
  assert.equal(f.blobs.size(), 2, "exactly the current set remains");

  const cleared = await f.clearAvatar(f.tokenA, f.jwksA);
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.avatar, null);
  assert.equal(f.blobs.size(), 0, "clearing retires every rendition");
  const row = await f.identity.avatarService.identities.findOne({ did: f.didA });
  assert.equal(row.avatar, null);
  const served = await call(f.base, `/avatars/${encodeURIComponent(f.didA)}/renditions/header?v=${commitB.body.avatar.chooser.sha256}`, { token: f.tokenA });
  assert.equal(served.status, 404);
});

test("refusals are plain-language, named, and never a partial write: unsupported type, over-cap, wrong signature, own-identity binding", async (t) => {
  const f = await hub();
  t.after(f.close);

  const pdf = Buffer.from("%PDF-1.4 family reunion plan", "utf8");
  const pdfRes = await f.ingest(f.tokenA, pdf, f.jwksA, { contentType: "application/pdf", size: Buffer.byteLength(pdf) });
  assert.equal(pdfRes.status, 415, JSON.stringify(pdfRes.body));
  assert.equal(pdfRes.body.code, "E_AVATAR_UNSUPPORTED_TYPE");
  assert.ok(pdfRes.body.error.length > 0);

  const big = await sharp({ create: { width: 2400, height: 2400, channels: 3, noise: { type: "gaussian", sigma: 40 } } }).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(Buffer.byteLength(big) > 5 * 1024 * 1024, "fixture is over the cap");
  const bigRes = await f.ingest(f.tokenA, big, f.jwksA, { contentType: "image/png" });
  assert.equal(bigRes.status, 413);
  assert.equal(bigRes.body.code, "E_AVATAR_TOO_LARGE");

  // A mismatched declared fingerprint refuses and stores nothing.
  const corrupt = await f.ingest(f.tokenA, f.jpeg, f.jwksA, { sha256: "0".repeat(64) });
  assert.equal(corrupt.status, 422);
  assert.equal(corrupt.body.code, "E_AVATAR_SHA_MISMATCH");

  // Device signature binds: another identity's device never signs your writes...
  const foreignSignedWrong = await f.ingest(f.tokenB, f.png, f.jwksA, { contentType: "image/png" });
  assert.equal(foreignSignedWrong.status, 403, JSON.stringify(foreignSignedWrong.body));
  assert.equal(foreignSignedWrong.body.code, "E_SIGNATURE_INVALID");
  // ...and even a correct signature from B's device cannot carry A's row.
  const payloadB = {
    scope: "identity-avatar",
    action: "ingest",
    size: Buffer.byteLength(f.png),
    sha256: sha256(f.png),
    contentType: "image/png",
  };
  const foreign = await call(f.base, `/accounts/me/avatar?did=${encodeURIComponent(f.didA)}`, {
    method: "POST",
    token: f.tokenB,
    body: f.png,
    headers: {
      "content-type": "image/png",
      "x-porchlight-avatar-payload": JSON.stringify(payloadB),
      "x-porchlight-signature": signPayload(f.jwksB.privateKeyJwk, payloadB),
    },
  });
  assert.equal(foreign.status, 403, JSON.stringify(foreign.body));
  assert.equal(foreign.body.code, "E_FORBIDDEN");

  // Nothing about the refusals stored bytes or changed the record.
  assert.equal(f.blobs.size(), 0);
  const me = await call(f.base, "/accounts/me", { token: f.tokenA });
  assert.equal(me.body.avatar, null);
});

test("the member purge cascade retires the avatar set with the account record", async (t) => {
  const f = await hub();
  t.after(f.close);
  const ingest = await f.ingest(f.tokenA, f.jpeg, f.jwksA);
  const pendingToken = ingest.body.pending.token;
  await f.commit(f.tokenA, pendingToken, f.jwksA);
  const retired = await f.avatarService.retireFor(f.didA);
  assert.equal(retired.removed, 2, "the whole set retires with the record");
  assert.equal(f.blobs.size(), 0);
  const again = await f.avatarService.retireFor(f.didA);
  assert.equal(again.removed, 0, "idempotent");
  const me = await call(f.base, "/accounts/me", { token: f.tokenA });
  assert.equal(me.body.avatar, null);
});

test("an abandoned pending retires itself: a retake replaces the slot, a stale token previews nothing", async (t) => {
  const f = await hub();
  t.after(f.close);
  const first = await f.ingest(f.tokenA, f.jpeg, f.jwksA);
  const firstPend = first.body.pending;
  // A retake replaces the pending slot: the first pending's bytes retire at once.
  const second = await f.ingest(f.tokenA, f.png, f.jwksA, { contentType: "image/png" });
  assert.notEqual(second.body.pending.token, firstPend.token);
  assert.equal(await f.blobs.has(firstPend.renditions.chooser.sha256), false, "the retaken preview's bytes retire");

  const stale = await call(
    f.base,
    `/avatars/${encodeURIComponent(f.didA)}/renditions/chooser?pending=${encodeURIComponent(firstPend.token)}&v=${firstPend.renditions.chooser.sha256}`,
    { token: f.tokenA },
  );
  assert.equal(stale.status, 404, "a stale pending token previews nothing");
  assert.equal(stale.body.code, "E_AVATAR_PENDING_NOT_FOUND");

  const committed = await f.commit(f.tokenA, second.body.pending.token, f.jwksA);
  assert.equal(committed.status, 200, "the fresh pending still commits");
});

test("an unwired byte store refuses plainly and every refusal changes nothing", async (t) => {
  const f = await hub({ wireBlobs: false });
  t.after(f.close);
  const res = await f.ingest(f.tokenA, f.jpeg, f.jwksA);
  assert.equal(res.status, 503, JSON.stringify(res.body));
  assert.equal(res.body.code, "E_AVATAR_UNAVAILABLE");
  const served = await call(f.base, `/avatars/${encodeURIComponent(f.didA)}/renditions/header`, { token: f.tokenA });
  assert.equal(served.status, 503);
});