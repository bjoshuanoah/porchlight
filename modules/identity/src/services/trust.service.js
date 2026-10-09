import { createHash, randomUUID } from "node:crypto";
import { decodeJwt, verifyEdDsaJwt } from "../util/jwt.js";
import { sha256, ID_TOKEN_TTL_SECONDS } from "./signing.service.js";

/** OIDC authorization-code TTL: one-time redemption inside two minutes. */
export const AUTH_CODE_TTL_SECONDS = 120;

function typedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Every fetch on the trust plane is redirect-hating: redirects must fail, never silently follow. */
function doFetchOf(transport) {
  return transport ?? ((url, options) => globalThis.fetch(url, options));
}

/**
 * Fetch a public key set from a hub's well-known endpoint over the injected
 * (or global, non-redirect-following) transport.
 */
async function fetchKeySet(url, transport) {
  const doFetch = doFetchOf(transport);
  let response;
  try {
    response = await doFetch(url, { redirect: "error" });
  } catch {
    throw typedError("E_JWKS_UNAVAILABLE", `could not fetch key set at ${url} (transport error; redirects rejected)`);
  }
  if (!response || !response.ok) {
    throw typedError("E_JWKS_UNAVAILABLE", `could not fetch key set at ${url} (status ${response?.status ?? "none"})`);
  }
  try {
    return await response.json();
  } catch {
    throw typedError("E_JWKS_UNAVAILABLE", `key set at ${url} is not valid JSON`);
  }
}

/**
 * Trust service — the identity-provider surface of a member's home hub, plus
 * the published verification surface receiving networks call to authenticate a
 * Porchlight member token.
 *
 * Authorization NEVER rides a member token: tokens assert identity only
 * ("this is Susan"), never roles, capabilities, or membership. Receiving
 * networks consult their own membership records for "what Susan may".
 */
