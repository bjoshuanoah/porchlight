/**
 * Bulk original download controller (PORCH-083). Transport-specific only:
 * extracts the Bearer membership token and the set scope from HTTP,
 * delegates the set resolution + composition to the bulk-original service,
 * and maps typed errors to plain-language HTTP. Routes and controllers
 * must not perform domain operations.
 *
 * Stream shape (the export controller's pattern): the response opens as an
 * attachment immediately (browser-triggered download), the generator's
 * chunks are written straight through, and the chunks only start flowing
 * after the set resolution + readability checks complete — so a refused
 * set (not-found, empty, unreadable, paused volume) answers with a
 * plain-language JSON status, never a partial response. A failure AFTER
 * bytes have flowed aborts the connection instead: the download fails,
 * never a truncated silent zip.
 */
export class BulkOriginalController {
  /**
   * @param {object} deps
   * @param {import("../services/bulk-original.service.js").BulkOriginalService} deps.originals
   */
  constructor({ originals }) {
    this.originals = originals;
  }

  /** GET /albums/:name/media/originals.zip — the album's bulk set (ac-1). */
  album = async (req, res) => {
    return this.#streamZip(req, res, (accessToken) =>
      this.originals.streamAlbumZip({ accessToken, name: req.params?.name }),
    );
  };

  /** GET /posts/:postId/media/originals.zip — the post's bulk set (ac-1). */
  post = async (req, res) => {
    return this.#streamZip(req, res, (accessToken) =>
      this.originals.streamPostZip({ accessToken, postId: req.params?.postId }),
    );
  };

  bearer(req) {
    const header = req.headers?.authorization ?? "";
    return header.startsWith("Bearer ") ? header.slice(7) : null;
  }

  /**
   * The browser download name carries the set context (album name or post
   * id, PORCH-083). The name is member-authored text, so it is flattened to
   * the filename-safe alphabet — the set's identity rides the album/post
   * surfaces, never inside a path segment.
   */
  downloadName(req) {
    const flatten = (value) => String(value ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
    if (req.params?.postId) {
      return `porchlight-post-${flatten(req.params.postId)}-originals.zip`;
    }
    const name = flatten(req.params?.name);
    return name.length > 0
      ? `porchlight-album-${name}-originals.zip`
      : "porchlight-album-originals.zip";
  }

  async #streamZip(req, res, stream) {
    try {
      const generator = stream(this.bearer(req));
      res.set("Content-Type", "application/zip");
      res.set("Content-Disposition", `attachment; filename="${this.downloadName(req)}"`);
      res.set("X-Content-Type-Options", "nosniff");
      for await (const chunk of generator) {
        res.write(chunk);
      }
      return res.end();
    } catch (error) {
      if (res.headersSent) {
        // Mid-stream read-back failure: abort the connection so the
        // download fails visibly, never a truncated silent zip (ac-3).
        return res.destroy();
      }
      return this.memberError(res, error);
    }
  }

  /** Member-facing error mapping: the set-refusal states, named plainly. */
  memberError(res, error) {
    const statusByCode = {
      E_MUST_SIGN_IN: 401,
      E_SIGNATURE_REQUIRED: 401,
      E_NOT_PERMITTED: 403,
      E_ALBUM_NAME_REQUIRED: 400,
      E_ALBUM_NOT_FOUND: 404,
      E_POST_NOT_FOUND: 404,
      E_MEDIA_NOT_FOUND: 404,
      E_ORIGINALS_SET_EMPTY: 404,
      E_ORIGINAL_UNREADABLE: 500,
      E_BLOB_MISSING: 500,
      E_MEDIA_VOLUME_NOT_READY: 503,
      E_DISK_HARD_STOP: 507,
    };
    const status = statusByCode[error.code];
    if (status) {
      return res.status(status).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: "The download surface hit an unexpected error." });
  }
}

export default BulkOriginalController;