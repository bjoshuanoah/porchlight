/**
 * Identity-owned models. These types are owned by the identity domain only.
 * social MUST NOT import this file; identity and social share zero models.
 */
export const identityModels = {
  user: {
    type: "object",
    required: ["id", "email", "passwordHash"],
    properties: {
      id: { type: "string" },
      email: { type: "string" },
      passwordHash: { type: "string" },
    },
  },
  session: {
    type: "object",
    required: ["id", "userId", "token"],
    properties: {
      id: { type: "string" },
      userId: { type: "string" },
      token: { type: "string" },
    },
  },
  /**
   * Hub account document (PORCH-003 bootstrap). The owner's first account is
   * created at first run, or holds the adopted identity when the owner
   * already has an identity on another hub. Owned exclusively by identity.
   */
  account: {
    type: "object",
    required: ["_id", "displayName", "kind"],
    properties: {
      _id: { type: "string" },
      displayName: { type: "string" },
      email: { type: ["string", "null"] },
      /** owner = created here at bootstrap; adopted = imported from another hub. */
      kind: { type: "string", enum: ["owner", "adopted"] },
      adoptedIdentity: {
        type: "object",
        required: ["sourceHubUrl", "externalId"],
        properties: { sourceHubUrl: { type: "string" }, externalId: { type: "string" } },
      },
      createdAt: { type: "string" },
    },
  },
};

export default identityModels;
