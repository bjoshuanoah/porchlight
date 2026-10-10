import { socialModels } from "../models.js";
import { sha256 } from "../util/crypto.js";
import { sha256Hex } from "./media.store.js";
import {
  RENDITION_FORMAT_V2,
  imageMetadata,
  videoMetadata,
  encodeImageRendition,
  encodeVideoPlayable,
  encodeVideoPoster,
} from "./rendition.encoder.js";

/**
 * Media pipeline service (PORCH-008, Porchlight Server TS 5 + the media
 * fidelity ruling Brian Oct 7 2026). Owns the ingest → renditions →
 * serving → GC → sweep path:
 *
 * - Originals are the archival record: original bytes stored ONCE,
 *   immutable, at full original quality — devices never transcode (the
 *   upload API accepts browser chunks as-is; every lower-quality
 *   shareable version is generated on the hub server).
 * - Uploads are resumable chunked browser uploads (POST begin → PUT
 *   chunks → POST complete, status read for resume), with server-side
 *   integrity verification (declared sha256 + size) before commit and
 *   scheduled/idempotent garbage collection of incomplete uploads.
 * - Rendition sets are generated on the hub at ingest, idempotent per
 *   media item, counted against the same owner-set storage ceiling as
 *   originals (quantity-only limits rule): image rungs (feed-thumb,
 *   album, detail — width rungs of the responsive ladder) as WebP plus
 *   the video poster + playable set (PORCH-044, codec-backed encoders in
 *   rendition.encoder.js).
 * - Serving defaults to renditions; original-quality retrieval is an
 *   explicit member action against the archive. Rendition responses are
 *   content-addressed (the URL carries the rendition's sha256) and serve
 *   with a long-lived private, immutable Cache-Control (PORCH-044 ac-3);
 *   originals serve with no-store and are never pre-cached.
 * - Disk guard: soft threshold warns the owner console, hard stop halts
 *   NEW uploads before corruption conditions; reads continue at both
 *   thresholds ([Assumed: 90% soft / 95% hard, tune at build] — named
 *   configuration on this service).
 *
 * Commit/chunk-write integrity: the state-changing writes (upload begin
 * and commit) are device-signed like every other content write; each
 * chunk carries its own sha256, verified against the declared per-chunk
 * hash at write time, and the full-bytes sha256 is verified against the
 * device-signed commit declaration before anything becomes an immutable
 * original.
 */
