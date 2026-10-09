import { randomBytes } from "node:crypto";
import { socialModels } from "../models.js";

/** Plain-language join-link failures (no codes exposed to members). */
export const INVITE_PLAIN_MESSAGES = {
  E_INVITE_REQUIRED: "This link is not a valid join link. Ask the network owner to send it again.",
  E_INVITE_NOT_FOUND: "That join code doesn't exist. Double-check the link your network owner sent, or ask for a new one.",
  E_INVITE_REVOKED: "This join link was revoked by the network owner. Ask for a new one if you still need access.",
  E_INVITE_EXHAUSTED: "This join link has already been used its allowed number of times. Ask the network owner for a new link.",
};

/**
 * Invite service. Owns the join-link lifecycle for the social domain:
 * issuance, owner-visible states (unused / used / revoked), instant
 * revocation, redemption at member entry, and plain-language failure.
 */
export class InviteService {
  /**
   * @param {import("@porchlight/shared").StoreLike["collection"]} invites
   */
  constructor(invites) {
    this.invites = invites;
    this.models = socialModels;
  }

  /**
   * Issue a join-link invite for a network. The join URL embeds the code
   * (`<hubUrl>/join/<token>`); URL without a hub URL still carries the code
   * path so the owner console can always show a shareable link shape.
   */
  async issue({ networkId, role = "member", maxUses = 1, hubUrl = null } = {}) {
    if (!networkId) {
      const error = new Error("networkId required");
      error.code = "E_NETWORK_REQUIRED";
      throw error;
    }
    const token = randomBytes(18).toString("base64url");
    const invite = {
      _id: `inv_${crypto.randomUUID()}`,
      token,
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
    return this.withJoinUrl(invite);
  }

  /** Revoke instantly — the join link stops working the moment this returns. */
  async revoke({ inviteId } = {}) {
    const invite = await this.invites.findOne({ _id: inviteId });
    if (!invite) {
      const error = new Error(`invite ${inviteId} not found`);
      error.code = "E_INVITE_NOT_FOUND";
      throw error;
    }
    if (invite.state === "revoked") return { revoked: false, invite: this.withJoinUrl(invite) };
    const revokedAt = new Date().toISOString();
    await this.invites.updateOne({ _id: inviteId }, { $set: { state: "revoked", revokedAt } });
    return { revoked: true, invite: this.withJoinUrl({ ...invite, state: "revoked", revokedAt }) };
  }

  /** Owner-visible list: raw rows plus the derived console status. */
  async list({ networkId } = {}) {
    const rows = await this.invites.find(networkId ? { networkId: String(networkId) } : {});
    return rows.map((invite) => this.withStatus(invite));
  }

  /**
   * The owner-visible state of one invite: unused (fresh uses remain, never
   * revoked), used (exhausted), or revoked. Revocation wins over exhaustion.
   */
  statusOf(invite) {
    if (!invite) return "revoked";
    if (invite.state === "revoked") return "revoked";
    if ((invite.useCount ?? 0) < (invite.maxUses ?? 1)) return "unused";
    return "used";
  }

  withStatus(invite) {
    return { ...invite, status: this.statusOf(invite) };
  }

  /**
   * Member-entry verification (the public join-link check the front door
   * targets): resolves the link's network and validity, or a plain-language
   * failure. Never throws a bare unknown-code error at members.
   */
  async verify(code) {
    const invalid = (code, message) => ({ valid: false, code, message });
    if (typeof code !== "string" || code.length === 0 || code.length > 512) {
      return invalid("E_INVITE_REQUIRED", INVITE_PLAIN_MESSAGES.E_INVITE_REQUIRED);
    }
    const invite = await this.invites.findOne({ token: code });
    if (!invite) {
      return invalid("E_INVITE_NOT_FOUND", INVITE_PLAIN_MESSAGES.E_INVITE_NOT_FOUND);
    }
    if (invite.state === "revoked") {
      return invalid("E_INVITE_REVOKED", INVITE_PLAIN_MESSAGES.E_INVITE_REVOKED);
    }
    if ((invite.useCount ?? 0) >= (invite.maxUses ?? 1)) {
      return invalid("E_INVITE_EXHAUSTED", INVITE_PLAIN_MESSAGES.E_INVITE_EXHAUSTED);
    }
    // The verified answer carries the join link the invite names (absolute
    // when the invite recorded its hub URL) — the member front door tells
    // the visited origin apart from the named one (PORCH-023).
    return { valid: true, invite: this.withJoinUrl(this.withStatus(invite)) };
  }

  /**
   * Redemption inside admission: the stored useCount is advanced under the
   * invite row's own read-state (V1 hub concurrency assumes the owner hub's
   * single-writer cadence; the pre-read state guard keeps double-redemption
   * honest at the service layer).
   */
  async redeem(code) {
    const invite = await this.invites.findOne({ token: code });
    if (!invite) {
      const error = new Error("that join code doesn't exist");
      error.code = "E_INVITE_NOT_FOUND";
      throw error;
    }
    const status = this.statusOf(invite);
    if (status === "revoked") {
      const error = new Error(INVITE_PLAIN_MESSAGES.E_INVITE_REVOKED);
      error.code = "E_INVITE_REVOKED";
      throw error;
    }
    if (status === "used") {
      const error = new Error(INVITE_PLAIN_MESSAGES.E_INVITE_EXHAUSTED);
      error.code = "E_INVITE_EXHAUSTED";
      throw error;
    }
    const useCount = (invite.useCount ?? 0) + 1;
    await this.invites.updateOne({ _id: invite._id }, { $set: { useCount } });
    return { ...invite, useCount };
  }

  withJoinUrl(invite) {
    const base = invite.hubUrl ? String(invite.hubUrl).replace(/\/+$/, "") : null;
    return { ...invite, joinUrl: base ? `${base}/join/${invite.token}` : `/join/${invite.token}` };
  }
}

export default InviteService;