import { AuthService } from "../services/auth.service.js";

/**
 * Identity auth controller. Transport-specific: translates between HTTP and
 * the domain. Business logic and models stay in the service layer; this
 * controller only maps service outcomes to responses.
 */
export class AuthController {
  /**
   * @param {AuthService} [service]
   */
  constructor(service = new AuthService()) {
    this.service = service;
  }

  /**
   * POST /session — creates a session for the caller's userId.
   */
  createSession = (req, res) => {
    const { id, userId } = req.body ?? {};
    if (!userId) {
      return res.status(400).json({ error: "userId required" });
    }
    const session = this.service.createSession({ id, userId });
    res.status(201).json(session);
  };
}

export default AuthController;