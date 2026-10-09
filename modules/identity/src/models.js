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
};

export default identityModels;