export class MediaService {
  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} deps.uploads
   * @param {import("@porchlight/shared").CollectionLike} deps.assets
   * @param {import("./membership.service.js").MembershipService} deps.membership
   * @param {import("./quota.service.js").QuotaService} deps.quota
   * @param {{ put: (key: string, bytes: Buffer) => Promise<string>,
   *             get: (key: string) => Promise<Buffer | null>,
   *             has: (key: string) => Promise<boolean>,
   *             delete: (key: string) => Promise<boolean> }} deps.blobs
   *   Content-addressed blob store (see ../services/media.store.js).
   * @param {() => Promise<{totalBytes: number, freeBytes: number}>} [deps.diskProbe]
   * @param {(action: string, payload?: object) => Promise<void>} [deps.audit]
   * @param {{ softUsedRatio?: number, hardUsedRatio?: number,
   *           chunkSize?: number, uploadTtlSeconds?: number,
   *           renditionRungs?: { image?: Record<string, number>, video?: Record<string, number> }} [options]
   */
  constructor({ uploads, assets, artifacts, membership, quota, blobs, diskProbe, audit, realtime }, options = {}) {
    this.uploads = uploads;
    this.assets = assets;
    this.artifacts = artifacts;
    this.membership = membership;
    this.quota = quota;
    this.blobs = blobs;
    this.realtime = realtime ?? null;
    this.diskProbe = diskProbe ?? null;
    this.audit = audit ?? (async () => {});
    this.models = socialModels;
    this.softUsedRatio = options.softUsedRatio ?? 0.9;
    this.hardUsedRatio = options.hardUsedRatio ?? 0.95;
    this.chunkSize = options.chunkSize ?? 4 * 1024 * 1024;
    this.uploadTtlSeconds = options.uploadTtlSeconds ?? 24 * 60 * 60;
    // Rendition ladder rungs (PORCH-044, media pipeline TS 5): pixel-width
    // rungs for the photo-first treatments (full-bleed mobile, contained
    // desktop card, detail view) — owner-readable configuration values,
    // validated + defaulted by normalizeConfig (packages/shared). Image
    // rungs render WebP; video posts get their poster/playable set.
    this.renditionRungs = normalizeRenditionRungs(
      options.renditionRungs ?? structuredClone(DEFAULT_RENDITION_RUNGS),
    );
  }

  /**
   * Begin a resumable chunked upload (ac-1). The device-signed payload
   * declares {scope:"media-upload", size, contentType}; admission runs the
   * quota ceiling check (plain-language E_STORAGE_QUOTA_EXCEEDED) and the
   * disk guard BEFORE any byte is accepted — a hard-stop disk rejects new
   * uploads outright, a soft-threshold disk admits with a warning the
   * owner console also sees via diskStatus().
   */
  async beginUpload({ accessToken, payload, signature } = {}) {
    const session = await this.#requireSession(accessToken);
    if (!payload || typeof payload !== "object") {
      throw typedError("E_UPLOAD_PAYLOAD_REQUIRED", MESSAGES.E_UPLOAD_PAYLOAD_REQUIRED);
    }
    const networkId = session.networkId;
    if (payload.networkId && payload.networkId !== networkId) {
      throw typedError("E_NOT_PERMITTED", MESSAGES.E_NOT_PERMITTED);
    }
    await this.verifyWrite({
      networkId,
      did: session.did,
      deviceId: session.deviceId,
      payload: { scope: "media-upload", size: payload.size, contentType: payload.contentType },
      signature,
    });
    assertUploadDeclaration(payload);
    const disk = await this.#diskGate(networkId);
    await this.quota.admitUpload({ networkId, bytes: Number(payload.size), kind: "original" });
    const uploadId = `upl_${crypto.randomUUID()}`;
    const upload = {
      _id: uploadId,
      networkId: String(networkId),
      did: session.did,
      deviceId: session.deviceId,
      size: Number(payload.size),
      contentType: payload.contentType,
      chunkSize: this.chunkSize,
      chunkCount: Math.max(1, Math.ceil(Number(payload.size) / this.chunkSize)),
      receivedChunks: [],
      state: "open",
      mediaId: null,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };
    await this.uploads.insertOne(upload);
    await this.audit("upload_begin", { networkId: String(networkId), did: session.did, detail: { uploadId, size: upload.size } });
    return {
      uploadId,
      chunkSize: upload.chunkSize,
      chunkCount: upload.chunkCount,
      disk: disk,
    };
  }

  /**
   * PUT one chunk (ac-1). The open upload belongs to the member whose
   * session began it (same did at the same origin — perimeter-scoped), the
   * index must sit inside the declared chunk count, and the chunk's own
   * sha256 must match the declared `x-chunk-sha256` header — a corrupted
   * transport chunk is rejected before it can poison the commit.
   * Idempotent: re-PUTting a received index rewrites that blob in place.
   */
  async putChunk({ accessToken, uploadId, index, bytes, chunkSha }) {
    const session = await this.#requireSession(accessToken);
    const upload = await this.#openUpload(uploadId, session);
    const indexNum = Number(index);
    if (!Number.isInteger(indexNum) || indexNum < 0 || indexNum >= upload.chunkCount) {
      throw typedError("E_CHUNK_INDEX_INVALID", MESSAGES.E_CHUNK_INDEX_INVALID);
    }
    const chunk = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
    if (chunk.length === 0) {
      throw typedError("E_CHUNK_EMPTY", MESSAGES.E_CHUNK_EMPTY);
    }
    if (indexNum < upload.chunkCount - 1 && chunk.length !== upload.chunkSize) {
      throw typedError("E_CHUNK_SIZE_INVALID", MESSAGES.E_CHUNK_SIZE_INVALID);
    }
    if (chunk.length > upload.chunkSize) {
      throw typedError("E_CHUNK_SIZE_INVALID", MESSAGES.E_CHUNK_SIZE_INVALID);
    }
    if (!chunkSha) {
      throw typedError("E_CHUNK_SHA_REQUIRED", MESSAGES.E_CHUNK_SHA_REQUIRED);
    }
    const actualSha = sha256(chunk);
    if (actualSha !== chunkSha) {
      throw typedError("E_CHUNK_CORRUPT", MESSAGES.E_CHUNK_CORRUPT);
    }
    await this.blobs.put(chunkKey(uploadId, indexNum), chunk);
    if (!upload.receivedChunks.includes(indexNum)) {
      upload.receivedChunks = [...upload.receivedChunks, indexNum].sort((a, b) => a - b);
    }
    await this.uploads.updateOne(
      { _id: uploadId },
      {
        $set: {
          receivedChunks: upload.receivedChunks,
          lastActivityAt: new Date().toISOString(),
        },
      },
    );
    return {
      uploadId,
      index: indexNum,
      received: upload.receivedChunks.length,
      chunkCount: upload.chunkCount,
      complete: upload.receivedChunks.length === upload.chunkCount,
    };
  }

  /** Resume surface (ac-1): which chunks the server already holds. */
  async uploadStatus({ accessToken, uploadId }) {
    const session = await this.#requireSession(accessToken);
    const upload = await this.#openUpload(uploadId, session);
    return {
      uploadId: upload._id,
      state: upload.state,
      size: upload.size,
      chunkSize: upload.chunkSize,
      chunkCount: upload.chunkCount,
      receivedChunks: upload.receivedChunks,
    };
  }

  /**
   * Commit (ac-1): verifies server-side integrity — every declared chunk
   * received, assembled length equals the signed committed length, and
   * the assembled-bytes sha256 equals the device-signed declared
   * sha256 — all BEFORE the original is stored. Committed bytes go to the
   * content-addressed blob store once (immutable by key semantics), the
   * asset row lands with `immutable: true`, and the original is recorded
   * in the quota artifact ledger against the owner's ceiling.
   */
  async completeUpload({ accessToken, uploadId, payload, signature } = {}) {
    const session = await this.#requireSession(accessToken);
    const upload = await this.#openUpload(uploadId, session);
    if (!payload || !isHex64(payload.sha256) || !Number.isInteger(Number(payload.size))) {
      throw typedError("E_COMMIT_DECLARATION_INVALID", MESSAGES.E_COMMIT_DECLARATION_INVALID);
    }
    await this.verifyWrite({
      networkId: upload.networkId,
      did: session.did,
      deviceId: session.deviceId,
      payload: { scope: "media-commit", uploadId, sha256: payload.sha256, size: Number(payload.size) },
      signature,
    });
    if (upload.receivedChunks.length !== upload.chunkCount) {
      throw typedError("E_UPLOAD_INCOMPLETE", MESSAGES.E_UPLOAD_INCOMPLETE, {
        receivedChunks: upload.receivedChunks,
        chunkCount: upload.chunkCount,
      });
    }
    const assembled = Buffer.concat(
      await Promise.all(upload.receivedChunks.map((index) => this.#chunkBytes(uploadId, index))),
    );
    if (assembled.length !== Number(payload.size)) {
      throw typedError("E_COMMIT_SIZE_MISMATCH", MESSAGES.E_COMMIT_SIZE_MISMATCH);
    }
    if (sha256Hex(assembled) !== payload.sha256) {
      throw typedError("E_COMMIT_SHA_MISMATCH", MESSAGES.E_COMMIT_SHA_MISMATCH);
    }

    // Probe the original hub-side BEFORE anything is stored (PORCH-044):
    // the rendition set can only be generated from decodable pixels. An
    // undecodable upload would strand every member-facing surface on
    // original bytes (the exact defect PORCH-044 exists to remove), so the
    // commit rejects rather than admitting unrenderable media.
    const sourceMeta = await this.#probeOriginal(assembled, upload.contentType);

    // Re-admission with the ACTUAL bytes (an over-declared begin cannot be
    // raced into an over-filled network) before anything is stored.
    await this.quota.admitUpload({ networkId: upload.networkId, bytes: assembled.length, kind: "original" });
    const blobKey = sha256Hex(assembled);
    await this.blobs.put(blobKey, assembled);
    const mediaId = `med_${crypto.randomUUID()}`;
    const limits = await this.quota.limits({ networkId: upload.networkId });
    const asset = {
      _id: mediaId,
      networkId: upload.networkId,
      did: upload.did,
      kind: "original",
      contentType: upload.contentType,
      blobKey,
      sha256: payload.sha256,
      bytes: assembled.length,
      // Hub-side probe (portrait/landscape effective dims; null for audio).
      width: sourceMeta?.width ?? null,
      height: sourceMeta?.height ?? null,
      durationSeconds: sourceMeta?.durationSeconds ?? null,
      immutable: true,
      // The device-signed commit rides the asset: it is the authorship
      // signature an export manifest cites per media item, verifiable over
      // the {scope:"media-commit", uploadId, sha256, size} payload.
      deviceSignature: signature,
      uploadId,
      createdAt: new Date().toISOString(),
    };
    await this.assets.insertOne(asset);
    await this.blobsDeleteChunks(upload);
    await this.uploads.updateOne({ _id: uploadId }, { $set: { state: "committed", mediaId } });

    await this.quota.recordArtifact({
      networkId: upload.networkId,
      kind: "original",
      bytes: asset.bytes,
      retentionDays: limits.retentionDays,
      sourceId: mediaId,
    });
    const renditions = await this.generateRenditions(mediaId, { retentionDays: limits.retentionDays });

    await this.audit("upload_commit", {
      networkId: upload.networkId,
      did: upload.did,
      detail: { mediaId, bytes: asset.bytes, renditions: renditions.map((row) => row.kind) },
    });
    // PORCH-047: media.attached to the origin's room the moment the ingest
    // commits — a media reference, never an original renderable anywhere
    // else; content-only payload (renditions keep the timeline light).
    await this.realtime?.published({
      networkId: upload.networkId,
      type: "media.attached",
      postId: null,
      content: { mediaId: asset._id, contentType: asset.contentType, kind: "original", createdAt: asset.createdAt },
    });
    return {
      mediaId,
      sha256: payload.sha256,
      bytes: asset.bytes,
      renditions: renditions.map((row) => row.kind),
    };
  }

  /**
   * Rendition generation (ac-2/ac-4): the hub produces the rendition set
   * ON THE SERVER — never a device — from the immutable original: the
   * image rungs (feed-thumb, album, detail — width rungs clamped to the
   * original) for image content, the poster + playable set for video, and
   * no rendition rows for audio (audio renders in the original's stream).
   * Idempotent per media item: rendition kinds already at the current
   * format are skipped, a crash mid-set re-runs and completes the rest,
   * and rendition rows left by an older format are regenerated (the
   * pre-PORCH-044 byte-derivative set was not renderable by a browser).
   * The set lands inside the ≤2–4x storage budget (guarded per rung for
   * images, per set for video with a codec-overhead floor); renditions
   * count against the same quota ceiling as the original.
   */
  async generateRenditions(mediaId, { retentionDays = null } = {}) {
    const original = await this.assets.findOne({ _id: mediaId });
    if (!original || original.kind !== "original") {
      throw typedError("E_MEDIA_NOT_FOUND", MESSAGES.E_MEDIA_NOT_FOUND);
    }
    const existing = await this.assets.find({ networkId: original.networkId, originalId: mediaId, kind: "rendition" });
    const originalBytes = await this.blobs.get(original.blobKey);
    if (originalBytes === null) {
      throw typedError("E_ORIGINAL_BYTES_MISSING", MESSAGES.E_ORIGINAL_BYTES_MISSING, { mediaId });
    }
    // Format upgrade: rendition rows not at the current format are removed
    // (blob + asset + ledger row) before regeneration — the archive self-
    // heals to the rendering set of record.
    const stale = existing.filter((row) => row.format !== RENDITION_FORMAT_V2);
    for (const row of stale) {
      await this.blobs.delete(row.blobKey);
      await this.assets.deleteOne({ _id: row._id });
      await this.quota.removeArtifact(row._id);
    }
    const existingKinds = new Set(
      existing.filter((row) => row.format === RENDITION_FORMAT_V2).map((row) => row.renditionKind),
    );
    const rungs = rungsForContentType(this.renditionRungs, original.contentType);
    const generated = [];
    for (const [renditionKind, targetWidth] of Object.entries(rungs)) {
      if (existingKinds.has(renditionKind)) continue;
      const rendered = await this.#renderRung(original, originalBytes, renditionKind, targetWidth);
      // Rendition budget guard (TS 5: the ladder stays inside the ≤2–4x
      // storage budget). Image rungs guard per rung at the byte floor;
      // video guards per set from the video floor up (codec overhead on
      // tiny clips is not archive-scale storage). A runaway transform
      // never lands in storage.
      const floor = RENDITION_KINDS_VIDEO.has(renditionKind) ? VIDEO_BUDGET_FLOOR_BYTES : RENDITION_BUDGET_FLOOR_BYTES;
      if (original.bytes >= floor) {
        this.#assertRenditionBudget(original, existing, renditionKind, rendered.bytes.length);
      }
      const blobKey = sha256Hex(rendered.bytes);
      await this.blobs.put(blobKey, rendered.bytes);
      const renditionId = `rnd_${crypto.randomUUID()}`;
      await this.assets.insertOne({
        _id: renditionId,
        networkId: original.networkId,
        did: original.did,
        kind: "rendition",
        renditionKind,
        format: RENDITION_FORMAT_V2,
        originalId: mediaId,
        contentType: rendered.contentType,
        blobKey,
        sha256: blobKey,
        bytes: rendered.bytes.length,
        width: rendered.width ?? null,
        height: rendered.height ?? null,
        immutable: true,
        createdAt: new Date().toISOString(),
      });
      await this.quota.recordArtifact({
        networkId: original.networkId,
        kind: "rendition",
        bytes: rendered.bytes.length,
        retentionDays,
        sourceId: renditionId,
      });
      generated.push({ kind: renditionKind, renditionId, bytes: rendered.bytes.length });
    }
    if (generated.length > 0) {
      await this.audit("renditions_generate", {
        networkId: original.networkId,
        did: original.did,
        detail: { mediaId, kinds: generated.map((row) => row.kind) },
      });
    }
    return generated;
  }

  /** Decode/probe the original's pixels (image dims; video dims; audio null). */
  async #probeOriginal(bytes, contentType) {
    if (String(contentType).startsWith("image/")) {
      return imageMetadata(bytes);
    }
    if (String(contentType).startsWith("video/")) {
      return videoMetadata(bytes);
    }
    return null;
  }

  /** One rung through the right encoder family. */
  async #renderRung(original, originalBytes, renditionKind, targetWidth) {
    const source = {
      width: original.width ?? 2,
      height: original.height ?? 2,
      durationSeconds: original.durationSeconds ?? 0,
    };
    if (renditionKind === "poster") {
      return encodeVideoPoster(originalBytes, source, targetWidth);
    }
    if (renditionKind === "playable") {
      return encodeVideoPlayable(originalBytes, source, targetWidth);
    }
    return encodeImageRendition(originalBytes, targetWidth);
  }

  /** The set-level ≤4x guard (video renditions; per-rung guard for images). */
  #assertRenditionBudget(original, existing, renditionKind, renderedBytes) {
    if (!RENDITION_KINDS_VIDEO.has(renditionKind)) {
      if (renderedBytes > original.bytes * 4) {
        throw typedError("E_RENDITION_BUDGET_EXCEEDED", MESSAGES.E_RENDITION_BUDGET_EXCEEDED, { renditionKind });
      }
      return;
    }
    const currentVideoBytes =
      existing
        .filter((row) => RENDITION_KINDS_VIDEO.has(row.renditionKind))
        .reduce((total, row) => total + row.bytes, 0) + renderedBytes;
    if (currentVideoBytes > original.bytes * 4) {
      throw typedError("E_RENDITION_BUDGET_EXCEEDED", MESSAGES.E_RENDITION_BUDGET_EXCEEDED, { renditionKind });
    }
  }

  /**
   * Default serving path (ac-3): serve and share render from RENDITIONS.
   * Reads never consult the disk guard (reads continue at every
   * threshold).
   */
  async serveRendition({ accessToken, mediaId, renditionKind }) {
    const session = await this.#requireSession(accessToken);
    // The origin-asset lookup IS the containment check (throws when the
    // media does not exist at this token's origin).
    const _original = await this.#originAsset(mediaId, session);
    if (!RENDITION_KINDS.includes(renditionKind)) {
      throw typedError("E_RENDITION_KIND_UNKNOWN", MESSAGES.E_RENDITION_KIND_UNKNOWN);
    }
    let rendition = await this.assets.findOne({
      networkId: session.networkId,
      originalId: mediaId,
      kind: "rendition",
      renditionKind,
    });
    if (rendition && rendition.format !== RENDITION_FORMAT_V2) {
      // Archive self-heal (PORCH-044): pre-format-v2 renditions are the
      // byte-derivative set of record's earlier shape — not renderable in a
      // browser. The read regeneration upgrades the archive once; the next
      // lookup finds the renderable rendition.
      await this.generateRenditions(mediaId);
      rendition = await this.assets.findOne({
        networkId: session.networkId,
        originalId: mediaId,
        kind: "rendition",
        renditionKind,
      });
    }
    if (!rendition) {
      throw typedError("E_RENDITION_NOT_FOUND", MESSAGES.E_RENDITION_NOT_FOUND);
    }
    const bytes = await this.blobs.get(rendition.blobKey);
    if (bytes === null) {
      throw typedError("E_BLOB_MISSING", MESSAGES.E_BLOB_MISSING);
    }
    return {
      mediaId,
      renditionKind,
      contentType: rendition.contentType,
      sha256: rendition.sha256,
      width: rendition.width ?? null,
      height: rendition.height ?? null,
      bytes,
    };
  }

  /**
   * Explicit original-quality retrieval (ac-3): an explicit member action
   * against the archive — the deliberate contrast with the
   * rendition-default path; every use is audited.
   */
  async serveOriginal({ accessToken, mediaId }) {
    const session = await this.#requireSession(accessToken);
    const original = await this.#originAsset(mediaId, session);
    if (original.kind !== "original") {
      throw typedError("E_MEDIA_NOT_FOUND", MESSAGES.E_MEDIA_NOT_FOUND);
    }
    const bytes = await this.blobs.get(original.blobKey);
    if (bytes === null) {
      throw typedError("E_BLOB_MISSING", MESSAGES.E_BLOB_MISSING);
    }
    await this.audit("original_download", {
      networkId: session.networkId,
      did: session.did,
      detail: { mediaId, bytes: original.bytes },
    });
    return { mediaId, contentType: original.contentType, sha256: original.sha256, bytes };
  }

  /** The asset record for a media id at the session's origin (not bytes). */
  async describe({ accessToken, mediaId }) {
    const session = await this.#requireSession(accessToken);
    const asset = await this.#originAsset(mediaId, session);
    return {
      mediaId: asset._id,
      kind: asset.kind,
      renditionKind: asset.renditionKind ?? null,
      contentType: asset.contentType,
      bytes: asset.bytes,
      sha256: asset.sha256,
      width: asset.width ?? null,
      height: asset.height ?? null,
      durationSeconds: asset.durationSeconds ?? null,
      renditions:
        asset.kind === "original"
          ? Object.keys(rungsForContentType(this.renditionRungs, asset.contentType))
          : [],
    };
  }

  /**
   * Feed/post view hydration (PORCH-044 ac-2): every post view that
   * carries mediaRefs carries `mediaMeta` — per media id the original's
   * display dimensions and the rendition set of record (kind, sha256,
   * width, height, bytes; the poster frame riding the `poster` field for
   * video). Clients build srcset/sizes and the video poster/src from this;
   * no rendition metadata is fetched per item on the wire.
   */
  async withMediaMeta(views, networkId) {
    const ids = [...new Set(views.flatMap((view) => (Array.isArray(view.mediaRefs) ? view.mediaRefs : [])))];
    if (ids.length === 0) return views;
    const assets = await this.assets.find({ networkId });
    const relevant = assets.filter(
      (row) => ids.includes(row._id) || (row.kind === "rendition" && ids.includes(row.originalId)),
    );
    const meta = new Map(
      ids.map((id) => [id, { mediaId: id, contentType: null, width: null, height: null, poster: null, renditions: [] }]),
    );
    for (const row of relevant) {
      if (row.kind === "original") {
        const entry = meta.get(row._id);
        if (!entry) continue;
        entry.contentType = row.contentType;
        entry.width = row.width ?? null;
        entry.height = row.height ?? null;
        entry.durationSeconds = row.durationSeconds ?? null;
      } else {
        const entry = meta.get(row.originalId);
        if (!entry) continue;
        const shape = {
          kind: row.renditionKind,
          sha256: row.sha256,
          width: row.width ?? null,
          height: row.height ?? null,
          bytes: row.bytes,
        };
        if (RENDITION_KINDS_VIDEO.has(row.renditionKind)) {
          if (row.renditionKind === "poster") entry.poster = shape;
          else entry.renditions = [shape];
        } else {
          entry.renditions.push(shape);
        }
      }
    }
    // Image rungs sort narrowest→widest so srcset descriptors ascend.
    for (const entry of meta.values()) {
      entry.renditions.sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
    }
    for (const view of views) {
      if (Array.isArray(view.mediaRefs) && view.mediaRefs.length > 0) {
        view.mediaMeta = Object.fromEntries(view.mediaRefs.filter((id) => meta.has(id)).map((id) => [id, meta.get(id)]));
      }
    }
    return views;
  }

  /**
   * Disk guard status (ac-4, owner console): live probe against the
   * thresholds. `uploadsHalted` is the hard-stop surface — NEW uploads
   * are rejected at this state; reads continue at both thresholds.
   */
  async diskStatus() {
    const probe = await this.#probeDisk();
    if (probe === null) {
      return { available: false, softThreshold: this.softUsedRatio, hardThreshold: this.hardUsedRatio };
    }
    const usedRatio = probe.totalBytes > 0 ? 1 - probe.freeBytes / probe.totalBytes : 0;
    return {
      available: true,
      totalBytes: probe.totalBytes,
      freeBytes: probe.freeBytes,
      usedRatio,
      softThreshold: this.softUsedRatio,
      hardThreshold: this.hardUsedRatio,
      warning: usedRatio >= this.softUsedRatio,
      uploadsHalted: usedRatio >= this.hardUsedRatio,
    };
  }

  /**
   * Garbage collection of incomplete uploads (ac-1, scheduled/idempotent):
   * open uploads idle past the TTL are aborted and their chunk blobs are
   * deleted from storage; already-committed uploads are never touched.
   */
  async gcIncompleteUploads({ now = () => new Date() } = {}) {
    const cutoff = new Date(now().getTime() - this.uploadTtlSeconds * 1000).toISOString();
    const rows = await this.uploads.find({ state: "open" });
    const stale = rows.filter((row) => row.lastActivityAt < cutoff);
    let blobsFreed = 0;
    for (const upload of stale) {
      const full = Array.from({ length: upload.chunkCount }, (_, index) => index);
      for (const index of full) {
        if (await this.blobs.delete(chunkKey(upload._id, index))) {
          blobsFreed += 1;
        }
      }
      await this.uploads.updateOne({ _id: upload._id }, { $set: { state: "aborted" } });
    }
    for (const upload of stale) {
      await this.audit("upload_gc", {
        networkId: upload.networkId,
        detail: { uploadId: upload._id, chunksDeleted: upload.receivedChunks?.length ?? 0 },
      });
    }
    return { abortedUploads: stale.length, chunkBlobsDeleted: blobsFreed, at: now().toISOString() };
  }

  /**
   * Media retention sweep (ac-4): delegates the ledger row removal to the
   * quota service (rows + audit), then cascades the STORAGE side — every
   * expired artifact's media row (original or rendition) and its blob
   * bytes leave the store. Expired originals cascade their rendition rows
   * and blobs in the same pass.
   */
  async sweep({ networkId, now = () => new Date() } = {}) {
    // Expiry is evaluated through the quota service: the OWNER-SET retention
    // window applies at every pass, not the per-row stamp recorded at ingest
    // (tightening sweeps rows under the old window; widening preserves them).
    const rows = await this.quota.expiredArtifactRows({ networkId, now });
    const expiredRenditionIds = new Set();
    for (const row of rows) {
      const asset = row.sourceId ? await this.assets.findOne({ _id: row.sourceId }) : null;
      if (!asset) continue;
      if (asset.kind === "original" && asset.immutable) {
        // Original expiry cascades its rendition set (renditions are
        // derived artifacts of the original, same retention).
        const renditions = await this.assets.find({ networkId: asset.networkId, originalId: asset._id, kind: "rendition" });
        for (const rendition of renditions) {
          expiredRenditionIds.add(rendition._id);
          await this.assets.deleteOne({ _id: rendition._id });
          await this.blobs.delete(rendition.blobKey);
        }
      }
      await this.assets.deleteOne({ _id: asset._id });
      await this.blobs.delete(asset.blobKey);
    }
    const ledger = await this.quota.sweep({ networkId, now });
    void expiredRenditionIds;
    await this.audit("media_sweep", {
      networkId: String(networkId),
      detail: { assetRowsRemoved: rows.length, swept: ledger.swept, bytesFreed: ledger.bytesFreed },
    });
    return { ...ledger, assetRowsRemoved: rows.length };
  }

  /* Internals */

  /** Upload admission disk gate (hard stop; soft warning passes through). */
  async #diskGate(networkId) {
    const status = await this.diskStatus();
    if (status.available && status.uploadsHalted) {
      throw typedError(
        "E_DISK_HARD_STOP",
        MESSAGES.E_DISK_HARD_STOP,
        { usedRatio: status.usedRatio, hardThreshold: status.hardThreshold },
      );
    }
    const netStatus = { ...status, networkId: String(networkId) };
    if (status.available && status.warning) {
      await this.audit("disk_soft_warning", {
        networkId: String(networkId),
        detail: { usedRatio: status.usedRatio, softThreshold: status.softThreshold },
      });
    }
    return netStatus;
  }

  async #probeDisk() {
    if (!this.diskProbe) return null;
    try {
      return await this.diskProbe();
    } catch {
      // An unreadable filesystem probe degrades to "unknown" — never
      // silently hard-stops or hard-admits.
      return null;
    }
  }

  /** Committed uploads leave their chunk blobs behind — collect them. */
  async blobsDeleteChunks(upload) {
    const received = new Set(upload.receivedChunks ?? []);
    for (const index of Array.from({ length: upload.chunkCount }, (_, i) => i)) {
      if (received.size === 0 || received.has(index)) {
        await this.blobs.delete(`${upload._id}/${index}`);
      }
    }
  }

  async #chunkBytes(uploadId, index) {
    const bytes = await this.blobs.get(chunkKey(uploadId, index));
    if (bytes === null) {
      throw typedError("E_UPLOAD_INCOMPLETE", MESSAGES.E_UPLOAD_INCOMPLETE, { missingChunk: index });
    }
    return bytes;
  }

  async #openUpload(uploadId, session) {
    const upload = await this.uploads.findOne({ _id: uploadId });
    if (!upload) {
      throw typedError("E_UPLOAD_NOT_FOUND", MESSAGES.E_UPLOAD_NOT_FOUND);
    }
    // Containment: the perimeter token scopes every media write to exactly
    // one origin network, and the upload belongs to the member who began it.
    if (upload.networkId !== session.networkId || upload.did !== session.did) {
      throw typedError("E_NOT_PERMITTED", MESSAGES.E_NOT_PERMITTED);
    }
    if (upload.state !== "open") {
      throw typedError("E_UPLOAD_CLOSED", MESSAGES.E_UPLOAD_CLOSED, { state: upload.state });
    }
    return upload;
  }

  async #originAsset(mediaId, session) {
    const asset = await this.assets.findOne({ _id: mediaId });
    if (!asset || asset.networkId !== session.networkId) {
      throw typedError("E_MEDIA_NOT_FOUND", MESSAGES.E_MEDIA_NOT_FOUND);
    }
    return asset;
  }

  async #requireSession(accessToken) {
    if (!accessToken) {
      throw typedError("E_MUST_SIGN_IN", MESSAGES.E_MUST_SIGN_IN);
    }
    const perimeter = await this.membership.verifyAccessToken(accessToken, { surface: "media" });
    if (!perimeter) {
      throw typedError("E_NOT_PERMITTED", MESSAGES.E_NOT_PERMITTED);
    }
    return {
      did: perimeter.session.did,
      deviceId: perimeter.session.deviceId,
      networkId: perimeter.membership.networkId,
    };
  }

  /** Device-signed state-changing writes verify against the enrollment. */
  async verifyWrite({ networkId, did, deviceId, payload, signature }) {
    await this.membership.verifyMemberWrite({ networkId, did, deviceId, payload, signature });
  }
}

