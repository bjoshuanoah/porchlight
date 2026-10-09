/**
 * Account controller: transport only. Bootstrap first-account creation,
 * second-hub adoption, handle reassignment — every decision lives in
 * AccountService. Errors map by typed code; nothing else.
 */
export class AccountController {
  /**
   * @param {AccountService} accountService
   * @param {{ record: (step: string, detail?: object) => Promise<void> }} [ledger]
   */
  constructor(accountService, ledger) {
    this.accountService = accountService;
    this.ledger = ledger ?? { record: async () => {} };
  }

  /** GET /account — bootstrap state for first-account/adoption offer. */
  get = async (_req, res) => {
    const account = await this.accountService.get();
    res.json({ exists: account !== null, account, adoptionAvailable: account === null });
  };

  /**
   * POST /bootstrap/account {displayName, email?, actorType?, device?{deviceId, label, publicKeyJwk}}
   * First-account creation with the device-held key bound at setup (ac-1).
   */
  createFirstAccount = async (req, res) => {
    const { displayName, email, device } = req.body ?? {};
    try {
      const result = await this.accountService.createFirstAccount({ displayName, email: email ?? null, device: device ?? null });
      if (result.created) await this.ledger.record("account", { detail: "owner account created with device-held key" });
      res.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      const status = error.status ?? 500;
      res.status(status).json({ error: error.message, code: error.code ?? "E_INTERNAL" });
    }
  };

  /**
   * POST /bootstrap/adopt {sourceHubUrl, did, displayName?} — second-hub
   * adoption: verifies the identity at its home hub and stores a reference;
   * the identity record is never copied (ac-3).
   */
  adoptIdentity = async (req, res) => {
    const { sourceHubUrl, did, displayName } = req.body ?? {};
    try {
      const result = await this.accountService.adoptIdentity({ sourceHubUrl, did, displayName: displayName ?? null });
      if (result.adopted) {
        await this.ledger.record("account", { detail: `identity referenced from ${result.account.adoptedIdentity.sourceHubUrl}` });
      }
      res.status(result.adopted ? 201 : 200).json(result);
    } catch (error) {
      const statusByCode = {
        E_OWNER_ACCOUNT_EXISTS: 409,
        E_ADOPTION_FIELDS_REQUIRED: 400,
        E_DEVICE_KEY_REQUIRED: 400,
        E_PRIVATE_KEY_REJECTED: 400,
        E_KEY_TYPE_REJECTED: 400,
        E_REMOTE_IDENTITY_NOT_FOUND: 404,
      };
      const status = statusByCode[error.code] ?? 500;
      res.status(status).json({ error: error.message, code: error.code ?? "E_INTERNAL" });
    }
  };

  /**
   * POST /handle {did, handle} — presentation-plane reassignment: the handle
   * may change (including on hub moves); the DID never changes (ac-10).
   */
  setHandle = async (req, res) => {
    const { did, handle } = req.body ?? {};
    if (!did || !handle) return res.status(400).json({ error: "did and handle required", code: "E_FIELDS_REQUIRED" });
    try {
      const identity = await this.accountService.setHandle({ did, handle });
      res.json({ handle: identity.handle, did: identity.did });
    } catch (error) {
      if (error.code === "E_HANDLE_TAKEN") return res.status(409).json({ error: error.message, code: error.code });
      if (error.code === "E_IDENTITY_NOT_FOUND") return res.status(404).json({ error: error.message, code: error.code });
      res.status(500).json({ error: error.message, code: error.code ?? "E_INTERNAL" });
    }
  };

  /** Profile field writes live on the account record the DID points at. */
  recordProfile = async (req, res) => {
    const { did, displayName, profile } = req.body ?? {};
    if (!did) return res.status(400).json({ error: "did required", code: "E_FIELDS_REQUIRED" });
    try {
      const identity = await this.accountService.recordProfile({ did, displayName, profile });
      res.json({ did: identity.did, displayName: identity.displayName, profile: identity.profile });
    } catch (error) {
      if (error.code === "E_IDENTITY_NOT_FOUND") return res.status(404).json({ error: error.message, code: error.code });
      res.status(500).json({ error: error.message, code: error.code ?? "E_INTERNAL" });
    }
  };
}

export default AccountController;