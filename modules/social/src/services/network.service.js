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
   */
  async createNetwork({ name, ownerAccountId } = {}) {
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
      createdAt: new Date().toISOString(),
    };
    await this.networks.insertOne(network);
    return { created: true, network };
  }
}

export default NetworkService;