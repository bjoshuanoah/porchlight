import { createHash } from "node:crypto";
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
// Group visibility (PORCH-068, Brian Oct 14 2026; delivery refined same
// day and the full membership lifecycle ruled the same day): every group
// carries `visibility` — private (invite-only, invisible to non-members
// everywhere) or public (discoverable, viewable, self-joinable by the
// whole network). Groups that predate the visibility field resolve
// PRIVATE — the ruling's explicit default for existing groups.
export const GROUP_VISIBILITIES = ["private", "public"];

/** Resolve a group's effective visibility: anything absent/unknown is private. */
export function groupVisibility(group) {
  return group?.visibility === "public" ? "public" : "private";
}

/**
 * The VIEW predicate (discovery and view access at the group itself): a
 * public group renders to every network member, a private group only to
 * its members. The visibilities never differ in feed broadcast — delivery
 * is membership-gated for both (groupDeliversTo).
 */
export function canSeeGroup(group, did) {
  return groupVisibility(group) === "public" || (Boolean(did) && Array.isArray(group?.members) && group.members.includes(did));
}

/** Filter group rows down to what one viewer may see. */
export function groupVisibleRows(rows, did) {
  return (rows ?? []).filter((group) => canSeeGroup(group, did));
}

/**
 * The group-settings OPEN predicate (PORCH-088): the member-plane
 * visibility rule carries, plus the network owner — the superuser must be
 * able to open the group's settings surface to exercise their authority
 * on it (the shipped management-read contract already names the owner as
 * the party that may manage every container: the console list skips the
 * member gate). The plain-member visibility law (PORCH-068) is untouched;
 * this predicate is read-path only and never widens delivery.
 */
export function canOpenGroupSettings(group, viewerDid, viewerMembership = null) {
  if (canSeeGroup(group, viewerDid)) return true;
  return Boolean(viewerMembership && viewerMembership.role === "owner");
}

/**
 * The FEED-DELIVERY predicate (Brian Oct 14, verbatim: "A public group
 * should also never show up on any non-member timeline unless they go to
 * the group and join the group"): a group post reaches a member's own
 * feed, ranked section, and event stream only while they hold membership
 * in that group — private and public alike. Delivery resolves the live
 * roster at read time.
 */
export function groupDeliversTo(group, did) {
  return Boolean(group) && Array.isArray(group.members) && did && group.members.includes(did);
}

/**
 * VIEW-surface post filter (ac-2): a private-group post never resolves for
 * a non-member on any viewing surface. `groupsById` maps the origin's
 * group ids to documents; a post whose group is missing keeps rendering
 * (the containment gate refuses writes into unknown groups, so this is a
 * dangling legacy reference, not a visibility decision).
 */
export function postVisibleToViewer(post, groupsById, did) {
  if (!post?.groupId) return true;
  return canSeeGroup(groupsById.get(String(post.groupId)), did);
}

/**
 * DELIVERY-surface post filter (ac-2, refined): a group post rides a
 * member's own feed and ranked section only for a member of that group,
 * private and public alike. Missing-document groupIds pass (see above).
 */
export function postDeliversToViewer(post, groupsById, did) {
  if (!post?.groupId) return true;
  return groupDeliversTo(groupsById.get(String(post.groupId)), did);
}

/** A group's blocked-member set as it stands in storage (legacy rows: empty). */
export function blockedMembersOf(group) {
  return Array.isArray(group?.blockedMemberIds) ? group.blockedMemberIds.filter((did) => typeof did === "string" && did) : [];
}

/**
 * The ruled accent palette (PORCH-088, group color): the color is a
 * palette-validated token — presentation data only, never a ranking or
 * delivery input. Values are the warm hub-family accents tuned to the UI
 * design tokens [Assumed: palette values, confirm at build]; `null`
 * (unset / reset) is the neutral default every surface renders.
 */
export const GROUP_COLOR_PALETTE = Object.freeze([
  "#D88A24", // amber — the hub primary
  "#C4674B", // terracotta
  "#C9A227", // gold
  "#7E8F6E", // sage
  "#4E8F86", // teal
  "#5B7FA6", // blue
  "#8E6E95", // plum
  "#B0578D", // rose
]);
export const GROUP_NEUTRAL_COLOR = null;

