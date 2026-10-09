import { socialModels } from "../models.js";
import { typedError } from "./post.service.js";

/**
 * Group service (PORCH-006): within-network containers (groups ruling
 * Brian Oct 8 2026) managed by the owner or a delegate. Group membership is
 * a subset of the network's membership; a post belongs to at most one
 * network and at most one group; no cross-network groups exist in V1.
 * The feed layer serves group timelines from these containers; interactions
 * stay origin-contained everywhere.
 */
export class GroupService {
  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} groups
   * @param {import("@porchlight/shared").CollectionLike} memberships
   */
  constructor({ groups, memberships }) {
    this.groups = groups;
    this.memberships = memberships;
    this.models = socialModels;
  }

  /**
   * Create a group on a network. Every listed member must hold an active
   * membership on that network — the subset rule is enforced at creation
   * and validated again whenever a post claims the group.
   */
  async create({ networkId, name, members = [] } = {}) {
    if (!networkId || typeof name !== "string" || name.trim().length === 0) {
      throw typedError("E_GROUP_NAME_REQUIRED", "A group needs a name and a network.");
    }
    if (!Array.isArray(members)) {
      throw typedError("E_GROUP_MEMBERS_INVALID", "Group members must be a list of member DIDs.");
    }
    for (const did of members) {
      const membership = await this.memberships.findOne({ networkId, did });
      if (!membership || membership.state !== "active") {
        throw typedError("E_GROUP_NOT_MEMBER", `Group member ${did} is not a member of this network.`);
      }
    }
    const group = {
      _id: `grp_${crypto.randomUUID()}`,
      networkId,
      name: name.trim(),
      members: [...new Set(members)],
      createdAt: new Date().toISOString(),
    };
    await this.groups.insertOne(group);
    return group;
  }

  /** Owner console list of the network's groups. */
  async list({ networkId } = {}) {
    return this.groups.find({ networkId: String(networkId) });
  }
}

export default GroupService;