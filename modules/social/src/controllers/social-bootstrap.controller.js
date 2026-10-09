
/**
 * Bootstrap controller for the social domain. Transport-specific:
 * translates between HTTP and the domain; records bootstrap progress into
 * the system ledger the server injects. No domain logic here.
 */
export class SocialBootstrapController {
  /**
   * @param {NetworkService} networks
   * @param {InviteService} invites
   * @param {{ record: (step: string, detail?: object) => Promise<void>, hubUrl?: () => string | null }} [ledger]
   */
  constructor(networks, invites, ledger) {
    this.networks = networks;
    this.invites = invites;
    this.ledger = ledger ?? { record: async () => {} };
  }

  /** GET /network — current network state for the bootstrap page. */
  get = async (_req, res) => {
    res.json({ exists: (await this.networks.get()) !== null, network: await this.networks.get() });
  };

  /** POST /bootstrap/network — create the owner network (idempotent). */
  createNetwork = async (req, res) => {
    const { name, ownerAccountId } = req.body ?? {};
    let result;
    try {
      result = await this.networks.createNetwork({ name, ownerAccountId });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    if (result.created) await this.ledger.record("network", { detail: `network "${result.network.name}" created` });
    res.status(result.created ? 201 : 200).json(result);
  };

  /** POST /bootstrap/invite — issue a join-link invite (new token each call). */
  issueInvite = async (req, res) => {
    const network = await this.networks.get();
    if (!network) {
      return res.status(409).json({ error: "Create the hub network before issuing invites" });
    }
    const { role, maxUses, hubUrl } = req.body ?? {};
    const invite = await this.invites.issue({ networkId: network._id, role, maxUses, hubUrl: hubUrl ?? null });
    const joinUrl = this.ledger.hubUrl ? this.ledger.hubUrl() : null;
    await this.ledger.record("invite", { detail: `invite ${invite._id} issued`, inviteId: invite._id });
    res.status(201).json({ invite, joinUrl });
  };

  /** POST /bootstrap/invite/revoke — instant revocation. */
  revokeInvite = async (req, res) => {
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