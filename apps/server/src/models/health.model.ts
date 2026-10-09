export const healthModel = {
  health: {
    type: "object",
    required: ["status", "service"],
    properties: {
      status: { type: "string" },
      service: { type: "string" },
    },
  },
};

export default healthModel;