export const RENDITION_KINDS = ["feed-thumb", "album", "detail", "poster", "playable"];

/**
 * Rendition ladder rungs of record (PORCH-044, media pipeline TS 5): the
 * rungs are owner-readable configuration values (packages/shared
 * DEFAULT_CONFIG.media). Image rungs are pixel widths for the photo-first
 * treatments (full-bleed mobile feed, contained desktop cards, the detail
 * view); video posts carry the poster + playable set. Widths clamp to the
 * original at generation (never upscaled).
 */
export const DEFAULT_RENDITION_RUNGS = Object.freeze({
  image: Object.freeze({ "feed-thumb": 640, album: 1080, detail: 1600 }),
  video: Object.freeze({ poster: 640, playable: 1280 }),
});

/** Budget guard floor: at/above this original size the ≤4x budget is enforced. */
export const RENDITION_BUDGET_FLOOR_BYTES = 1024;

/** Video budget floor: codec overhead on tiny clips is not archive-scale storage. */
export const VIDEO_BUDGET_FLOOR_BYTES = 64 * 1024;

/**
 * Validate + default the owner-readable rung configuration. Kinds are
 * fixed (the ladder of record is the set above); an unknown kind or a
 * non-integer out-of-range width fails loudly instead of silently
 * shrinking the ladder.
 */
