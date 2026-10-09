/**
 * Owner console controller. The server behaviors behind the console screens
 * (Porchlight UI owns the screens; this owns the behaviors): invite
 * lifecycle management, member management, quantity-only limits, retention
 * sweep, and the member-action audit trail. Transport-specific only — all
 * domain logic lives in the services.
 */
export class ConsoleController {
  /**
   * @param {object} deps
   * @param {import("../services/network.service.js").NetworkService} deps.networks
   * @param {import("../services/invite.service.js").InviteService} deps.invites
   * @param {import("../services/membership.service.js").MembershipService} deps.membership
   * @param {import("../services/quota.service.js").QuotaService} deps.quota
   * @param {import("../services/audit.service.js").AuditService} deps.audit
   * @param {import("../services/group.service.js").GroupService} deps.groups
   */
  constructor({ networks, invites, membership, quota, audit, groups }) {
    this.networks = networks;
    this.invites = invites;
    this.membership = membership;
    this.quota = quota;
    this.audit = audit;
    this.groups = groups;
  }

  /** GET /console/invites — owner-visible join-link states (unused/used/revoked). */
  listInvites = async (req, res) => {
    const invites = await this.invites.list({ networkId: req.query?.networkId ?? undefined });
    res.json({ invites });
  };

  /** POST /console/invites — issue a join-link invite (join URL embeds the code). */
  issueInvite = async (req, res) => {
    const network = await this.networks.get();
    if (!network) {
      return res.status(409).json({ error: "Create the hub network before issuing invites" });
    }
    const { role, maxUses } = req.body ?? {};
    const invite = await this.invites.issue({ networkId: network._id, role, maxUses });
    await this.audit.record({ networkId: network._id, did: null, action: "invite_issue", detail: { inviteId: invite._id } });
    res.status(201).json({ invite });
  };

  /** POST /console/invites/revoke — instant revocation. */
  revokeInvite = async (req, res) => {
    const { inviteId } = req.body ?? {};
    try {
      const result = await this.invites.revoke({ inviteId });
      await this.audit.record({
        networkId: result.invite.networkId,
        did: null,
        action: "invite_revoke",
        detail: { inviteId },
      });
      res.json(result);
    } catch (error) {
      const status = error.code === "E_INVITE_NOT_FOUND" ? 404 : 500;
      res.status(status).json({ error: error.message });
    }
  };

  /** GET /console/members — the network's membership records. */
  listMembers = async (_req, res) => {
    const network = await this.networks.get();
    if (!network) {
      return res.status(409).json({ error: "No network exists yet" });
    }
    const members = await this.membership.listMembers({ networkId: network._id });
    res.json({ members: members.map((m) => this.membership.view(m)) });
  };

  /** POST /console/members/revoke — instant revocation; sessions die with it. */
  revokeMember = async (req, res) => {
    const network = await this.networks.get();
    if (!network) {
      return res.status(409).json({ error: "No network exists yet" });
    }
    const { did, memberId } = req.body ?? {};
    try {
      const result = await this.membership.revokeMember({ networkId: network._id, did, memberId });
      res.json(result);
    } catch (error) {
      const status = error.code === "E_MEMBER_NOT_FOUND" ? 404 : 500;
      res.status(status).json({ error: error.message });
    }
  };

  /** GET /console/limits — quantity-only limits with live usage. */
  getLimits = async (_req, res) => {
    const network = await this.networks.get();
    if (!network) {
      return res.status(409).json({ error: "No network exists yet" });
    }
    const limits = await this.quota.limits({ networkId: network._id });
    const usage = await this.quota.usage({ networkId: network._id });
    res.json({
      network: { _id: network._id, name: network.name },
      quota: limits,
      usedBytes: usage.usedBytes,
    });
  };

  /** PUT /console/limits — owner sets storage ceiling / retention window. */
  setLimits = async (req, res) => {
    const network = await this.networks.get();
    if (!network) {
      return res.status(409).json({ error: "No network exists yet" });
    }
    const { storageCeilingMb, retentionDays } = req.body ?? {};
    try {
      const result = await this.quota.setLimits({ networkId: network._id, storageCeilingMb, retentionDays });
      res.json(result);
    } catch (error) {
      const status = error.code === "E_INVALID_QUOTA" ? 400 : 500;
      res.status(status).json({ error: error.message, code: error.code ?? "E_INTERNAL" });
    }
  };

  /** GET /console/audit — member action trail (uploads, deletions, logins). */
  listAudit = async (_req, res) => {
    const network = await this.networks.get();
    if (!network) {
      return res.status(409).json({ error: "No network exists yet" });
    }
    res.json({ events: await this.audit.list({ networkId: network._id }) });
  };

  /** POST /console/retention/sweep — owner-run retention enforcement pass. */
  sweepRetention = async (_req, res) => {
    const network = await this.networks.get();
    if (!network) {
      return res.status(409).json({ error: "No network exists yet" });
    }
    const result = await this.quota.sweep({ networkId: network._id });
    res.json(result);
  };

  /**
   * POST /console/groups — owner creates a within-network group container
   * (groups ruling Oct 8 2026). Group membership must be a subset of the
   * network membership; the group service enforces it.
   */
  createGroup = async (req, res) => {
    const network = await this.networks.get();
    if (!network) {
      return res.status(409).json({ error: "No network exists yet" });
    }
    const { name, members } = req.body ?? {};
    try {
      const group = await this.groups.create({ networkId: network._id, name, members });
      await this.audit.record({ networkId: network._id, did: null, action: "group_create", detail: { groupId: group._id } });
      res.status(201).json({ group });
    } catch (error) {
      const status = error.code === "E_GROUP_NOT_MEMBER" ? 403 : 400;
      res.status(status).json({ error: error.message, code: error.code ?? "E_INTERNAL" });
    }
  };

  /** GET /console/groups — the network's group containers. */
  listGroups = async (_req, res) => {
    const network = await this.networks.get();
    if (!network) {
      return res.status(409).json({ error: "No network exists yet" });
    }
    res.json({ groups: await this.groups.list({ networkId: network._id }) });
  };
}

export default ConsoleController;