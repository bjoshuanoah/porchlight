/**
 * TrustService OIDC + member-token verification tests (slice C, ac-6/7/8).
 * No network: every cross-hub fetch is injected via a transport fixture that
 * also asserts the redirect:"error" discipline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createMemoryStore } from "@porchlight/shared";
import { decodeJwt, newEd25519Jwks, signEdDsaJwt, verifyEdDsaJwt } from "../src/util/jwt.js";
import { HubSigningService, ID_TOKEN_TTL_SECONDS } from "../src/services/signing.service.js";
import { TrustService, AUTH_CODE_TTL_SECONDS } from "../src/services/trust.service.js";

const HUB_A = "https://hub-a.test";
const HUB_B = "https://hub-b.test";

function hubFixture({ issuer }) {
  const store = createMemoryStore();
  const signing = new HubSigningService(store.collection("issuer_keys"));
  const trust = new TrustService({
    authCodes: store.collection("auth_codes"),
    sessions: store.collection("sessions"),
    signing,
    hubUrlFn: () => issuer,
  });
  return { store, signing, trust, issuer };
}

/**
 * HTTP fixture: asserts every outbound call obeys redirect:"error"; unknown
 * URLs are 404s (fail closed). Values may be functions so key sets always
 * reflect the live keystore (rotation/prune flows).
 */
function transportFor(map) {
  return async (url, options) => {
    assert.ok(options?.redirect === "error", "every trust-plane fetch must use redirect:'error'");
    const entry = map[url];
    if (!entry) return { ok: false, status: 404, json: async () => ({}) };
    const body = typeof entry === "function" ? await entry() : entry;
    return { ok: true, status: 200, json: async () => body };
  };
}

function jwksTransport(hubA) {
  return transportFor({
    [`${HUB_A}/.well-known/jwks.json`]: () => hubA.signing.jwks(),
    [`${HUB_A}/.well-known/identity-keys.json`]: () => hubA.signing.didDocPublicKeys(),
  });
}

function seedActiveSession(hubA, did) {
  const nowMs = Date.now();
  return hubA.store.collection("sessions").insertOne({
    _id: `sess_${randomUUID()}`,
    did,
    deviceId: "dev-1",
    accessTokenHash: "hash-a",
    refreshTokenHash: "hash-b",
    accessExpiresAt: new Date(nowMs + 600_000).toISOString(),
    refreshExpiresAt: new Date(nowMs + 45 * 24 * 3600 * 1000).toISOString(),
    status: "active",
    createdAt: new Date(nowMs).toISOString(),
  });
}

