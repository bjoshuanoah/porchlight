// Conversation preview slice on timeline cards (PORCH-046 ac-5/ac-6):
// each card renders its five most-recent replies in natural reading order,
// with a quantity-only expander for the rest, and the member's own writes
// render optimistically. This module holds the pure window/dedup arithmetic;
// the rendering surface treats these rows as one cohesive slice.

export const REPLY_SLICE_LIMIT = 5;

const replyKey = (reply) => String(reply?._id ?? reply?.id ?? '');

/** Server decoration tolerance: a payload without the preview stays a plain post. */
export function conversationOf(post) {
  const replies = Array.isArray(post?.replySlice) ? post.replySlice : [];
  const total = Number.isFinite(post?.replyTotal) ? post.replyTotal : replies.length;
  return { replies, total };
}

// The rendered window: the five latest replies, oldest-first (reading
// direction). An arriving reply enters the window in place; the oldest
// in-slice reply exits into the expander count when the window is full.
export function windowOf(replies) {
  const sorted = (replies ?? [])
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return sorted.slice(-REPLY_SLICE_LIMIT);
}

function byIdMap(replies) {
  return new Map((replies ?? []).map((reply) => [replyKey(reply), reply]));
}

// Nested conversation structure shared by the post detail and the in-place
// conversation surface (PORCH-046/PORCH-041): parent id → replies, oldest
// first; roots ride the empty parent id.
export function repliesByParent(comments) {
  const byParent = new Map();
  for (const reply of comments ?? []) {
    const key = reply?.parentId || '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(reply);
  }
  for (const [key, rows] of byParent) {
    byParent.set(key, rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)));
  }
  return byParent;
}

/**
 * The card's display slice (ac-2 optimistic + ac-5 window + ac-6 count):
 * - server slice + confirmed replies (acknowledged, next read pending)
 *   + pending replies (write in flight, rolled back on failure) merge by id;
 * - the rendered window is the five latest of the merge;
 * - the conversation total grows by the replies still local-only, so a full
 *   window exits its oldest reply into "(and N more)" immediately.
 * A confirmed reply the server slice already carries (same id) is ignored —
 * its quantity lives in the server total, never counted twice.
 */
export function sliceDisplay(post, local = null) {
  const base = conversationOf(post);
  const serverIds = byIdMap(base.replies);
  const pending = (local?.pending ?? []).filter((reply) => replyKey(reply) && !serverIds.has(replyKey(reply)));
  const confirmed = (local?.confirmed ?? [])
    .filter((entry) => replyKey(entry?.reply) && !serverIds.has(replyKey(entry.reply)))
    .map((entry) => entry.reply);
  const merged = [...base.replies.filter((entry) => replyKey(entry)), ...confirmed, ...pending];
  const windowed = windowOf(merged);
  const total = Math.max(base.total + pending.length + confirmed.length, windowed.length);
  return { replies: windowed, total };
}

/**
 * Expander math (ac-6): the quiet amber control carries conversation length
 * minus the on-card slice — nothing else. At or below the slice limit there
 * is no expander.
 */
export function expanderCount(total) {
  return Math.max(0, total - REPLY_SLICE_LIMIT);
}

/**
 * Reconcile (ac-2): an acknowledged reply is kept locally only until a feed
 * read can hold it — every reply total sampled after the write exists fully
 * includes it, so once the read's total passes the total the write was
 * confirmed against, the local copy retires. A stale read (total still at
 * the confirm-time value) keeps the local row visible until it does.
 */
export function reconcileConfirmed(confirmed, serverTotal) {
  return (confirmed ?? []).filter(
    (entry) => !Number.isFinite(serverTotal) || serverTotal < entry.basis + 1,
  );
}

/** An optimistic reply render: the row joins the slice immediately (ac-2). */
export function pendingReply(post, body, { did, name, localId }) {
  return {
    _id: localId,
    postId: post?._id ?? post?.id ?? null,
    parentId: null,
    authorDid: did ?? null,
    authorName: name ?? null,
    body,
    createdAt: new Date().toISOString(),
  };
}