export function normalizeRenditionRungs(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const merged = {
    image: { ...DEFAULT_RENDITION_RUNGS.image, ...(src.image ?? {}) },
    video: { ...DEFAULT_RENDITION_RUNGS.video, ...(src.video ?? {}) },
  };
  for (const group of ["image", "video"]) {
    for (const kind of Object.keys(src?.[group] ?? {})) {
      if (!(kind in DEFAULT_RENDITION_RUNGS[group])) {
        throw typedError(
          "E_RENDITION_RUNG_INVALID",
          `config media.renditions.${group}.${kind} is not a rendition kind of record (${Object.keys(DEFAULT_RENDITION_RUNGS[group]).join(", ")}).`,
        );
      }
    }
    for (const [kind, width] of Object.entries(merged[group])) {
      if (!Number.isInteger(width) || width < 16 || width > 8192) {
        throw typedError(
          "E_RENDITION_RUNG_INVALID",
          `config media.renditions.${group}.${kind} must be an integer width between 16 and 8192 (got ${width}).`,
        );
      }
    }
  }
  return merged;
}

/** The rungs that apply to one content type: image rungs, the video set, or none. */
export function rungsForContentType(rungs, contentType) {
  const type = String(contentType ?? "");
  if (type.startsWith("video/")) return rungs.video;
  if (type.startsWith("image/")) return rungs.image;
  // Audio (and any future media kind) renders without renditions — the
  // original stream plays as stored; no ladder rung applies.
  return {};
}

