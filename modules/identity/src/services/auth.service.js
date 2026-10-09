import { identityModels } from "../models.js";

/**
 * Identity auth service. Owns the complete route → controller → service →
 * model path for identity. Uses only identity-owned models and never imports
 * social internals (identity shares zero models with social).
 */
export class AuthService {
  constructor() {
    this.models = identityModels;
  }

  createSession({ id, userId }) {
    const session = {
      id: `sess_${id ?? crypto.randomUUID()}`,
      userId,
      token: crypto.randomUUID(),
    };
    return session;
  }

  validate(session) {
    return Boolean(session?.userId && session?.token);
  }
}

export default AuthService;
