import { logAuthFailure } from "@porchlight/shared";
import { bearerToken, endpointLabel } from "../util/session-guard.js";

/**
 * Avatar controller (PORCH-070). Transport only: pulls the Bearer session,
 * the raw upload bytes and their signed declaration (headers — the
 * media-chunk route's header declaration shape), the JSON commit/clear
 * bodies, and delegates the domain to the avatar service. Errors map by
 * typed code to plain-language responses; nothing else.
 *
 * Body split (one route surface, POST /accounts/me/avatar):
 * - ingest: Content-Type image/*, raw bytes as the body; the declaration
 *   rides `x-porchlight-avatar-payload` (JSON) and its device signature
 *   `x-porchlight-signature`.
 * - commit/clear: Content-Type application/json, body { payload, signature }
 *   — the hub's device-signed JSON-body write convention.
 */
export class AvatarController {
  /**
   * @param {{ accountService: import("../services/account.service.js").AccountService,
   *           avatarService: import("../services/avatar.service.js").AvatarService }} deps
   */
  constructor(accountService, avatarService, log = null) {
    this.accountService = accountService;
    this.avatarService = avatarService;
    this.log = log;
  }

  post = async (req, res) => {
    if (req.headers["x-porchlight-avatar-payload"] ? true : req.body && Buffer.isBuffer(req.body)) {
      return this.#ingest(req, res);
    }
    return this.#jsonAction(req, res);
  };

  async #ingest(req, res) {
    const token = bearerToken(req);
    let payload = null;
    try {
      payload = JSON.parse(String(req.headers["x-porchlight-avatar-payload"] ?? ""));
    } catch {
      payload = null;
    }
    try {
      const result = await this.avatarService.ingest({
        did: req.query.did ? String(req.query.did) : null,
        accessToken: token,
        bytes: req.body && req.body.length > 0 ? req.body : Buffer.alloc(0),
        payload,
        signature: String(req.headers["x-porchlight-signature"] ?? "") || null,
      });
      res.json(result);
    } catch (error) {
      this.memberError(res, error);
    }
  }

  async #jsonAction(req, res) {
    const token = bearerToken(req);
    const { payload, signature } = req.body ?? {};
    const did = req.query.did ? String(req.query.did) : null;
    try {
      if (payload?.action === "commit") {
        const result = await this.avatarService.commit({
          did,
          accessToken: token,
          token: payload?.token ?? null,
          payload,
          signature,
        });
        return res.json(result);
      }
      if (payload?.action === "clear") {
        const result = await this.avatarService.clear({
          did,
          accessToken: token,
          payload,
          signature,
        });
        return res.json(result);
      }
      return res.status(400).json({
        error: "The photo request is missing a known action (upload, confirm use, or remove).",
        code: "E_AVATAR_DECLARATION_INVALID",
      });
    } catch (error) {
      this.memberError(res, error);
    }
  }

  /** GET /avatars/:did/renditions/:kind — the face-serving surface. */
  serveRendition = async (req, res) => {
    try {
      const rung = await this.avatarService.serveRung({
        accessToken: bearerToken(req),
        did: req.params?.did ? decodeURIComponent(req.params.did) : null,
        kind: req.params?.kind,
        version: String(req.query?.["v"] ?? req.query?.version ?? "") || null,
        pendingToken: String(req.query?.["pending"] ?? "") || null,
      });
      res.set("Content-Type", rung.contentType);
      res.set("X-Porchlight-Sha256", rung.sha256);
      res.set("X-Porchlight-Media-Width", String(rung.width));
      res.set("X-Porchlight-Media-Height", String(rung.height));
      if (rung.pending) {
        // A face nobody confirmed yet is nobody's face to cache.
        res.set("Cache-Control", "private, no-store");
      } else {
        // The committed rungs are content-addressed and immutable — the
        // media pipeline's cache contract (PORCH-044 ac-3), one policy
        // everywhere media renders. (Rendition serving policy duplicated
        // here by the module boundary: the policy's home lives in the
        // social transport; identity may import no social internals.)
        res.set("Cache-Control", "private, max-age=31536000, immutable");
        res.set("ETag", `"${rung.sha256}"`);
      }
      return res.status(200).send(rung.bytes);
    } catch (error) {
      return this.memberError(res, error);
    }
  };

  memberError(res, error) {
    const plain = {
      E_SESSION_REQUIRED: 401,
      E_SIGNATURE_REQUIRED: 401,
      E_DEVICE_REQUIRED: 403,
      E_SIGNATURE_INVALID: 403,
      E_FORBIDDEN: 403,
      E_IDENTITY_NOT_FOUND: 404,
      E_AVATAR_DECLARATION_INVALID: 400,
      E_AVATAR_SHA_MISMATCH: 422,
      E_AVATAR_UNSUPPORTED_TYPE: 415,
      E_AVATAR_TOO_LARGE: 413,
      E_AVATAR_UNDECODABLE: 415,
      E_AVATAR_SAME_PHOTO: 409,
      E_AVATAR_PENDING_INVALID: 404,
      E_AVATAR_PENDING_NOT_FOUND: 404,
      E_RENDITION_KIND_UNKNOWN: 400,
      E_RENDITION_NOT_FOUND: 404,
      E_BLOB_MISSING: 500,
      E_AVATAR_UNAVAILABLE: 503,
    };
    if (error?.code && error.code === "E_SESSION_REQUIRED") {
      logAuthFailure(
        { endpoint: endpointLabel({ method: "POST", originalUrl: "/api/identity/accounts/me/avatar" }), code: "E_SESSION_REQUIRED", reason: error.cause?.code ?? "session_guard",
          detail: error.cause?.detail ?? null },
        this.log,
      );
    }
    if (error?.code && plain[error.code]) {
      return res.status(plain[error.code]).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: "The photo surface hit an unexpected error." });
  }
}

export default AvatarController;