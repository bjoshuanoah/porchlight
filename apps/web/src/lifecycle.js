// Post and comment lifecycle (PORCH-094): the client half of the Oct 16
// lifecycle rulings. Pure helpers for the authority-gated affordances, the
// edit composer's location rows, and the optimistic river merges the
// delete tombstone and the edit re-render ride. No component owns this
// logic directly: the card, the card slice, and the detail column are
// three renderings of one contract (the parity rule), so the predicates
// and merges live here once.

import { identityOf, originOf, networkId, visibleAtOrigin } from "./feed-filter.js";

export const rowKeyOf = (row) => String(row?._id ?? row?.id ?? "");

// The viewer's did (the identity id) — the attribution field every
// lifecycle authority check compares against.
export const viewerDidOf = (data) => data?.identity?.id ?? null;

const authorDidOf = (row) => row?.authorDid ?? row?.authorId ?? null;

/** The network-owner check: the member row role, never a claim the hub verifies per write. */
export function viewerIsNetworkOwner(data) {
  const did = viewerDidOf(data);
  return Boolean(did) && (data?.members ?? []).some(
    (entry) => entry?.did === did && entry?.role === "owner",
  );
}

const sameOriginAsViewerNetwork = (post, data) => {
  if (!originOf(post) || !networkId(data)) return true;
  return String(originOf(post)) === String(networkId(data));
};

/**
 * Post edit authority (ac-1): the AUTHOR of the post, on content this
 * viewer's origin contains. Ownership NEVER confers edit authority — the
 * two-role law is one-directional (PORCH-093's server gate mirrors it).
 */
export function canEditPost(post, data = {}) {
  return Boolean(post)
    && Boolean(visibleAtOrigin(post, data))
    && authorDidOf(post) === viewerDidOf(data);
}

/**
 * Post delete authority (ac-1): the author of the post, or the network
 * owner of the origin network — on non-authored posts the owner sees
 * Delete only. Every other member sees nothing.
 */
export function canDeletePost(post, data = {}) {
  if (!post || !visibleAtOrigin(post, data)) return false;
  return canEditPost(post, data)
    || (viewerIsNetworkOwner(data) && sameOriginAsViewerNetwork(post, data));
}

/** Comment edit authority (ac-1/ac-4): the comment's author, never anyone else. */
export function canEditComment(row, data = {}) {
  return Boolean(row) && authorDidOf(row) === viewerDidOf(data);
}

/**
 * Comment delete authority (ac-1/ac-4): the comment's author, or the
 * network owner of the comment's origin on another member's row —
 * Delete only there. Group managers are refused exactly like any other
 * member (the server gate mirrors it).
 */
export function canDeleteComment(row, data = {}) {
  if (!row) return false;
  if (canEditComment(row, data)) return true;
  return viewerIsNetworkOwner(data) && sameOriginAsViewerNetwork(row, data);
}

/** The menu rows an authority pair yields — nothing renders for no authority. */
export function lifecycleMenuItems({ edit = false, remove = false } = {}) {
  const items = [];
  if (edit) items.push("edit");
  if (remove) items.push("delete");
  return items;
}

/**
 * Edit-mode location rows (ac-2, the Oct 16 location ruling): the general
 * timeline plus the groups the author belongs to — never another network
 * and never a group the author does not belong to. The empty id is the
 * general timeline; a group id pre-points the control.
 */
export function editLocationRows(post, data = {}) {
  const did = viewerDidOf(data);
  const rows = (data?.groups ?? [])
    .filter((group) => Array.isArray(group?.members) && group.members.includes(did))
    .map((group) => ({ id: identityOf(group), label: group.name ?? identityOf(group) }));
  return [{ id: "", label: "General timeline" }, ...rows];
}

/** The edit composer's pre-set target: the post's current location, or the general timeline. */
export function currentLocationId(post) {
  return post?.groupId ? String(post.groupId) : "";
}

export const GENERAL_LOCATION_ID = "";

const groupNameOf = (data, groupId) => {
  if (!groupId) return null;
  const group = (data?.groups ?? []).find((row) => identityOf(row) === String(groupId));
  return group?.name ?? null;
};

/** Group delivery (server's groupDeliversTo law, client mirror): membership only. */
export function groupDeliversTo(post, did, groups = []) {
  if (!post?.groupId) return true;
  const group = (groups ?? []).find((row) => identityOf(row) === String(post.groupId));
  return Boolean(group && Array.isArray(group.members) && did && group.members.includes(did));
}

const sameRiverRow = (post, postId, networkIdOfEnvelope = null) =>
  rowKeyOf(post) === String(postId)
  && (networkIdOfEnvelope === null
    || !originOf(post) || String(originOf(post)) === String(networkIdOfEnvelope));

/**
 * The post edit's optimistic river merge (ac-2): the changed fields re-render
 * in place as a copy-on-write splice of the SAME row — identity, slice,
 * reactions, and key untouched, so the card re-renders its fields with no
 * full-card remount. A location change that removes delivery from the viewer
 * drops the row in the same step (the same-frame card drop).
 */
export function applyPostEditedRow(posts, { postId, networkId: editedOrigin = null, fields, viewerDid, groups }) {
  const index = (posts ?? []).findIndex((post) => sameRiverRow(post, postId, editedOrigin));
  if (index < 0) return posts;
  const next = posts.slice();
  const row = { ...posts[index], ...fields, ...(fields.groupId ? { groupName: groupNameOf({ groups }, fields.groupId) ?? posts[index].groupName ?? null } : {}) };
  if (fields.groupId !== undefined && !groupDeliversTo(row, viewerDid, groups)) {
    next.splice(index, 1);
    return next;
  }
  next[index] = row;
  return next;
}

