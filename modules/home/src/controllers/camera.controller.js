import { delegate, memberError } from "./transport.js";

/**
 * Camera controller (PORCH-139). Transport-specific: extracts the Bearer
 * identity token and the signed payload from HTTP, delegates the domain to
 * the camera service, and maps typed errors to plain-language HTTP. The one
 * streaming surface (the standing engine media path behind the scoped view
 * token) is the bridge's own feed-serving job: it verifies the token
 * hub-side and pipes the engine's re-stream, no domain logic.
 */
export class CameraController {
  /** @param {import("../services/camera.service.js").CameraService} service */
  constructor(service) {
    this.service = service;
  }

  bearer(req) {
    const header = req.headers?.authorization ?? "";
    return header.startsWith("Bearer ") ? header.slice(7) : null;
  }

  /** POST /homes/:homeId/cameras — add + validate one camera (owner, signed). */
  register = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return delegate(res, () => this.service.register({
      accessToken: this.bearer(req), homeId: req.params?.homeId, payload, signature,
    }));
  };

  /** GET /homes/:homeId/cameras — the member-with-authorization camera list. */
  list = async (req, res) => {
    return delegate(res, () => this.service.list({ accessToken: this.bearer(req), homeId: req.params?.homeId }));
  };

  /** PUT /cameras/:cameraId — rename/move (owner, signed). */
  update = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return delegate(res, () => this.service.update({
      accessToken: this.bearer(req), cameraId: req.params?.cameraId, payload, signature,
    }));
  };

  /** POST /cameras/:cameraId/recording — per-camera recording control. */
  setRecording = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return delegate(res, () => this.service.setRecording({
      accessToken: this.bearer(req), cameraId: req.params?.cameraId, payload, signature,
    }));
  };

  /** POST /homes/:homeId/cameras/recording — bulk recording control. */
  bulkRecording = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return delegate(res, () => this.service.bulkRecording({
      accessToken: this.bearer(req), homeId: req.params?.homeId, payload, signature,
    }));
  };

  /** GET /homes/:homeId/cameras/health — the three independent planes + storage + service. */
  health = async (req, res) => {
    return delegate(res, () => this.service.health({ accessToken: this.bearer(req), homeId: req.params?.homeId }));
  };

  /** POST /homes/:homeId/camera-access — owner grants a member camera access. */
  grantAccess = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return delegate(res, () => this.service.grantAccess({
      accessToken: this.bearer(req), homeId: req.params?.homeId, payload, signature,
    }));
  };

  /** GET /homes/:homeId/camera-access — owner's camera authorization list. */
  listAccess = async (req, res) => {
    return delegate(res, () => this.service.listAccess({ accessToken: this.bearer(req), homeId: req.params?.homeId }));
  };

  /** POST /camera-access/:accessId/revoke — camera access ends. */
  revokeAccess = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return delegate(res, () => this.service.revokeAccess({
      accessToken: this.bearer(req), accessId: req.params?.accessId, payload, signature,
    }));
  };

  /** POST /homes/:homeId/camera-view — the scoped bridge session (token + feeds). */
  viewSession = async (req, res) => {
    return delegate(res, () => this.service.viewSession({ accessToken: this.bearer(req), homeId: req.params?.homeId }));
  };

  /** GET /homes/:homeId/timeline?from&to&cameraId — segments + event thumbnails. */
  timeline = async (req, res) => {
    return delegate(res, () => this.service.timeline({
      accessToken: this.bearer(req), homeId: req.params?.homeId,
      from: req.query?.from, to: req.query?.to, cameraId: req.query?.cameraId ?? null,
    }));
  };

  /** GET /homes/:homeId/seek?cameraId&at — seek to a known time or the gap. */
  seek = async (req, res) => {
    return delegate(res, () => this.service.seek({
      accessToken: this.bearer(req), homeId: req.params?.homeId,
      cameraId: req.query?.cameraId, at: req.query?.at,
    }));
  };

  /**
   * GET /homes/:homeId/cameras/:cameraId/media?path&token — the bridge's
   * media serving: the scoped engine view token (or a bearer session) is
   * verified hub-side, then the engine's standing re-stream pipes through.
   * This is the one transport-specific handler in the module — media bytes
   * need stream plumbing, and the auth resolution stays hub-side.
   */
  media = async (req, res) => {
    let resolved = null;
    try {
      resolved = await this.service.mediaRef({
        accessToken: this.bearer(req),
        token: req.query?.token ?? null,
        homeId: req.params?.homeId,
        cameraId: req.params?.cameraId,
        path: req.query?.path ? String(req.query.path) : null,
      });
    } catch (error) {
      return memberError(res, error);
    }
    const engine = this.service.engine;
    if (!engine?.openMedia) {
      return res.status(503).json({ code: "E_ENGINE_NOT_CONNECTED", error: "The camera engine isn't connected yet." });
    }
    let upstream = null;
    try {
      upstream = await engine.openMedia(resolved.path);
    } catch {
      return res.status(502).json({ code: "E_ENGINE_UNAVAILABLE", error: "The camera engine didn't answer for that feed." });
    }
    if (upstream?.gap) {
      return res.status(404).json({ code: "E_FOOTAGE_GAP", error: "That footage can't be served right now.", gap: String(upstream.gap) });
    }
    res.status(200);
    if (upstream.contentType) res.setHeader("content-type", upstream.contentType);
    if (upstream.body) {
      const { Readable } = await import("node:stream");
      Readable.fromWeb(upstream.body).pipe(res);
      return;
    }
    return res.json({});
  };
}

export default CameraController;
