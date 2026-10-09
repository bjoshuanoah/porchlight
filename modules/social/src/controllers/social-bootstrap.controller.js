
/**
 * Bootstrap controller for the social domain. Transport-specific:
 * translates between HTTP and the domain; records bootstrap progress into
 * the system ledger the server injects. No domain logic here.
 *
 * Bootstrap-era gating (PORCH-015): a bootstrap write on a step is allowed
 * only while that step's ledger status is not yet "complete"; once the era
 * closes, owner management moves to the console. The gate is fail-closed —
 * when the ledger cannot report steps (absent, throwing, or a non-object
 * payload), every gated surface is closed.
 */
export class SocialBootstrapController {
  /**
   * @param {NetworkService} networks
   * @param {InviteService} invites
   * @param {import("../services/membership.service.js").MembershipService} membership
   * @param {{ record: (step: string, detail?: object) => Promise<void>, hubUrl?: () => string | null,
   *            steps?: (() => Promise<{ account?: { status: string }, network?: { status: string }, invite?: { status: string }, quota?: { status: string } }>) | null }} [ledger]
   * @param {(did: string) => Promise<{ grantId: string, token: string, expiresAt: string }>} [mintOwnerDeviceLink]
   *   Identity-plane device-link mint for the owner-bind handoff (PORCH-031);
   *   null when identity serving is disabled.
   */
  constructor(networks, invites, membership, ledger, mintOwnerDeviceLink = null) {
    this.networks = networks;
    this.invites = invites;
    this.membership = membership;
    this.ledger = ledger ?? { record: async () => {} };
    this.mintOwnerDeviceLink = mintOwnerDeviceLink;
  }

  /**
   * The era for a step is open only while its ledger status is not exactly
   * "complete" (pending/failed/absent-step-row all count as open).
   * Fail-closed: steps missing from the ledger, a throwing steps() call, or
   * an unusable steps payload closes the era.
   */
  async #eraOpen(step) {
    if (!this.ledger || typeof this.ledger.steps !== "function") return false;
    let steps;
    try {
      steps = await this.ledger.steps();
    } catch {
      return false;
    }
    if (!steps || typeof steps !== "object") return false;
    return steps[step]?.status !== "complete";
  }

  /** Writes the closed-era 403 when the step's era is shut; true = closed. */
  async #eraClosed(res, step) {
    if (await this.#eraOpen(step)) return false;
    res.status(403).json({ error: "Bootstrap is closed; use the owner console.", code: "E_BOOTSTRAP_CLOSED" });
    return true;
  }

  /** GET /network — current network state for the bootstrap page. */
  get = async (_req, res) => {
    res.json({ exists: (await this.networks.get()) !== null, network: await this.networks.get() });
  };

  /** POST /bootstrap/network — create the owner network (idempotent). */
  createNetwork = async (req, res) => {
    if (await this.#eraClosed(res, "network")) return;
    const { name, ownerAccountId, ownerDid } = req.body ?? {};
    let result;
    try {
      result = await this.networks.createNetwork({ name, ownerAccountId, ownerDid });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    // Founder-root binding (PORCH-018): the owner who creates the network
    // leaves bootstrap already a member of it — no invite consumed, no
    // manual bind step. Idempotent on resume; a request without an
    // ownerDid (or a DID that is not the network row's ownerDid) binds
    // nothing and returns the network result unchanged.
    const membership = ownerDid
      ? await this.membership.bindFounder({ network: result.network, did: ownerDid })
      : null;
    // Owner-bind handoff (PORCH-031): bootstrap possession is the grant's
    // authorization — the same era gate this write rides. A bound founder
    // leaves with a single-use, 24-hour device-link grant (device-link
    // class TTL) for their own identity; the CLI prints it as the URL that
    // binds the owner's browser device. Mint failure fails the step BEFORE
    // the ledger records the network complete, so the era stays open for a
    // re-run (the network write itself is idempotent).
    const ownerBind =
      membership && this.mintOwnerDeviceLink
        ? { did: membership.did, ...(await this.mintOwnerDeviceLink(membership.did)) }
        : null;
    // Recorded on EVERY successful era-open completion — including the
    // idempotent re-run of a hub whose network row exists but whose ledger
    // row was never written (a mint failure the first time through). Without
    // this, that hub's network step would never close its era.
    await this.ledger.record("network", {
      detail: result.created ? `network "${result.network.name}" created` : `network "${result.network.name}" already present`,
    });
    res
      .status(result.created ? 201 : 200)
      .json(membership ? { ...result, membership, ...(ownerBind ? { ownerBind } : {}) } : result);
  };

  /** POST /bootstrap/invite — issue a join-link invite (new token each call). */
  issueInvite = async (req, res) => {
    if (await this.#eraClosed(res, "invite")) return;
    const network = await this.networks.get();
    if (!network) {
      return res.status(409).json({ error: "Create the hub network before issuing invites" });
    }
    const { role, maxUses, hubUrl } = req.body ?? {};
    const invite = await this.invites.issue({
      networkId: network._id,
      role,
      maxUses,
      hubUrl: hubUrl ?? (this.ledger.hubUrl ? this.ledger.hubUrl() : null),
    });
    await this.ledger.record("invite", { detail: `invite ${invite._id} issued`, inviteId: invite._id });
    res.status(201).json({ invite, joinUrl: invite.joinUrl });
  };

  /** POST /bootstrap/invite/revoke — instant revocation. */
  revokeInvite = async (req, res) => {
    if (await this.#eraClosed(res, "invite")) return;
    const { inviteId } = req.body ?? {};
    try {
      const result = await this.invites.revoke({ inviteId });
      res.json(result);
    } catch (error) {
      const status = error.code === "E_INVITE_NOT_FOUND" ? 404 : 500;
      res.status(status).json({ error: error.message });
    }
  };
}

export default SocialBootstrapController;