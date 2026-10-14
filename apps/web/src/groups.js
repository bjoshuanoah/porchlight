/**
 * Group management view helpers (PORCH-030, Oct 14 2026 follow-up). Pure
 * mapping between the hub's member-plane group payloads and the Groups
 * page's render rows, so create / view / add-members stay deterministic and
 * unit-testable without a DOM — the same discipline as member-directory.js.
 *
 * Group creation is open to every member of the network (Brian, Oct 14
 * 2026) and the creating member manages the group they made; the network
 * owner retains the same authority. Origin containment is unchanged: a
 * group belongs to exactly one network and its membership is a subset of
 * that network's membership.
 */

const idOf = (item) => String(item?._id ?? item?.id ?? "");

/**
 * Group visibility (PORCH-068): private (invite-only, members-only) or
 * public (the whole network views). Groups that predate the field resolve
 * private — the ruling's explicit default — and every private group a
 * member holds rides the member gate.
 */
export function groupVisibility(group = {}) {
  return group?.visibility === "public" ? "public" : "private";
}

export function isGroupMember(group = {}, did) {
  return Boolean(did) && (group?.members ?? []).includes(did);
}

/**
 * The composer's write targets (PORCH-068 ac-4): only groups the author
 * belongs to are offered — never every group in the network, and neither a
 * private nor a public group the author does not hold.
 */
export function composableGroups(groups = [], did = null) {
  return (groups || []).filter((group) => group && idOf(group) && isGroupMember(group, did));
}

/**
 * Self-serve join (PORCH-068 lifecycle ruling): a public group is joinable
 * by any member of the network with their own act — no approval flow —
 * unless a past removal's blocked entry stands; the manager lifts it.
 */
export function canJoinGroup(group = null, did = null) {
  if (!group || !did || idOf(group) === "") return false;
  if (groupVisibility(group) !== "public") return false;
  if (isGroupMember(group, did)) return false;
  return !(group?.blockedMemberIds ?? []).includes(did);
}

/**
 * The blocked-members render rows (PORCH-068 lifecycle ruling): removal
 * enters the blocked set atomically; only the managing member sees the
 * unblock act. No read-time names ride a blocked DID's row.
 */
export function blockedRows(group = {}) {
  return (group?.blockedMemberIds ?? [])
    .filter((did) => typeof did === "string" && did)
    .map((did) => ({ did, name: null }));
}

/** Groups of the member's own origin network, names first, then by age. */
export function groupRows(groups = [], networkId = null) {
  return (groups || [])
    .filter((group) => group && idOf(group)
      && (!group.networkId || !networkId || String(group.networkId) === String(networkId)))
    .sort((a, b) => String(a?.name ?? "").localeCompare(String(b?.name ?? ""))
      || String(idOf(a)).localeCompare(String(idOf(b))));
}

/** The roster as render rows: the hub's read-time names, ids only as fallback. */
export function groupMemberRows(group = {}) {
  const names = group?.names ?? {};
  return (group?.members ?? [])
    .filter((did) => typeof did === "string" && did)
    .map((did) => ({
      did,
      name: typeof names[did] === "string" && names[did] ? names[did] : null,
    }));
}

/** Can this member manage the group's membership (creator, or the owner)? */
export function canManageGroup(group = null, data = {}) {
  const did = data?.identity?.id;
  if (!group || !did) return false;
  if (group.createdBy && String(group.createdBy) === String(did)) return true;
  return (data?.members ?? []).some((entry) => entry?.did === did && entry?.role === "owner");
}

/**
 * Add-member candidates: the hub's origin-roster read (mention-candidate
 * rows) minus the group's existing membership. Unnamed members still add —
 * they render by id in the picker, the roster resolves their names.
 */
export function addableCandidates(candidates = [], group = {}) {
  const roster = new Set((group?.members ?? []).map(String));
  return (candidates || []).filter((candidate) => candidate?.did && !roster.has(String(candidate.did)));
}