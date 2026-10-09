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
   * per the content model; created by the owner during bootstrap.
   */
  network: {
    type: "object",
    required: ["_id", "name", "ownerAccountId"],
    properties: {
      _id: { type: "string" },
      name: { type: "string" },
      ownerAccountId: { type: "string" },
      createdAt: { type: "string" },
    },
  },
  /**
   * Join-link invite (quantity-only rule: lifecycle state is owner-visible
   * and instantly revocable). Owned exclusively by social.
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
      createdAt: { type: "string" },
      revokedAt: { type: ["string", "null"] },
    },
  },
};

export default socialModels;
