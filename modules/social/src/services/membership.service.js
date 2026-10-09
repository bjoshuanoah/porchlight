import { verifyDeviceSignatureRaw, opaqueToken, sha256 } from "../util/crypto.js";
import { socialModels } from "../models.js";

export const ACCESS_TTL_SECONDS = 600;
export const REFRESH_TTL_SECONDS = 45 * 24 * 60 * 60;

const ROLES = ["owner", "delegate", "member"];

function isoPlus(date, seconds) {
  return new Date(date.getTime() + seconds * 1000).toISOString();
}

function typedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/**
 * Membership service. The perimeter of the social domain: membership is the
 * only permission boundary. Admission is invite-keyed ("first login = server
 * URL + invite code", no email signup), issues a membership token scoped to
 * exactly one network, and enrolls the member's device key for write
 * signature verification.
 *
 * Identity interaction is by DID through an injected verifier callback only —
 * social imports no identity source (CI boundary). The verifier resolves the
 * hub-issued member ID token to `{ did }` or null; authorization never rides
 * that token, it only proves the DID behind the device that is presenting the
 * invite.
 */
export class MembershipService {
  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} deps.memberships
   * @param {import("@porchlight/shared").CollectionLike} deps.membershipSessions
   * @param {import("@porchlight/shared").CollectionLike} deps.deviceKeys
   * @param {import("./invite.service.js").InviteService} deps.invites
   * @param {(idToken: string | null) => Promise<{ did: string, sessionId?: unknown } | null>} deps.verifyMemberIdToken
   *   Server-wired identity-plane resolver (identity module session lookup).
   * @param {import("@porchlight/shared").CollectionLike} [deps.networks]
   * @param {(action: string, detail?: object) => Promise<void>} [deps.audit]
   */
  constructor({ memberships, membershipSessions, deviceKeys, invites, verifyMemberIdToken, networks, audit }) {
    this.memberships = memberships;
    this.membershipSessions = membershipSessions;
    this.deviceKeys = deviceKeys;
    this.invites = invites;
    this.verifyMemberIdToken = verifyMemberIdToken ?? (async () => null);
    this.networks = networks ?? null;
    this.audit = audit ?? (async () => {});
    this.models = socialModels;
  }

  /**
   * Public verification seam for the client front door: validates a join
   * code against the live invite lifecycle and returns the network the link
   * points at (plain-language on every failure path).
   */
  async verifyJoinLink(code) {
    return this.invites.verify(code);
  }

  /**
   * Membership admission (ac-2). Given a member presenting a server URL +
   * invite code with an identity-verified DID, admit them to the invited
   * network: create the membership, enroll their device key (possession is
   * proven by the device signature over the invite code), and issue a
   * membership token scoped to that network only.
   *
   * Owner-root rule (PORCH-015): the network owner is proven by the hub
   * account, never by an invite. When the invited network's `ownerDid`
   * matches the admitting identity's DID, the admitted membership's role is
   * forced to "owner" regardless of the invite's role; every other DID
   * takes the invite's normalized role.
   */
  async admit({ code, identityAccessToken, deviceId, devicePublicKeyJwk, signature } = {}) {
    const identity = await this.verifyMemberIdToken(identityAccessToken);
    if (!identity?.did) {
      throw typedError("E_MUST_SIGN_IN", "Sign in to your account with your device first, then use the join link.");
    }
    if (!deviceId || typeof deviceId !== "string") {
      throw typedError("E_DEVICE_REQUIRED", "Your device needs to identify itself to join this network.");
    }
    assertPublicDeviceKey(devicePublicKeyJwk);
    if (typeof signature !== "string" || signature.length === 0) {
      throw typedError("E_SIGNATURE_REQUIRED", "Your device must sign the join request with its key.");
    }
    if (!verifyDeviceSignatureRaw({ publicKeyJwk: devicePublicKeyJwk, message: `porchlight-join:${code}`, signature })) {
      throw typedError("E_SIGNATURE_INVALID", "This join request was not signed by the device that sent it.");
    }

    const inviteRow = await this.invites.redeem(code);
    const networkId = inviteRow.networkId;

    // Owner-root rule: the founder's hub identity owns the network row, so
    // their admission is forced to "owner" — the invite's role never demotes
    // the owner; other DIDs inherit the invite's role as before.
    const networkRow = this.networks ? await this.networks.findOne({ _id: networkId }) : null;
    const isFounder = networkRow !== null && networkRow.ownerDid === identity.did;
    const role = isFounder ? "owner" : normalizeRole(inviteRow.role);

    // One active membership per (did, networkId): a repeat admission with an
    // existing membership is idempotent — the invite redemption guard above
    // already ensures no second use is consumed.
    let membership = await this.activeMembership({ networkId, did: identity.did });
    if (!membership) {
      membership = {
        _id: `mem_${crypto.randomUUID()}`,
        networkId,
        did: identity.did,
        role,
        state: "active",
        admittedViaInviteId: inviteRow._id,
        admittedAt: new Date().toISOString(),
        revokedAt: null,
      };
      await this.memberships.insertOne(membership);
    }

    await this.enrollDevice({ networkId, did: membership.did, deviceId, publicKeyJwk: devicePublicKeyJwk });
    await this.audit("login", { networkId, did: membership.did, detail: { deviceId, inviteId: inviteRow._id } });

    const tokens = await this.issueSession({ membership, deviceId });
    return { membership: this.view(membership), networkId, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, membershipSessionId: tokens._id };
  }

  /** Enroll (or refresh) the per-network device key copy used to verify writes. */
  async enrollDevice({ networkId, did, deviceId, publicKeyJwk }) {
    const existing = await this.deviceKeys.findOne({ networkId, did, deviceId });
    if (existing) {
      await this.deviceKeys.updateOne({ _id: existing._id }, { $set: { publicKeyJwk, enrolledAt: new Date().toISOString() } });
      return { ...existing, publicKeyJwk };
    }
    const row = {
      _id: `dek_${crypto.randomUUID()}`,
      networkId,
      did,
      deviceId,
      publicKeyJwk,
      enrolledAt: new Date().toISOString(),
    };
    await this.deviceKeys.insertOne(row);
    return row;
  }

  /** Issue a membership session: opaque access + refresh, both hashed at rest. */
  async issueSession({ membership, deviceId }) {
    const accessToken = opaqueToken();
    const refreshToken = opaqueToken();
    const now = new Date();
    const session = {
      _id: `mss_${crypto.randomUUID()}`,
      membershipId: membership._id,
      networkId: membership.networkId,
      did: membership.did,
      deviceId: deviceId ?? null,
      accessTokenHash: sha256(accessToken),
      refreshTokenHash: sha256(refreshToken),
      accessExpiresAt: isoPlus(now, ACCESS_TTL_SECONDS),
      refreshExpiresAt: isoPlus(now, REFRESH_TTL_SECONDS),
      status: "active",
      createdAt: now.toISOString(),
    };
    await this.membershipSessions.insertOne(session);
    return { _id: session._id, accessToken, refreshToken };
  }

  /** Rotate the access token off the refresh token (same network scope). */
  async refresh({ refreshToken, now = () => new Date() } = {}) {
    if (typeof refreshToken !== "string" || refreshToken.length === 0) {
      throw typedError("E_SESSION_REQUIRED", "Your session has ended. Sign in again with your invite link or device.");
    }
    const session = await this.membershipSessions.findOne({ refreshTokenHash: sha256(refreshToken) });
    if (!session) {
      throw typedError("E_SESSION_REQUIRED", "Your session has ended. Sign in again with your invite link or device.");
    }
    if (session.status !== "active" || new Date(session.refreshExpiresAt).getTime() <= now().getTime()) {
      throw typedError("E_SESSION_REQUIRED", "Your session has ended. Sign in again with your invite link or device.");
    }
    const membership = await this.memberships.findOne({ _id: session.membershipId });
    if (!membership || membership.state !== "active") {
      throw typedError("E_SESSION_REQUIRED", "Your membership is no longer active. Ask the network owner about access.");
    }
    const accessToken = opaqueToken();
    await this.membershipSessions.updateOne(
      { _id: session._id },
      { $set: { accessTokenHash: sha256(accessToken), accessExpiresAt: isoPlus(now(), ACCESS_TTL_SECONDS) } },
    );
    return { accessToken, networkId: session.networkId, did: session.did };
  }

  /**
   * Membership-token verification. Opaque bearer token stored as a hash;
   * only an active session on an active membership inside its access window
   * resolves, and ALWAYS within exactly the network it was admitted to —
   * there is no membership token that spans networks.
   */
  async verifyAccessToken(accessToken, { networkId, now = () => new Date() } = {}) {
    if (!accessToken) return null;
    const session = await this.membershipSessions.findOne({ accessTokenHash: sha256(accessToken) });
    if (!session || session.status !== "active") return null;
    if (new Date(session.accessExpiresAt).getTime() <= now().getTime()) return null;
    const membership = await this.memberships.findOne({ _id: session.membershipId });
    if (!membership || membership.state !== "active") return null;
    if (networkId !== undefined && networkId !== null && session.networkId !== networkId) return null;
    return { membership, session: { _id: session._id, deviceId: session.deviceId, did: session.did } };
  }

  /** Active membership row for a (networkId, did), or null. */
  async activeMembership({ networkId, did }) {
    const membership = await this.memberships.findOne({ networkId, did });
    return membership && membership.state === "active" ? membership : null;
  }

  /**
   * Re-establish membership sessions on a re-opened or re-bound device
   * (PORCH-010 device-link/pair landing): the identity plane proves the DID
   * through the same injected verifier admission uses; the session rides
   * ONLY live membership rows — it never creates membership and never
   * widens the perimeter. Every network the member belongs to gets its own
   * network-scoped token, exactly as admission would have issued.
   */
  async restoreSession({ identityAccessToken, deviceId = null } = {}) {
    const identity = await this.verifyMemberIdToken(identityAccessToken);
    if (!identity?.did) {
      throw typedError("E_MUST_SIGN_IN", "Open your identity on this device first, then continue.");
    }
    const rows = (await this.memberships.find({ did: identity.did })).filter(row => row.state === "active");
    if (!rows.length) {
      throw typedError("E_NOT_A_MEMBER", "You are not currently a member of a network on this hub.");
    }
    const sessions = [];
    for (const membership of rows) {
      const tokens = await this.issueSession({ membership, deviceId });
      sessions.push({ networkId: membership.networkId, role: membership.role, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
    }
    return { did: identity.did, sessions };
  }

  /** Owner console list of the network's members. */
  async listMembers({ networkId } = {}) {
    return this.memberships.find(networkId ? { networkId: String(networkId) } : {});
  }

  /**
   * Instant member revocation (owner console): the membership goes inactive
   * and every open membership session for it dies in the same write — the
   * perimeter closes the moment the owner acts.
   */
  async revokeMember({ networkId, did, memberId } = {}) {
    const membership = memberId
      ? await this.memberships.findOne({ _id: memberId })
      : await this.activeMembership({ networkId, did });
    if (!membership) {
      throw typedError("E_MEMBER_NOT_FOUND", "No such member on this network.");
    }
    if (membership.state !== "active") {
      return { revoked: false, membership: this.view(membership) };
    }
    const revokedAt = new Date().toISOString();
    await this.memberships.updateOne({ _id: membership._id }, { $set: { state: "revoked", revokedAt } });
    const open = await this.membershipSessions.find({ membershipId: membership._id, status: "active" });
    for (const session of open) {
      await this.membershipSessions.updateOne({ _id: session._id }, { $set: { status: "revoked" } });
    }
    await this.audit("membership_revoke", { networkId: membership.networkId, did: membership.did, detail: { memberId: membership._id } });
    return { revoked: true, membership: this.view({ ...membership, state: "revoked", revokedAt }) };
  }

  /**
   * Write-verification primitive for the origin (ac-2 tail: "the member then
   * signs all writes against that origin with their device key"). Verifies a
   * member's Ed25519 signature over a JSON payload with the enrolled device
   * key, for an active membership on the exact origin network. Typed errors
   * for every failure (caller maps to member-facing text).
   */
  async verifyMemberWrite({ networkId, did, deviceId, payload, signature, now = () => new Date() } = {}) {
    if (typeof deviceId !== "string" || !deviceId) {
      throw typedError("E_DEVICE_REQUIRED", "Your device needs to identify itself for this action.");
    }
    const membership = await this.activeMembership({ networkId, did });
    if (!membership) {
      throw typedError("E_NOT_A_MEMBER", "You are not a member of this network.");
    }
    const deviceKey = await this.deviceKeys.findOne({ networkId, did, deviceId });
    if (!deviceKey) {
      throw typedError("E_DEVICE_NOT_ENROLLED", "This device is not enrolled with your membership. Sign in again with your invite link.");
    }
    if (typeof signature !== "string" || signature.length === 0) {
      throw typedError("E_SIGNATURE_REQUIRED", "This write must be signed by your device key.");
    }
    if (!verifyDeviceSignatureRaw({ publicKeyJwk: deviceKey.publicKeyJwk, message: canonicalJson(payload), signature })) {
      throw typedError("E_SIGNATURE_INVALID", "This write's device signature does not verify.");
    }
    void now;
    return { membership, verified: true };
  }

  /** Public member view: internal hashes/session ids never surface. */
  view(membership) {
    if (!membership) return null;
    return {
      _id: membership._id,
      networkId: membership.networkId,
      did: membership.did,
      role: membership.role,
      state: membership.state,
      admittedAt: membership.admittedAt,
      revokedAt: membership.revokedAt,
    };
  }
}

function normalizeRole(role) {
  return ROLES.includes(role) ? role : "member";
}

/** JWK custody invariant: OKP Ed25519 public key only — rejects private material. */
function assertPublicDeviceKey(publicKeyJwk) {
  if (!publicKeyJwk || typeof publicKeyJwk !== "object") {
    throw typedError("E_KEY_REQUIRED", "Your device key is required to join this network.");
  }
  if (typeof publicKeyJwk.d === "string" && publicKeyJwk.d.length > 0) {
    throw typedError("E_PRIVATE_KEY_REJECTED", "Private key material was sent instead of the device's public key.");
  }
  if (publicKeyJwk.kty !== "OKP" || publicKeyJwk.crv !== "Ed25519") {
    throw typedError("E_KEY_TYPE_REJECTED", "Only Ed25519 device keys are supported.");
  }
  if (typeof publicKeyJwk.x !== "string" || publicKeyJwk.x.length === 0) {
    throw typedError("E_KEY_TYPE_REJECTED", "Only Ed25519 device keys are supported.");
  }
}

export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

export default MembershipService;