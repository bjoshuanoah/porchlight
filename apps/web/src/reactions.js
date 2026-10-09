// Reaction reflection shared by the timeline card and the post detail
// (PORCH-036, PORCH-038): the two surfaces ride the SAME origin conversation
// through the SAME reflection routine, so a reaction added from a card shows
// identically in the post detail and never creates a divergent surface.
// Only the emoji actually present render; rows stay per-member (ownDid marks
// the member's own row for the warm highlight exclusively) and no count is
// ever derived — the rendering surface dedupes emoji values from the rows.

// Loader tolerance: the hub returns a reaction row list; anything without an
// emoji value never participates in rendering.
export function reactionRowsOf(value) {
  return Array.isArray(value) ? value.filter((row) => row?.emoji) : [];
}

// The member's own emoji values, used exclusively for the warm highlight and
// for toggling (tap an emoji the member already reacted with clears it).
export function ownEmojiRows(rows, ownDid) {
  const did = String(ownDid ?? '');
  return new Set((rows ?? []).filter((row) => String(row.memberDid ?? '') === did).map((row) => row.emoji));
}

// Add or clear one member-visible row for the given emoji. Another member's
// identical emoji survives an own-row clear, and re-adding an existing own
// reaction is idempotent — change or clear, never a duplicate row.
export function reflectReaction(base, { emoji, ownDid, isOwn, reaction }) {
  const did = String(ownDid ?? '');
  const rows = Array.isArray(base) ? base : [];
  if (!did || !emoji) return rows;
  const ownRow = (row) => row.emoji === emoji && String(row.memberDid ?? '') === did;
  if (isOwn) return rows.filter((row) => !ownRow(row));
  if (rows.some(ownRow)) return rows;
  return [...rows, {
    emoji,
    memberDid: did,
    _id: reaction?._id ?? `local:${emoji}`,
    createdAt: reaction?.createdAt ?? new Date().toISOString(),
  }];
}