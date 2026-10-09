import { socialModels } from "../models.js";
import { typedError } from "./post.service.js";

/**
 * Group service (PORCH-006; creation and membership management per the
 * groups amendment, Brian Oct 14 2026): within-network containers. Every
 * network member can create a group, and the creating member manages its
 * membership — the earlier owner-or-delegate management wording is
 * superseded. Group membership is a subset of the network's membership; a
 * post belongs to at most one network and at most one group; no
 * cross-network groups exist in V1. The feed layer serves group timelines
 * from these containers; interactions stay origin-contained everywhere.
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

  /** The subset rule's predicate: one active membership row per network + DID. */
  async #activeMembership(networkId, did) {
    const membership = await this.memberships.findOne({ networkId, did });
    return membership && membership.state === "active" ? membership : null;
  }

  /**
   * Create a group on a network (PORCH-030 ac-2). Creation is open: the
   * caller — any active member of the network, owner or not — is recorded
   * as the group's creator (`createdBy`) and counts among the group's
   * members from birth (without membership the creator could never post
   * into their own group). Every listed member must hold an active
   * membership on that network — the subset rule is enforced at creation
   * and validated again whenever a post claims the group.
   */
  async create({ networkId, name, members = [], createdBy = null } = {}) {
    if (!networkId || typeof name !== "string" || name.trim().length === 0) {
      throw typedError("E_GROUP_NAME_REQUIRED", "A group needs a name and a network.");
    }
    if (!Array.isArray(members)) {
      throw typedError("E_GROUP_MEMBERS_INVALID", "Group members must be a list of member DIDs.");
    }
    if (createdBy !== null && typeof createdBy !== "string") {
      throw typedError("E_GROUP_MEMBERS_INVALID", "The group creator must be a member DID.");
    }
    const roster = [...new Set(members)];
    if (typeof createdBy === "string") {
      if (!(await this.#activeMembership(networkId, createdBy))) {
        throw typedError("E_GROUP_NOT_MEMBER", `Group creator ${createdBy} is not a member of this network.`);
      }
      if (!roster.includes(createdBy)) {
        roster.unshift(createdBy);
      }
    }
    for (const did of roster) {
      if (!(await this.#activeMembership(networkId, did))) {
        throw typedError("E_GROUP_NOT_MEMBER", `Group member ${did} is not a member of this network.`);
      }
    }
    const group = {
      _id: `grp_${crypto.randomUUID()}`,
      networkId,
      name: name.trim(),
      createdBy: createdBy ?? null,
      members: roster,
      createdAt: new Date().toISOString(),
    };
    await this.groups.insertOne(group);
    return group;
  }

  /** Member-visible list of the network's groups (PORCH-030 ac-1). */
  async list({ networkId } = {}) {
    return this.groups.find({ networkId: String(networkId) });
  }

  /** Member-readable group detail: one container, scoped to the origin network. */
  async get({ networkId, groupId } = {}) {
    const group = await this.groups.findOne({ _id: groupId });
    if (!group || group.networkId !== String(networkId)) {
      throw typedError("E_GROUP_UNKNOWN", "That group doesn't exist in this network.");
    }
    return group;
  }

  /**
   * Group membership management (PORCH-030 ac-3): the group's creator
   * manages its membership, and the network owner retains the same
   * authority on their own network. Added members must hold an active
   * membership on the group's origin network — the subset rule re-applies
   * on every addition, so group membership never outgrows network
   * membership and origin containment is unchanged.
   */
  async addMembers({ groupId, networkId, actorDid, dids = [] } = {}) {
    const group = await this.groups.findOne({ _id: groupId });
    if (!group || group.networkId !== String(networkId)) {
      throw typedError("E_GROUP_UNKNOWN", "That group doesn't exist in this network.");
    }
    if (!Array.isArray(dids) || dids.length === 0 || dids.some((did) => typeof did !== "string" || did.length === 0)) {
      throw typedError("E_GROUP_MEMBERS_INVALID", "Group members must be a list of member DIDs.");
    }
    if (group.createdBy !== actorDid) {
      const actorMembership = actorDid ? await this.#activeMembership(group.networkId, actorDid) : null;
      if (!actorMembership || actorMembership.role !== "owner") {
        throw typedError("E_GROUP_NOT_CREATOR", "Only the group's creator or the network owner manages this group's membership.");
      }
    }
    for (const did of dids) {
      if (!(await this.#activeMembership(group.networkId, did))) {
        throw typedError("E_GROUP_NOT_MEMBER", `Group member ${did} is not a member of this network.`);
      }
    }
    const members = [...new Set([...(group.members ?? []), ...dids])];
    await this.groups.updateOne({ _id: group._id }, { $set: { members } });
    return { ...group, members };
  }
}

export default GroupService;