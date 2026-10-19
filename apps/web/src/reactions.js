// Reaction reflection shared by the timeline card and the post detail
// (PORCH-036, PORCH-038): the two surfaces ride the SAME origin conversation
// through the SAME reflection routine, so a reaction added from a card shows
// identically in the post detail and never creates a divergent surface.
// Only the emoji actually present render; rows stay per-member (ownDid marks
// the member's own row for the warm highlight exclusively). PORCH-090
// amends the render contract (Brian, Oct 15, 2026): the chip now carries the
// PEOPLE count derived at render from the per-member rows (only where more
// than one member holds the emoji) and the who-reacted reveal lists those
// rows in the served order — the per-member one-row-per-emoji rule makes
// the row count exactly the distinct-people count; nothing numeric is
// stored or wire-served.

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

// Optimistic toggle (PORCH-046 ac-2): the member's own row reflects
// IMMEDIATELY, in one pure step both surfaces (card and detail) share.
// The write decides the settle: success swaps the local row for the
// confirmed server row (reflectReaction is idempotent, never a duplicate),
// failure reverts to the exact prior rows.
export function optimisticToggle(base, { emoji, ownDid, isOwn }) {
  const rows = Array.isArray(base) ? base : [];
  if (!emoji) return rows;
  return reflectReaction(rows, {
    emoji,
    ownDid,
    isOwn: isOwn ? true : false,
    reaction: isOwn ? null : { _id: `local:${emoji}`, createdAt: new Date().toISOString() },
  });
}

// The chip model (PORCH-090): per emoji, the distinct-member reactor rows in
// the served order (one row per member per emoji makes the row list exactly
// the distinct-people list). Rows carry their derivation key: an unattributed
// row (a live-arrived row the hub serves as member + emoji only) keys on its
// row id, never on an index, so a merged row cannot double-count an unnamed
// member whose row lands again attributed. The count is the people count,
// derived at render only — it never attaches to a chip below one member and
// never ships on any payload (PORCH-091's wire law).
export function reactionChips(rows) {
  const byEmoji = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.emoji) continue;
    let chip = byEmoji.get(row.emoji);
    if (!chip) { chip = { emoji: row.emoji, reactors: [], seen: new Set() }; byEmoji.set(row.emoji, chip); }
    const did = String(row.memberDid ?? '');
    const key = did || `row:${row._id ?? row.createdAt ?? row.emoji}`;
    if (chip.seen.has(key)) continue;
    chip.seen.add(key);
    chip.reactors.push(row);
  }
  return [...byEmoji.values()];
}

// The who-reacted reveal gestures (PORCH-090): the timing half of the
// hover/long-press/focus contract as one injectable-timer machine, so the
// intent, long-press, grace, and suppress windows are unit-testable without
// a browser.
//   - Pointer: hover opens after the ~300ms intent delay; the pointer
//     leaving the chip arms a short grace so chip→popover movement never
//     closes it; the popover paper holds it open (a paper leave closes).
//   - Touch: pressStart arms the ~500ms long-press; when it fires the
//     reveal opens AND the release click is consumed (the pressEnd → click
//     handoff), so the reveal never toggles; the suppression self-clears so
//     the member's next tap is a plain toggle again.
//   - Keyboard: focus opens through the same intent delay once the caller's
//     recency gate rules out a tap/pointer focus; escape, blur, and the
//     outside tap close. The focus ring itself stays theme-layer-only
//     (PORCH-035).
// No path here ever writes a reaction row — the toggle is the chip's click,
// and only when click() says it is plain.
export function revealMachine({
  open,
  close = () => {},
  overPopover = () => false,
  intentMs = 300,
  pressMs = 500,
  graceMs = 140,
  settleMs = 500,
  timers = { setTimeout, clearTimeout },
} = {}) {
  const state = { intent: null, press: null, grace: null, settle: null, suppress: false, anchor: null };
  const clear = (slot) => {
    if (state[slot]) { timers.clearTimeout(state[slot]); state[slot] = null; }
  };
  const silence = () => {
    for (const slot of ['intent', 'press', 'grace', 'settle']) clear(slot);
    state.suppress = false;
  };
  return {
    // A plain tap; false only while a long-press release is being consumed.
    click() {
      if (state.suppress) {
        state.suppress = false;
        clear('settle');
        return false;
      }
      return true;
    },
    hoverStart(emoji, anchor, event) {
      if (event && event.pointerType && event.pointerType !== 'mouse') return;
      if (state.grace) clear('grace');
      if (state.intent || state.press) return;
      state.anchor = anchor;
      state.intent = timers.setTimeout(() => {
        state.intent = null;
        open({ emoji, anchor: state.anchor });
      }, intentMs);
    },
    hoverLeave() {
      clear('intent');
      if (!state.anchor || state.grace) return;
      state.grace = timers.setTimeout(() => {
        state.grace = null;
        if (!overPopover()) { state.anchor = null; silence(); close(); }
      }, graceMs);
    },
    paperEnter() { clear('grace'); },
    paperLeave() {
      silence();
      state.anchor = null;
      close();
    },
    pressStart(emoji, anchor) {
      if (state.grace) clear('grace');
      if (state.press || state.intent) return;
      state.anchor = anchor;
      state.press = timers.setTimeout(() => {
        state.press = null;
        state.suppress = true;
        open({ emoji, anchor });
      }, pressMs);
    },
    pressEnd() {
      if (state.press) { clear('press'); return false; }
      if (state.suppress) {
        state.settle = timers.setTimeout(() => {
          state.settle = null;
          state.suppress = false;
        }, settleMs);
        return true;
      }
      return true;
    },
    silence,
  };
}
// ---- Vote display (PORCH-104, UI half of the Oct 19 ruling) -----------------
// The vote surfaces' pure model: the served member view carries exactly two
// vote-derived values — upCount and the viewer's OWN myVote — and nothing
// else vote-derived may render anywhere. These helpers keep that math in one
// place for the timeline card and the post detail surface alike.

/** The member's own effective vote as served ("up" | "down", null when they
 * hold none); any other value (undefined on pre-amendment rows, offline
 * cache rows) renders as no vote. */
export function ownVoteOf(myVote) {
  return myVote === "up" || myVote === "down" ? myVote : null;
}

/** The post's up-vote quantity as served; a row without a finite upCount
 * renders no number (zero renders nothing too — zero up-votes is silence). */
export function upCountOf(upCount) {
  const value = Number(upCount);
  return Number.isFinite(value) ? value : null;
}

/** The optimistic write state for one click on `direction`: cast and flip in
 * a single step, with the public count derived from the served quantity. A
 * click on the vote the member already holds is NOT a write: the shipped
 * signed vote write carries no clear semantics — cast or change only ("a
 * vote is up or down"; re-stating changes nothing, PORCH-103) — so a held
 * button stays inert rather than lying optimistically. Returns null to
 * signal "no write"; the ruled un-vote (clicking a held vote removes it)
 * needs a server amendment and is flagged on PORCH-104's trail. */
export function castVoteState(post, direction) {
  const held = ownVoteOf(post?.myVote);
  if (direction !== "up" && direction !== "down") return null;
  if (held === direction) return null;
  const count = upCountOf(post?.upCount) ?? 0;
  return {
    vote: direction,
    count: Math.max(0, count + (direction === "up" ? 1 : held === "up" ? -1 : 0)),
  };
}
