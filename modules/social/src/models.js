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
};

export default socialModels;
