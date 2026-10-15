// Live feed consumption (PORCH-081): the socket feed is the live path. The
// browser consumes the hub's realtime event plane (PORCH-047 server
// contract: socket.io per-origin rooms, closed content-only vocabulary,
// per-origin cursor catch-up). The PORCH-046 stand-in — a fixed-interval
// REST full-read — is deleted: polling in any form is banned as the live
// path. The resource cadence was the recorded reason (each keep-alive
// cycle redrew whole views, closed reply editors mid-typing, and drained
// device batteries); its removal is evidenced by this module carrying no
// cadence at all.
//
// Arrival merges into the river in place (ac-2): a post prepends as a
// copy-on-write entry, a reply enters the card's conversation slice (the
// latest-four window moves its oldest root into the more-comments count,
// per the Photo-First Timeline contract), a reaction renders as given.
// Unknown event types are logged and ignored — the vocabulary is closed,
// never guessed at. Nothing here derives an engagement metric: the server
// contract refuses count-bearing fields on every envelope.
// The reading place is compensated in scroll.js (PORCH-046's anchor).

import { identityOf } from "./feed-filter.js";
import { readLocal, writeLocal } from "./store.js";
import { windowOf } from "./slice.js";

/** The closed event vocabulary (PORCH-047). */
export const EVENT_TYPES = ["post.created", "reply.created", "reaction.applied", "media.attached"];

/** The per-origin catch-up cursor (the plane's opaque seq), browser-local. */
export function readEventCursor(storage, origin) {
  return readLocal(storage, origin, "realtime-cursor", null);
}

export function saveEventCursor(storage, origin, cursor) {
  if (cursor) writeLocal(storage, origin, "realtime-cursor", String(cursor));
}

/** The origin-annotated timeline row for an arriving post's content view. */
const arrivalRow = (envelope, context) => ({
  ...envelope.content,
  origin: context.origin,
  network: context.network ?? context.origin,
});

const sameOrigin = (post, envelope) =>
  String(post?.originNetworkId ?? "") === String(envelope?.networkId ?? "");

/**
 * Apply one arrival to the river in place (ac-2): returns a NEW posts
 * array only when a row changed — the caller never rebuilds the view for
 * a no-op arrival, and a changed row is a copy-on-write splice, never a
 * full replace. Idempotent against catch-up replays (dedupe by entity id)
 * and the member's own optimistic writes.
 */
export function applyEvent(posts, envelope, context = {}) {
  const type = envelope?.type;
  if (!EVENT_TYPES.includes(type)) {
    // The vocabulary is closed; unknown types log and ignore, never guess.
    context.log?.warn?.(`Unknown realtime event "${type}" ignored (the event vocabulary is closed).`);
    return posts;
  }
  if (type === "media.attached") {
    // Upload-commit acknowledgment (content-only media reference). No feed
    // surface rides the commit signal; the attached media renders through
    // the post that carries it (its own post.created envelope has run).
    return posts;
  }
  if (type === "post.created") return mergeNewPost(posts, envelope, context);
  if (type === "reply.created") return mergeNewReply(posts, envelope);
  return mergeNewReaction(posts, envelope);
}

function mergeNewPost(posts, envelope, context) {
  const content = envelope.content;
  const id = identityOf(content);
  if (!id) return posts;
  if ((posts ?? []).some((post) => identityOf(post) === id && sameOrigin(post, envelope))) {
    // A read or the member's own write already carries this post; the
    // decorated read row stays the richer source (it may hold a fuller
    // conversation slice than this envelope).
    return posts;
  }
  return [arrivalRow(envelope, context), ...(posts ?? [])];
}

function mergeNewReply(posts, envelope) {
  const content = envelope.content;
  const replyId = identityOf(content);
  const postId = String(envelope.postId ?? "");
  if (!replyId || !postId) return posts;
  const index = (posts ?? []).findIndex((post) => identityOf(post) === postId && sameOrigin(post, envelope));
  if (index < 0) return posts; // the post is not in this river; its card is not rendered
  const post = posts[index];
  const slice = Array.isArray(post.replySlice) ? post.replySlice : [];
  // The reply ledger (ac-2 idempotence): every reply id this card already
  // merged, seeded with the slice the last read decorated — a replay (own
  // optimistic echo, catch-up, reconnect) re-renders nothing.
  const known = Array.isArray(post.knownResponses) ? post.knownResponses : slice.map((row) => identityOf(row));
  if (known.includes(replyId)) return posts;
  const nextKnown = [...known, replyId];
  let replyTotal = Number.isFinite(post.replyTotal) ? post.replyTotal : null;
  let nextSlice = slice;
  if (content.parentId) {
    // Nested arrival under a rendered root bumps the root's response count
    // (the conversation-quantity expander); a deeper parent attributes on
    // the next read or expansion — the count is server truth there.
    nextSlice = slice.map((root) => identityOf(root) === content.parentId
      ? { ...root, responseCount: (Number(root.responseCount) || 0) + 1 }
      : root);
  } else {
    replyTotal = (replyTotal ?? slice.length) + 1;
    // The latest-four window moves its oldest root into the expander count.
    nextSlice = windowOf([...slice, { ...content, responseCount: 0 }]);
  }
  const next = posts.slice();
  next[index] = { ...post, replySlice: nextSlice, replyTotal, knownResponses: nextKnown };
  return next;
}

function mergeNewReaction(posts, envelope) {
  const row = envelope.content;
  const postId = String(envelope.postId ?? "");
  if (!row?.emoji || !postId) return posts;
  const index = (posts ?? []).findIndex((post) => identityOf(post) === postId && sameOrigin(post, envelope));
  if (index < 0) return posts;
  const rows = Array.isArray(posts[index].reactionRows) ? posts[index].reactionRows : [];
  const duplicate = rows.some((candidate) => identityOf(candidate) === identityOf(row)
    || (candidate.emoji === row.emoji && String(candidate.memberDid ?? "") === String(row.memberDid ?? "")));
  if (duplicate) return posts;
  const next = posts.slice();
  next[index] = { ...posts[index], reactionRows: [...rows, row] };
  return next;
}

/**
 * The reconnect delta resolve (ac-4): GET /api/social/events?since= per the
 * shipped contract. Beyond the replay window the response reads `stale` and
 * the caller renders the REST catch-up note — the member is never asked for
 * a manual refresh, and no polling cycle returns to fill the gap.
 */
export async function catchUpSince(request, connection, since = null) {
  const path = since ? `social/events?since=${encodeURIComponent(since)}` : "social/events";
  const result = await request(connection, path);
  return {
    events: Array.isArray(result.events) ? result.events : [],
    stale: Boolean(result.stale),
    cursor: result.cursor ?? null,
    replayHours: result.replayHours ?? null,
  };
}