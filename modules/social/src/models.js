/**
 * Social-owned models. These types are owned by the social domain only.
 * identity MUST NOT import this file; identity and social share zero models.
 */
export const socialModels = {
  post: {
    type: "object",
    required: ["id", "userId", "body"],
    properties: {
      id: { type: "string" },
      userId: { type: "string" },
      body: { type: "string" },
    },
  },
  /**
   * Network document (PORCH-003 bootstrap). One origin network per content
   * per the content model; created by the owner during bootstrap. Quota
   * limits are owner-set per network (quantity-only limits rule): null =
   * unset and reported, never silently defaulted.
   */
  network: {
    type: "object",
    required: ["_id", "name", "ownerAccountId"],
    properties: {
      _id: { type: "string" },
      name: { type: "string" },
      ownerAccountId: { type: "string" },
      createdAt: { type: "string" },
      quota: {
        type: "object",
        properties: {
          storageCeilingMb: { type: ["integer", "null"] },
          retentionDays: { type: ["integer", "null"] },
        },
      },
    },
  },
  /**
   * Join-link invite (quantity-only rule: lifecycle state is owner-visible
   * and instantly revocable). Owned exclusively by social. Owner-visible
   * status is derived at read: state "revoked" → revoked; useCount < maxUses
   * → unused; otherwise used. The code rides the join URL the invite
   * service hands back (URL + embedded code).
   */
  invite: {
    type: "object",
    required: ["_id", "token", "networkId", "state"],
    properties: {
      _id: { type: "string" },
      token: { type: "string" },
      networkId: { type: "string" },
      role: { type: "string" },
      maxUses: { type: "integer" },
      useCount: { type: "integer" },
      state: { type: "string", enum: ["active", "revoked"] },
      hubUrl: { type: ["string", "null"] },
      createdAt: { type: "string" },
      revokedAt: { type: ["string", "null"] },
    },
  },
  /**
   * Membership record (PORCH-005). The perimeter itself: access to a
   * network's content comes from holding an approved membership here. One
   * active membership per (did, networkId); roles are owner/delegate/member.
   */
  membership: {
    type: "object",
    required: ["_id", "networkId", "did", "role", "state"],
    properties: {
      _id: { type: "string" },
      networkId: { type: "string" },
      did: { type: "string" },
      role: { type: "string", enum: ["owner", "delegate", "member"] },
      state: { type: "string", enum: ["active", "revoked"] },
      admittedViaInviteId: { type: ["string", "null"] },
      admittedAt: { type: "string" },
      revokedAt: { type: ["string", "null"] },
    },
  },
  /**
   * Membership session (PORCH-005): the admission-issued session whose
   * access token is the membership token scoped to exactly one network.
   * Tokens are stored sha256-hashed only; plaintext is handed back once.
   */
  membershipSession: {
    type: "object",
    required: ["_id", "membershipId", "networkId", "did", "status", "accessExpiresAt"],
    properties: {
      _id: { type: "string" },
      membershipId: { type: "string" },
      networkId: { type: "string" },
      did: { type: "string" },
      accessTokenHash: { type: "string" },
      refreshTokenHash: { type: "string" },
      accessExpiresAt: { type: "string" },
      refreshExpiresAt: { type: "string" },
      status: { type: "string", enum: ["active", "revoked"] },
      createdAt: { type: "string" },
    },
  },
  /**
   * Device key enrollment (PORCH-005). Social keeps its own per-network copy
   * of the member device's Ed25519 PUBLIC key, enrolled at admission where
   * possession is proven by signature. Every social-domain write is verified
   * against this enrollment; private key material never travels to the hub.
   */
  deviceKey: {
    type: "object",
    required: ["_id", "networkId", "did", "deviceId", "publicKeyJwk"],
    properties: {
      _id: { type: "string" },
      networkId: { type: "string" },
      did: { type: "string" },
      deviceId: { type: "string" },
      publicKeyJwk: { type: "object" },
      enrolledAt: { type: "string" },
    },
  },
  /**
   * Quota artifact ledger (PORCH-005, day-one quota primitive). Storage
   * usage per network is the sum of original + rendition artifact rows;
   * retention windows expire rows so the retention sweep can remove them.
   * Content/media modules record artifacts through the quota service.
   */
  artifact: {
    type: "object",
    required: ["_id", "networkId", "kind", "bytes", "createdAt"],
    properties: {
      _id: { type: "string" },
      networkId: { type: "string" },
      kind: { type: "string", enum: ["original", "rendition"] },
      bytes: { type: "integer" },
      sourceId: { type: "string" },
      createdAt: { type: "string" },
      expiresAt: { type: ["string", "null"] },
    },
  },
  /**
   * Member action audit (PORCH-005 ac-4). Member actions are auditable
   * events visible in the owner console: logins (admissions), uploads
   * (artifact records), deletions (retention sweep), revocations.
   */
  auditEvent: {
    type: "object",
    required: ["_id", "networkId", "action", "createdAt"],
    properties: {
      _id: { type: "string" },
      networkId: { type: "string" },
      did: { type: ["string", "null"] },
      action: { type: "string" },
      detail: { type: "object" },
      createdAt: { type: "string" },
    },
  },
};

export default socialModels;
