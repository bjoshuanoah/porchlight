import { request } from "./api.js";
import { signDevicePayload } from "./device.js";

function device(connection) {
  if (!connection?.token || !connection.identity?.id || !connection.deviceId) {
    throw new Error("Connect this device to your family's hub before sharing a moment.");
  }
  return connection;
}

async function signed(connection, path, payload, method = "POST") {
  const member = device(connection);
  const signature = await signDevicePayload(new URL(member.url).origin, member.identity.id, member.deviceId, payload);
  return request(member, path, { method, body: JSON.stringify({ payload, signature }) });
}

export async function publishPost(connection, payload) {
  return signed(connection, "social/posts", payload);
}

export async function publishReply(connection, post, body, parentId = null, mentions = [], previewId = null) {
  return signed(connection, `social/posts/${encodeURIComponent(post._id || post.id)}/comments`, {
    postId: post._id || post.id, body, parentId, mentions, previewId,
  });
}

// Link previews (PORCH-052): compose-time URL resolution — the HUB fetches
// the third-party URL (bounded); the device signs the resolve the same way
// it signs every write (the resolve may ingest an og:image original).
export async function resolvePreview(connection, url) {
  return signed(connection, "social/previews/resolve", { scope: "link-preview", url });
}

// Mention autocomplete (PORCH-037): the member types a NAME. The hub answers
// with same-origin members only — the origin is the post's own connection, so
// candidates never cross networks. DIDs returned here ride the write payload;
// they are never rendered on any mention surface.
export async function mentionCandidates(connection, q = "") {
  const member = device(connection);
  return request(member, `social/mentions/candidates?q=${encodeURIComponent(q)}`);
}

export async function publishReaction(connection, post, emoji) {
  return signed(connection, `social/posts/${encodeURIComponent(post._id || post.id)}/reactions`, {
    postId: post._id || post.id, emoji,
  });
}

// Clear one of the member's own reactions (PORCH-036 ac-3): signed removal
// at the reaction's origin; the served DELETE carries the same signed
// payload shape as every other member write.
export async function unpublishReaction(connection, post, emoji) {
  return signed(connection, `social/posts/${encodeURIComponent(post._id || post.id)}/reactions`, {
    postId: post._id || post.id, emoji,
  }, "DELETE");
}

// Comment-subject reactions (PORCH-101, rendering PORCH-098's subject
// contract): the SAME signed reaction route declares its subject — the
// payload adds subjectType "comment" and the commentId, so a chip on a
// comment and a chip on its parent post are two separate reactions of one
// member. The leave clears only the member's own row on THAT comment.
export async function publishCommentReaction(connection, post, comment, emoji) {
  return signed(connection, `social/posts/${encodeURIComponent(post._id || post.id)}/reactions`, {
    postId: post._id || post.id,
    emoji,
    subjectType: "comment",
    commentId: comment._id || comment.id,
  });
}

export async function unpublishCommentReaction(connection, post, comment, emoji) {
  return signed(connection, `social/posts/${encodeURIComponent(post._id || post.id)}/reactions`, {
    postId: post._id || post.id,
    emoji,
    subjectType: "comment",
    commentId: comment._id || comment.id,
  }, "DELETE");
}

export async function publishVote(connection, post, value) {
  return signed(connection, `social/posts/${encodeURIComponent(post._id || post.id)}/votes`, {
    postId: post._id || post.id, value,
  });
}

// Group settings menu (PORCH-089): the client half of the group settings
// workstream's write vocabulary. The routes and their server-side gates
// merged with PORCH-088 on the main line; these builders exist as exports so the
// wire shapes the app's writes carry are pinned by tests and re-verified
// against a deployed hub by the stage-2 checklist (the Oct 12 contract) —
// the signed bytes here are the exact bytes the menu's actions deliver.

/** The group avatar's signed declaration: the member-avatar route's header
 * declaration shape, scoped "group-avatar" (the group avatar route's
 * contract — x-porchlight-avatar-payload / x-porchlight-signature). */
export function groupAvatarDeclaration({ size, sha256: sha, contentType }) {
  return { scope: "group-avatar", action: "set", size, sha256: sha, contentType };
}

/** The group color write's signed payload: a palette token, or null (the
 * neutral reset) — the server refuses off-palette colors in plain language. */
export function groupColorPayload(color) {
  return { scope: "group-avatar", action: "color", color: color ?? null };
}

/** The owner post-removal's signed payload (server half: post.service's
 * removePost rebuilds it from the path's post before verifying, so the
 * client must carry the very same values: kind + postId + groupId +
 * networkId, the origin network's id). */
