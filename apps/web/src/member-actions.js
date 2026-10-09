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

export async function publishReply(connection, post, body, parentId = null, mentions = []) {
  return signed(connection, `social/posts/${encodeURIComponent(post._id || post.id)}/comments`, {
    postId: post._id || post.id, body, parentId, mentions,
  });
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

export async function publishVote(connection, post, value) {
  return signed(connection, `social/posts/${encodeURIComponent(post._id || post.id)}/votes`, {
    postId: post._id || post.id, value,
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
