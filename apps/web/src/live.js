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
import {
  applyPostEditedRow, applyPostDeletedRow, applyCommentEditedRow, applyCommentDeletedRows,
  groupDeliversTo,
} from "./lifecycle.js";

/** The closed event vocabulary (PORCH-047; lifecycle events added Oct 16, PORCH-094). */
export const EVENT_TYPES = [
  "post.created", "reply.created", "reaction.applied", "media.attached",
  "post.updated", "post.deleted", "comment.updated", "comment.deleted",
];

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
  if (type === "reaction.applied") return mergeNewReaction(posts, envelope);
  if (type === "post.updated") return mergeUpdatedPost(posts, envelope, context);
  if (type === "post.deleted") return applyPostDeletedRow(posts, envelope.postId, envelope.networkId);
  if (type === "comment.updated") return applyCommentEditedRow(posts, {
    postId: envelope.postId,
    networkId: envelope.networkId,
    comment: envelope.content,
  });
  if (type === "comment.deleted") {
    return applyCommentDeletedRows(posts, {
      postId: envelope.postId,
      rootId: envelope.content?.rootId,
      cascadeIds: envelope.content?.cascadeIds ?? [],
      networkId: envelope.networkId,
    });
  }
  // The vocabulary membership is asserted above; this line is unreachable
  // by construction and safe by the copy-on-write no-op.
  return posts;
}

/**
 * The post.updated merge (edit + location change, PORCH-094): the served
 * view swaps the row's delivered fields in place per the row it already
 * holds — the changed fields re-render with no redraw of the river. The
 * delivery law drives visibility: a viewer the move removes the card from
 * drops the row in the same frame; a newly delivered viewer gains it
 * through the same merge; a viewer keeping visibility re-renders the
 * location context in place. The decorated conversation slice a read
 * served stays the richer local source.
 */
function mergeUpdatedPost(posts, envelope, context) {
  const content = envelope.content ?? {};
  const postId = String(envelope.postId ?? identityOf(content) ?? "");
  if (!postId) return posts;
  const existing = (posts ?? []).find((post) =>
    identityOf(post) === postId && sameOrigin(post, envelope));
  if (existing) {
    const fields = { ...content };
    if (existing.replySlice) fields.replySlice = existing.replySlice;
    if (existing.knownResponses) fields.knownResponses = existing.knownResponses;
    if (existing.reactionRows) fields.reactionRows = existing.reactionRows;
    if (Number.isFinite(existing.replyTotal)) fields.replyTotal = existing.replyTotal;
    // Silence carries the move: a post moved back to the general timeline
    // drops its group chip with the same delivery law — no stale chip ever
    // outlives the envelope that cleared its group.
    if (!fields.groupId) fields.groupName = null;
    return applyPostEditedRow(posts, {
      postId: postId,
      networkId: envelope.networkId,
      fields,
      viewerDid: context.viewerDid ?? null,
      groups: context.viewerGroups ?? [],
    });
  }
  // A card the viewer gains (a location move delivering it here) enters
  // the river as an arrival — never a whole-view redraw.
  if (!groupDeliversTo(content, context.viewerDid ?? null, context.viewerGroups ?? [])) return posts;
  return mergeNewPost(posts, envelope, context);
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
    // The ruled top-four window (PORCH-084) re-sorts in place; the root
    // falling past the top four moves into the expander count.
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