export function groupPostRemovePayload(post) {
  return {
    kind: "group_post_remove",
    postId: post?._id || post?.id,
    groupId: post?.groupId,
    networkId: post?.originNetworkId ?? post?.networkId ?? null,
  };
}

export async function setGroupAvatar(connection, groupId, file) {
  const member = device(connection);
  if (!file) throw new Error("Choose a photo to set.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.byteLength) {
    const empty = new Error("That file is empty. Choose an image.");
    empty.code = "E_AVATAR_UNDECODABLE";
    throw empty;
  }
  const contentType = file.type || "application/octet-stream";
  const payload = groupAvatarDeclaration({ size: bytes.byteLength, sha256: await sha256(bytes), contentType });
  const signature = await signDevicePayload(new URL(member.url).origin, member.identity.id, member.deviceId, payload);
  return request(member, `social/groups/${encodeURIComponent(groupId)}/avatar`, {
    method: "POST",
    body: bytes,
    headers: {
      "content-type": contentType,
      "x-porchlight-avatar-payload": JSON.stringify(payload),
      "x-porchlight-signature": signature,
    },
  });
}

export async function setGroupColor(connection, groupId, color = null) {
  const member = device(connection);
  const payload = groupColorPayload(color);
  const signature = await signDevicePayload(new URL(member.url).origin, member.identity.id, member.deviceId, payload);
  return request(member, `social/groups/${encodeURIComponent(groupId)}/color`, {
    method: "PATCH",
    body: JSON.stringify({ color, payload, signature }),
  });
}

export async function removeGroupPost(connection, post) {
  const member = device(connection);
  const payload = groupPostRemovePayload(post);
  const signature = await signDevicePayload(new URL(member.url).origin, member.identity.id, member.deviceId, payload);
  return request(member, `social/groups/${encodeURIComponent(payload.groupId)}/posts/${encodeURIComponent(payload.postId)}`, {
    method: "DELETE",
    body: JSON.stringify({ signature }),
  });
}

// Post and comment lifecycle (PORCH-094): the member writes ride the
// shipped signed lifecycle routes (PORCH-093) — the server rebuilds each
// payload from the path's post before verifying, so the client signs
// exactly the values the path's post carries. Builders are exported so the
// wire shapes stay pinned by tests and re-verified against a deployed hub
// by the stage-2 checklist (the Oct 12 contract).

/** The author's post edit: body and caption text, plus the editable
 * location target (Oct 16 location ruling) as ONE write. Media never rides
 * an edit: a delete-and-repost changes media, so no media field exists on
 * this payload (the server refuses one that arrives). */
export function postEditPayload(post, { body = null, caption = null, groupId = undefined } = {}) {
  const payload = {
    kind: "post-edit",
    postId: post?._id || post?.id,
    networkId: post?.originNetworkId ?? post?.networkId ?? null,
  };
  if (body !== null) payload.body = body;
  // The server's caption normalization runs BEFORE verification (an empty
  // caption resolves null), so the signed bytes carry the normalized value.
  if (caption !== null && caption !== undefined) {
    payload.caption = typeof caption === "string" && caption.trim().length > 0 ? caption : null;
  }
  if (groupId !== undefined) payload.groupId = groupId || null;
  return payload;
}

/** The author's comment edit: text only — comments carry no location and no media. */
export function commentEditPayload(post, commentId, body) {
  return {
    kind: "comment-edit",
    postId: post?._id || post?.id,
    commentId,
    body,
    networkId: post?.originNetworkId ?? post?.networkId ?? null,
  };
}

/** The tombstoning post delete: kind + postId + networkId, the values the server rebuilds. */
export function postDeletePayload(post) {
  return {
    kind: "delete",
    postId: post?._id || post?.id,
    networkId: post?.originNetworkId ?? post?.networkId ?? null,
  };
}

/** The tombstoning comment delete: kind + postId + commentId + networkId. */
export function commentDeletePayload(post, commentId) {
  return {
    kind: "comment-delete",
    postId: post?._id || post?.id,
    commentId,
    networkId: post?.originNetworkId ?? post?.networkId ?? null,
  };
}

export async function editPost(connection, post, fields) {
  const member = device(connection);
  const payload = postEditPayload(post, fields);
  const signature = await signDevicePayload(new URL(member.url).origin, member.identity.id, member.deviceId, payload);
  return request(member, `social/posts/${encodeURIComponent(payload.postId)}`, {
    method: "PUT",
    body: JSON.stringify({ payload, signature }),
  });
}

export async function deletePost(connection, post) {
  const member = device(connection);
  const payload = postDeletePayload(post);
  const signature = await signDevicePayload(new URL(member.url).origin, member.identity.id, member.deviceId, payload);
  return request(member, `social/posts/${encodeURIComponent(payload.postId)}`, {
    method: "DELETE",
    body: JSON.stringify({ payload, signature }),
  });
}

