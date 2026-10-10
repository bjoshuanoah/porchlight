/**
 * Responsive rendition ladder — client side (PORCH-044 ac-2/ac-3).
 *
 * The hub hydrates every media-bearing post with `mediaMeta` (the
 * rendition set of record with widths + content addresses), and clients
 * request from the ladder via img srcset/sizes — no surface fetches a
 * rendition materially larger than it renders. Pure helpers: the SPA
 * renders from them and the tests pin the contract.
 */
import { photoFirst } from "./photo-first.js";

export function renditionUrl(origin, mediaId, kind, sha256) {
  // Rendition URLs are content-addressed: `v` is the rendition's sha256 —
  // the same pixels always answer at the same URL, immutable and long-
  // lived in the browser cache (the service worker carries the auth).
  const base = String(origin || "").replace(/\/+$/, "");
  return `${base}/api/social/media/${encodeURIComponent(mediaId)}/renditions/${encodeURIComponent(kind)}?v=${encodeURIComponent(sha256)}`;
}

/** The full srcset ladder ascending by width, from the hydrated meta. */
export function renditionSrcset(meta, origin) {
  const rungs = (meta?.renditions ?? [])
    .filter((rung) => rung.sha256 && (rung.width ?? 0) > 0 && rung.kind !== "poster" && rung.kind !== "playable")
    .sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return rungs
    .map((rung) => `${renditionUrl(origin, meta.mediaId, rung.kind, rung.sha256)} ${rung.width}w`)
    .join(", ");
}

/**
 * Timeline sizes (PORCH-043 treatments): full-bleed mobile media below 900
 * viewport units; desktop card media spans the post container interior
 * (breakout past the desktop card padding).
 */
export function timelineImageSizes() {
  return `(max-width: ${photoFirst.mobileBelow - 1}px) 100vw, calc(min(780px, 100vw - 40px) + ${2 * photoFirst.postPad}px)`;
}

/**
 * Detail sizes: the detail view caps media at 720px height, so the widest
 * useful render is 720 × aspect (the payload meta carries the original's
 * display aspect — every rung scales, the aspect never changes).
 */
export function detailImageSizes(meta) {
  const aspect = meta?.width && meta?.height ? meta.width / meta.height : 1.5;
  const widest = Math.max(64, Math.min(820, Math.round(720 * aspect)));
  return `(max-width: ${photoFirst.mobileBelow - 1}px) 100vw, ${widest}px`;
}

/** The smallest rung's URL — the <img src> fallback for no-srcset browsers. */
export function renditionSrc(meta, origin) {
  const rungs = (meta?.renditions ?? []).filter((rung) => rung.sha256 && (rung.width ?? 0) > 0);
  const smallest = rungs.reduce(
    (narrowest, rung) => ((rung.width ?? 0) < (narrowest?.width ?? Infinity) ? rung : narrowest),
    null,
  );
  return smallest
    ? renditionUrl(origin, meta.mediaId, smallest.kind, smallest.sha256)
    : null;
}

/** A video post's rendition contract: the playable rendition + poster. */
export function playableVideoUrl(meta, origin) {
  const playable = (meta?.renditions ?? []).find((rung) => rung.kind === "playable" && rung.sha256);
  return playable ? renditionUrl(origin, meta.mediaId, "playable", playable.sha256) : null;
}

export function posterUrl(meta, origin) {
  const poster = meta?.poster;
  return poster?.sha256 ? renditionUrl(origin, meta.mediaId, "poster", poster.sha256) : null;
}

/**
 * The aspect ratio a surface reserves its final frame from (PORCH-049
 * ac-2): the stamped `aspect` when the payload states it, the stamped
 * dims' ratio when a pre-PORCH-049 archive carries only width/height, and
 * null when the payload states no geometry — the legacy intrinsic-sizing
 * fallback (no reserved box, media renders its intrinsic size on load).
 * Pure helper so the SPA renders from it and the tests pin the fallback.
 */
export function stampedAspect(meta) {
  if (typeof meta?.aspect === "number" && meta.aspect > 0) return meta.aspect;
  if ((meta?.width ?? 0) > 0 && (meta?.height ?? 0) > 0) return meta.width / meta.height;
  return null;
}

/**
 * The share-sheet file name (PORCH-049 turn): content-typed extension, the
 * media id for stability. The original blob carries its MIME; the table
 * maps the common family-media types and the video/image catch-all keeps
 * every platform's share sheet from filing an extension-less blob.
 */
export function mediaFileName(mediaId, blob) {
  const extByType = {
    "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif",
    "image/webp": "webp", "image/heic": "heic", "image/heif": "heif",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
  };
  const type = String(blob?.type ?? "").split(";")[0];
  const ext = extByType[type] ?? (type.startsWith("video/") ? "mp4" : type.startsWith("image/") ? "jpg" : "bin");
  return `${mediaId}.${ext}`;
}

/**
 * Blob-loader fallback (insecure HTTP origins, where the auth-relaying
 * service worker can't register). Video posts ride their playable
 * rendition; images take the rung nearest the viewport's device pixels,
 * capped by the original width.
 */
export function rungKindForViewport(meta, viewportWidth, devicePixelRatio) {
  if (meta?.poster?.sha256) return "playable";
  const rungs = (meta?.renditions ?? [])
    .filter((rung) => rung.sha256 && (rung.width ?? 0) > 0 && rung.kind !== "poster" && rung.kind !== "playable")
    .sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  if (rungs.length === 0) return null;
  const need = Math.min(meta.width ?? Infinity, Math.ceil(viewportWidth * (devicePixelRatio || 1)));
  const fitting = rungs.filter((rung) => rung.width >= need);
  return (fitting.length > 0 ? fitting[0] : rungs[rungs.length - 1]).kind;
}