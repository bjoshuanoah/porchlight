
import { requireSessionOr401 } from "../util/session-guard.js";

/**
 * OIDC controller: transport only. The member's home hub is its own identity
 * provider: authorize (code path, nonce + PKCE) and token exchange. Token
 * payloads assert identity only — authorization never rides them (ac-6/7).
 */
export class OidcController {
  /**
   * @param {import("trustService").TrustService} trustService
   * @param {import("authService").AuthService} authService
   * @param {((line: string) => void) | null} [log] - auth-failure capture sink (PORCH-019).
   */
  constructor(trustService, authService, log = null) {
    this.trustService = trustService;
    this.authService = authService;
    this.log = log;
  }

  /** Resolve the Bearer access token to a session identity or fail closed (401). */
  async requireSession(req, res) {
    return requireSessionOr401({ req, res, authService: this.authService, log: this.log });
  }

  /**
   * POST /oidc/authorize {did, clientId, nonce, codeChallenge, codeChallengeMethod}
   * Member-authenticated and session-bound to the did: a member only ever
   * authorizes their own identity — a session can mint a code for nobody else.
   */
  authorize = async (req, res) => {
    const session = await this.requireSession(req, res);
    if (!session) return;
    const { did, clientId, nonce, codeChallenge, codeChallengeMethod } = req.body ?? {};
    if (!did || !clientId || !nonce || !codeChallenge) {
      return res.status(400).json({ error: "did, clientId, nonce and codeChallenge required", code: "E_FIELDS_REQUIRED" });
    }
    if (did !== session.did) {
      return res.status(403).json({ error: "authorization codes are issued only to your own identity", code: "E_FORBIDDEN" });
    }
    try {
      const result = await this.trustService.createAuthCode({ did, clientId, nonce, codeChallenge, codeChallengeMethod });
      res.status(201).json(result);
    } catch (error) {
      const statusByCode = {
        E_SESSION_REQUIRED: 401,
        E_PKCE_REQUIRED: 400,
        E_CHALLENGE_METHOD_UNSUPPORTED: 400,
        E_CLIENT_MISMATCH: 400,
      };
      res.status(statusByCode[error.code] ?? 500).json({ error: error.message, code: error.code ?? "E_INTERNAL" });
    }
  };

  /** POST /oidc/token {code, codeVerifier, clientId} — PKCE exchange; issues the ID token. */
  token = async (req, res) => {
    const { code, codeVerifier, clientId } = req.body ?? {};
    if (!code || !codeVerifier || !clientId) {
      return res.status(400).json({ error: "code, codeVerifier and clientId required", code: "E_FIELDS_REQUIRED" });
    }
    try {
      res.json(await this.trustService.exchangeAuthCode({ code, codeVerifier, clientId }));
    } catch (error) {
      const statusByCode = {
        E_AUTH_CODE_UNKNOWN: 404,
        E_AUTH_CODE_EXPIRED: 410,
        E_AUTH_CODE_CONSUMED: 409,
        E_PKCE_MISMATCH: 401,
        E_CLIENT_MISMATCH: 401,
      };
      res.status(statusByCode[error.code] ?? 500).json({ error: error.message, code: error.code ?? "E_INTERNAL" });
    }
  };
}

export default OidcController;