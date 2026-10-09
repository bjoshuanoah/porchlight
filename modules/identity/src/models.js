/**
 * Identity-owned models. Identity shares zero models with social: social
 * references identity by identifier (the DID) only and MUST NOT import this
 * file. Every identity in the system — human or agent — carries a DID minted
 * at identity birth, never reissued.
 */

/**
 * identities — the account record (owned by the user, hosted by one hub at a
 * time). The hub hosts the bytes; the account is the identity record the DID
 * points at, never the identity itself.
 */
export const identityModel = {
  type: "object",
  required: ["_id", "did", "actorType", "displayName"],
  properties: {
    _id: { type: "string" },
    /** Canonical identifier: `did:porch:<opaque>`, minted at birth, never reissued. */
    did: { type: "string" },
    /** First-class actors: humans and agents share the same account records. */
    actorType: { type: "string", enum: ["human", "agent"] },
    displayName: { type: "string" },
    email: { type: ["string", "null"] },
    /** Presentation-plane handle: changeable, resolves to the DID. No global registry. */
    handle: { type: ["string", "null"] },
    profile: { type: "object" },
    /** Exactly one home: "home" while hosted here, "moved" after migration. */
    homingStatus: { type: "string", enum: ["home", "moved"] },
    /** Issuer of the new home after a migration handoff (null otherwise). */
    migratedToIssuer: { type: ["string", "null"] },
    createdAt: { type: "string" },
  },
};

/**
 * did_documents — the homing pointer: the standards-form service-discovery
 * record (W3C DID Core shape) served by the hub that currently hosts the
 * identity. Service entries re-point on migration; the DID never changes.
 */
export const didDocumentModel = {
  type: "object",
  required: ["did", "document"],
  properties: {
    did: { type: "string" },
    document: { type: "object" },
    updatedAt: { type: "string" },
  },
};

/**
 * device_registrations — per identity, never per physical device: a device
 * serving several identities holds one registration per identity, each with
 * its own public key. The hub stores and verifies public keys only; private
 * keys are device-bound and never transported. Retired (revoked) rows remain
 * visible in the owner's member view.
 */
export const deviceRegistrationModel = {
  type: "object",
  required: ["_id", "did", "deviceId", "publicKeyJwk", "status"],
  properties: {
    _id: { type: "string" },
    did: { type: "string" },
    deviceId: { type: "string" },
    label: { type: ["string", "null"] },
    /** Public half only (OKP JWK); the private key never leaves the device/host. */
    publicKeyJwk: { type: "object" },
    /** createdBy: first-account | pairing | device-link */
    createdBy: { type: ["string", "null"] },
    status: { type: "string", enum: ["active", "revoked"] },
    revokedAt: { type: ["string", "null"] },
    createdAt: { type: "string" },
  },
};

/**
 * challenges — one-time auth challenges: the device signs the nonce with its
 * device-held key; the hub verifies and issues session tokens.
 */
export const challengeModel = {
  type: "object",
  required: ["_id", "did", "nonce", "expiresAt", "consumed"],
  properties: {
    _id: { type: "string" },
    did: { type: "string" },
    nonce: { type: "string" },
    expiresAt: { type: "string" },
    consumed: { type: "boolean" },
    createdAt: { type: "string" },
  },
};

/**
 * sessions — per identity per device; issuing for the same (did, deviceId)
 * supersedes the prior session (fresh registration supersedes a stuck one).
 * Access tokens carry ~10 minutes (the standing OIDC assumption), refresh
 * rides longer-lived tokens. Token values are stored as SHA-256 hashes.
 */
export const sessionModel = {
  type: "object",
  required: ["_id", "did", "deviceId", "accessTokenHash", "status"],
  properties: {
    _id: { type: "string" },
    did: { type: "string" },
    deviceId: { type: "string" },
    accessTokenHash: { type: "string" },
    refreshTokenHash: { type: "string" },
    accessExpiresAt: { type: "string" },
    refreshExpiresAt: { type: "string" },
    /** active | superseded | revoked (revocation wipes the whole identity's sessions) */
    status: { type: "string", enum: ["active", "superseded", "revoked"] },
    createdAt: { type: "string" },
  },
};

/** pairing_codes — short-lived, one-time add-device codes from a working device. */
export const pairingCodeModel = {
  type: "object",
  required: ["_id", "did", "code", "expiresAt", "consumed"],
  properties: {
    _id: { type: "string" },
    did: { type: "string" },
    code: { type: "string" },
    expiresAt: { type: "string" },
    consumed: { type: "boolean" },
    createdAt: { type: "string" },
  },
};

/**
 * device_links — owner-routed continuity when no working device exists: the
 * link targets the member's existing DID, never mints a new identity.
 */
export const deviceLinkModel = {
  type: "object",
  required: ["_id", "did", "token", "expiresAt", "consumed"],
  properties: {
    _id: { type: "string" },
    did: { type: "string" },
    token: { type: "string" },
    expiresAt: { type: "string" },
    consumed: { type: "boolean" },
    createdAt: { type: "string" },
  },
};

/**
 * issuer_keys — the hub-adjacent operator keystore. Two key planes, never
 * conflated: the "member-auth" plane signs member-verification ID tokens
 * (published via JWKS, kid-based rotation); the "did-doc" plane signs
 * infrastructure attestations only — the DID document and migration handoff
 * tokens — and is never exposed on any member surface.
 */
export const issuerKeyModel = {
  type: "object",
  required: ["kid", "plane", "publicKeyJwk", "privateKeyJwk", "status"],
  properties: {
    kid: { type: "string" },
    /** member-auth | did-doc */
    plane: { type: "string", enum: ["member-auth", "did-doc"] },
    algorithm: { type: "string", enum: ["Ed25519"] },
    publicKeyJwk: { type: "object" },
    privateKeyJwk: { type: "object" },
    /** active (signing) | published (rotated out, still served) | retired (pruned) */
    status: { type: "string", enum: ["active", "published", "retired"] },
    createdAt: { type: "string" },
  },
};

/**
 * auth_codes — the short-lived one-time authorization codes of the OIDC
 * code path (nonce + PKCE S256 bound). Carries no membership data: tokens
 * assert identity only ("this is Susan"), never "Susan may".
 */
export const authCodeModel = {
  type: "object",
  required: ["_id", "did", "clientId", "codeHash", "codeChallenge", "codeChallengeMethod", "nonce", "expiresAt", "consumed"],
  properties: {
    _id: { type: "string" },
    did: { type: "string" },
    /** The receiving network this code is bound to (id_token audience). */
    clientId: { type: "string" },
    codeHash: { type: "string" },
    codeChallenge: { type: "string" },
    codeChallengeMethod: { type: "string", enum: ["S256"] },
    nonce: { type: "string" },
    expiresAt: { type: "string" },
    consumed: { type: "boolean" },
    createdAt: { type: "string" },
  },
};

const identityModels = {
  identityModel,
  didDocumentModel,
  deviceRegistrationModel,
  challengeModel,
  sessionModel,
  pairingCodeModel,
  deviceLinkModel,
  issuerKeyModel,
  authCodeModel,
};

export default identityModels;