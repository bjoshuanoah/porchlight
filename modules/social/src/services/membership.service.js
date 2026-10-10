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
 * invite. A second injected callback (`memberNames`, PORCH-029) resolves
 * member DIDs to family-facing display names for the owner's member
 * directory — display fields only, still no identity source.
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
   * @param {(did: string, deviceId: string) => Promise<{ publicKeyJwk: object } | null> | null} [deps.registeredDeviceKey]
   *   Server-wired identity-plane device-registration resolver (active
   *   registration row for (did, deviceId)) — the session-key copy source
   *   for founder device enrollment. Resolves nothing identity-side here:
   *   possession was already proven when the identity session opened.
   * @param {((event: Record<string, unknown>) => void) | null} [deps.authFailureSink]
   *   PORCH-019 auth-failure capture: invoked when a member surface's
   *   membership token fails verification (failing step + session/device/
   *   membership identity state; never token material).
   * @param {((dids: string[]) => Promise<Array<{did: string, displayName: string | null}>>) | null} [deps.memberNames]
   *   Server-wired identity-plane name resolver for the owner's member
   *   directory (PORCH-029): DIDs in, family-facing display fields out.
   *   Null on assemblies that don't wire it — the directory renders without
   *   names rather than failing.
   * @param {(event: { membershipId: string, networkId: string, did: string, sessionIds: string[] }) => void} [deps.onRevoked]
   *   PORCH-047: invoked the moment a member's sessions die at revocation —
   *   the real-time surface closes the member's live subscriptions in the
   *   same instant (revocation is active, not "at next request").
   */
  constructor({ memberships, membershipSessions, deviceKeys, invites, verifyMemberIdToken, networks, audit, registeredDeviceKey, authFailureSink, memberNames, onRevoked }) {
    this.memberships = memberships;
    this.membershipSessions = membershipSessions;
    this.deviceKeys = deviceKeys;
    this.invites = invites;
    this.verifyMemberIdToken = verifyMemberIdToken ?? (async () => null);
    this.networks = networks ?? null;
    this.registeredDeviceKey = registeredDeviceKey ?? null;
    this.memberNames = memberNames ?? null;
    this.onRevoked = onRevoked ?? null;
    this.authFailureSink = authFailureSink ?? null;
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
    // PORCH-034 follow-up: a re-joining device learns the member's
    // family-facing name at admission, so the device never falls back to
    // presenting the device label as the person.
    const resolved = this.memberNames ? await this.memberNames([membership.did]) : [];
    const name = (resolved ?? []).find((row) => row.did === membership.did)?.displayName ?? null;
    return { membership: this.view(membership), networkId, name, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, membershipSessionId: tokens._id };
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
   * Resolve WHY a refresh token failed (PORCH-019 ac-1): the failing step in
   * the renewal path, for the capture the session surfaces log. A refresh
   * token that would rotate resolves null (nothing to diagnose).
   * Reasons: missing_token | unknown_token | session_<status> |
   * expired_refresh_token.
   */
  async diagnoseRefreshToken(refreshToken, now = () => new Date()) {
    if (typeof refreshToken !== "string" || refreshToken.length === 0) return { reason: "missing_token" };
    const session = await this.membershipSessions.findOne({ refreshTokenHash: sha256(refreshToken) });
    if (!session) return { reason: "unknown_token" };
    const state = {
      did: session.did,
      deviceId: session.deviceId,
      sessionId: session._id,
      sessionStatus: session.status,
      networkId: session.networkId,
      refreshExpiresAt: session.refreshExpiresAt,
    };
    if (session.status !== "active") return { reason: `session_${session.status}`, ...state };
    if (new Date(session.refreshExpiresAt).getTime() <= now().getTime()) {
      return { reason: "expired_refresh_token", ...state };
    }
    const membership = await this.memberships.findOne({ _id: session.membershipId });
    if (!membership) return { reason: "membership_missing", ...state };
    if (membership.state !== "active") {
      return { reason: `membership_${membership.state}`, ...state, membershipState: membership.state };
    }
    return null;
  }

  /**
   * Membership-token verification. Opaque bearer token stored as a hash;
   * only an active session on an active membership inside its access window
   * resolves, and ALWAYS within exactly the network it was admitted to —
   * there is no membership token that spans networks.
   *
   * PORCH-019: caller surfaces pass `surface` (their domain surface name) —
   * a token that fails here is captured via the auth-failure sink with the
   * failing step and the session/device/membership identity state (never
   * token material), so member read/write 401s land in the hub log too.
   */
  async verifyAccessToken(accessToken, { networkId, now = () => new Date(), surface = null } = {}) {
    const resolution = await this.resolveAccessToken(accessToken, { networkId, now });
    if (resolution.perimeter) return resolution.perimeter;
    if (surface) {
      this.authFailureSink?.({ endpoint: surface, code: "E_SESSION_REQUIRED", ...resolution.diagnosis });
    }
    return null;
  }

  /**
   * Resolve WHY a membership access token failed (PORCH-019 ac-1): the
   * failing step on the membership plane, for the auth-failure capture. A
   * token that verifies resolves null (nothing to diagnose). Reasons:
   * missing_token | unknown_token | session_<status> | expired_access_token |
   * membership_missing | membership_<state> | network_mismatch.
   */
  diagnoseAccessToken(accessToken, { networkId, now = () => new Date() } = {}) {
    return this.resolveAccessToken(accessToken, { networkId, now }).then(
      (resolution) => resolution.diagnosis ?? null,
    );
  }

  /**
   * One pass over the membership session plane: the verified perimeter, or
   * the failing-step diagnosis. Never token material.
   * @private
   */
  async #resolve(accessToken, { networkId, now }) {
    if (!accessToken) return { diagnosis: { reason: "missing_token" } };
    const session = await this.membershipSessions.findOne({ accessTokenHash: sha256(accessToken) });
    const state = session ? {
      did: session.did,
      deviceId: session.deviceId,
      sessionId: session._id,
      sessionStatus: session.status,
      accessExpiresAt: session.accessExpiresAt,
      networkId: session.networkId,
    } : {};
    if (!session) return { diagnosis: { reason: "unknown_token" } };
    if (session.status !== "active") return { diagnosis: { reason: `session_${session.status}`, ...state } };
    if (new Date(session.accessExpiresAt).getTime() <= now().getTime()) {
      return { diagnosis: { reason: "expired_access_token", ...state } };
    }
    const membership = await this.memberships.findOne({ _id: session.membershipId });
    if (!membership) return { diagnosis: { reason: "membership_missing", ...state } };
    if (membership.state !== "active") {
      return { diagnosis: { reason: `membership_${membership.state}`, ...state, membershipId: membership._id, membershipState: membership.state } };
    }
    if (networkId !== undefined && networkId !== null && session.networkId !== networkId) {
      return { diagnosis: { reason: "network_mismatch", ...state, membershipId: membership._id, membershipState: membership.state } };
    }
    return { perimeter: { membership, session: { _id: session._id, deviceId: session.deviceId, did: session.did } } };
  }

  resolveAccessToken(accessToken, options = {}) {
    return this.#resolve(accessToken, { now: () => new Date(), ...options });
  }

  /** Active membership row for a (networkId, did), or null. */
  async activeMembership({ networkId, did }) {
    const membership = await this.memberships.findOne({ networkId, did });
    return membership && membership.state === "active" ? membership : null;
  }

  /**
   * Founder-root binding (PORCH-018). The hub account proves ownership,
   * never an invite: when `did` IS the network row's recorded `ownerDid`,
   * the owner holds an active owner-role membership on the network they
   * created — no invite consumed, no manual bind step. Idempotent: an
   * already-bound founder returns their existing active membership; a
   * non-founders DID or a network without a recorded ownerDid binds
   * nothing (null). Memberships stay invited-only everywhere else; this is
   * the one direct admission path keyed on the hub account, matching the
   * founder rule admission already forces (role "owner" for the ownerDid).
   *
   * @returns the membership VIEW, or null when nothing was bound.
   */
  async bindFounder({ network, did } = {}) {
    if (!network || !did || network.ownerDid !== did) return null;
    // A revoked founder binding stays closed: the network-side revocation
    // kill switch is authoritative regardless of the founder identity, so
    // only a DID with no membership row at all can first-bind here.
    const existing = await this.memberships.findOne({ networkId: network._id, did });
    if (existing) return existing.state === "active" ? this.view(existing) : null;
    const membership = {
      _id: `mem_${crypto.randomUUID()}`,
      networkId: network._id,
      did,
      role: "owner",
      state: "active",
      admittedViaInviteId: null,
      admittedAt: new Date().toISOString(),
      revokedAt: null,
    };
    await this.memberships.insertOne(membership);
    await this.audit("founder_bind", { networkId: network._id, did, detail: {} });
    return this.view(membership);
  }

  /**
   * (PORCH-010 device-link/pair landing): the identity plane proves the DID
   * through the same injected verifier admission uses; the session rides
   * ONLY live membership rows — it never widens the perimeter, with one
   * founder-root exception (PORCH-018): when the presenting DID is the
   * network row's recorded ownerDid, a missing owner binding is created
   * here — the hub account is the proof, never an invite.
   * This is also the repair path for hubs bootstrapped before the binding
   * existed: the owner's next silent re-credential binds them.
   *
   * PORCH-048: EVERY re-bound device re-credentials its write-verification
   * enrollment — admit and the founder path are no longer the only
   * enrollment points. The presenting device's ACTIVE identity-plane
   * registration for (did, deviceId) is the copy source for each live
   * membership's per-network device_keys row (possession proven when the
   * identity session opened, re-proven at every write via the same
   * verifyMemberWrite contract). Origin containment: each enrollment rides
   * exactly the live membership row's own networkId — no enrollment is
   * created beyond memberships the DID holds here. A revoked registration
   * resolves nothing (the resolver returns active rows only), so a
   * re-credential can never resurrect dead keys.
   */
  async restoreSession({ identityAccessToken, deviceId = null } = {}) {
    const identity = await this.verifyMemberIdToken(identityAccessToken);
    if (!identity?.did) {
      throw typedError("E_MUST_SIGN_IN", "Open your identity on this device first, then continue.");
    }
    // One (did, deviceId) registration lookup for the whole re-credential:
    // the device binding is an identity-plane fact, never a per-network one.
    const registration = deviceId && this.registeredDeviceKey
      ? await this.registeredDeviceKey(identity.did, deviceId)
      : null;
    if (this.networks) {
      const network = await this.networks.findOne({});
      if (network && network.ownerDid === identity.did && registration?.publicKeyJwk) {
        await this.enrollDevice({ networkId: network._id, did: identity.did, deviceId, publicKeyJwk: registration.publicKeyJwk });
      }
      await this.bindFounder({ network, did: identity.did });
    }
    const rows = (await this.memberships.find({ did: identity.did })).filter(row => row.state === "active");
    if (!rows.length) {
      throw typedError("E_NOT_A_MEMBER", "You are not currently a member of a network on this hub.");
    }
    const members = [...new Set(rows.map((row) => row.did))];
    // The member's own name on their own re-credential rides the identity
    // plane directly (these rows are already live membership gates); the
    // per-origin containment discipline applies to content attribution,
    // not to the authenticated member's self name.
    const resolved = this.memberNames ? await this.memberNames(members) : [];
    const byDid = new Map((resolved ?? []).map((row) => [row.did, row.displayName ?? null]));
    const sessions = [];
    for (const membership of rows) {
      // PORCH-048: the per-network enrollment rides the live membership —
      // this is the restore for every member device (device-link or pairing
      // re-bind), not only the founder's.
      if (registration?.publicKeyJwk) {
        await this.enrollDevice({ networkId: membership.networkId, did: identity.did, deviceId, publicKeyJwk: registration.publicKeyJwk });
      }
      const tokens = await this.issueSession({ membership, deviceId });
      // PORCH-034 follow-up: every re-credential returns the member's
      // family-facing name, so a re-bound device stores the person — never
      // the device label — as the identity's presentation name.
      sessions.push({ networkId: membership.networkId, role: membership.role, name: byDid.get(membership.did) ?? null, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
    }
    return { did: identity.did, sessions };
  }

  /** Owner console list of the network's members. */
  async listMembers({ networkId } = {}) {
    return this.memberships.find(networkId ? { networkId: String(networkId) } : {});
  }

  /**
   * The owner's member directory (PORCH-029): membership rows joined with
   * the family-facing member name resolved through the injected identity
   * boundary callback. Members the hub has no identity row for render
   * without a name (plain fallback at the client); the join state (role,
   * active/revoked, dates) comes straight from the membership row.
   */
  async listMemberViews({ networkId } = {}) {
    const rows = await this.listMembers({ networkId });
    const names = this.memberNames
      ? await this.memberNames([...new Set(rows.map((row) => row.did).filter(Boolean))])
      : [];
    const byDid = new Map((names ?? []).map((row) => [row.did, row.displayName]));
    return rows.map((row) => ({ ...this.view(row), name: byDid.get(row.did) ?? null }));
  }

  /**
   * Attribution names (PORCH-034): the family-facing member names for the
   * authored-content views, resolved at READ time against THIS origin
   * network's active membership only — a DID holding no active membership
   * here resolves to no name (names render for network members only), and
   * nothing is frozen on the post or comment document. Rides the same
   * injected identity boundary callback as the owner directory; null on
   * assemblies that don't wire it, rendering the plain nameless fallback.
   *
   * @param {object} deps
   * @param {string} deps.networkId
   * @param {string[]} [deps.dids]
   * @returns {Promise<Map<string, string | null>>} attribution per requested DID (members only)
   */
  async attributionNames({ networkId, dids = [] } = {}) {
    const wanted = [...new Set((dids ?? []).filter(Boolean).map(String))];
    if (!wanted.length) return new Map();
    const rows = await this.memberships.find({ networkId: String(networkId) });
    const roster = new Set(rows.filter((row) => row.state === "active" && row.did).map((row) => String(row.did)));
    const members = wanted.filter((did) => roster.has(did));
    if (!members.length) return new Map();
    const resolved = this.memberNames ? await this.memberNames(members) : [];
    const byDid = new Map((resolved ?? []).map((row) => [row.did, row.displayName]));
    return new Map(members.map((did) => [did, byDid.get(did) ?? null]));
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
    const sessionIds = [];
    for (const session of open) {
      await this.membershipSessions.updateOne({ _id: session._id }, { $set: { status: "revoked" } });
      sessionIds.push(session._id);
    }
    // PORCH-047: the real-time surface learns the revocation in the same
    // write — live subscriptions close now, not at the member's next request.
    this.onRevoked?.({ membershipId: membership._id, networkId: membership.networkId, did: membership.did, sessionIds });
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