export class TrustService {
  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} deps.authCodes `auth_codes`
   * @param {import("@porchlight/shared").CollectionLike} deps.sessions `sessions`
   * @param {import("./signing.service.js").HubSigningService} deps.signing
   *        Received by injection — the key planes are never instantiated
   *        inside a service.
   * @param {() => string|null} deps.hubUrlFn issuer provider (OIDC issuer = hubUrl()).
   */
  constructor({ authCodes, sessions, signing, hubUrlFn }) {
    this.authCodes = authCodes;
    this.sessions = sessions;
    this.signing = signing;
    this.hubUrlFn = hubUrlFn;
  }

  #issuer() {
    const issuer = this.hubUrlFn?.() ?? null;
    if (!issuer) {
      throw typedError("E_HUB_URL_REQUIRED", "hub URL provider returned no issuer; refusing to issue trust artifacts");
    }
    return issuer;
  }

  // ------------------------------------------------------------------
  // Issuer surface — the member's home hub is the identity provider.
  // ------------------------------------------------------------------

  /**
   * Begin the OIDC code flow: mint a short, one-time authorization code bound
   * to (did, clientId, nonce, PKCE S256 challenge). Issued ONLY to a member
   * holding an active home-hub session; the code ships to the member once and
   * is stored solely as a sha256 hash. → { code, expiresAt }.
   */
  async createAuthCode({
    did,
    clientId,
    nonce,
    codeChallenge,
    codeChallengeMethod = "S256",
    now = () => new Date(),
  }) {
    if (!did || !clientId) {
      throw typedError("E_PKCE_REQUIRED", "did and clientId are required to bind an authorization code");
    }
    // The member must stand authenticated at the home hub (an active session).
    const nowDate = now();
    const session = await this.sessions.findOne({ did, status: "active" });
    const live = session && (!session.accessExpiresAt || session.accessExpiresAt > nowDate.toISOString());
    if (!live) {
      throw typedError("E_SESSION_REQUIRED", "no active home-hub session for this did");
    }
    // OIDC code path is nonce-bound and PKCE-bound (S256 only) — no exceptions.
    if (!nonce || !codeChallenge) {
      throw typedError("E_PKCE_REQUIRED", "both nonce and PKCE code_challenge are required for the code flow");
    }
    if (codeChallengeMethod !== "S256") {
      throw typedError("E_CHALLENGE_METHOD_UNSUPPORTED", `code challenge method "${codeChallengeMethod}" unsupported; only S256 is accepted`);
    }
    const nowMs = nowDate.getTime();
    const expiresAt = new Date(nowMs + AUTH_CODE_TTL_SECONDS * 1000).toISOString();
    const code = `ac_${randomUUID()}`;
    await this.authCodes.insertOne({
      _id: `x_${randomUUID()}`,
      did,
      clientId,
      codeHash: sha256(code),
      codeChallenge,
      codeChallengeMethod: "S256",
      nonce,
      expiresAt,
      consumed: false,
      createdAt: nowDate.toISOString(),
    });
    return { code, expiresAt };
  }

  /** S256 PKCE challenge for an ASCII verifier: base64url(sha256(verifier)), unpadded. */
  pkceChallengeForVerifier(codeVerifier) {
    return createHash("sha256").update(String(codeVerifier), "ascii").digest("base64url");
  }

  /**
   * Redeem one authorization code for an ID token (hub member-auth plane) and
   * an opaque Bearer access token. The code is consumed exactly once; unknown,
   * expired, reused, wrong-client, and PKCE-mismatch redemptions all fail
   * typed and closed. → { id_token, access_token, token_type, expires_in }.
   */
  async exchangeAuthCode({ code, codeVerifier, clientId, now = () => new Date() }) {
    if (!code) throw typedError("E_AUTH_CODE_UNKNOWN", "an authorization code is required");
    const row = await this.authCodes.findOne({ codeHash: sha256(String(code)) });
    if (!row) throw typedError("E_AUTH_CODE_UNKNOWN", "unknown authorization code");
    const nowMs = now().getTime();
    if (row.consumed) throw typedError("E_AUTH_CODE_CONSUMED", "authorization code already redeemed");
    if (Date.parse(row.expiresAt) <= nowMs) {
      await this.authCodes.updateOne({ _id: row._id }, { $set: { consumed: true } });
      throw typedError("E_AUTH_CODE_EXPIRED", "authorization code expired");
    }
    if (row.clientId !== clientId) {
      throw typedError("E_CLIENT_MISMATCH", "authorization code is bound to a different client");
    }
    if (!codeVerifier || this.pkceChallengeForVerifier(codeVerifier) !== row.codeChallenge) {
      throw typedError("E_PKCE_MISMATCH", "PKCE code_verifier does not match the stored S256 challenge");
    }
    await this.authCodes.updateOne({ _id: row._id }, { $set: { consumed: true } });

    // IDENTITY ONLY — payload is built here, exactly once, with exactly these
    // claims; roles/capabilities/membership have no way into a token.
    const idToken = await this.signing.signMemberToken(
      { iss: this.#issuer(), sub: row.did, aud: clientId, nonce: row.nonce },
      { issuedAtSeconds: Math.floor(nowMs / 1000) },
    );
    return {
      id_token: idToken,
      access_token: `at_${randomUUID()}`,
      token_type: "Bearer",
      expires_in: ID_TOKEN_TTL_SECONDS,
    };
  }

  /**
   * Direct ID token issuance shortcut for cross-hub verification — the issuing
   * call is challenge-signature-authenticated and skips the code flow. Same
   * identity-only claim discipline. → { id_token, expiresInSeconds }.
   */
  async issueMemberToken({ did, audience, nonce = null, actorType = "human", handle = null } = {}) {
    if (!did) {
      throw typedError("E_IDENTITY_NOT_FOUND", "a did is required to issue a member token");
    }
    if (!audience) {
      throw typedError("E_AUDIENCE_MISMATCH", "an audience is required to issue a member token");
    }
    const claims = {
      iss: this.#issuer(),
      sub: did,
      aud: audience,
      actorType,
      ...(nonce != null ? { nonce } : {}),
      ...(handle != null ? { handle } : {}),
    };
    const idToken = await this.signing.signMemberToken(claims);
    return { id_token: idToken, expiresInSeconds: ID_TOKEN_TTL_SECONDS };
  }

  // ------------------------------------------------------------------
  // Receiving-network verification — the published entry surface.
  // ------------------------------------------------------------------

  /**
   * Verify a member token for a receiving network against the PINNED issuer's
   * served JWKS (member-auth plane, kid-addressed), EdDSA only. Key-set
   * discipline fails CLOSED: fetched kids ∩ pinnedKids empty →
   * E_KEY_SET_MISMATCH (re-invite = re-pin; a token is never silently trusted
   * across key-set changes).
   *
   * The result authenticates identity ONLY — { did, claims } carries no
   * authorization data; callers must consult their own membership record for
   * "what this member may".
   *
   * @param {string} token compact JWS
   * @param {object} options { pinnedIssuer, audience, nonce?, pinnedKids,
   *   transport? } — pinnedKids: the kids pinned at invite; transport:
   *   fetch-compatible fn (injected for deterministic tests), always called
   *   with { redirect: "error" }.
   * @returns {Promise<{did: string, claims: object}>}
   */
  async verifyMemberToken(token, { pinnedIssuer, audience, nonce = null, transport = null, pinnedKids } = {}) {
    if (!pinnedIssuer) {
      throw typedError("E_ISSUER_MISMATCH", "a pinned issuer is required to verify a member token");
    }
    if (!audience) {
      throw typedError("E_AUDIENCE_MISMATCH", "an expected audience is required to verify a member token");
    }
    const jwks = await fetchKeySet(`${pinnedIssuer}/.well-known/jwks.json`, transport);
    const keys = Array.isArray(jwks?.keys) ? jwks.keys.filter((key) => key?.kid) : [];

    let decoded;
    try {
      decoded = decodeJwt(String(token));
    } catch {
      throw typedError("E_MALFORMED_TOKEN", "malformed member token: undecodable compact JWS");
    }

    // FAIL CLOSED: the pinned key set must still intersect what the hub serves.
    const pinned = Array.isArray(pinnedKids) ? pinnedKids : [];
    const intersection = new Set(keys.map((key) => key.kid).filter((kid) => pinned.includes(kid)));
    if (intersection.size === 0) {
      throw typedError("E_KEY_SET_MISMATCH", "served key set no longer intersects with the pinned kids (re-invite required)");
    }

    const publicKeyJwk = keys.find((key) => key.kid === decoded.header.kid);
    if (!publicKeyJwk) {
      throw typedError("E_TOKEN_KID_UNKNOWN", `no served member-auth key with kid "${decoded.header.kid}"`);
    }
    const { payload } = verifyEdDsaJwt(String(token), { publicKeyJwk });
    if (payload.iss !== pinnedIssuer) {
      throw typedError("E_ISSUER_MISMATCH", `token issuer "${payload.iss}" is not the pinned issuer "${pinnedIssuer}"`);
    }
    if (payload.aud !== audience) {
      throw typedError("E_AUDIENCE_MISMATCH", `token audience "${payload.aud}" is not the expected "${audience}"`);
    }
    if (nonce != null && payload.nonce !== nonce) {
      throw typedError("E_NONCE_MISMATCH", "token nonce does not match the expected value");
    }
    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      throw typedError("E_TOKEN_EXPIRED", "member token expired");
    }
    return { did: payload.sub, claims: payload };
  }

  /**
   * Verify a cross-hub migration handoff token against the OUTGOING hub's
   * did-doc-plane key set (`/.well-known/identity-keys.json`), fetched over
   * the injected transport. → { header, payload } claims — the caller must
   * additionally require payload.did / payload.oldIssuer to match its own view
   * (MigrationService does).
   */
  async verifyHandoff(token, { oldIssuer, transport } = {}) {
    if (!oldIssuer) {
      throw typedError("E_HANDOFF_MISMATCH", "the outgoing (old) issuer must be pinned for handoff verification");
    }
    const keySet = await fetchKeySet(`${oldIssuer}/.well-known/identity-keys.json`, transport);
    const keys = Array.isArray(keySet?.keys) ? keySet.keys.filter((key) => key?.kid) : [];

    let decoded;
    try {
      decoded = decodeJwt(String(token));
    } catch {
      throw typedError("E_MALFORMED_TOKEN", "malformed handoff token: undecodable compact JWS");
    }
    const publicKeyJwk = keys.find((key) => key.kid === decoded.header.kid);
    if (!publicKeyJwk) {
      throw typedError("E_OLD_HUB_KEYSET_MISMATCH", `the old hub's did-doc key set has no key for kid "${decoded.header.kid}"`);
    }
    const { header, payload } = verifyEdDsaJwt(String(token), { publicKeyJwk });
    if (payload.typ !== "porchlight-handoff") {
      throw typedError("E_HANDOFF_MISMATCH", "verified token is not a porchlight handoff token");
    }
    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      throw typedError("E_HANDOFF_EXPIRED", "handoff token expired");
    }
    return { header, payload };
  }
}

export default TrustService;