
/**
 * Identity auth controller: transport only. The controller maps HTTP to the
 * AuthService (challenge-signature → session tokens); every domain decision
 * lives in the service layer.
 */
export class AuthController {
  /**
   * @param {import("authService").AuthService} authService
   * @param {DidService|null} [didService] — presentation-plane handle resolution.
   */
  constructor(authService, didService = null) {
    this.authService = authService;
    this.didService = didService;
  }

  /** Resolve the Bearer access token to its session identity, or null. */
  async bearerIdentity(token) {
    if (!token) return null;
    try {
      const value = token.startsWith("Bearer ") ? token.slice(7).trim() : token;
      return await this.authService.verifyAccessToken(value);
    } catch {
      return null;
    }
  }

  /** POST /session/challenge {did|handle} — one-time challenge for that identity. */
  createChallenge = async (req, res) => {
    const body = req.body ?? {};
    if (!body.did && !body.handle) {
      return res.status(400).json({ error: "did or handle required", code: "E_FIELDS_REQUIRED" });
    }
    try {
      let did = body.did;
      if (!did && this.didService) {
        // The handle is a changeable presentation layer: resolve it, then the
        // challenge rides the canonical DID it points to.
        const identity = await this.didService.resolveHandle(String(body.handle));
        if (!identity) return res.status(404).json({ error: "identity not found on this hub", code: "E_IDENTITY_NOT_FOUND" });
        did = identity.did;
      }
      const challenge = await this.authService.createChallenge({ did });
      res.json(challenge);
    } catch (error) {
      if (error.code === "E_IDENTITY_NOT_FOUND") return res.status(404).json({ error: error.message, code: error.code });
      res.status(500).json({ error: error.message, code: error.code ?? "E_INTERNAL" });
    }
  };

  /** POST /session {did, deviceId, nonce, signature} — verify proof; issue session tokens. */
  createSession = async (req, res) => {
    const { did, deviceId, nonce, signature } = req.body ?? {};
    if (!did || !deviceId || !nonce || !signature) {
      return res.status(400).json({ error: "did, deviceId, nonce and signature required", code: "E_FIELDS_REQUIRED" });
    }
    try {
      const session = await this.authService.openSession({ did, deviceId, nonce, signature });
      res.status(201).json(session);
    } catch (error) {
      const statusByCode = {
        E_CHALLENGE_REQUIRED: 401,
        E_NO_REGISTRATION: 401,
        E_SIGNATURE_INVALID: 401,
        E_IDENTITY_NOT_FOUND: 404,
      };
      res
        .status(statusByCode[error.code] ?? 500)
        .json({ error: error.message, code: error.code ?? "E_INTERNAL" });
    }
  };

  /** POST /session/refresh {refreshToken} — refresh against the home hub. */
  refresh = async (req, res) => {
    const { refreshToken } = req.body ?? {};
    if (!refreshToken) {
      return res.status(400).json({ error: "refreshToken required", code: "E_FIELDS_REQUIRED" });
    }
    try {
      res.json(await this.authService.refresh({ refreshToken }));
    } catch (error) {
      const status = error.code === "E_REFRESH_INVALID" ? 401 : 500;
      res.status(status).json({ error: error.message, code: error.code ?? "E_INTERNAL" });
    }
  };
}

export default AuthController;