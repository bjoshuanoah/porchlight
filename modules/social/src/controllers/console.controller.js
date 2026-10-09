/**
 * Owner console controller. The server behaviors behind the console screens
 * (Porchlight UI owns the screens; this owns the behaviors): invite
 * lifecycle management, member management, quantity-only limits, disk
 * guard status, retention sweep, and the member-action audit trail.
 * Transport-specific only — all domain logic lives in the services.
 */
import { logAuthFailure } from "@porchlight/shared";

export class ConsoleController {
  /**
   * @param {object} deps
   * @param {import("../services/network.service.js").NetworkService} deps.networks
   * @param {import("../services/invite.service.js").InviteService} deps.invites
   * @param {import("../services/membership.service.js").MembershipService} deps.membership
   * @param {import("../services/quota.service.js").QuotaService} deps.quota
   * @param {import("../services/audit.service.js").AuditService} deps.audit
   * @param {import("../services/group.service.js").GroupService} deps.groups
   * @param {import("../services/ranking.service.js").RankingService} deps.ranking
   * @param {import("../services/media.service.js").MediaService} [deps.media]
   * @param {{ release: { service: string, version: string | null }, launch: () => Promise<{ resumable: boolean, lastError: string | null, steps: Record<string, { status: string }>, diagnostics: Array<{ at: string, source: string, message: string }> }> }} [deps.system]
   *   Hub-global release identity + launch diagnostics ledger, injected by
   *   apps/server (the system vertical owns the ledger; the social module
   *   imports no system source).
   * @param {() => string | null} [deps.hubUrl]
   *   The hub's current public URL provider (read per call — never a stale
   *   copy, PORCH-017). Recorded on join links so a landing invite names the
   *   hub it was made for (PORCH-023).
   * @param {((line: string) => void) | null} [deps.log]
   *   Auth-failure capture sink (PORCH-019); defaults to console.log.
   */
  constructor({ networks, invites, membership, quota, audit, groups, ranking, media, system, hubUrl, log }) {
    this.networks = networks;
    this.invites = invites;
    this.membership = membership;
    this.quota = quota;
    this.audit = audit;
    this.groups = groups;
    this.ranking = ranking;
    this.media = media ?? null;
    this.system = system ?? null;
    this.hubUrl = typeof hubUrl === "function" ? hubUrl : null;
    this.log = log ?? null;
  }