export async function editComment(connection, post, commentId, body) {
  const member = device(connection);
  const payload = commentEditPayload(post, commentId, body);
  const signature = await signDevicePayload(new URL(member.url).origin, member.identity.id, member.deviceId, payload);
  return request(member, `social/posts/${encodeURIComponent(payload.postId)}/comments/${encodeURIComponent(commentId)}`, {
    method: "PUT",
    body: JSON.stringify({ payload, signature }),
  });
}

export async function deleteComment(connection, post, commentId) {
  const member = device(connection);
  const payload = commentDeletePayload(post, commentId);
  const signature = await signDevicePayload(new URL(member.url).origin, member.identity.id, member.deviceId, payload);
  return request(member, `social/posts/${encodeURIComponent(payload.postId)}/comments/${encodeURIComponent(commentId)}`, {
    method: "DELETE",
    body: JSON.stringify({ payload, signature }),
  });
}

function sha256(bytes) {
  return crypto.subtle.digest("SHA-256", bytes).then((hash) =>
    Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(""));
}

export async function uploadOriginals(connection, files) {
  const member = device(connection);
  const originals = [];
  for (const file of files) {
    const contentType = file.type || "application/octet-stream";
    const declaration = { size: file.size, contentType };
    const signature = await signDevicePayload(new URL(member.url).origin, member.identity.id, member.deviceId,
      { scope: "media-upload", ...declaration });
    const begin = await request(member, "social/media/uploads", {
      method: "POST", body: JSON.stringify({ payload: declaration, signature }),
    });
    const status = await request(member, `social/media/uploads/${encodeURIComponent(begin.uploadId)}`);
    const received = new Set(status.receivedChunks || []);
    const whole = await file.arrayBuffer();
    for (let index = 0; index < begin.chunkCount; index++) {
      if (received.has(index)) continue;
      const chunk = whole.slice(index * begin.chunkSize, Math.min(whole.byteLength, (index + 1) * begin.chunkSize));
      const target = new URL(`/api/social/media/uploads/${encodeURIComponent(begin.uploadId)}/chunks/${index}`, member.url);
      const response = await fetch(target, {
        method: "PUT",
        headers: { authorization: `Bearer ${member.token}`, "content-type": "application/octet-stream", "x-chunk-sha256": await sha256(chunk) },
        body: chunk,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `The hub could not receive part ${index + 1} of ${file.name}.`);
      }
    }
    const payload = { sha256: await sha256(whole), size: file.size };
    const commitSignature = await signDevicePayload(new URL(member.url).origin, member.identity.id, member.deviceId,
      { scope: "media-commit", uploadId: begin.uploadId, ...payload });
    const completed = await request(member, `social/media/uploads/${encodeURIComponent(begin.uploadId)}/complete`, {
      method: "POST", body: JSON.stringify({ payload, signature: commitSignature }),
    });
    originals.push(completed);
  }
  return originals;
}

export async function exportOriginals(connection) {
  const member = device(connection);
  const signature = await signDevicePayload(new URL(member.url).origin, member.identity.id, member.deviceId,
    { scope: "export", networkId: member.networkId });
  const target = new URL("/api/social/media/export", member.url);
  target.searchParams.set("signature", signature);
  const response = await fetch(target, { headers: { authorization: `Bearer ${member.token}` } });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "The archive could not be prepared.");
  }
  return response.blob();
}

// Bulk original download (PORCH-082 end-card, route per PORCH-083's build
// contract): one GET of the set-scoped zip — the same audited-path
// authentication shape the archive export carries (member token + device
// signature in the query). The URL is the served route shape: /api/social
// carries no network segment (the membership token IS the origin — the
// PORCH-013 family convention); a network-segmented URL 404s. The zip
// streams to the browser whole; the caller only receives the blob to hand
// to a download link. One-at-a-time original saves stay the per-photo path
// on mobile — this is the bulk path only.
export async function bulkPostOriginals(connection, post) {
  const member = device(connection);
  const postId = post?._id || post?.id;
  if (!member.networkId || !postId) {
    throw new Error("This moment's family server could not be identified for a bulk download.");
  }
  const signature = await signDevicePayload(new URL(member.url).origin, member.identity.id, member.deviceId,
    { scope: "bulk-originals", networkId: member.networkId, postId });
  const target = new URL(
    `/api/social/posts/${encodeURIComponent(postId)}/media/originals.zip`,
    member.url,
  );
  target.searchParams.set("signature", signature);
  const response = await fetch(target, { headers: { authorization: `Bearer ${member.token}` } });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Your family server could not prepare the bulk download.");
  }
  return response.blob();
}
