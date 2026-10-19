/**
 * Share-flow device reasoning (PORCH-105, Brian Oct 19 2026). Pure decisions
 * so the surfaces stay dumb and the contracts stay testable:
 *
 *   - the per-media overlay's action (mobile Share, desktop keeps the Oct 15
 *     ruled download);
 *   - the end-card's bulk platform matrix (iOS shares the zip through the
 *     sheet; Android shares up to 10 full-resolution photos as the set and
 *     rides the bulk zip route beyond 10; desktop keeps the zip download);
 *   - the capability gates around navigator.share, including the size
 *     refusal that falls back to the plain download behavior.
 *
 * Classification is engine-fact based per the PORCH-051 ruling: device
 * strings are never the signal, and iPadOS presenting as a Mac stays
 * iOS-class through the WebKit + touch-capable pair.
 *
 * The zip carrier for every zip path is the shipped bulk-original archive
 * route (Porchlight Server, PORCH-083) — reused, never rebuilt; no new
 * endpoint exists server-side.
 */

import { webkitClass } from "./install.js";

/** Android's practical per-surface share file limit, below which the set
 * shares as individual full-resolution photos (build contract ruling). */
export const ANDROID_SHEET_SET_LIMIT = 10;

/** Touch-capability fact: the signal for mobile per-media behavior —
 * device hardware only, no display-mode read (the screen files carry no
 * mode-branch machinery, PORCH-042). */
export function shareTouchCapable(env = {}) {
  if (env.touchCapable !== undefined) return Boolean(env.touchCapable);
  if (typeof navigator === "undefined") return false;
  return (navigator.maxTouchPoints ?? 0) > 0;
}

/** iOS-class vs Android-class on a touch surface (WebKit engine test). */
export function shareDeviceClass(env = {}) {
  const touch = env.touchCapable !== undefined ? Boolean(env.touchCapable) : shareTouchCapable(env);
  if (!touch) return "desktop";
  const userAgent = env.userAgent
    ?? (typeof navigator !== "undefined" ? navigator?.userAgent : "");
  return webkitClass(userAgent) ? "ios" : "android";
}

/** Can a file ride navigator.share's files list at all? Capability-first:
 * no share object, no canShare, or a refused probe → false. */
export function shareFileCapable(env = {}) {
  const share = env.share ?? (typeof navigator !== "undefined" ? navigator?.share : undefined);
  const canShare = env.canShare ?? (typeof navigator !== "undefined" ? navigator?.canShare : undefined);
  if (typeof share !== "function" || typeof canShare !== "function") return false;
  try {
    return Boolean(canShare.call(navigator, { files: [new File([], "porchlight-probe", { type: "image/png" })] }));
  } catch { return false; }
}

/** The per-media overlay's original action (Oct 19 ruling): touch surfaces
 * share the original through the native sheet; desktop keeps the Oct 15
 * download control exactly as ruled. */
export function overlayOriginalAction(env = {}) {
  return shareTouchCapable(env) ? "share" : "download";
}

/** The end-card bulk decision (ac-3 platform matrix). `verb` names the
 * in-flight state family copy renders: sharing / fetching. */
export function endCardPlan({ deviceClass, photos = 0, shareCapable } = {}) {
  const capable = shareCapable !== undefined ? Boolean(shareCapable) : shareFileCapable();
  if (deviceClass === "desktop" || !capable) {
    return { kind: "zip-download", verb: "Fetching your originals…", label: "Download all originals" };
  }
  if (deviceClass === "ios") {
    return { kind: "share-zip", verb: "Sharing your originals…", label: "Share all originals" };
  }
  // Android: the set as individual files up to the limit; beyond it the
  // bulk zip route is the carrier and the sheet (or save) takes the zip.
  if (photos <= ANDROID_SHEET_SET_LIMIT) {
    return { kind: "share-files", verb: "Sharing your originals…", label: "Share all originals" };
  }
  return { kind: "share-zip", verb: "Sharing your originals…", label: "Share all originals" };
}

/** A blob rides the sheet as a File with its real name back. */
export function shareFileOf(blob, fileName) {
  return new File([blob], fileName, { type: blob?.type || "application/octet-stream" });
}

/** The plain download hand-off (the fallback behavior for a platform that
 * refused the share or set a size ceiling — plain behavior, never an error
 * path family). */
export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * One original through the native sheet. Returns a deterministic outcome:
 *   { mode: "shared" } | { mode: "shared", dismissed: true } — the sheet ran
 *   (an AbortError is a member dismissal: quiet, never an error).
 *   { mode: "downloaded" } — the platform refused (capability absent or the
 *   sizes ceiling hit); the download behavior answers instead, silently.
 * Any other share failure falls back to the same download behavior too: the
 * member always keeps their original, never an error path family.
 */
export async function shareOriginal(blob, fileName, env = {}) {
  const share = env.share ?? navigator?.share;
  const canShare = env.canShare ?? navigator?.canShare;
  const download = env.download ?? downloadBlob;
  if (blob instanceof Blob && typeof share === "function" && typeof canShare === "function") {
    try {
      const file = shareFileOf(blob, fileName);
      if (canShare.call(navigator, { files: [file] })) {
        await share.call(navigator, { files: [file], title: "Porchlight" });
        return { mode: "shared" };
      }
    } catch (error) {
      if (error?.name === "AbortError") return { mode: "shared", dismissed: true };
    }
  }
  if (blob instanceof Blob) download(blob, fileName);
  return { mode: "downloaded" };
}

/**
 * A set of originals (or one zip) through the sheet. Returns:
 *   { mode: "shared" | "shared-dismissed", files } — the sheet took them.
 *   { mode: "refused" } — the platform declined the set/sizes; the caller
 *   falls back to its bulk path (for the end card: the zip route), plainly.
 */
export async function shareFileSet(blobs, { names = [], title = "Porchlight", env = {} } = {}) {
  const share = env.share ?? navigator?.share;
  const canShare = env.canShare ?? navigator?.canShare;
  if (typeof share !== "function" || typeof canShare !== "function") return { mode: "refused" };
  const files = blobs.map((blob, index) => shareFileOf(blob, names[index] || `Shared ${index + 1}`));
  if (!files.length) return { mode: "refused" };
  try {
    if (canShare.call(navigator, { files })) {
      await share.call(navigator, { files, title });
      return { mode: "shared", files };
    }
    return { mode: "refused", files };
  } catch (error) {
    if (error?.name === "AbortError") return { mode: "shared-dismissed", files };
    return { mode: "refused", files };
  }
}