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
// Group visibility (PORCH-068, Brian Oct 14 2026): every group carries
// `visibility` — private (invite-only, members see the posts, timeline, and
// roster) or public (the whole network views the group and its posts).
// Groups that predate the visibility field resolve PRIVATE — the ruling's
// explicit default for existing groups.
export const GROUP_VISIBILITIES = ["private", "public"];

/** Resolve a group's effective visibility: anything absent/unknown is private. */
export function groupVisibility(group) {
  return group?.visibility === "public" ? "public" : "private";
}

/** The visibility predicate every guarded read applies: public, or a member. */
export function canSeeGroup(group, did) {
  return groupVisibility(group) === "public" || (Boolean(did) && Array.isArray(group?.members) && group.members.includes(did));
}

/** Filter group rows down to what one viewer may see. */
export function groupVisibleRows(rows, did) {
  return (rows ?? []).filter((group) => canSeeGroup(group, did));
}

/**
 * Feed/post read filter (ac-2): a private-group post never renders for a
 * non-member on any post surface. `groupsById` maps the origin's group ids
 * to documents; a post whose group is missing keeps rendering (the
 * containment gate refuses writes into unknown groups, so this is a
 * dangling legacy reference, not a visibility decision).
 */
export function postVisibleToViewer(post, groupsById, did) {
  if (!post?.groupId) return true;
  return canSeeGroup(groupsById.get(String(post.groupId)), did);
}

export class GroupService {
  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} groups
   * @param {import("@porchlight/shared").CollectionLike} memberships
   * @param {import("./membership.service.js").MembershipService} [membership]
   */
  constructor({ groups, memberships, membership = null }) {
    this.groups = groups;
    this.memberships = memberships;
    this.membership = membership;
    this.models = socialModels;
  }

  /** A group read carries its roster's family-facing names (PORCH-034). */
  async #named(group) {
    if (!this.membership?.attributionNames || !Array.isArray(group?.members) || group.members.length === 0) {
      return { ...group, names: {} };
    }
    const resolved = await this.membership.attributionNames({ networkId: group.networkId, dids: group.members });
    const names = {};
    for (const [did, value] of resolved) names[did] = value ?? null;
    return { ...group, names };
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
  async create({ networkId, name, members = [], createdBy = null, visibility = "private" } = {}) {
    if (!networkId || typeof name !== "string" || name.trim().length === 0) {
      throw typedError("E_GROUP_NAME_REQUIRED", "A group needs a name and a network.");
    }
    // Visibility (PORCH-068 ac-1): private|public; a new group defaults
    // private unless the creator explicitly picks public at creation.
    if (!GROUP_VISIBILITIES.includes(visibility)) {
      throw typedError("E_GROUP_VISIBILITY_INVALID", "A group is either private or public.");
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
      visibility,
      createdAt: new Date().toISOString(),
    };
    await this.groups.insertOne(group);
    return group;
  }

  /**
   * Member-visible list of the network's groups (PORCH-030 ac-1, visibility
   * per PORCH-068): a private group renders only for its members, a public
   * group renders for every member. `viewerDid` null (the owner console's
   * management read) skips the filter — the console lists every container
   * the owner may still manage.
   */
  async list({ networkId, viewerDid = null } = {}) {
    const rows = await this.groups.find({ networkId: String(networkId) });
    return viewerDid === null ? rows : groupVisibleRows(rows, viewerDid);
  }

  /** Member-readable group detail: one container, scoped to the origin network.
   *  The read carries the roster's family-facing names (the Members view's
   *  render rows; PORCH-034 attribution at read time). A private group's
   *  detail — its timeline and member list — renders only for group members
   *  (PORCH-068 ac-2); a non-member is refused exactly as if the group did
   *  not exist. `viewerDid` null (the owner console's management read) skips
   *  the member gate. */
  async get({ networkId, groupId, viewerDid = null } = {}) {
    const group = await this.groups.findOne({ _id: groupId });
    if (!group || group.networkId !== String(networkId)) {
      throw typedError("E_GROUP_UNKNOWN", "That group doesn't exist in this network.");
    }
    if (viewerDid !== null && !canSeeGroup(group, viewerDid)) {
      // Concealing refusal: a private group a member does not belong to is
      // not a member-plane fact — unknown-shaped, like any foreign group.
      throw typedError("E_GROUP_UNKNOWN", "That group doesn't exist in this network.");
    }
    return this.#named(group);
  }

  /**
   * Visibility change (PORCH-068 ac-1): the managing member — the group's
   * creator, or the network owner on their network — may change a group's
   * visibility later. The same authorization as membership management.
   */
  async updateVisibility({ groupId, networkId, actorDid, visibility } = {}) {
    const group = await this.groups.findOne({ _id: groupId });
    if (!group || group.networkId !== String(networkId)) {
      throw typedError("E_GROUP_UNKNOWN", "That group doesn't exist in this network.");
    }
    if (!GROUP_VISIBILITIES.includes(visibility)) {
      throw typedError("E_GROUP_VISIBILITY_INVALID", "A group is either private or public.");
    }
    if (group.createdBy !== actorDid) {
      const actorMembership = actorDid ? await this.#activeMembership(group.networkId, actorDid) : null;
      if (!actorMembership || actorMembership.role !== "owner") {
        throw typedError("E_GROUP_NOT_CREATOR", "Only the group's creator or the network owner manages this group.");
      }
    }
    await this.groups.updateOne({ _id: group._id }, { $set: { visibility } });
    return this.#named({ ...group, visibility });
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
    return this.#named({ ...group, members });
  }
}

export default GroupService;