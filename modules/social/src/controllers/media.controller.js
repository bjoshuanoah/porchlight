/**
 * Media controller (PORCH-008). Transport-specific only: extracts the
 * Bearer membership token, the device-signed payloads, and raw chunk
 * bytes from HTTP, delegates the domain to the media/export services, and
 * maps typed errors to plain-language HTTP responses. Routes and
 * controllers must not perform domain operations.
 *
 * Streaming note (ac-3): the export archive is written to the response as
 * the generator produces chunks — no server-local staging — with the
 * Content-Disposition attachment name carrying the network's export name.
 */
import {
  RENDITION_CACHE_CONTROL,
  ORIGINAL_CACHE_CONTROL,
  contentAddressMatches,
  ifNoneMatchSatisfied,
} from "./media-response.js";

export class MediaController {
  /**
   * @param {object} deps
   * @param {import("../services/media.service.js").MediaService} deps.media
   * @param {import("../services/export.service.js").ExportService} deps.export
   */
  constructor({ media, export: exportService }) {
    this.media = media;
    this.export = exportService;
  }

  /** POST /media/uploads — begin a resumable chunked upload (ac-1). */
  beginUpload = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return this.memberResult(res, () =>
      this.media.beginUpload({ accessToken: this.bearer(req), payload, signature }),
    );
  };

  /** GET /media/uploads/:uploadId — resume surface for the browser (ac-1). */
  uploadStatus = async (req, res) => {
    return this.memberResult(res, () =>
      this.media.uploadStatus({ accessToken: this.bearer(req), uploadId: req.params?.uploadId }),
    );
  };

  /**
   * PUT /media/uploads/:uploadId/chunks/:index — one raw chunk (ac-1).
   * The body is raw bytes (express.raw on the route); the chunk's own
   * sha256 is declared in the x-chunk-sha256 header and verified.
   */
  putChunk = async (req, res) => {
    return this.memberResult(res, () =>
      this.media.putChunk({
        accessToken: this.bearer(req),
        uploadId: req.params?.uploadId,
        index: req.params?.index,
        bytes: req.body,
        chunkSha: req.headers?.["x-chunk-sha256"] ?? null,
      }),
    );
  };

  /** POST /media/uploads/:uploadId/complete — device-signed commit (ac-1). */
  completeUpload = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return this.memberResult(res, () =>
      this.media.completeUpload({
        accessToken: this.bearer(req),
        uploadId: req.params?.uploadId,
        payload,
        signature,
      }),
    );
  };

  /** GET /media/:mediaId/renditions/:kind — the rendition-default serve path (ac-3). */
  serveRendition = async (req, res) => {
    try {
      const rendition = await this.media.serveRendition({
        accessToken: this.bearer(req),
        mediaId: req.params?.mediaId,
        renditionKind: req.params?.kind,
      });
      // Content-addressed and immutable (PORCH-044 ac-3): the URL carries
      // the rendition's sha256, so the long-lived browser-cache contract is
      // safe — a mismatched content address is not that rendition.
      if (!contentAddressMatches(req.query?.v ?? null, rendition.sha256)) {
        return res.status(404).json({ error: "That rendition has not been generated yet.", code: "E_RENDITION_NOT_FOUND" });
      }
      res.set("Cache-Control", RENDITION_CACHE_CONTROL);
      res.set("ETag", `"${rendition.sha256}"`);
      res.set("X-Porchlight-Sha256", rendition.sha256);
      res.set("X-Porchlight-Media-Width", String(rendition.width ?? 0));
      res.set("X-Porchlight-Media-Height", String(rendition.height ?? 0));
      if (ifNoneMatchSatisfied(req, rendition.sha256)) {
        return res.status(304).end();
      }
      return res.status(200).type(rendition.contentType).send(rendition.bytes);
    } catch (error) {
      return this.memberError(res, error);
    }
  };

  /** GET /media/:mediaId/original — the explicit archive-original action (ac-3). */
  serveOriginal = async (req, res) => {
    try {
      const original = await this.media.serveOriginal({
        accessToken: this.bearer(req),
        mediaId: req.params?.mediaId,
      });
      // Originals are never pre-cached (PORCH-044 ac-3): the explicit
      // archive action always revalidates against the archive.
      res.set("Cache-Control", ORIGINAL_CACHE_CONTROL);
      res.set("X-Porchlight-Sha256", original.sha256);
      return res.status(200).type(original.contentType).send(original.bytes);
    } catch (error) {
      return this.memberError(res, error);
    }
  };

  /** GET /media/export — device-signed request streams the archive (ac-3). */
  exportArchive = async (req, res) => {
    try {
      const accessToken = this.bearer(req);
      const signature = req.query?.signature ?? req.body?.signature ?? null;
      // Single enforcement path: the export service owns the token,
      // membership, and device-signature checks (PORCH-015 — the duplicated
      // inline perimeter check was removed); the controller only asks for
      // the verified perimeter to name the attachment.
      const { networkId } = await this.export.verifyExportRequest({ accessToken, signature });
      const generator = this.export.streamMemberExport({ accessToken, signature });
      res.set("Content-Type", "application/zip");
      res.set("Content-Disposition", `attachment; filename="${this.constructor.archiveName(networkId)}"`);
      res.set("X-Content-Type-Options", "nosniff");
      for await (const chunk of generator) {
        res.write(chunk);
      }
      return res.end();
    } catch (error) {
      return this.memberError(res, error);
    }
  };

  bearer(req) {
    const header = req.headers?.authorization ?? "";
    return header.startsWith("Bearer ") ? header.slice(7) : null;
  }

  /** Archive download naming lives with the controller's export surface. */
  static archiveName(networkId) {
    return `porchlight-export-${networkId}.zip`;
  }

  memberError(res, error) {
    const plain = {
      E_STORAGE_QUOTA_EXCEEDED: 429,
      E_DISK_HARD_STOP: 507,
      E_MUST_SIGN_IN: 401,
      E_SIGNATURE_REQUIRED: 401,
      E_SIGNATURE_INVALID: 403,
      E_NOT_PERMITTED: 403,
      E_UPLOAD_NOT_FOUND: 404,
      E_UPLOAD_CLOSED: 409,
      E_UPLOAD_INCOMPLETE: 409,
      E_MEDIA_NOT_FOUND: 404,
      E_RENDITION_NOT_FOUND: 404,
      E_RENDITION_KIND_UNKNOWN: 400,
      E_RENDITION_BUDGET_EXCEEDED: 500,
      E_CHUNK_EMPTY: 400,
      E_CHUNK_INDEX_INVALID: 400,
      E_CHUNK_SIZE_INVALID: 400,
      E_CHUNK_SHA_REQUIRED: 400,
      E_CHUNK_CORRUPT: 422,
      E_COMMIT_DECLARATION_INVALID: 400,
      E_COMMIT_SIZE_MISMATCH: 422,
      E_COMMIT_SHA_MISMATCH: 422,
      E_UPLOAD_DECLARATION_INVALID: 400,
      E_UPLOAD_PAYLOAD_REQUIRED: 400,
      E_ORIGINAL_BYTES_MISSING: 500,
      E_BLOB_MISSING: 500,
      E_EXPORT_MEDIA_MISSING: 500,
      E_MEDIA_UNDECODABLE: 415,
      // PORCH-054: the volume readiness states surface exactly as named.
      E_MEDIA_VOLUME_NOT_READY: 503,
      E_MEDIA_ROOT_INVALID: 400,
      E_MEDIA_ROOT_REFUSED: 422,
    };
    if (error?.code && plain[error.code]) {
      return res.status(plain[error.code]).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: "The media surface hit an unexpected error." });
  }

  async memberResult(res, work) {
    try {
      const result = await work();
      return res.status(200).json(result ?? { ok: true });
    } catch (error) {
      return this.memberError(res, error);
    }
  }
}

export default MediaController;