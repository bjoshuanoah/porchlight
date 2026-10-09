
/**
 * Migration controller: transport only. Identity mobility is first-class:
 * the outgoing hub issues an operator-signed handoff token and marks the
 * homing pointer moved; the receiving hub ingests the identity after
 * verifying the handoff (ac-4).
 */
export class MigrationController {
  /**
   * @param {import("migrationService").MigrationService} migrationService
   * @param {import("authService").AuthService} authService
   */
  constructor(migrationService, authService) {
    this.migrationService = migrationService;
    this.authService = authService;
  }

  /** Resolve the Bearer access token to a session identity or fail closed (401). */
  async requireSession(req, res) {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    const identity = token ? await this.authService.verifyAccessToken(token) : null;
    if (!identity) {
      res.status(401).json({ error: "active session required", code: "E_SESSION_REQUIRED" });
      return null;
    }
    return identity;
  }

  /**
   * POST /migration/handoff {did, newIssuer} — issuing a handoff token moves a
   * homing pointer; that is an identity write, so it is session-bound to the
   * did: a member migrates only their own identity. (Receiving stays
   * token-verified — the signed handoff token is the receiving hub's proof.)
   */
  issueHandoff = async (req, res) => {
    const session = await this.requireSession(req, res);
    if (!session) return;
    const { did, newIssuer } = req.body ?? {};
    if (!did || !newIssuer) return res.status(400).json({ error: "did and newIssuer required", code: "E_FIELDS_REQUIRED" });
    if (did !== session.did) {
      return res.status(403).json({ error: "handoff tokens are issued only for your own identity", code: "E_FORBIDDEN" });
    }
    try {
      const result = await this.migrationService.issueHandoff({ did, newIssuer });
      res.status(201).json(result);
    } catch (error) {
      if (error.code === "E_IDENTITY_NOT_FOUND") return res.status(404).json({ error: error.message, code: error.code });
      res.status(500).json({ error: error.message, code: error.code ?? "E_INTERNAL" });
    }
  };

  /** POST /migration/receive {handoffToken, did, envelope, oldIssuer} — new hub ingests after verification. */
  receiveMigration = async (req, res) => {
    const { handoffToken, did, envelope, oldIssuer } = req.body ?? {};
    if (!handoffToken || !did || !envelope || !oldIssuer) {
      return res.status(400).json({ error: "handoffToken, did, envelope and oldIssuer required", code: "E_FIELDS_REQUIRED" });
    }
    try {
      const result = await this.migrationService.receiveMigration({ handoffToken, did, envelope, oldIssuer });
      res.status(result.adopted === "existing" ? 200 : 201).json(result);
    } catch (error) {
      const statusByCode = {
        E_HANDOFF_INVALID: 401,
        E_HANDOFF_EXPIRED: 401,
        E_HANDOFF_MISMATCH: 401,
        E_OLD_HUB_KEYSET_MISMATCH: 401,
        E_HANDOFF_DID_MISMATCH: 401,
      };
      res.status(statusByCode[error.code] ?? 500).json({ error: error.message, code: error.code ?? "E_INTERNAL" });
    }
  };
}

export default MigrationController;