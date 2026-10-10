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