/** The color write's validator: a palette token, or null (the neutral reset). */
export function validGroupColor(color) {
  if (color === null) return true;
  return typeof color === "string" && GROUP_COLOR_PALETTE.includes(color);
}

/**
 * Management authority's predicate (PORCH-088, TS 17): the group's managing
 * member — the creator (`createdBy`) — or the network owner, who rides as
 * superuser on every mutation (the shipped ownership machinery). Module-level
 * so the post-removal path (post.service) authorizes against the same rule
 * without a second copy that could drift.
 */
export function isGroupManager(group, actorDid, actorMembership = null) {
  if (!group) return false;
  if (group.createdBy && group.createdBy === actorDid) return true;
  return Boolean(actorMembership && actorMembership.role === "owner");
}

/** The group avatar's client-serving metas: per-rung square stamps, no byte internals. */
export function groupAvatarMetas(avatar) {
  if (!avatar || !Array.isArray(avatar.renditions) || avatar.renditions.length === 0) return null;
  const metas = {};
  for (const rung of avatar.renditions) {
    metas[rung.kind] = {
      kind: rung.kind,
      width: rung.width,
      height: rung.height,
      contentType: rung.contentType,
      sha256: rung.sha256,
    };
  }
  return metas;
}

export class GroupService {
  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} groups
   * @param {import("@porchlight/shared").CollectionLike} memberships
   * @param {import("./membership.service.js").MembershipService} [membership]
   * @param {{ put: (key: string, bytes: Buffer) => Promise<unknown>,
   *           get: (key: string) => Promise<Buffer|null>,
   *           has: (key: string) => Promise<boolean>,
   *           delete: (key: string) => Promise<boolean> } | null} [blobs]
   *   PORCH-088: the media pipeline's content-addressed blob store (the
   *   hub assembly passes the same store the media and avatar planes use —
   *   group avatar bytes share the media root). Null → the avatar write
   *   and its serving refuse plainly (never a silent no-op).
   * @param {(bytes: Buffer, contentType: string) => Promise<Array<{kind:string,width:number,height:number,contentType:string,bytes:Buffer}>>} [treatImage]
   *   PORCH-088: the identity plane's member-avatar ingest treatment
   *   (deterministic square crop then compression), wired by the hub
   *   assembly — social imports no identity source, CI-enforced. Null →
   *   the avatar write refuses plainly.
   * @param {import("./push.service.js").PushService} [push=null]
   *   PORCH-088: the per-group notification preference resolves at read
   *   time through the push service (the persisted row read-at-send/read-
   *   at-read contract — never cached). Absent → the detail read serves
   *   the unset default (ON).
   */
  constructor({ groups, memberships, membership = null, blobs = null, treatImage = null, push = null }) {
    this.groups = groups;
    this.memberships = memberships;
    this.membership = membership;
    this.blobs = blobs;
    this.treatImage = treatImage;
    this.push = push;
    this.models = socialModels;
  }

  /** A group read carries its roster's family-facing names (PORCH-034). */
  async #named(group) {
    if (!this.membership?.attributionNames || !Array.isArray(group?.members) || group.members.length === 0) {
      return { ...group, names: {} };
    }
    const resolved = await this.membership.attributionNames({ networkId: group.networkId, dids: group.members });
    const names = {};
    for (const [did, value] of resolved) names[did] = value?.name ?? null;
    return { ...group, names };
  }

  /** The subset rule's predicate: one active membership row per network + DID. */
  async #activeMembership(networkId, did) {
    const membership = await this.memberships.findOne({ networkId, did });
    return membership && membership.state === "active" ? membership : null;
  }

  /**
   * The lifecycle's authority check (PORCH-030 ac-3, carried): the group's
   * creator manages it, and the network owner retains the same authority
   * on their own network.
   */
  async #assertManager(group, actorDid, what = "membership") {
    if (group.createdBy === actorDid) return;
    const actorMembership = actorDid ? await this.#activeMembership(group.networkId, actorDid) : null;
    if (!actorMembership || actorMembership.role !== "owner") {
      throw typedError("E_GROUP_NOT_CREATOR", `Only the group's creator or the network owner manages this group's ${what}.`);
    }
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
      // PORCH-068 lifecycle: removed members land here atomically with their
      // removal and cannot self-join or be invited back until unblocked.
      blockedMemberIds: [],
      visibility,
      createdAt: new Date().toISOString(),
    };
    await this.groups.insertOne(group);
    return group;
  }

  /**
   * Member-visible list of the network's groups (PORCH-030 ac-1, visibility
   * per PORCH-068): a private group renders only for its members, a public
   * group renders for every member (the self-serve join affordance reads
   * these rows). Every row carries its resolved `visibility` and whether
   * `viewerDid` holds membership. `viewerDid` null (the owner console's
   * management read) skips the visibility filter — the console lists every
   * container the owner may still manage, flagged the same way.
   */
  async list({ networkId, viewerDid = null } = {}) {
    const rows = await this.groups.find({ networkId: String(networkId) });
    return (viewerDid === null ? rows : groupVisibleRows(rows, viewerDid)).map((group) => ({
      ...group,
      visibility: groupVisibility(group),
      isMember: Boolean(viewerDid) && Array.isArray(group.members) && group.members.includes(viewerDid),
      // PORCH-088 presentation rides the index rows too (square rung
      // stamps, palette accent): the chips and headers render from these
      // without a second fetch. Presentation data only.
      avatar: groupAvatarMetas(group.avatar),
      color: group.color ?? GROUP_NEUTRAL_COLOR,
    }));
  }

  /** Member-readable group detail: one container, scoped to the origin network.
   *  The read carries the roster's family-facing names (the Members view's
   *  render rows; PORCH-034 attribution at read time). A private group's
   *  detail — its timeline and member list — renders only for group members
   *  (PORCH-068 ac-2); a non-member is refused exactly as if the group did
   *  not exist. `viewerDid` null (the owner console's management read) skips
   *  the member gate.
   *  PORCH-088 menu contract (ac-7): the same one fetch also serves the
   *  settings menu's data — presentation (the avatar rendition set's square
   *  geometry stamps, the palette color), the VIEWER's resolved per-group
   *  notification state, and the authority flags (managing member / network
   *  owner) so the client renders only the entries the role can exercise.
   *  Authority stays server-enforced on every write; the flags only shape
   *  what the client shows. */
  async get({ networkId, groupId, viewerDid = null } = {}) {
    const group = await this.groups.findOne({ _id: groupId });
    if (!group || group.networkId !== String(networkId)) {
      throw typedError("E_GROUP_UNKNOWN", "That group doesn't exist in this network.");
    }
    const viewerMembership = viewerDid ? await this.#activeMembership(group.networkId, viewerDid) : null;
    if (viewerDid !== null) {
      // PORCH-088: the network owner may open a group they hold no
      // membership in (their superuser authority needs its read); a plain
      // member still faces the concealing refusal — a private group they
      // do not belong to is unknown-shaped, like any foreign group.
      if (!canOpenGroupSettings(group, viewerDid, viewerMembership)) {
        throw typedError("E_GROUP_UNKNOWN", "That group doesn't exist in this network.");
      }
    }
    const named = await this.#named(group);
    // The menu contract's flags + presentation resolved here (service layer):
    // a DID with no active membership resolves no owner flag.
    const notifications = viewerDid && this.push
      ? await this.push.resolveGroupPreference({ did: viewerDid, groupId: group._id })
      : true;
    return {
      ...named,
      visibility: groupVisibility(group),
      isMember: Boolean(viewerDid) && Array.isArray(group.members) && group.members.includes(viewerDid),
      // PORCH-088 presentation: square rung stamps only — byte internals
      // (blob keys) never serve. The color rides as stored; null renders
      // neutral (presentation data only, never a ranking or delivery input).
      avatar: groupAvatarMetas(group.avatar),
      color: group.color ?? GROUP_NEUTRAL_COLOR,
      notifications: { perGroup: notifications },
      // The two distinct flags the menu renders: the group's managing
      // member is its creator; the network owner is the superuser role.
      isManagingMember: Boolean(viewerDid && group.createdBy === viewerDid),
      isNetworkOwner: Boolean(viewerMembership && viewerMembership.role === "owner"),
    };
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
    await this.#assertManager(group, actorDid);
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
    await this.#assertManager(group, actorDid);
    const blocked = new Set(blockedMembersOf(group));
    for (const did of dids) {
      if (blocked.has(did)) {
        // The lifecycle gate (Brian Oct 14, lifecycle ruling): a removed
        // member cannot be invited back until the manager's unblock act.
        throw typedError("E_GROUP_BLOCKED", "A removed member cannot be added back until the group's manager unblocks them.");
      }
      if (!(await this.#activeMembership(group.networkId, did))) {
        throw typedError("E_GROUP_NOT_MEMBER", `Group member ${did} is not a member of this network.`);
      }
    }
    const members = [...new Set([...(group.members ?? []), ...dids])];
    await this.groups.updateOne({ _id: group._id }, { $set: { members } });
    return this.#named({ ...group, members });
  }

  /**
   * Self-serve join (PORCH-068 lifecycle ruling, Brian Oct 14: "join group
   * button with no authorization step: no approval flow, no request
   * stage"): a public group is joinable by any active member of the
   * network, and joining turns on that member's feed delivery immediately
   * (the delivery predicate is the live roster). Private groups resolve
   * unknown-shaped for a non-member — the managing member is the only path
   * in. A removed (blocked) member cannot re-join until the manager's
   * unblock act lifts the entry. Already being a member is a no-op read,
   * never a mutation.
   */
  async join({ groupId, networkId, did } = {}) {
    const group = await this.groups.findOne({ _id: groupId });
    if (!group || group.networkId !== String(networkId)) {
      throw typedError("E_GROUP_UNKNOWN", "That group doesn't exist in this network.");
    }
    const members = Array.isArray(group.members) ? group.members : [];
    if (members.includes(did)) {
      // Already a member: a no-op read, never a mutation.
      return this.get({ networkId: group.networkId, groupId, viewerDid: did });
    }
    if (groupVisibility(group) === "private") {
      // Invite-only and invisibility agree: the concealing refusal — a
      // private group is not a member-plane fact for this joiner; its
      // managing member is the only path in.
      throw typedError("E_GROUP_UNKNOWN", "That group doesn't exist in this network.");
    }
    if (blockedMembersOf(group).includes(did)) {
      throw typedError("E_GROUP_BLOCKED", "You were removed from this group and cannot re-join until the group's manager unblocks you.");
    }
    if (!(await this.#activeMembership(group.networkId, did))) {
      throw typedError("E_GROUP_NOT_MEMBER", `Group joiner ${did} is not a member of this network.`);
    }
    const roster = [...new Set([...(group.members ?? []), did])];
    await this.groups.updateOne({ _id: group._id }, { $set: { members: roster } });
    return this.get({ networkId: group.networkId, groupId, viewerDid: did });
  }

  /**
   * Member removal (PORCH-068 lifecycle ruling): the managing member
   * removes a member, which leaves memberIds and enters blockedMemberIds
   * in ONE storage write — removal and block are atomic, with the
   * member-controlled state (their authored posts) untouched.
   */
  async removeMember({ groupId, networkId, actorDid, did } = {}) {
    const group = await this.groups.findOne({ _id: groupId });
    if (!group || group.networkId !== String(networkId)) {
      throw typedError("E_GROUP_UNKNOWN", "That group doesn't exist in this network.");
    }
    if (typeof did !== "string" || did.length === 0) {
      throw typedError("E_GROUP_MEMBERS_INVALID", "A removal names the member DID.");
    }
    await this.#assertManager(group, actorDid);
    if (!Array.isArray(group.members) || !group.members.includes(did)) {
      throw typedError("E_GROUP_MEMBER_UNKNOWN", "That member is not in this group.");
    }
    const members = group.members.filter((member) => member !== did);
    const blockedMemberIds = [...blockedMembersOf(group), did];
    await this.groups.updateOne({ _id: group._id }, { $set: { members, blockedMemberIds } });
    return this.#named({ ...group, members, blockedMemberIds });
  }

  /**
   * Unblock (PORCH-068 lifecycle ruling): lifting a blocked entry is the
   * managing member's act; the member then re-joins themselves (self-serve,
   * public) or is added (creator's invite, private). A DID that carries no
   * entry is a no-op read, never a mutation.
   */
  async unblock({ groupId, networkId, actorDid, did } = {}) {
    const group = await this.groups.findOne({ _id: groupId });
    if (!group || group.networkId !== String(networkId)) {
      throw typedError("E_GROUP_UNKNOWN", "That group doesn't exist in this network.");
    }
    if (typeof did !== "string" || did.length === 0) {
      throw typedError("E_GROUP_MEMBERS_INVALID", "An unblock names the member DID.");
    }
    await this.#assertManager(group, actorDid);
    if (!blockedMembersOf(group).includes(did)) {
      return this.get({ networkId: group.networkId, groupId, viewerDid: actorDid });
    }
    const blockedMemberIds = blockedMembersOf(group).filter((member) => member !== did);
    await this.groups.updateOne({ _id: group._id }, { $set: { blockedMemberIds } });
    return this.get({ networkId: group.networkId, groupId, viewerDid: actorDid });
  }

  #assertAvatarPlane() {
    if (!this.blobs || !this.treatImage) {
      throw typedError(
        "E_GROUP_AVATAR_UNAVAILABLE",
        "The hub's media storage isn't available, so group photos can't be stored right now.",
      );
    }
  }

  /** Retire a rung set's blobs; `keep` holds any concurrent set's keys. */
  async #retireGroupRungs(renditions, keep = new Set()) {
    if (!this.blobs || !Array.isArray(renditions)) return;
    for (const rung of renditions) {
      if (rung?.blobKey && !keep.has(rung.blobKey)) await this.blobs.delete(rung.blobKey);
    }
  }

  /**
   * Set the group's avatar (PORCH-088 ac-2, managing-member authority): the
   * identity plane's member-avatar ingest treatment rides byte-for-byte —
   * deterministic square crop THEN compression, square geometry stamps on
   * every rung, the uploaded rectangular bytes are treatment input only
   * (no rectangular original is ever retained). The prior committed set
   * retires whole on replace (never accumulated; replaced renditions become
   * unreachable content, never a cache-poison risk). Serving is the group's
   * own rendition surface: hub origin only, content-addressed, long-lived
   * cache. Refusals (unsupported type, too large, undecodable) are the
   * treatment's plain-language states with zero mutation.
   *
   * @param {{ groupId: string, networkId: string, actorDid: string, actorDeviceId: string|null, bytes: Buffer, contentType: string, payload: object, signature: string }} args
   */
  async setAvatar({ groupId, networkId, actorDid, actorDeviceId = null, bytes, contentType, payload, signature } = {}) {
    const group = await this.groups.findOne({ _id: groupId });
    if (!group || group.networkId !== String(networkId)) {
      throw typedError("E_GROUP_UNKNOWN", "That group doesn't exist in this network.");
    }
    await this.#assertManager(group, actorDid, "presentation");
    // The device-signed write convention: the declaration rides the signed
    // payload verify against the origin enrollment before anything mutates
    // (the member-avatar route's declaration shape, scoped "group-avatar").
    if (!payload || typeof payload !== "object" || payload.action !== "set" || payload.scope !== "group-avatar") {
      throw typedError("E_GROUP_AVATAR_DECLARATION_INVALID", "The group photo declaration doesn't match this request. Try again.");
    }
    await this.membership.verifyMemberWrite({
      networkId: String(networkId),
      did: actorDid,
      deviceId: actorDeviceId,
      payload,
      signature,
    });
    this.#assertAvatarPlane();
    const buffer = Buffer.isBuffer(bytes) && bytes.length > 0 ? bytes : null;
    if (!buffer) {
      throw typedError("E_GROUP_AVATAR_REQUIRED", "Choose a photo for the group first.");
    }
    if (!Number.isInteger(payload.size) || payload.size !== buffer.length) {
      throw typedError("E_GROUP_AVATAR_DECLARATION_INVALID", "The photo bytes don't match the declaration. Choose the file again.");
    }
    if (payload.sha256 !== createHash("sha256").update(buffer).digest("hex")) {
      throw typedError("E_GROUP_AVATAR_SHA_MISMATCH", "The photo didn't arrive intact — its fingerprint doesn't match. Nothing was stored.");
    }
    // The treatment owns the plain-language refusals (unsupported type, over
    // cap, undecodable) and throws BEFORE anything is stored: zero mutation.
    const treated = await this.treatImage(buffer, contentType);
    const stored = [];
    for (const rung of treated) {
      const sha256 = createHash("sha256").update(rung.bytes).digest("hex");
      await this.blobs.put(sha256, rung.bytes);
      stored.push({ kind: rung.kind, width: rung.width, height: rung.height, contentType: rung.contentType, sha256, blobKey: sha256 });
    }
    const prior = Array.isArray(group.avatar?.renditions) ? group.avatar.renditions : [];
    await this.groups.updateOne(
      { _id: group._id },
      { $set: { avatar: { renditions: stored, updatedAt: new Date().toISOString() } } },
    );
    await this.#retireGroupRungs(prior, new Set(stored.map((rung) => rung.blobKey)));
    const updated = await this.groups.findOne({ _id: group._id });
    return this.#named({ ...updated, avatar: groupAvatarMetas(updated.avatar) });
  }

  /**
   * Set the group's color (PORCH-088 ac-3, managing-member authority): a
   * palette-validated accent token; `null` resets to the neutral default.
   * color is presentation data only — group chips stay color-independent
   * server-side, and nothing in the ranking or delivery reads it.
   *
   * The write is device-signed (the hub's device-signed JSON-body write
   * convention): payload { scope: "group-avatar", action: "color", color },
   * signature verified against the origin enrollment before any mutation.
   */
  async setColor({ groupId, networkId, actorDid, actorDeviceId = null, color, payload, signature } = {}) {
    const group = await this.groups.findOne({ _id: groupId });
    if (!group || group.networkId !== String(networkId)) {
      throw typedError("E_GROUP_UNKNOWN", "That group doesn't exist in this network.");
    }
    if (!validGroupColor(color)) {
      throw typedError("E_GROUP_COLOR_INVALID", "That color isn't one of the group's palette colors. Pick one from the palette.");
    }
    await this.#assertManager(group, actorDid, "presentation");
    if (!payload || typeof payload !== "object" || payload.action !== "color" || payload.scope !== "group-avatar" || payload.color !== color) {
      throw typedError("E_GROUP_AVATAR_DECLARATION_INVALID", "The color change's signed declaration doesn't match this request. Try again.");
    }
    await this.membership.verifyMemberWrite({
      networkId: String(networkId),
      did: actorDid,
      deviceId: actorDeviceId,
      payload,
      signature,
    });
    await this.groups.updateOne({ _id: group._id }, { $set: { color: color ?? null } });
    const updated = await this.groups.findOne({ _id: group._id });
    return this.#named({ ...updated, color: updated.color ?? GROUP_NEUTRAL_COLOR, avatar: groupAvatarMetas(updated.avatar) });
  }

  /**
   * Serving (PORCH-088 ac-2): one committed rung, content-addressed and
   * immutable — hub origin only (the group's rendition surface reads the
   * shared blob store; member browsers never fetch a third-party surface).
   * The view gate is the group's own visibility rule: a private group's
   * presentation is invisible to non-members (the concealing refusal).
   *
   * @param {{ groupId: string, networkId: string, viewerDid: string, kind: string, version: string|null }} args
   */
  async serveAvatarRung({ groupId, networkId, viewerDid, kind, version } = {}) {
    const group = await this.groups.findOne({ _id: groupId });
    if (!group || group.networkId !== String(networkId)) {
      throw typedError("E_GROUP_UNKNOWN", "That group doesn't exist in this network.");
    }
    if (viewerDid && !canSeeGroup(group, viewerDid)) {
      // PORCH-088: the network owner may read the group's presentation
      // (their superuser authority needs its face); a plain member still
      // faces concealment — an invisible group's avatar is not a
      // member-plane fact (unknown-shaped).
      const viewerMembership = await this.#activeMembership(group.networkId, viewerDid);
      if (!canOpenGroupSettings(group, viewerDid, viewerMembership)) {
        throw typedError("E_GROUP_UNKNOWN", "That group doesn't exist in this network.");
      }
    }
    this.#assertAvatarPlane();
    if (!groupAvatarMetas(group.avatar)) {
      throw typedError("E_GROUP_AVATAR_NOT_FOUND", "This group doesn't have a photo yet.");
    }
    const rung = (group.avatar.renditions ?? []).find((some) => some.kind === kind);
    if (!rung || (version != null && version !== rung.sha256)) {
      throw typedError("E_GROUP_AVATAR_NOT_FOUND", "This group doesn't have a photo yet.");
    }
    const bytes = await this.blobs.get(rung.blobKey);
    if (bytes === null || !bytes.length) {
      throw typedError("E_BLOB_MISSING", "This group photo's stored copy is missing. Ask the group's creator to set it again.");
    }
    return { bytes, kind: rung.kind, width: rung.width, height: rung.height, contentType: rung.contentType, sha256: rung.sha256 };
  }
}

export default GroupService;