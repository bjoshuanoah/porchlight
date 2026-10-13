import { socialModels } from "../models.js";

/**
 * Network service. Owns the network surface for the social domain: creation
 * during owner bootstrap (network creation completes over the tunnel,
 * Porchlight Server TS 2). Models stay social-owned; no identity imports.
 */
export class NetworkService {
  /**
   * @param {import("@porchlight/shared").StoreLike["collection"]} networks
   */
  constructor(networks) {
    this.networks = networks;
    this.models = socialModels;
  }

  async get() {
    return this.networks.findOne({});
  }

  /**
   * Create the owner's first network. Idempotent at the bootstrap level:
   * an existing network is returned with created:false.
   *
   * The owner identity is bound two ways: `ownerDid` is the DID the
   * founder-owner rule keys on (membership admission for that DID is forced
   * to the owner role — the hub account proves ownership, never an invite),
   * and `ownerAccountId` records the owning account for system-side joins.
   */
  async createNetwork({ name, ownerAccountId, ownerDid } = {}) {
    if (!name) {
      const error = new Error("network name required");
      error.code = "E_NAME_REQUIRED";
      throw error;
    }
    const existing = await this.networks.findOne({});
    if (existing) return { created: false, network: existing };
    const network = {
      _id: `net_${crypto.randomUUID()}`,
      name: String(name),
      ownerAccountId: ownerAccountId ?? null,
      ownerDid: ownerDid ?? null,
      // Quantity-only owner limits start unset: reported, never defaulted.
      quota: { storageCeilingMb: null, retentionDays: null },
      createdAt: new Date().toISOString(),
    };
    await this.networks.insertOne(network);
    return { created: true, network };
  }

  /**
   * PORCH-065: the address re-point's network half — record the hub's
   * serving origin on the network row (`hubUrl`, a self-reference state
   * field of record; link minting prefers it). Idempotent: re-writing the
   * same URL is a harmless no-op.
   */
  async recordHubUrl(url) {
    const network = await this.networks.findOne({});
    if (!network) {
      const error = new Error("no network exists on this hub yet");
      error.code = "E_NETWORK_NOT_FOUND";
      throw error;
    }
    if (network.hubUrl === url) return network;
    await this.networks.updateOne({ _id: network._id }, { $set: { hubUrl: url } });
    return this.networks.findOne({ _id: network._id });
  }
}

export default NetworkService;