/** Video rendition kinds (poster + playable). */
export const RENDITION_KINDS_VIDEO = new Set(["poster", "playable"]);

function chunkKey(uploadId, index) {
  return `${uploadId}/${index}`;
}

export const MESSAGES = {
  E_MUST_SIGN_IN: "Sign in to your membership before using the media surfaces.",
  E_NOT_PERMITTED: "This action is not available to you in this network.",
  E_UPLOAD_PAYLOAD_REQUIRED: "An upload needs its declared size and content type.",
  E_UPLOAD_DECLARATION_INVALID: "The upload declaration must carry an integer byte size and a content type.",
  E_UPLOAD_NOT_FOUND: "That upload session doesn't exist.",
  E_UPLOAD_CLOSED: "That upload is already settled (committed or aborted).",
  E_UPLOAD_INCOMPLETE: "That upload is missing chunks — resume it before committing.",
  E_CHUNK_EMPTY: "An upload chunk cannot be empty.",
  E_CHUNK_INDEX_INVALID: "That chunk index is outside the upload's chunk count.",
  E_CHUNK_SIZE_INVALID: "A chunk is larger than the upload's chunk size.",
  E_CHUNK_SHA_REQUIRED: "Every chunk carries its own sha256 for transport integrity.",
  E_CHUNK_CORRUPT: "That chunk failed its integrity check — resend it.",
  E_COMMIT_DECLARATION_INVALID: "The commit must declare the upload's sha256 and size.",
  E_COMMIT_SIZE_MISMATCH: "The uploaded bytes did not match the committed size.",
  E_COMMIT_SHA_MISMATCH: "The uploaded bytes did not match the committed sha256.",
  E_DISK_HARD_STOP: "The server's disk is critically full: new uploads are stopped until space is freed. Existing media and reads are unaffected.",
  E_MEDIA_NOT_FOUND: "That media doesn't exist in this network.",
  E_RENDITION_KIND_UNKNOWN: "Renditions are feed-thumb, detail, or album.",
  E_RENDITION_NOT_FOUND: "That rendition has not been generated yet.",
  E_RENDITION_BUDGET_EXCEEDED: "A rendition exceeded the storage budget and was not stored.",
  E_ORIGINAL_BYTES_MISSING: "The original's stored bytes are unreadable.",
  E_BLOB_MISSING: "The stored media bytes are unreadable.",
  E_MEDIA_UNDECODABLE: "The hub cannot decode this upload's pixels — nothing was stored. Photos arrive as JPEG/PNG/WebP/HEIC, videos as MP4/WebM/MOV.",
};

// The media store re-exports live here so the media service is the one
// import surface for the pipeline's byte layer.
export { sha256Hex, createMemoryMediaStore, createFileMediaStore, nodeDiskProbe } from "./media.store.js";

function isHex64(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function assertUploadDeclaration(payload) {
  const size = Number(payload.size);
  if (!Number.isInteger(size) || size < 1 || typeof payload.contentType !== "string" || payload.contentType.length === 0) {
    throw typedError("E_UPLOAD_DECLARATION_INVALID", MESSAGES.E_UPLOAD_DECLARATION_INVALID);
  }
}

export function typedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

export default MediaService;