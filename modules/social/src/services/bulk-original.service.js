/**
 * Bulk original download (PORCH-083, build contract "Bulk Original
 * Download"). The set-scoped convenience zip on the media pipeline's
 * audited original path: a multi-image post's photos or an album's media
 * stream as ONE archive of full-quality original bytes.
 *
 * - Set resolution rides the owning surfaces' own code paths (the album's
 *   membership-keyed order and viewer-visibility filter, the post's
 *   mediaRefs order with origin containment + private-group visibility) —
 *   this service never invents a second set-resolution convention.
 * - Composition rides the export builder's deterministic ZIP writer
 *   (stored entries, fixed DOS timestamp) streamed entry-by-entry: each
 *   original is read once from the media root and the entry is yielded
 *   straight to the response — no server-local staging, no temp files, no
 *   full-resident archive (the home-scale guard).
 * - Original bytes are read, never moved or re-encoded (the fidelity
 *   ruling); renditions are excluded by construction (only kind
 *   "original" asset rows compose).
 * - One audit record per successful stream (actor, set, photo count) —
 *   beside the per-photo original_download audit family.
 * - This is the convenience bulk download, distinct from the signed
 *   archive export: no signature manifest, no quota consumption (quota
 *   accounts stored bytes, not reads), zero phone-home (the archive
 *   terminates at the member's browser).
 */
import { typedError, MESSAGES as MEDIA_MESSAGES } from "./media.service.js";
import { createZipWriter } from "./export.service.js";

export const BULK_ORIGINAL_MESSAGES = {
  E_ORIGINALS_SET_EMPTY: "There are no photos in this set to download.",
  E_ORIGINAL_UNREADABLE: "A photo of this set can't be read from the archive.",
  E_BULK_NOT_PERMITTED: "This action is not available to you in this network.",
};

/**
 * Deterministic per-set entry names: the index + the original's extension
 * (media assets store content type, never an original client filename, so
 * the index is the deterministic name of record).
 */
const EXTENSION_BY_CONTENT_TYPE = new Map(
  Object.entries({
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/heic": "heic",
    "image/heif": "heif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/mp4": "m4a",
    "audio/webm": "weba",
    "audio/ogg": "ogg",
  }),
);

function extensionFor(contentType) {
  return EXTENSION_BY_CONTENT_TYPE.get(String(contentType ?? "").toLowerCase()) ?? "bin";
}

export class BulkOriginalService {
  /**
   * @param {object} deps
   * @param {import("./membership.service.js").MembershipService} deps.membership
   * @param {import("./album.service.js").AlbumService} deps.albums
   * @param {import("./post.service.js").PostService} deps.posts
   * @param {import("@porchlight/shared").CollectionLike} deps.assets
   * @param {import("@porchlight/shared")} deps.blobs
   *   The media store facade (content-addressed blob byte layer).
   * @param {import("./media.volume.js").MediaVolumeService} deps.volume
   * @param {(action: string, payload?: object) => Promise<void>} [deps.audit]
   */
  constructor({ membership, albums, posts, assets, blobs, volume, audit }) {
    this.membership = membership;
    this.albums = albums;
    this.posts = posts;
    this.assets = assets;
    this.blobs = blobs;
    this.volume = volume;
    this.audit = audit ?? (async () => {});
  }

  /**
   * Album scope: the album's media set as one streaming zip (ac-1).
   * Set resolution and every refusal (unknown album, token, containment,
   * private-group visibility) ride the album surface's own path; an empty
   * set serves 404 before any byte is written.
   */
  async *streamAlbumZip({ accessToken, name } = {}) {
    const set = await this.albums.setMediaIds({ accessToken, name });
    yield* this.#zipStream({ set, setKind: "album", label: set.name });
  }

  /**
   * Post scope: one multi-image post's photo set as one streaming zip
   * (ac-1). Containment and visibility ride the post surface's own member
   * read gates; foreign-origin or non-visible posts always 404 — never the
   * perimeter response, always "doesn't exist here".
   */
  async *streamPostZip({ accessToken, postId } = {}) {
    const set = await this.posts.setMediaIds({ accessToken, postId });
    yield* this.#zipStream({ set, setKind: "post", label: set.postId });
  }

  /**
   * The zip stream (ac-2, ac-3). Resolution completes before the first
   * byte: every entry must reference an original asset in this set and the
   * blob's existence is verified BEFORE the response starts, so unreadable
   * rows fail named in plain language rather than truncating a stream.
   * After that each original is read and yielded exactly once; a mid-stream
   * read-back failure aborts the archive (the controller destroys the
   * response) — never a truncated silent zip.
   */
  async *#zipStream({ set, setKind, label }) {
    const originals = [];
    const seen = new Set();
    for (const mediaId of set.mediaIds) {
      if (seen.has(mediaId) || typeof mediaId !== "string") continue;
      seen.add(mediaId);
      const asset = await this.assets.findOne({ _id: mediaId, networkId: set.networkId, kind: "original" });
      // Only original asset rows compose: the rendition set and derived
      // artifacts are excluded by construction (fidelity ruling).
      if (asset) originals.push(asset);
    }
    if (originals.length === 0) {
      throw typedError("E_ORIGINALS_SET_EMPTY", BULK_ORIGINAL_MESSAGES.E_ORIGINALS_SET_EMPTY);
    }
    // Volume readiness (PORCH-054): the serving pause covers the bulk read.
    await this.volume.assertReady();
    for (const asset of originals) {
      if (!(await this.blobs.has(asset.blobKey))) {
        // Named before the response starts: the archive is refused whole,
        // never served with a hole.
        throw typedError("E_ORIGINAL_UNREADABLE", BULK_ORIGINAL_MESSAGES.E_ORIGINAL_UNREADABLE, { mediaId: asset._id });
      }
    }

    const zip = createZipWriter();
    for (const [index, asset] of originals.entries()) {
      const bytes = await this.blobs.get(asset.blobKey);
      if (bytes === null) {
        // Read-back failure mid-stream: abort the archive — the named
        // refusal above covers the resolvable case; this is the racy
        // path and it must never degrade to a truncated silent zip.
        throw typedError("E_ORIGINAL_UNREADABLE", BULK_ORIGINAL_MESSAGES.E_ORIGINAL_UNREADABLE, { mediaId: asset._id });
      }
      yield zip.entry({ path: `${String(index + 1).padStart(3, "0")}.${extensionFor(asset.contentType)}`, bytes });
    }
    yield zip.finish();

    // One audit record per successful stream (actor: member + device-bound
    // session; set; count; at) beside the per-photo original_download family.
    await this.audit("originals_zip_download", {
      networkId: set.networkId,
      did: set.did,
      detail: { set: label, setKind, count: originals.length, deviceId: set.deviceId ?? null },
    });
  }
}

// The perimeter codes reuse the media surface's plain language verbatim;
// only the bulk-specific states carry their own messages.
export const BULK_PERIMETER_MESSAGES = {
  E_MUST_SIGN_IN: MEDIA_MESSAGES.E_MUST_SIGN_IN,
  E_NOT_PERMITTED: MEDIA_MESSAGES.E_NOT_PERMITTED,
  E_MEDIA_NOT_FOUND: MEDIA_MESSAGES.E_MEDIA_NOT_FOUND,
  E_MEDIA_VOLUME_NOT_READY: MEDIA_MESSAGES.E_MEDIA_VOLUME_NOT_READY,
  E_DISK_HARD_STOP: MEDIA_MESSAGES.E_DISK_HARD_STOP,
  E_BLOB_MISSING: MEDIA_MESSAGES.E_BLOB_MISSING,
};

export default BulkOriginalService;