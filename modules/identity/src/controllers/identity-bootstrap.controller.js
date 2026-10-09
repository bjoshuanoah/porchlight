
/**
 * Bootstrap-account controller. Transport-specific: translates between HTTP
 * and the identity domain. Business logic and models stay in the service
 * layer; the controller records bootstrap-progress into the system ledger
 * the server injects (no domain decisions here).
 */
export class IdentityBootstrapController {
  /**
   * @param {AccountService} service
   * @param {{ record: (step: string, detail: object) => Promise<void> }} [ledger]
   */
  constructor(service, ledger) {
    this.service = service;
    this.ledger = ledger ?? { record: async () => {} };
  }

  /** GET /account — current account state for the bootstrap page. */
  get = async (_req, res) => {
    const account = await this.service.get();
    res.json({ exists: account !== null, account, adoptionAvailable: account === null });
  };

  /** POST /bootstrap/account — first-account creation (idempotent). */
  createFirstAccount = async (req, res) => {
    const { email, displayName } = req.body ?? {};
    try {
      const result = await this.service.createFirstAccount({ email: email ?? null, displayName: displayName ?? null });
      if (result.created) await this.ledger.record("account", { detail: "owner account created" });
      res.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };

  /** POST /bootstrap/adopt — adopt an existing identity from another hub. */
  adoptIdentity = async (req, res) => {
    const { sourceHubUrl, externalIdentityId, displayName } = req.body ?? {};
    let result;
    try {
      result = await this.service.adoptIdentity({ sourceHubUrl, externalIdentityId, displayName });
    } catch (error) {
      if (error.code === "E_OWNER_ACCOUNT_EXISTS") {
        return res.status(409).json({ adopted: false, error: error.message });
      }
      if (error.code === "E_ADOPTION_FIELDS_REQUIRED") {
        return res.status(400).json({ error: error.message });
      }
      throw error;
    }
    if (result.adopted) {
      await this.ledger.record("account", { detail: `identity adopted from ${result.account.adoptedIdentity.sourceHubUrl}` });
      res.status(201).json(result);
    } else {
      res.status(200).json(result);
    }
  };
}

export default IdentityBootstrapController;