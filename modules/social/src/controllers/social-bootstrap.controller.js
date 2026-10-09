
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
   * @param {{ record: (step: string, detail?: object) => Promise<void>, hubUrl?: () => string | null,
   *            steps?: (() => Promise<{ account?: { status: string }, network?: { status: string }, invite?: { status: string }, quota?: { status: string } }>) | null }} [ledger]
   */
  constructor(networks, invites, ledger) {
    this.networks = networks;
    this.invites = invites;
    this.ledger = ledger ?? { record: async () => {} };
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
    if (result.created) await this.ledger.record("network", { detail: `network "${result.network.name}" created` });
    res.status(result.created ? 201 : 200).json(result);
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