  /**
   * Owner-console perimeter guard (PORCH-015): every /console/* handler
   * calls this first. A valid Bearer membership token for THIS network with
   * the owner role is the only way through — no token or no session is 401
   * (plain member language), a session without the owner role is 403.
   * The guard lives in the controller (traceability: the audit pins the
   * route table, which stays thin middleware-free).
   *
   * @returns {Promise<{membership: object, session: object} | null>} the
   *   verified perimeter to continue with, or null after writing the error.
   */
  async #requireOwner(req, res) {
    const header = req.headers?.authorization ?? "";
    const accessToken = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    const network = await this.networks.get();
    const perimeter =
      accessToken && network
        ? await this.membership.verifyAccessToken(accessToken, { networkId: network._id })
        : null;
    if (!perimeter) {
      // PORCH-019: captured with the failing step (membership-plane
      // diagnosis) and the session/device identity state — never tokens.
      const diagnosis = await this.membership.diagnoseAccessToken?.(accessToken, { networkId: network?._id ?? null }) ?? { reason: accessToken ? "unknown_token" : "missing_token" };
      logAuthFailure(
        {
          endpoint: `${req.method ?? "UNKNOWN"} ${req.originalUrl ?? req.url ?? "unknown"}`,
          code: "E_SESSION_REQUIRED",
          ...diagnosis,
        },
        this.log ?? undefined,
      );
      res.status(401).json({
        error: "Sign in to your membership before opening the owner console.",
        code: "E_SESSION_REQUIRED",
      });
      return null;
    }
    if (perimeter.membership.role !== "owner") {
      res.status(403).json({ error: "The owner console belongs to the network owner.", code: "E_FORBIDDEN" });
      return null;
    }
    return perimeter;
  }

  /** GET /console/invites — owner-visible join-link states (unused/used/revoked). */
  listInvites = async (req, res) => {
    if (!(await this.#requireOwner(req, res))) return;
    const invites = await this.invites.list({ networkId: req.query?.networkId ?? undefined });
    res.json({ invites });
  };

  /** POST /console/invites — issue a join-link invite (join URL embeds the code). */
  issueInvite = async (req, res) => {
    if (!(await this.#requireOwner(req, res))) return;
    const network = await this.networks.get();
    if (!network) {
      return res.status(409).json({ error: "Create the hub network before issuing invites" });
    }
    const { role, maxUses } = req.body ?? {};
    // The join link names the hub it was made for: with the URL recorded,
    // verify's joinUrl is absolute and the member's front door can tell a
    // mismatched host apart (PORCH-023).
    const invite = await this.invites.issue({ networkId: network._id, role, maxUses, hubUrl: this.hubUrl ? this.hubUrl() : null });
    await this.audit.record({ networkId: network._id, did: null, action: "invite_issue", detail: { inviteId: invite._id } });
    res.status(201).json({ invite });
  };

  /** POST /console/invites/revoke — instant revocation. */
  revokeInvite = async (req, res) => {
    if (!(await this.#requireOwner(req, res))) return;
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
  listMembers = async (req, res) => {
    if (!(await this.#requireOwner(req, res))) return;
    const network = await this.networks.get();
    if (!network) {
      return res.status(409).json({ error: "No network exists yet" });
    }
    const members = await this.membership.listMemberViews({ networkId: network._id });
    res.json({ members });
  };

  /** POST /console/members/revoke — instant revocation; sessions die with it. */
  revokeMember = async (req, res) => {
    if (!(await this.#requireOwner(req, res))) return;
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
  getLimits = async (req, res) => {
    if (!(await this.#requireOwner(req, res))) return;
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
    if (!(await this.#requireOwner(req, res))) return;
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
  listAudit = async (req, res) => {
    if (!(await this.#requireOwner(req, res))) return;
    const network = await this.networks.get();
    if (!network) {
      return res.status(409).json({ error: "No network exists yet" });
    }
    res.json({ events: await this.audit.list({ networkId: network._id }) });
  };

  /**
   * POST /console/retention/sweep — owner-run retention enforcement pass.
   * Routes through the media service when it is wired (PORCH-008): the
   * quota ledger rows sweep first, then each expired artifact's stored
   * media row (original or rendition) and its blob bytes cascade in the
   * same pass.
   */
  sweepRetention = async (req, res) => {
    if (!(await this.#requireOwner(req, res))) return;
    const network = await this.networks.get();
    if (!network) {
      return res.status(409).json({ error: "No network exists yet" });
    }
    if (this.media) {
      return res.json(await this.media.sweep({ networkId: network._id }));
    }
    res.json(await this.quota.sweep({ networkId: network._id }));
  };

  /**
   * GET /console/disk — the disk-guard status surface (PORCH-008 ac-4):
   * live used/free bytes against the soft and hard thresholds. The soft
   * warning (`warning: true`) is what the owner console banners; the hard
   * state (`uploadsHalted: true`) is where the media service rejects new
   * uploads while reads continue.
   */
  diskStatus = async (req, res) => {
    if (!(await this.#requireOwner(req, res))) return;
    if (!this.media) {
      return res.status(501).json({ error: "The media pipeline is not wired into this deployment" });
    }
    res.json(await this.media.diskStatus());
  };

  /**
   * POST /console/media/gc — owner-runnable garbage-collection pass over
   * idle incomplete uploads (the scheduled pass calls the same service
   * method; the console route makes it observable and re-runnable).
   */
  gcUploads = async (req, res) => {
    if (!(await this.#requireOwner(req, res))) return;
    if (!this.media) {
      return res.status(501).json({ error: "The media pipeline is not wired into this deployment" });
    }
    res.json(await this.media.gcIncompleteUploads());
  };

  /**
   * POST /console/groups — owner creates a within-network group container
   * (groups ruling Oct 8 2026). Group membership must be a subset of the
   * network membership; the group service enforces it.
   */
  createGroup = async (req, res) => {
    if (!(await this.#requireOwner(req, res))) return;
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
  listGroups = async (req, res) => {
    if (!(await this.#requireOwner(req, res))) return;
    const network = await this.networks.get();
    if (!network) {
      return res.status(409).json({ error: "No network exists yet" });
    }
    res.json({ groups: await this.groups.list({ networkId: network._id }) });
  };

  /**
   * GET /console/system — the console's update-status surface (PORCH-011
   * ac-4): the running hub release and version, plus the launch diagnostics
   * ledger (bootstrap step statuses and diagnostic entries — a failed start
   * is diagnosable because the failing check is named in an entry).
   * Updates are owner-run in V1 (npm install + the install-time restart,
   * Brian Oct 13, 2026): nothing on this surface checks for updates, polls
   * a registry, or schedules any background machinery — a stale read of
   * static release identity and the local-only diagnostics ledger.
   */
  systemStatus = async (req, res) => {
    if (!(await this.#requireOwner(req, res))) return;
    if (!this.system) {
      return res.status(501).json({ error: "The system release surface is not wired into this deployment" });
    }
    res.json({ release: this.system.release, launch: await this.system.launch() });
  };

  /**
   * GET /console/ranking — the owner-readable ranking parameters (Feed
   * Ranking Contract: fixed, published formula with every parameter a
   * named configuration value). Read-only; the vote-privacy surface of
   * the formula is not affected: parameters only, no vote data.
   */
  getRanking = async (req, res) => {
    if (!(await this.#requireOwner(req, res))) return;
    res.json(this.ranking.describe());
  };
}

export default ConsoleController;