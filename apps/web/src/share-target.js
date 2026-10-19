/**
 * Share into the app (PORCH-105 ac-1/ac-4/ac-5, Brian Oct 19 2026): the
 * manifest's share_target is a launch surface, not an API surface. The
 * service worker stages a share-target launch's payload in its own store
 * (never the rendition cache, never an /api surface), and this module is the app's
 * half: retrieving the staged payload over the message channel, deciding
 * exactly which composer mode the payload opens with what staged, and
 * clearing the staging once compose has taken it.
 *
 * Identity gates everything: the consuming surface only ever runs with an
 * identity open (the staged share waits behind the WhoIsHere front state
 * and resumes after the member opens); it never touches the token plane,
 * so a share cannot bypass the session model.
 */

/** The manifest share_target action path (the POST the platform delivers). */
export const SHARE_TARGET_PATH = "/share";

/** How the worker answers the app's staged-share request. */
export const SHARE_STAGED_MESSAGE = "share-staged";

export const SHARE_STAGE_PREFIX = "/share-stage/";

/** MIME → the one composer mode the share opens (ac-4). */
function kindOf(type) {
  const mime = String(type || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "other";
}

/**
 * Classify one staged share into a compose staging (ac-4): exactly the
 * matching composer mode opens with content staged.
 *   - an image set opens photo compose with every shared photo (carousel
 *     preview shape); a text/title riding the share stages into the caption;
 *   - one video opens video compose; one audio opens audio compose;
 *   - text (or a bare URL/title) opens text compose with the shared text
 *     in the area;
 *   - types that cannot combine or files the composer cannot stage resolve
 *     to a clean subset plus plain family copy naming what was staged and
 *     what was left out — never a broken dialog, never a silent drop.
 */
export function classifyStagedShare({ title = "", text = "", url = "", files = [] } = {}) {
  const rows = files.map((file) => ({
    file,
    name: file?.name || "Shared file",
    kind: kindOf(file?.type),
  }));
  const photos = rows.filter((row) => row.kind === "image");
  const videos = rows.filter((row) => row.kind === "video");
  const audios = rows.filter((row) => row.kind === "audio");
  const others = rows.filter((row) => row.kind === "other");
  const shared = typeof text === "string" && text.trim() ? text.trim() : "";
  const linkish = typeof url === "string" && url.trim() ? url.trim() : "";
  const heading = typeof title === "string" && title.trim() ? title.trim() : "";

  let staged = { type: "text", files: [], body: shared || linkish || heading, caption: "", notice: null, dropped: [] };
  if (photos.length) {
    staged = {
      type: "photo", files: photos.map((row) => row.file), body: "", caption: shared,
      notice: null, dropped: rows.filter((row) => row.kind !== "image"),
    };
  } else if (videos.length) {
    staged = {
      type: "video", files: videos.slice(0, 1).map((row) => row.file), body: "", caption: shared,
      notice: null, dropped: rows.filter((row) => row !== videos[0]),
    };
  } else if (audios.length) {
    staged = {
      type: "audio", files: audios.slice(0, 1).map((row) => row.file), body: "", caption: shared,
      notice: null, dropped: rows.filter((row) => row !== audios[0]),
    };
  } else {
    staged.dropped = others;
  }
  const droppedNames = staged.dropped.map((row) => row.name).filter(Boolean);

  if (staged.files.length && droppedNames.length) {
    staged.notice = `Porchlight added your ${staged.type === "photo" ? `${staged.files.length} photos` : staged.type}. These cannot join the same post: ${droppedNames.join(", ")}.`;
  } else if (!staged.files.length && droppedNames.length) {
    // Unsupported share: nothing stages; the dialog renders the plain copy
    // naming what Porchlight can stage — never a broken dialog, never a
    // silent drop — and the member keeps the text area.
    staged.notice = `Porchlight can add photos, videos, and audio. These files cannot be added: ${droppedNames.join(", ")}. You can still write your post here.`;
  }
  return staged;
}

/**
 * Fetch the worker's staged share over one MessageChannel round-trip,
 * bounded: no staging, no worker, or a slow worker resolves null and the
 * app behaves as a plain launch (graceful absence everywhere).
 */
export async function requestStagedShare(worker, options = {}) {
  const target = worker ?? (typeof navigator === "undefined" ? null : navigator?.serviceWorker?.controller);
  if (!target || typeof target.postMessage !== "function") return null;
  const timeoutMs = options.timeoutMs ?? 5000;
  const channel = new MessageChannel();
  const reply = new Promise((resolve) => {
    channel.port1.onmessage = (event) => {
      if (event?.data?.type === SHARE_STAGED_MESSAGE) resolve(event.data.payload ?? null);
      else resolve(null);
    };
    target.postMessage({ type: "share-staged-request" }, [channel.port2]);
  });
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const payload = await Promise.race([timeout, reply]);
  // The ports never outlive the read: an unreplied channel would keep the
  // event loop (and the app's teardown) waiting on a share that never came.
  try { channel.port1.close(); } catch { /* already closed */ }
  try { channel.port2.close(); } catch { /* transferred away */ }
  return payload;
}

/** Clear the staging once compose has taken the payload. */
export async function clearStagedShare(worker) {
  const target = worker ?? (typeof navigator === "undefined" ? null : navigator?.serviceWorker?.controller);
  if (!target || typeof target.postMessage !== "function") return;
  target.postMessage({ type: "share-staged-clear" });
}