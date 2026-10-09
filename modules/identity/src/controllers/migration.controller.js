
/**
 * Migration controller: transport only. Identity mobility is first-class:
 * the outgoing hub issues an operator-signed handoff token and marks the
 * homing pointer moved; the receiving hub ingests the identity after
 * verifying the handoff (ac-4).
 */
export class MigrationController {
  /**
   * @param {import("migrationService").MigrationService} migrationService
   */
  constructor(migrationService) {
    this.migrationService = migrationService;
  }

  /**
   * POST /migration/handoff {did, newIssuer} — operator surface (the identity
   * plane is operator-held hub infrastructure; in phase 1 the hub binds the
   * loopback interface and the operator surfaces ride it).
   */
  issueHandoff = async (req, res) => {
    const { did, newIssuer } = req.body ?? {};
    if (!did || !newIssuer) return res.status(400).json({ error: "did and newIssuer required", code: "E_FIELDS_REQUIRED" });
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