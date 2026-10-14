// Timeline cards show four latest root comments in reading order. Nested
// responses stay collapsed until the member expands their parent in place.
export const REPLY_SLICE_LIMIT = 4;

const replyKey = (reply) => String(reply?._id ?? reply?.id ?? '');

/** Server decoration tolerance: a payload without the preview stays a plain post. */
export function conversationOf(post) {
  const replies = Array.isArray(post?.replySlice) ? post.replySlice : [];
  const total = Number.isFinite(post?.replyTotal) ? post.replyTotal : replies.length;
  return { replies, total };
}

// An arriving root enters the window in place; the oldest visible root
// moves into the more-comments count.
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
 * Merge the hub's root slice with local optimistic roots. The count describes
 * root comments only; responses belong to their parent, not this window.
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

/** Root-comment quantity beyond the four visible on the card. */
export function expanderCount(total) {
  return Math.max(0, total - REPLY_SLICE_LIMIT);
}

// A confirmed root stays local until a feed read includes its quantity.
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