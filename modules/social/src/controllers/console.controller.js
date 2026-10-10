/**
 * Owner console controller. The server behaviors behind the console screens
 * (Porchlight UI owns the screens; this owns the behaviors): invite
 * lifecycle management, member management, quantity-only limits, disk
 * guard status, retention sweep, and the member-action audit trail.
 * Transport-specific only — all domain logic lives in the services.
 */
import { logAuthFailure } from "@porchlight/shared";

/**
 * The media-root edit copy (PORCH-054 ac-4): a root change never moves
 * existing media — the owner runs the move and repoints, in that order.
 * The console surfaces this sentence verbatim (plain family language; no
 * security-dashboard styling).
 */
const MEDIA_ROOT_NO_MIGRATION_COPY =
  "Changing the media root never moves existing media. Move the archive onto the new volume yourself, then repoint here — until the hub is repointed it keeps reading the root it served before.";

export class ConsoleController {
  /**
   * @param {object} deps
   * @param {import("../services/network.service.js").NetworkService} deps.networks
   * @param {import("../services/invite.service.js").InviteService} deps.invites
   * @param {import("../services/membership.service.js").MembershipService} deps.membership
   * @param {import("../services/quota.service.js").QuotaService} deps.quota
   * @param {import("../services/audit.service.js").AuditService} deps.audit
   * @param {import("../services/group.service.js").GroupService} deps.groups
   * @param {import("../services/member-admin.service.js").MemberAdminService} [deps.memberAdmin]
   *   PORCH-053: the permanent-deletion cascade service (owner-only typed-
   *   confirmation purge). Optional — surfaces answer 501 without it, the
   *   module not wired for member administration.
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
  constructor({ networks, invites, membership, quota, audit, groups, ranking, media, system, hubUrl, log, memberAdmin }) {
    this.networks = networks;
    this.invites = invites;
    this.membership = membership;
    this.quota = quota;
    this.audit = audit;
    this.groups = groups;
    this.ranking = ranking;
    this.media = media ?? null;
    this.memberAdmin = memberAdmin ?? null;
    this.system = system ?? null;
    this.hubUrl = typeof hubUrl === "function" ? hubUrl : null;
    this.log = log ?? null;
  }

  /**
   * Owner-console perimeter pass (PORCH-015): a valid Bearer membership
   * token for THIS network is the only way through — no token or no session
   * is 401 (plain member language), sharing the one verification pass the
   * capability guard (#requireCapability, PORCH-053) rides.
   * The guard lives in the controller (traceability: the audit pins the
   * route table, which stays thin middleware-free).
   *
   * @returns {Promise<{membership: object, session: object} | null>} the
   *   verified perimeter to continue with, or null after writing the error.
   */
  async #verifyPerimeter(req, res) {
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
    return perimeter;
  }

  async #requireOwner(req, res) {
    const perimeter = await this.#verifyPerimeter(req, res);
    if (!perimeter) return null;
    if (perimeter.membership.role !== "owner") {
      res.status(403).json({ error: "The owner console belongs to the network owner.", code: "E_FORBIDDEN" });
      return null;
    }
    return perimeter;
  }

  /**
   * Capability-console perimeter guard (PORCH-053): every admin handler
   * authorizes through the ONE capability table (MembershipService's
   * `capabilitiesFor`), never an ad-hoc role string. A valid Bearer
   * membership token for THIS network is still the only way through (401
   * with plain member language, PORCH-019 capture on failure); a live
   * session whose role lacks the capability is 403, worded per capability
   * in family language — the delegate ladder (invites, device links,
   * removal) admits delegates; promote/demote and permanent deletion stay
   * owner-only because no delegate capability reaches them.
   *
   * @returns {Promise<{membership: object, session: object} | null>} the
   *   verified perimeter to continue with, or null after writing the error.
   */
  async #requireCapability(capability, req, res) {
    const perimeter = await this.#verifyPerimeter(req, res);
    if (!perimeter) return null;
    if (!this.membership.capabilitiesFor(perimeter.membership.role).includes(capability)) {
      const copy = {
        members_read: "The member directory belongs to the network's owner and delegates.",
        invites_read: "Invitations belong to the network's owner and delegates.",
        invite_issue: "Join links belong to the network's owner and delegates.",
        invite_revoke: "Withdrawing join links belongs to the network's owner and delegates.",
        device_links_read: "Device links belong to the network's owner and delegates.",
        device_link_issue: "Device links belong to the network's owner and delegates.",
        device_link_revoke: "Withdrawing device links belongs to the network's owner and delegates.",
        member_remove: "Removing members belongs to the network's owner and delegates.",
        member_role: "Role changes belong to the network owner.",
        member_purge: "Permanent deletion belongs to the network owner.",
      };
      res.status(403).json({ error: copy[capability] ?? "The owner console belongs to the network owner.", code: "E_FORBIDDEN" });
      return null;
    }
    return perimeter;
  }

  /** GET /console/invites — owner/delegate join-link states (unused/used/revoked). */
  listInvites = async (req, res) => {
    if (!(await this.#requireCapability("invites_read", req, res))) return;
    const invites = await this.invites.list({ networkId: req.query?.networkId ?? undefined });
    res.json({ invites });
  };

  /** POST /console/invites — issue a join-link invite (join URL embeds the code). */
  issueInvite = async (req, res) => {
    const perimeter = await this.#requireCapability("invite_issue", req, res);
    if (!perimeter) return;
    const network = await this.networks.get();
    if (!network) {
      return res.status(409).json({ error: "Create the hub network before issuing invites" });
    }
    const { role, maxUses } = req.body ?? {};
    // The join link names the hub it was made for: with the URL recorded,
    // verify's joinUrl is absolute and the member's front door can tell a
    // mismatched host apart (PORCH-023).
    const invite = await this.invites.issue({ networkId: network._id, role, maxUses, hubUrl: this.hubUrl ? this.hubUrl() : null });
    await this.audit.record({ networkId: network._id, did: perimeter.session.did, action: "invite_issue", detail: { inviteId: invite._id } });
    res.status(201).json({ invite });
  };

  /** POST /console/invites/revoke — instant revocation. */
  revokeInvite = async (req, res) => {
    const perimeter = await this.#requireCapability("invite_revoke", req, res);
    if (!perimeter) return;
    const { inviteId } = req.body ?? {};
    try {
      const result = await this.invites.revoke({ inviteId });
      await this.audit.record({
        networkId: result.invite.networkId,
        did: perimeter.session.did,
        action: "invite_revoke",
        detail: { inviteId },
      });
      res.json(result);
    } catch (error) {
      const status = error.code === "E_INVITE_NOT_FOUND" ? 404 : 500;
      res.status(status).json({ error: error.message });
    }
  };

  /** GET /console/members — the network's membership records (owner + delegate). */
  listMembers = async (req, res) => {
    if (!(await this.#requireCapability("members_read", req, res))) return;
    const network = await this.networks.get();
    if (!network) {
      return res.status(409).json({ error: "No network exists yet" });
    }
    const members = await this.membership.listMemberViews({ networkId: network._id });
    res.json({ members });
  };

  /** POST /console/members/revoke — instant revocation; sessions die with it. */
  revokeMember = async (req, res) => {
    const perimeter = await this.#requireCapability("member_remove", req, res);
    if (!perimeter) return;
    const network = await this.networks.get();
    if (!network) {
      return res.status(409).json({ error: "No network exists yet" });
    }
    const { did, memberId } = req.body ?? {};
    try {
      const result = await this.membership.revokeMember({ networkId: network._id, did, memberId, actor: perimeter });
      res.json(result);
    } catch (error) {
      const status = error.code === "E_MEMBER_NOT_FOUND" ? 404 : error.code === "E_FORBIDDEN" ? 403 : error.code === "E_LAST_OWNER" ? 409 : 500;
      res.status(status).json({ error: error.message, code: error.code ?? "E_INTERNAL" });
    }
  };

  /**
   * PATCH /console/members/role — promote/demote member↔delegate, owner-only
   * (PORCH-053 ac-2). The change lands immediately in the acting capability
   * surface: the membership row's role drives every read-time check.
   */
  setMemberRole = async (req, res) => {
    const perimeter = await this.#requireCapability("member_role", req, res);
    if (!perimeter) return;
    const network = await this.networks.get();
    if (!network) {
      return res.status(409).json({ error: "No network exists yet" });
    }
    const { memberId, role } = req.body ?? {};
    try {
      const membership = await this.membership.setMemberRole({ networkId: network._id, memberId, to: role, actor: perimeter });
      res.json({ membership });
    } catch (error) {
      const statusByCode = {
        E_MEMBER_NOT_FOUND: 404,
        E_ROLE_INVALID: 400,
        E_ROLE_UNCHANGED: 409,
        E_LAST_OWNER: 409,
        E_FORBIDDEN: 403,
      };
      res.status(statusByCode[error.code] ?? 500).json({ error: error.message, code: error.code ?? "E_INTERNAL" });
    }
  };

  /**
   * DELETE /console/members/:memberId — the permanent member deletion
   * (PORCH-053 ac-4), owner-only: the typed member-name confirmation is
   * validated in the service, then the origin-network deletion cascade runs
   * (authored originals, derived artifacts, authored comments) and the
   * action lands in the audit log with the confirming actor. Never a
   * single-tap surface: the typed name IS the second factor.
   */
  purgeMember = async (req, res) => {
    if (!this.memberAdmin) {
      return res.status(501).json({ error: "Member administration is not wired into this deployment" });
    }
    const perimeter = await this.#requireCapability("member_purge", req, res);
    if (!perimeter) return;
    const network = await this.networks.get();
    if (!network) {
      return res.status(409).json({ error: "No network exists yet" });
    }
    try {
      const result = await this.memberAdmin.purgeMember({
        networkId: network._id,
        memberId: req.params?.memberId,
        confirmName: req.body?.confirmName,
        actor: perimeter,
      });
      res.json(result);
    } catch (error) {
      const statusByCode = {
        E_MEMBER_NOT_FOUND: 404,
        E_CONFIRM_NAME: 400,
        E_LAST_OWNER: 409,
        E_FORBIDDEN: 403,
      };
      res.status(statusByCode[error.code] ?? 500).json({ error: error.message, code: error.code ?? "E_INTERNAL" });
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

  /** GET /console/audit — member action trail (uploads, deletions, logins),
   *  newest first, bounded pages: ?limit= and ?offset= ride the read
   *  contract (PORCH-058); the service owns the bounds. */
  listAudit = async (req, res) => {
    if (!(await this.#requireOwner(req, res))) return;
    const network = await this.networks.get();
    if (!network) {
      return res.status(409).json({ error: "No network exists yet" });
    }
    res.json(await this.audit.list({
      networkId: network._id,
      limit: req.query?.limit,
      offset: req.query?.offset,
    }));
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

  /** GET /console/media-root — the media-root setting (PORCH-054 ac-1):
   *  the current root with its readiness state (ready / volume not ready),
   *  plus the no-migration sentence the edit copy must carry plainly. */
  getMediaRoot = async (req, res) => {
    if (!(await this.#requireOwner(req, res))) return;
    if (!this.media) {
      return res.status(501).json({ error: "The media pipeline is not wired into this deployment" });
    }
    res.json({ ...await this.media.volumeStatus(), note: MEDIA_ROOT_NO_MIGRATION_COPY });
  };

  /** PUT /console/media-root — the owner edit (PORCH-054 ac-4): the
   *  proposed root runs the five startup checks; a failing path is refused
   *  with the check's reason named; a passing edit re-points the pipeline
   *  and never moves existing media (owner-run move and repoint). */
  setMediaRoot = async (req, res) => {
    if (!(await this.#requireOwner(req, res))) return;
    const network = await this.networks.get();
    if (!network) {
      return res.status(409).json({ error: "No network exists yet" });
    }
    if (!this.media) {
      return res.status(501).json({ error: "The media pipeline is not wired into this deployment" });
    }
    try {
      const before = await this.media.volumeStatus();
      const status = await this.media.changeRoot({ root: req.body?.root });
      await this.audit.record({
        networkId: network._id,
        action: "media_root_change",
        detail: {
          from: before.root,
          to: status.root,
          mediaMoved: false,
          note: "No automatic migration: the owner runs the move and repoints.",
        },
      });
      res.json({ ...status, note: MEDIA_ROOT_NO_MIGRATION_COPY });
    } catch (error) {
      const statusByCode = { E_MEDIA_ROOT_INVALID: 400, E_MEDIA_ROOT_REFUSED: 422, E_MEDIA_ROOT_UNAVAILABLE: 501 };
      res.status(statusByCode[error.code] ?? 500).json({
        error: error.message,
        code: error.code ?? "E_INTERNAL",
        check: error.check ?? null,
      });
    }
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
   * (groups ruling Oct 8 2026; the member plane is the open surface, PORCH-
   * 030 — this console surface remains for the owner's tooling). Group
   * membership must be a subset of the network membership; the group
   * service enforces it. The creating owner is recorded as the group's
   * creator (createdBy), same as the member plane records its creator.
   */
  createGroup = async (req, res) => {
    const perimeter = await this.#requireOwner(req, res);
    if (!perimeter) return;
    const network = await this.networks.get();
    if (!network) {
      return res.status(409).json({ error: "No network exists yet" });
    }
    const { name, members } = req.body ?? {};
    try {
      const group = await this.groups.create({ networkId: network._id, name, members, createdBy: perimeter.session.did });
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
   * Update-surface perimeter (PORCH-040). The owner console reaches the
   * shared update service with its owner Bearer session; `porchlight update`
   * reaches the SAME service from the hub machine with the machine-local ops
   * token the hub minted for it (<home>/state/ops-token.json, mode 0600,
   * sent as the x-porchlight-ops-token header — it can never arrive over
   * the tunnel or the LAN boundary). No third way in: any other credential
   * falls through to the standard owner guard.
   *
   * @returns {Promise<object|null>} the verified perimeter, or null after
   *   writing the error response.
   */
  async #requireUpdateAccess(req, res) {
    const opsHeader = req.headers?.["x-porchlight-ops-token"];
    const opsToken = typeof opsHeader === "string" ? opsHeader.trim() : null;
    if (opsToken && this.system?.update?.verifyToken(opsToken)) return { ops: true };
    return this.#requireOwner(req, res);
  }

  /**
   * GET /console/update — the owner-initiated release check (PORCH-040):
   * the running release plus the npm registry's latest, resolved ONLY when
   * the owner actually opens this surface (console view or `porchlight
   * update`). No background fetch exists anywhere; an unreachable registry
   * is a plain-language note, never an error crash.
   */
  updateStatus = async (req, res) => {
    if (!(await this.#requireUpdateAccess(req, res))) return;
    if (!this.system?.update) {
      return res.status(501).json({ error: "The update surface is not wired into this deployment" });
    }
    res.json({ release: await this.system.update.status() });
  };

  /**
   * POST /console/update — the single owner action that applies a newer
   * release and restarts the hub (PORCH-040). The console button and
   * `porchlight update` ride this one shared service over the same npm-backed
   * path. Already-latest is the version statement only — no install, no
   * restart; a failed apply changes nothing and the prior release keeps
   * serving. After a successful apply the hub restarts itself; the response
   * is flushed first.
   */
  applyUpdate = async (req, res) => {
    if (!(await this.#requireUpdateAccess(req, res))) return;
    if (!this.system?.update) {
      return res.status(501).json({ error: "The update surface is not wired into this deployment" });
    }
    const result = await this.system.update.apply();
    if (result.status === "failed") {
      return res.status(502).json(result);
    }
    res.json(result);
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