import { requireSessionOr401 } from "../util/session-guard.js";

/**
 * Account controller: transport only. Bootstrap first-account creation,
 * second-hub adoption, handle reassignment — every decision lives in
 * AccountService. Errors map by typed code; nothing else.
 *
 * Presentation-plane writes are session-bound to the did: an active session
 * may act only on its own identity (perimeter ac: no anonymous or third-party
 * identity writes).
 */
export class AccountController {
  /**
   * @param {AccountService} accountService
   * @param {import("authService").AuthService} authService
   * @param {{ record: (step: string, detail?: object) => Promise<void> }} [ledger]
   * @param {((line: string) => void) | null} [log] - auth-failure capture sink (PORCH-019).
   */
  constructor(accountService, authService, ledger, log = null) {
    this.accountService = accountService;
    this.authService = authService;
    this.ledger = ledger ?? { record: async () => {} };
    this.log = log;
  }

  /** Resolve the Bearer access token to a session identity or fail closed (401). */
  async requireSession(req, res) {
    return requireSessionOr401({ req, res, authService: this.authService, log: this.log });
  }

  /** GET /account — bootstrap state for the first-account offer (adoption is flag-hidden, PORCH-026). */
  get = async (_req, res) => {
    const { account, adoptionAvailable } = await this.accountService.bootstrapOffer();
    res.json({ exists: account !== null, account, adoptionAvailable });
  };

  /**
   * POST /bootstrap/account {firstName, lastName, email?, device?{deviceId, label, publicKeyJwk}}
   * First-account creation with the device-held key bound at setup (ac-1).
   * Required names (PORCH-024): the hub validates first and last regardless
   * of client state; the display name is composed server-side.
   */
  createFirstAccount = async (req, res) => {
    const { firstName, lastName, email, device } = req.body ?? {};
    try {
      const result = await this.accountService.createFirstAccount({ firstName, lastName, email: email ?? null, device: device ?? null });
      if (result.created) await this.ledger.record("account", { detail: "owner account created with device-held key" });
      res.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      const statusByCode = {
        E_FIRST_NAME_REQUIRED: 400,
        E_LAST_NAME_REQUIRED: 400,
        E_DEVICE_KEY_REQUIRED: 400,
        E_KEY_TYPE_REJECTED: 400,
        E_PRIVATE_KEY_REJECTED: 400,
        E_OWNER_ACCOUNT_EXISTS: 409,
      };
      const status = statusByCode[error.code] ?? error.status ?? 500;
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
        E_ADOPTION_HIDDEN: 403,
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
   * Session-bound to the did: a member reassigns only their own handle, never
   * an identity they hold no session for.
   */
  setHandle = async (req, res) => {
    const session = await this.requireSession(req, res);
    if (!session) return;
    const { did, handle } = req.body ?? {};
    if (!did || !handle) return res.status(400).json({ error: "did and handle required", code: "E_FIELDS_REQUIRED" });
    if (did !== session.did) {
      return res.status(403).json({ error: "handles are reassigned only to your own identity", code: "E_FORBIDDEN" });
    }
    try {
      const identity = await this.accountService.setHandle({ did, handle });
      res.json({ handle: identity.handle, did: identity.did });
    } catch (error) {
      if (error.code === "E_HANDLE_TAKEN") return res.status(409).json({ error: error.message, code: error.code });
      if (error.code === "E_IDENTITY_NOT_FOUND") return res.status(404).json({ error: error.message, code: error.code });
      res.status(500).json({ error: error.message, code: error.code ?? "E_INTERNAL" });
    }
  };

  /**
   * Profile field writes live on the account record the DID points at.
   * Session-bound to the did: a member records profile data only on their own
   * account row.
   */
  recordProfile = async (req, res) => {
    const session = await this.requireSession(req, res);
    if (!session) return;
    const { did, displayName, profile } = req.body ?? {};
    if (!did) return res.status(400).json({ error: "did required", code: "E_FIELDS_REQUIRED" });
    if (did !== session.did) {
      return res.status(403).json({ error: "profile fields are written only to your own identity", code: "E_FORBIDDEN" });
    }
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