import { identityModels } from "../models.js";

/**
 * Account service. Owns the bootstrap-period account surface for the
 * identity domain: the owner's first account, and adoption of an existing
 * identity from another hub (Porchlight Server TS 2, first account/adoption).
 * Models stay identity-owned; no social imports.
 */
export class AccountService {
  /**
   * @param {import("@porchlight/shared").StoreLike["collection"]} accounts
   *        Identity-owned `accounts` collection handle.
   */
  constructor(accounts) {
    this.accounts = accounts;
    this.models = identityModels;
  }

  /** Whether any hub account exists (drives the first-account/adoption offer). */
  async hasAccount() {
    return (await this.accounts.findOne({})) !== null;
  }

  async get() {
    return this.accounts.findOne({});
  }

  /**
   * Create the first owner account. Idempotent at the bootstrap level: an
   * existing account is returned with created:false instead of a conflict.
   */
  async createFirstAccount({ email, displayName } = {}) {
    const existing = await this.accounts.findOne({});
    if (existing) return { created: false, account: existing };
    const account = {
      _id: `acct_${crypto.randomUUID()}`,
      displayName: displayName ?? "Owner",
      email: email ?? null,
      kind: "owner",
      adoptedIdentity: null,
      createdAt: new Date().toISOString(),
    };
    await this.accounts.insertOne(account);
    return { created: true, account };
  }

  /**
   * Adopt an identity the owner already holds on another porchlight hub.
   * Offered by the bootstrap flow alongside first-account creation; refused
   * with a typed reason when an owner account already exists.
   */
  async adoptIdentity({ sourceHubUrl, externalIdentityId, displayName } = {}) {
    if (!sourceHubUrl || !externalIdentityId) {
      const error = new Error("sourceHubUrl and externalIdentityId required");
      error.code = "E_ADOPTION_FIELDS_REQUIRED";
      throw error;
    }
    const existing = await this.accounts.findOne({});
    if (existing) {
      if (existing.kind === "adopted") return { adopted: false, alreadyAdopted: true, account: existing };
      const error = new Error("An owner account already exists on this hub; adoption applies only before first-account creation");
      error.code = "E_OWNER_ACCOUNT_EXISTS";
      throw error;
    }
    const account = {
      _id: `acct_${crypto.randomUUID()}`,
      displayName: displayName ?? externalIdentityId,
      email: null,
      kind: "adopted",
      adoptedIdentity: {
        sourceHubUrl: String(sourceHubUrl),
        externalId: String(externalIdentityId),
      },
      createdAt: new Date().toISOString(),
    };
    await this.accounts.insertOne(account);
    return { adopted: true, alreadyAdopted: false, account };
  }
}

export default AccountService;