/** The failed edit's exact revert: the pre-action row returns in place. */
export function revertPostEditedRow(posts, { postId, networkId: editedOrigin = null, snapshot }) {
  const index = (posts ?? []).findIndex((post) => sameRiverRow(post, postId, editedOrigin));
  if (index < 0) return posts;
  const next = posts.slice();
  next[index] = snapshot;
  return next;
}

export const snapshotPostRow = (posts, postId, editedOrigin = null) =>
  (posts ?? []).find((post) => sameRiverRow(post, postId, editedOrigin)) ?? null;

/** The delete tombstone (ac-3): the row leaves the river in one pure step. */
export function applyPostDeletedRow(posts, postId, editedOrigin = null) {
  if (!(posts ?? []).some((post) => sameRiverRow(post, postId, editedOrigin))) return posts;
  return (posts ?? []).filter((post) => !sameRiverRow(post, postId, editedOrigin));
}

/**
 * The comment edit's river merge (ac-4): the row's text swaps in place by
 * id — order, response counts, and every other row untouched. PORCH-101:
 * the served comment view's `reactionRows` is the additive empty default on
 * every comment.updated (PORCH-098's commentView hard-codes the empty list;
 * the event never carries authoritative rows), so a row the merge touches
 * keeps its decorated rows in place — an edit never blinks the chips, and a
 * restored comment's captured rows survive until the read that decorates
 * them (the rows themselves re-materialize server-side with the restore).
 */
export function applyCommentEditedRow(posts, { postId, networkId: editedOrigin = null, comment }) {
  const index = (posts ?? []).findIndex((post) => sameRiverRow(post, postId, editedOrigin));
  if (index < 0) return posts;
  const post = posts[index];
  const slice = Array.isArray(post.replySlice) ? post.replySlice : [];
  const rowId = rowKeyOf(comment);
  if (!slice.some((row) => rowKeyOf(row) === rowId)) return posts;
  const nextSlice = slice.map((row) => (rowKeyOf(row) === rowId
    ? { ...row, ...comment, reactionRows: Array.isArray(row.reactionRows) ? row.reactionRows : (comment.reactionRows ?? []) }
    : row));
  const next = posts.slice();
  next[index] = { ...post, replySlice: nextSlice };
  return next;
}

/**
 * The row set a deletion removes from a rendered tree: the deleted row, its
 * rendered nested children (resolved from the rows' parentId chains), and
 * the server-echoed cascade ids.
 */
export function removedTreeIds(rows, rootId, cascadeIds = []) {
  const cascade = new Set([String(rootId)]);
  for (const id of cascadeIds) cascade.add(String(id));
  let frontier = [String(rootId)];
  while (frontier.length) {
    frontier = (rows ?? [])
      .filter((row) => cascade.has(String(row?.parentId)) && !cascade.has(rowKeyOf(row)))
      .map((row) => (cascade.add(rowKeyOf(row)), rowKeyOf(row)));
  }
  return cascade;
}

/** The rendered ancestor root of a deleted nested comment, if one renders. */
export function renderedAncestorRoot(rows, rootId) {
  return (rows ?? []).find(
    (row) => rowKeyOf(row) !== String(rootId) && subtreeContains(rows, rowKeyOf(row), rootId),
  ) ?? null;
}

function subtreeContains(rows, rootId, targetId) {
  let frontier = [String(rootId)];
  const seen = new Set();
  while (frontier.length) {
    const current = frontier.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    if (current === String(targetId)) return true;
    frontier.push(...(rows ?? []).filter((row) => String(row?.parentId) === current).map(rowKeyOf));
  }
  return false;
}

/**
 * The comment delete's river merge (ac-3/ac-4): the deleted row and its
 * nested tree leave the slice live. Expander counts recompute against live
 * comments: a removed root decrements the root total; a nested removal
 * decrements its rendered root's response count by the subtree size (the
 * next served read recounts authoritatively). Copy-on-write; a river not
 * holding the post returns unchanged.
 */
export function applyCommentDeletedRows(posts, { postId, rootId, cascadeIds = [], networkId: deletedOrigin = null }) {
  const index = (posts ?? []).findIndex((post) => sameRiverRow(post, postId, deletedOrigin));
  if (index < 0) return posts;
  const post = posts[index];
  const slice = Array.isArray(post.replySlice) ? post.replySlice : [];
  const cascade = removedTreeIds(slice, rootId, cascadeIds);
  let nextSlice = slice.filter((row) => !cascade.has(rowKeyOf(row)));
  let nextTotal = Number.isFinite(post.replyTotal) ? post.replyTotal : null;
  if (slice.some((row) => cascade.has(rowKeyOf(row)) && !row?.parentId)) {
    nextTotal = nextTotal === null ? null : Math.max(0, nextTotal - 1);
  } else {
    const ancestor = renderedAncestorRoot(slice, rootId);
    const subtreeSize = 1 + cascadeIds.filter((id) => String(id) !== String(rootId)).length;
    if (ancestor) {
      nextSlice = nextSlice.map((row) => rowKeyOf(row) === rowKeyOf(ancestor)
        ? { ...row, responseCount: Math.max(0, (Number(row.responseCount) || 0) - subtreeSize) }
        : row);
    }
  }
  const known = Array.isArray(post.knownResponses) ? post.knownResponses : null;
  const next = posts.slice();
  next[index] = {
    ...post,
    replySlice: nextSlice,
    replyTotal: nextTotal,
    ...(known ? { knownResponses: known.filter((id) => !cascade.has(String(id))) } : {}),
  };
  return next;
}