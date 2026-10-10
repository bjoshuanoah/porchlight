/**
 * Album controller (PORCH-013). Transport-specific only: extracts the
 * Bearer membership token, the album name/path params, and the device
 * signature; delegates the domain to the album and media services; maps
 * typed errors to plain-language HTTP. Routes and controllers must not
 * perform domain operations.
 *
 * Serve paths stream bytes exactly like the media surface (integrity
 * header X-Porchlight-Sha256). The album rendition is the default serve
 * path; the original-quality retrieval is the explicit, audited member
 * action against the archive. The rendition/original cache policy is the
 * media pipeline's single contract (PORCH-044 ac-3).
 */
import {
  RENDITION_CACHE_CONTROL,
  ORIGINAL_CACHE_CONTROL,
  contentAddressMatches,
  ifNoneMatchSatisfied,
} from "./media-response.js";

export class AlbumController {
  /**
   * @param {object} deps
   * @param {import("../services/album.service.js").AlbumService} deps.albums
   */
  constructor({ albums }) {
    this.albums = albums;
  }

  /** GET /albums — this origin's albums (manual-organization list). */
  listAlbums = async (req, res) => {
    return this.memberResult(res, () => this.albums.list({ accessToken: this.bearer(req) }));
  };

  /** GET /albums/:name — one album's items (origin-contained post views). */
  getAlbum = async (req, res) => {
    return this.memberResult(res, () =>
      this.albums.get({ accessToken: this.bearer(req), name: req.params?.name }),
    );
  };

  /** POST /albums/:name/items — device-signed add of a post to the album. */
  addItem = async (req, res) => {
    const { postId, signature } = req.body ?? {};
    return this.memberResult(res, () =>
      this.albums.addItem({ accessToken: this.bearer(req), name: req.params?.name, postId, signature }),
    );
  };

  /** DELETE /albums/:name/items/:postId — device-signed remove of one item. */
  removeItem = async (req, res) => {
    return this.memberResult(res, () =>
      this.albums.removeItem({
        accessToken: this.bearer(req),
        name: req.params?.name,
        postId: req.params?.postId,
        signature: this.requestSignature(req),
      }),
    );
  };

  /** DELETE /albums/:name — device-signed whole-album cascade delete. */
  deleteAlbum = async (req, res) => {
    return this.memberResult(res, () =>
      this.albums.deleteAlbum({
        accessToken: this.bearer(req),
        name: req.params?.name,
        signature: this.requestSignature(req),
      }),
    );
  };

  /** GET /albums/:name/media — album-serving list, renditions as default. */
  mediaList = async (req, res) => {
    return this.memberResult(res, () =>
      this.albums.listMedia({ accessToken: this.bearer(req), name: req.params?.name }),
    );
  };

  /** GET /albums/:name/media/:mediaId/renditions/:kind — the default serve path (ac-3). */
  serveRendition = async (req, res) => {
    try {
      const rendition = await this.albums.serveRendition({
        accessToken: this.bearer(req),
        name: req.params?.name,
        mediaId: req.params?.mediaId,
        renditionKind: req.params?.kind,
      });
      if (!contentAddressMatches(req.query?.v ?? null, rendition.sha256)) {
        return res.status(404).json({ error: "That rendition has not been generated yet.", code: "E_RENDITION_NOT_FOUND" });
      }
      res.set("Cache-Control", RENDITION_CACHE_CONTROL);
      res.set("ETag", `"${rendition.sha256}"`);
      res.set("X-Porchlight-Sha256", rendition.sha256);
      if (ifNoneMatchSatisfied(req, rendition.sha256)) {
        return res.status(304).end();
      }
      return res.status(200).type(rendition.contentType).send(rendition.bytes);
    } catch (error) {
      return this.memberError(res, error);
    }
  };

  /** GET /albums/:name/media/:mediaId/original — explicit archive retrieval (ac-3). */
  serveOriginal = async (req, res) => {
    try {
      const original = await this.albums.serveOriginal({
        accessToken: this.bearer(req),
        name: req.params?.name,
        mediaId: req.params?.mediaId,
      });
      res.set("Cache-Control", ORIGINAL_CACHE_CONTROL);
      res.set("X-Porchlight-Sha256", original.sha256);
      return res.status(200).type(original.contentType).send(original.bytes);
    } catch (error) {
      return this.memberError(res, error);
    }
  };

  bearer(req) {
    const header = req.headers?.authorization ?? "";
    return header.startsWith("Bearer ") ? header.slice(7) : null;
  }

  /**
   * DELETE writes carry the device signature out-of-band (query, like the
   * export stream). POST writes carry it in the JSON body.
   */
  requestSignature(req) {
    return req.query?.signature ?? req.body?.signature ?? null;
  }

  async memberResult(res, work) {
    try {
      const result = await work();
      return res.status(200).json(result ?? { ok: true });
    } catch (error) {
      return this.memberError(res, error);
    }
  }

  /** Member-facing error mapping: album codes plus the media delegate codes. */
  memberError(res, error) {
    const statusByCode = {
      E_MUST_SIGN_IN: 401,
      E_SIGNATURE_REQUIRED: 401,
      E_SIGNATURE_INVALID: 403,
      E_NOT_PERMITTED: 403,
      E_POST_NOT_FOUND: 404,
      E_ALBUM_NOT_FOUND: 404,
      E_ALBUM_ITEM_NOT_FOUND: 404,
      E_ALBUM_NAME_REQUIRED: 400,
      E_MEDIA_NOT_FOUND: 404,
      E_RENDITION_NOT_FOUND: 404,
      E_RENDITION_KIND_UNKNOWN: 400,
      E_RENDITION_BUDGET_EXCEEDED: 500,
      E_BLOB_MISSING: 500,
      E_MEDIA_UNDECODABLE: 415,
    };
    const status = statusByCode[error.code];
    if (status) {
      return res.status(status).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: "The albums surface hit an unexpected error." });
  }
}

export default AlbumController;