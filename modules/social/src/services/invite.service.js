import { randomBytes } from "node:crypto";
import { socialModels } from "../models.js";

/**
 * Invite service. Owns the join-link lifecycle for the social domain:
 * issuance during bootstrap, instant owner-visible revocation (quantity-only
 * limits rule; lifecycle states owner-visible, Porchlight Server TS 6).
 */
export class InviteService {
  /**
   * @param {import("@porchlight/shared").StoreLike["collection"]} invites
   */
  constructor(invites) {
    this.invites = invites;
    this.models = socialModels;
  }

  /** Issue a join-link invite for a network. */
  async issue({ networkId, role = "member", maxUses = 1, hubUrl = null } = {}) {
    if (!networkId) {
      const error = new Error("networkId required");
      error.code = "E_NETWORK_REQUIRED";
      throw error;
    }
    const invite = {
      _id: `inv_${crypto.randomUUID()}`,
      token: randomBytes(18).toString("base64url"),
      networkId: String(networkId),
      role: String(role),
      maxUses: Number(maxUses) || 1,
      useCount: 0,
      state: "active",
      hubUrl,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    await this.invites.insertOne(invite);
    return invite;
  }

  /** Revoke instantly — the join link stops working the moment this returns. */
  async revoke({ inviteId } = {}) {
    const invite = await this.invites.findOne({ _id: inviteId });
    if (!invite) {
      const error = new Error(`invite ${inviteId} not found`);
      error.code = "E_INVITE_NOT_FOUND";
      throw error;
    }
    if (invite.state === "revoked") return { revoked: false, invite };
    const revokedAt = new Date().toISOString();
    await this.invites.updateOne({ _id: inviteId }, { $set: { state: "revoked", revokedAt } });
    return { revoked: true, invite: { ...invite, state: "revoked", revokedAt } };
  }
}

export default InviteService;