function s256(verifier) {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

const AUTHORIZATION_KEYS = ["roles", "capabilities", "membership", "scopes", "permissions", "groups"];

test("createAuthCode requires an active home-hub session (E_SESSION_REQUIRED)", async () => {
  const hub = hubFixture({ issuer: HUB_A });
  const verifier = "verifier-string-for-the-unknown-identity";
  await assert.rejects(
    hub.trust.createAuthCode({
      did: "did:porch:nobody",
      clientId: "net-b",
      nonce: "n-1",
      codeChallenge: s256(verifier),
      codeChallengeMethod: "S256",
    }),
    { code: "E_SESSION_REQUIRED" },
  );
  await assert.rejects(
    hub.trust.createAuthCode({
      did: "did:porch:nobody",
      clientId: "net-b",
      nonce: "n-1",
      codeChallenge: s256(verifier),
      codeChallengeMethod: "S256",
    }),
    { code: "E_SESSION_REQUIRED" },
  );
});

test("createAuthCode requires nonce + PKCE S256 challenge (E_PKCE_REQUIRED, E_CHALLENGE_METHOD_UNSUPPORTED)", async () => {
  const hub = hubFixture({ issuer: HUB_A });
  const did = "did:porch:susan";
  await seedActiveSession(hub, did);
  await assert.rejects(
    hub.trust.createAuthCode({ did, clientId: "net-b", nonce: null, codeChallenge: s256("v"), codeChallengeMethod: "S256" }),
    { code: "E_PKCE_REQUIRED" },
  );
  await assert.rejects(
    hub.trust.createAuthCode({ did, clientId: "net-b", nonce: "n-1", codeChallenge: null, codeChallengeMethod: "S256" }),
    { code: "E_PKCE_REQUIRED" },
  );
  await assert.rejects(
    hub.trust.createAuthCode({ did, clientId: "net-b", nonce: "n-1", codeChallenge: s256("v"), codeChallengeMethod: "plain" }),
    { code: "E_CHALLENGE_METHOD_UNSUPPORTED" },
  );
});

test("full code path: happy flow issues a ~10-minute EdDSA ID token matching iss/aud/nonce/sub (ac-6)", async () => {
  const hub = hubFixture({ issuer: HUB_A });
  const did = "did:porch:susan";
  await seedActiveSession(hub, did);
  const verifier = `pkce-verifier-${randomUUID()}`;
  const nonce = `nonce-${randomUUID()}`;

  const created = await hub.trust.createAuthCode({
    did,
    clientId: "net-b",
    nonce,
    codeChallenge: s256(verifier),
    codeChallengeMethod: "S256",
  });
  assert.match(created.code, /^ac_/);
  assert.ok(created.expiresAt);

  const result = await hub.trust.exchangeAuthCode({ code: created.code, codeVerifier: verifier, clientId: "net-b" });
  assert.deepEqual(
    { token_type: result.token_type, expires_in: result.expires_in },
    { token_type: "Bearer", expires_in: ID_TOKEN_TTL_SECONDS },
  );
  assert.match(result.access_token, /^at_/);

  const decoded = decodeJwt(result.id_token);
  assert.equal(decoded.header.alg, "EdDSA");
  assert.equal(decoded.payload.iss, HUB_A);
  assert.equal(decoded.payload.sub, did);
  assert.equal(decoded.payload.aud, "net-b");
  assert.equal(decoded.payload.nonce, nonce);
  assert.equal(decoded.payload.exp - decoded.payload.iat, ID_TOKEN_TTL_SECONDS);

  // Independently verify signature against the hub's served member-auth JWKS.
  const jwks = await hub.signing.jwks();
  const served = jwks.keys.find((key) => key.kid === decoded.header.kid);
  assert.ok(served, "token kid must be in the served JWKS");
  const verified = verifyEdDsaJwt(result.id_token, { publicKeyJwk: served });
  assert.equal(verified.payload.sub, did);
});

test("code is one-time: second exchange is E_AUTH_CODE_CONSUMED", async () => {
  const hub = hubFixture({ issuer: HUB_A });
  const did = "did:porch:susan";
  await seedActiveSession(hub, did);
  const verifier = `pkce-${randomUUID()}`;
  const { code } = await hub.trust.createAuthCode({
    did,
    clientId: "net-b",
    nonce: "n-once",
    codeChallenge: s256(verifier),
    codeChallengeMethod: "S256",
  });
  await hub.trust.exchangeAuthCode({ code, codeVerifier: verifier, clientId: "net-b" });
  await assert.rejects(hub.trust.exchangeAuthCode({ code, codeVerifier: verifier, clientId: "net-b" }), {
    code: "E_AUTH_CODE_CONSUMED",
  });
});

test("PKCE mismatch rejected (E_PKCE_MISMATCH) and does NOT consume the code", async () => {
  const hub = hubFixture({ issuer: HUB_A });
  const did = "did:porch:susan";
  await seedActiveSession(hub, did);
  const verifier = `pkce-${randomUUID()}`;
  const { code } = await hub.trust.createAuthCode({
    did,
    clientId: "net-b",
    nonce: "n-once",
    codeChallenge: s256(verifier),
    codeChallengeMethod: "S256",
  });
  await assert.rejects(hub.trust.exchangeAuthCode({ code, codeVerifier: `wrong-${verifier}`, clientId: "net-b" }), {
    code: "E_PKCE_MISMATCH",
  });
  // The failed PKCE attempt leaves the code redeemable by the right verifier.
  const result = await hub.trust.exchangeAuthCode({ code, codeVerifier: verifier, clientId: "net-b" });
  assert.equal(decodeJwt(result.id_token).payload.nonce, "n-once");
});

test("wrong clientId rejected (E_CLIENT_MISMATCH)", async () => {
  const hub = hubFixture({ issuer: HUB_A });
  const did = "did:porch:susan";
  await seedActiveSession(hub, did);
  const verifier = `pkce-${randomUUID()}`;
  const { code } = await hub.trust.createAuthCode({
    did,
    clientId: "net-b",
    nonce: "n-once",
    codeChallenge: s256(verifier),
    codeChallengeMethod: "S256",
  });
  await assert.rejects(hub.trust.exchangeAuthCode({ code, codeVerifier: verifier, clientId: "net-c" }), {
    code: "E_CLIENT_MISMATCH",
  });
});

test("expired auth code rejected (E_AUTH_CODE_EXPIRED) — 120s TTL via injected clock", async () => {
  const hub = hubFixture({ issuer: HUB_A });
  const did = "did:porch:susan";
  await seedActiveSession(hub, did);
  const t0 = new Date("2026-10-08T12:00:00.000Z");
  const verifier = `pkce-${randomUUID()}`;
  const { code } = await hub.trust.createAuthCode({
    did,
    clientId: "net-b",
    nonce: "n-once",
    codeChallenge: s256(verifier),
    codeChallengeMethod: "S256",
    now: () => t0,
  });
  const justBefore = new Date(t0.getTime() + (AUTH_CODE_TTL_SECONDS - 1) * 1000);
  await hub.trust.exchangeAuthCode({ code, codeVerifier: verifier, clientId: "net-b", now: () => justBefore });
  const { code: code2 } = await hub.trust.createAuthCode({
    did,
    clientId: "net-b",
    nonce: "n-once-2",
    codeChallenge: s256(verifier),
    codeChallengeMethod: "S256",
    now: () => t0,
  });
  const justAfter = new Date(t0.getTime() + (AUTH_CODE_TTL_SECONDS + 1) * 1000);
  await assert.rejects(
    hub.trust.exchangeAuthCode({ code: code2, codeVerifier: verifier, clientId: "net-b", now: () => justAfter }),
    { code: "E_AUTH_CODE_EXPIRED" },
  );
});

test("token TTL ~10 minutes and expiry is enforced at verification (E_TOKEN_EXPIRED)", async () => {
  const hub = hubFixture({ issuer: HUB_A });
  const transport = jwksTransport(hub);
  const did = "did:porch:susan";
  const { id_token } = await hub.trust.issueMemberToken({ did, audience: "net-b", nonce: "n-1" });
  const decoded = decodeJwt(id_token);
  assert.equal(decoded.payload.exp - decoded.payload.iat, ID_TOKEN_TTL_SECONDS);

  // An expired token (negative remaining life) fails closed at the verifier.
  const nowSec = Math.floor(Date.now() / 1000);
  const expired = await hub.signing.signMemberToken(
    { iss: HUB_A, sub: did, aud: "net-b", nonce: "n-1" },
    { ttlSeconds: 10, issuedAtSeconds: nowSec - 100 },
  );
  const kid = decodeJwt(id_token).header.kid;
  await assert.rejects(hub.trust.verifyMemberToken(expired, { pinnedIssuer: HUB_A, audience: "net-b", pinnedKids: [kid], transport }), {
    code: "E_TOKEN_EXPIRED",
  });
});

test("id_token payload is IDENTITY ONLY: no roles/capabilities/membership anywhere (ac-7)", async () => {
  const hub = hubFixture({ issuer: HUB_A });
  const did = "did:porch:susan";
  await seedActiveSession(hub, did);
  const verifier = `pkce-${randomUUID()}`;
  const { code } = await hub.trust.createAuthCode({
    did,
    clientId: "net-b",
    nonce: "n-once",
    codeChallenge: s256(verifier),
    codeChallengeMethod: "S256",
  });
  const { id_token } = await hub.trust.exchangeAuthCode({ code, codeVerifier: verifier, clientId: "net-b" });
  const payload = decodeJwt(id_token).payload;
  assert.deepEqual(
    Object.keys(payload).sort(),
    ["aud", "exp", "iat", "iss", "nonce", "sub"],
  );

  const { id_token: direct } = await hub.trust.issueMemberToken({ did, audience: "net-b", actorType: "human" });
  const directPayload = decodeJwt(direct).payload;
  assert.deepEqual(
    Object.keys(directPayload).sort(),
    ["actorType", "aud", "exp", "iat", "iss", "sub"],
  );
  for (const banned of AUTHORIZATION_KEYS) {
    assert.ok(!(banned in payload), `code path token must never carry "${banned}"`);
    assert.ok(!(banned in directPayload), `direct token must never carry "${banned}"`);
  }
});

test("verifier output carries nothing usable for authorization (ac-7)", async () => {
  const hub = hubFixture({ issuer: HUB_A });
  const did = "did:porch:susan";
  const { id_token } = await hub.trust.issueMemberToken({ did, audience: "net-b", nonce: "n-1" });
  const kid = decodeJwt(id_token).header.kid;
  const verified = await hub.trust.verifyMemberToken(id_token, {
    pinnedIssuer: HUB_A,
    audience: "net-b",
    nonce: "n-1",
    pinnedKids: [kid],
    transport: jwksTransport(hub),
  });
  assert.deepEqual(Object.keys(verified).sort(), ["claims", "did"]);
  assert.equal(verified.did, did);
  assert.deepEqual(
    Object.keys(verified.claims).filter((key) => AUTHORIZATION_KEYS.includes(key)),
    [],
  );
});

test("rotation: a still-published old key verifies transparently", async () => {
  const hub = hubFixture({ issuer: HUB_A });
  const did = "did:porch:susan";
  const { id_token } = await hub.trust.issueMemberToken({ did, audience: "net-b" });
  const pinnedKid = decodeJwt(id_token).header.kid;

  const { activeKid } = await hub.signing.rotateMemberAuthKeys();
  assert.notEqual(activeKid, pinnedKid);

  const verified = await hub.trust.verifyMemberToken(id_token, {
    pinnedIssuer: HUB_A,
    audience: "net-b",
    pinnedKids: [pinnedKid],
    transport: jwksTransport(hub),
  });
  assert.equal(verified.did, did);
});

test("pruned rotation fails CLOSED: served set loses the pinned kids → E_KEY_SET_MISMATCH (re-invite = re-pin, ac-8)", async () => {
  const hub = hubFixture({ issuer: HUB_A });
  const did = "did:porch:susan";
  const { id_token } = await hub.trust.issueMemberToken({ did, audience: "net-b" });
  const pinnedKid = decodeJwt(id_token).header.kid;

  await hub.signing.rotateMemberAuthKeys();
  await hub.signing.prunePublishedKey(pinnedKid);
  // Fetched set now lacks every pinned kid; even a fresh signature must not
  // re-establish trust over an un-pinned key set.
  const { id_token: fresh } = await hub.trust.issueMemberToken({ did, audience: "net-b" });
  assert.notEqual(decodeJwt(fresh).header.kid, pinnedKid);

  await assert.rejects(
    hub.trust.verifyMemberToken(fresh, {
      pinnedIssuer: HUB_A,
      audience: "net-b",
      pinnedKids: [pinnedKid],
      transport: jwksTransport(hub),
    }),
    { code: "E_KEY_SET_MISMATCH" },
  );
});

test("pinned key set never intersecting (never re-issued after invite) → E_KEY_SET_MISMATCH", async () => {
  const hub = hubFixture({ issuer: HUB_A });
  const did = "did:porch:susan";
  const { id_token } = await hub.trust.issueMemberToken({ did, audience: "net-b" });
  await assert.rejects(
    hub.trust.verifyMemberToken(id_token, {
      pinnedIssuer: HUB_A,
      audience: "net-b",
      pinnedKids: [],
      transport: jwksTransport(hub),
    }),
    { code: "E_KEY_SET_MISMATCH" },
  );
  await assert.rejects(
    hub.trust.verifyMemberToken(id_token, {
      pinnedIssuer: HUB_A,
      audience: "net-b",
      pinnedKids: undefined,
      transport: jwksTransport(hub),
    }),
    { code: "E_KEY_SET_MISMATCH" },
  );
});

test("unknown kid rejected (E_TOKEN_KID_UNKNOWN); alg discipline and sig validity come from the fixed EdDSA verifier", async () => {
  const hub = hubFixture({ issuer: HUB_A });
  const did = "did:porch:susan";
  const { id_token } = await hub.trust.issueMemberToken({ did, audience: "net-b" });
  const kid = decodeJwt(id_token).header.kid;

  // A key not on the hub's member-auth plane at all.
  const stranger = newEd25519Jwks();
  const foreign = signEdDsaJwt({
    payload: { iss: HUB_A, sub: did, aud: "net-b", exp: Math.floor(Date.now() / 1000) + 600 },
    privateKeyJwk: stranger.privateKeyJwk,
    kid: "kid_stranger",
  });
  await assert.rejects(
    hub.trust.verifyMemberToken(foreign, {
      pinnedIssuer: HUB_A,
      audience: "net-b",
      pinnedKids: [kid],
      transport: jwksTransport(hub),
    }),
    { code: "E_TOKEN_KID_UNKNOWN" },
  );
});

test("iss, aud and nonce are all enforced against the pinned values", async () => {
  const hub = hubFixture({ issuer: HUB_A });
  const did = "did:porch:susan";
  // Forged iss (signed by this hub's own key — signature is fine, issuer is not).
  const forgedIss = await hub.signing.signMemberToken({ iss: HUB_B, sub: did, aud: "net-b", exp: Math.floor(Date.now() / 1000) + 600 });
  const kidAtIssue = decodeJwt(forgedIss).header.kid;
  await assert.rejects(
    hub.trust.verifyMemberToken(forgedIss, { pinnedIssuer: HUB_A, audience: "net-b", pinnedKids: [kidAtIssue], transport: jwksTransport(hub) }),
    { code: "E_ISSUER_MISMATCH" },
  );

  const wrongAud = (await hub.trust.issueMemberToken({ did, audience: "net-b" })).id_token;
  await assert.rejects(
    hub.trust.verifyMemberToken(wrongAud, { pinnedIssuer: HUB_A, audience: "net-c", pinnedKids: [kidAtIssue], transport: jwksTransport(hub) }),
    { code: "E_AUDIENCE_MISMATCH" },
  );

  const withNonce = (await hub.trust.issueMemberToken({ did, audience: "net-b", nonce: "n-1" })).id_token;
  await assert.rejects(
    hub.trust.verifyMemberToken(withNonce, { pinnedIssuer: HUB_A, audience: "net-b", nonce: "n-2", pinnedKids: [kidAtIssue], transport: jwksTransport(hub) }),
    { code: "E_NONCE_MISMATCH" },
  );
  const ok = await hub.trust.verifyMemberToken(withNonce, {
    pinnedIssuer: HUB_A,
    audience: "net-b",
    nonce: "n-1",
    pinnedKids: [kidAtIssue],
    transport: jwksTransport(hub),
  });
  assert.equal(ok.did, did);
});

test("fixed-alg discipline: a non-EdDSA token is rejected even when the kid matches (E_ALG_MISMATCH)", async () => {
  const hub = hubFixture({ issuer: HUB_A });
  const did = "did:porch:susan";
  const { id_token } = await hub.trust.issueMemberToken({ did, audience: "net-b" });
  const kid = decodeJwt(id_token).header.kid;
  const { privateKeyJwk } = newEd25519Jwks();

  // Well-formed Ed25519 signature but a forged alg header — must not pass.
  const b64urlJson = (object) => Buffer.from(JSON.stringify(object)).toString("base64url");
  const parts = String(id_token).split(".");
  const goodPayload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  const header = { alg: "RS256", typ: "JWT", kid };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(goodPayload)}`;
  const { sign, createPrivateKey } = await import("node:crypto");
  const sig = sign(null, Buffer.from(signingInput), createPrivateKey({ key: privateKeyJwk, format: "jwk" })).toString("base64url");
  const swapped = `${signingInput}.${sig}`;

  await assert.rejects(
    hub.trust.verifyMemberToken(swapped, {
      pinnedIssuer: HUB_A,
      audience: "net-b",
      pinnedKids: [kid],
      transport: jwksTransport(hub),
    }),
    { code: "E_ALG_MISMATCH" },
  );
});

test("unavailable JWKS fails closed (E_JWKS_UNAVAILABLE)", async () => {
  const hub = hubFixture({ issuer: HUB_A });
  const did = "did:porch:susan";
  const { id_token } = await hub.trust.issueMemberToken({ did, audience: "net-b" });
  const kid = decodeJwt(id_token).header.kid;
  const failing = transportFor({}); // nothing served → 404
  await assert.rejects(
    hub.trust.verifyMemberToken(id_token, { pinnedIssuer: HUB_A, audience: "net-b", pinnedKids: [kid], transport: failing }),
    { code: "E_JWKS_UNAVAILABLE" },
  );
});

test("issueMemberToken is a direct shortcut with issuer = hubUrl() and optional actorType/handle claims", async () => {
  const hub = hubFixture({ issuer: HUB_A });
  const did = "did:porch:agent-9";
  const { id_token, expiresInSeconds } = await hub.trust.issueMemberToken({
    did,
    audience: "net-b",
    nonce: null,
    actorType: "agent",
    handle: "agent9",
  });
  assert.equal(expiresInSeconds, ID_TOKEN_TTL_SECONDS);
  const payload = decodeJwt(id_token).payload;
  assert.equal(payload.iss, HUB_A);
  assert.equal(payload.sub, did);
  assert.equal(payload.aud, "net-b");
  assert.ok(!("nonce" in payload), "null nonce must be omitted, not asserted");
  assert.equal(payload.actorType, "agent");
  assert.equal(payload.handle, "agent9");
});