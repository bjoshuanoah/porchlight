/**
 * Camera service (PORCH-139, PRD 2 / TS 2 of the Porchlight Home
 * initiative). The cameras and NVR engine (PORCH-I-009) is the recording,
 * detection, and storage source of record — consumed, never built here.
 * The home domain owns three things the engine does not:
 *
 *   1. the association store — camera ↔ home, camera ↔ covered area
 *      (rooms/outdoor areas), so feeds and events land in the home in view;
 *   2. camera authorization as its OWN grant scope class — a live visit
 *      grant never reaches a camera surface (the bridge refuses with plain
 *      language); members need a separate camera-access row, owners hold
 *      cameras by membership;
 *   3. the family-UI projection — feed descriptors (natural aspect, per-
 *      camera audio), timeline/seek against the engine's segment index,
 *      and the health planes joined into explained states.
 *
 * The engine seam (injected; tests provide fakes, the hub builds the
 * transport adapters from the runtime config of record):
 *   validateCamera({ url }) → { ok: true, cameraId, aspect: {width,height}|null, audio }
 *                           | { ok: false, reason }
 *   liveFeed(engineCameraId) → { upstreamId, path, audio }
 *       ONE upstream connection per camera fanned out to every consumer
 *       (PORCH-I-009 PRD 9) — the bridge holds a standing descriptor per
 *       camera and never opens a second upstream for added viewers.
 *   openMedia(path) → { body: ReadableStream, contentType } | { gap: reason }
 *   segments({ cameraId, from, to }) → [{ start, end, ref }]
 *   segmentAt({ cameraId, at }) → { ref, path, kind } | { gap }
 *   evidenceAt({ cameraId, at }) → { kind, ref, path } | { gap }
 *   health(engineCameraId) → { recording: {state}, playback: {state}, detection: {state} }
 *   serviceHealth() / storage() → { state, detail }
 */
import { requireSignedSession, requireSession } from "../util/writes.js";
import { fail } from "./errors.js";
import { createEngineTokenService } from "./engine-token.js";

export const CAMERA_GAPS = ["retention-expired", "recording-disabled", "unavailable", "degraded"];

/** Standing descriptor cache TTL — one liveFeed lookup per camera per window. */
const FEED_CACHE_MS = 60_000;

function cleanName(value, fallback) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) {
    if (fallback === true) return null;
    return fail("E_NAME_REQUIRED", "Give this camera a name — any household label works.");
  }
  if (name.length > 120) {
    return fail("E_NAME_TOO_LONG", "That name is too long — 120 characters or fewer, please.");
  }
  return name;
}

/** Aspect ratio (width / height) of an engine-reported frame, or null. */
export function cameraAspect(aspect) {
  if (!aspect || !Number.isFinite(Number(aspect.width)) || !Number.isFinite(Number(aspect.height))) return null;
  const w = Number(aspect.width);
  const h = Number(aspect.height);
  if (w <= 0 || h <= 0) return null;
  return w / h;
}

export class CameraService {
  /**
   * @param {import("@porchlight/shared").CollectionLike} cameras
   * @param {import("@porchlight/shared").CollectionLike} cameraAccess
   * @param {import("./home.service.js").HomeService} homes
   * @param {import("@porchlight/shared").CollectionLike} areas
   * @param {import("@porchlight/shared").CollectionLike} events — the event
   *     service's home events (same module, same store): timeline thumbnails.
   * @param {object|null} engine — the engine seam above; null = not connected,
   *     every camera surface fails closed with plain language.
   * @param {import("@porchlight/shared").CollectionLike} homeAudit
   * @param {{ verifySession, registeredDeviceKey }} identity
   * @param {{ secret: string } | null} engineTokenSecrets — the bridge's
   *     engine-token issuer; absent = no view tokens can be minted.
   * @param {() => string} [now]
   */
  constructor(cameras, cameraAccess, homes, areas, events, engine, homeAudit, identity, engineTokenSecrets, now = defaultNow) {
    this.cameras = cameras;
    this.cameraAccess = cameraAccess;
    this.homes = homes;
    this.areas = areas;
    this.events = events;
    this.engine = engine ?? null;
    this.audit = homeAudit;
    this.verifySession = identity.verifySession;
    this.registeredDeviceKey = identity.registeredDeviceKey ?? null;
    this.engineToken = engineTokenSecrets ? createEngineTokenService({ ...engineTokenSecrets, now }) : null;
    this.now = now;
    this.feedCache = new Map();
  }

  // --- authorization ---------------------------------------------------------

  /**
   * The bridge's camera authorization seam: home membership + SEPARATE
   * camera authorization. Owners hold cameras by membership; a member needs
   * a live camera-access row; a visit grantee (individual or family
   * distribution) resolves to NO camera surface — the refusal is plain
   * language, camera authorization is never bundled with device controls.
   */
  async authorizeRead(accessToken, homeId) {
    const { did } = await requireSession({ accessToken, verifySession: this.verifySession });
    return this.authorizeReadForActor({ did, homeId });
  }

  /**
   * The camera read authorization seam, session-free (the did already
   * resolved) — the SAME verdicts: home membership, the separate
   * camera-access row, and no camera surface for any visit grantee.
   * PORCH-149's event-review actor seam rides this.
   */
  async authorizeReadForActor({ did, homeId } = {}) {
    const authorized = await this.homes.authorizeMember({ did, homeId });
    if (authorized.access?.accessClass !== "owner-membership") {
      return fail("E_NOT_PERMITTED", "Cameras never ride a visit grant — ask the home's owner for camera access.");
    }
    if (authorized.role === "owner") return authorized;
    const access = await this.cameraAccess.findOne({
      homeId: String(homeId), did: authorized.did, revokedAt: null,
    });
    if (!access) {
      return fail("E_CAMERA_ACCESS_REQUIRED", "Cameras carry their own authorization — ask your home's owner for camera access.");
    }
    return authorized;
  }

  /** Owner-only surfaces: add/validate, recording controls, storage/health. */
  async authorizeOwner(accessToken, homeId) {
    const authorized = await this.homes.authorize({ accessToken, homeId });
    if (authorized.access?.accessClass !== "owner-membership" || authorized.role !== "owner") {
      return fail("E_NOT_PERMITTED", "This camera surface belongs to the home's owner.");
    }
    return authorized;
  }

  /**
   * Require the engine connection of record. Camera surfaces are the
   * bridge's projection of an engine that is a separate service: with no
   * connection they fail closed and explain themselves — never a healthy
   * blank surface.
   */
  requireEngine() {
    if (!this.engine) {
      return fail("E_ENGINE_NOT_CONNECTED", "The camera engine isn't connected yet — live feeds, playback, and health return when it is.");
    }
    return this.engine;
  }

  // --- association store -----------------------------------------------------

  /** POST /homes/:homeId/cameras — add + validate one camera (owner, signed). */
  async register({ accessToken, homeId, payload, signature } = {}) {
    const { did } = await this.authorizeOwner(accessToken, homeId);
    await requireSignedSession({
      accessToken, payload, signature, verifySession: this.verifySession, registeredDeviceKey: this.registeredDeviceKey,
    });
    const name = cleanName(payload?.name);
    const rtsp = typeof payload?.rtsp === "string" ? payload.rtsp.trim() : "";
    if (!rtsp) return fail("E_VALIDATION", "Point the camera at the home's engine — a camera URL is required.");
    const engine = this.requireEngine();
    let validated = null;
    try {
      validated = await engine.validateCamera({ url: rtsp });
    } catch {
      return fail("E_CAMERA_REJECTED", "The camera engine couldn't be reached to validate this camera.");
    }
    if (!validated?.ok) {
      return fail("E_CAMERA_REJECTED", `The engine couldn't validate that camera — ${validated?.reason || "check the camera's connection"}.`);
    }
    const areaId = typeof payload?.areaId === "string" ? payload.areaId : null;
    if (areaId) {
      const area = await this.areas.findOne({ _id: areaId, homeId: String(homeId) });
      if (!area) return fail("E_AREA_NOT_FOUND", "That area isn't part of this home — cameras land in a room or outdoor area.");
    }
    const camera = {
      _id: `cam_${crypto.randomUUID()}`,
      homeId: String(homeId),
      areaId,
      engineCameraId: String(validated.cameraId),
      name,
      /** Covering-area coverage drives where camera events land (TS 2 association). */
      aspect: validated.aspect ?? null,
      audio: validated.audio === true,
      recordingEnabled: true,
      createdBy: did,
      deviceSignature: signature ?? null,
      createdAt: this.now(),
    };
    await this.cameras.insertOne(camera);
    this.feedCache.delete(camera.engineCameraId);
    await this.audit.record({
      type: "camera-change",
      homeId: camera.homeId,
      actorIdentityRef: did,
      detail: { action: "register", cameraId: camera._id, name },
      outcome: "confirmed",
    });
    return { camera: this.view(camera) };
  }

  /** PUT /cameras/:cameraId — rename or move the covered area (owner, signed). */
  async update({ accessToken, cameraId, payload, signature } = {}) {
    const camera = await this.findOne(cameraId);
    const { did } = await this.authorizeOwner(accessToken, camera.homeId);
    await requireSignedSession({
      accessToken, payload, signature, verifySession: this.verifySession, registeredDeviceKey: this.registeredDeviceKey,
    });
    const update = {};
    if (payload?.name !== undefined) update.name = cleanName(payload.name);
    if (payload?.areaId !== undefined) {
      const areaId = payload.areaId ? String(payload.areaId) : null;
      if (areaId) {
        const area = await this.areas.findOne({ _id: areaId, homeId: camera.homeId });
        if (!area) return fail("E_AREA_NOT_FOUND", "That area isn't part of this home — cameras land in a room or outdoor area.");
      }
      update.areaId = areaId;
    }
    await this.cameras.updateOne({ _id: camera._id }, { $set: update });
    await this.audit.record({
      type: "camera-change",
      homeId: camera.homeId,
      actorIdentityRef: did,
      detail: { action: "update", cameraId: camera._id, fields: Object.keys(update) },
      outcome: "confirmed",
    });
    return { camera: this.view({ ...camera, ...update }) };
  }

  /** POST /cameras/:cameraId/recording — per-camera recording control (owner). */
  async setRecording({ accessToken, cameraId, payload, signature } = {}) {
    const camera = await this.findOne(cameraId);
    const { did } = await this.authorizeOwner(accessToken, camera.homeId);
    await requireSignedSession({
      accessToken, payload, signature, verifySession: this.verifySession, registeredDeviceKey: this.registeredDeviceKey,
    });
    const enabled = payload?.enabled === true;
    await this.cameras.updateOne({ _id: camera._id }, { $set: { recordingEnabled: enabled } });
    await this.audit.record({
      type: "camera-recording",
      homeId: camera.homeId,
      actorIdentityRef: did,
      detail: { action: "set-recording", cameraId: camera._id, cameraName: camera.name, enabled },
      outcome: "confirmed",
    });
    return { camera: this.view({ ...camera, recordingEnabled: enabled }) };
  }

  /** POST /homes/:homeId/cameras/recording — bulk recording control (owner). */
  async bulkRecording({ accessToken, homeId, payload, signature } = {}) {
    const { did } = await this.authorizeOwner(accessToken, homeId);
    await requireSignedSession({
      accessToken, payload, signature, verifySession: this.verifySession, registeredDeviceKey: this.registeredDeviceKey,
    });
    const enabled = payload?.enabled === true;
    const wanted = Array.isArray(payload?.cameraIds) ? payload.cameraIds.map(String) : null;
    const all = await this.cameras.find({ homeId: String(homeId) });
    const targets = wanted ? all.filter((cam) => wanted.includes(cam._id)) : all;
    if (!targets.length) return fail("E_CAMERA_NOT_FOUND", "No cameras to change in this home — a camera recording change needs names.");
    for (const camera of targets) {
      await this.cameras.updateOne({ _id: camera._id }, { $set: { recordingEnabled: enabled } });
      this.feedCache.delete(camera.engineCameraId);
    }
    await this.audit.record({
      type: "camera-recording",
      homeId: String(homeId),
      actorIdentityRef: did,
      detail: { action: "bulk-recording", cameraIds: targets.map((cam) => cam._id), enabled },
      outcome: "confirmed",
    });
    return { cameras: targets.map((cam) => this.view({ ...cam, recordingEnabled: enabled })) };
  }

  // --- camera authorization (the separate grant scope class) -----------------

  /** POST /homes/:homeId/camera-access — the owner grants a MEMBER camera access. */
  async grantAccess({ accessToken, homeId, payload, signature } = {}) {
    const { did: ownerDid } = await this.authorizeOwner(accessToken, homeId);
    await requireSignedSession({
      accessToken, payload, signature, verifySession: this.verifySession, registeredDeviceKey: this.registeredDeviceKey,
    });
    const did = typeof payload?.did === "string" ? payload.did.trim() : "";
    if (!did) return fail("E_VALIDATION", "Name the member who should reach this home's cameras.");
    let member = null;
    try {
      member = await this.homes.authorizeMember({ did, homeId });
    } catch (error) {
      if (error?.code === "E_NOT_PERMITTED") {
        return fail("E_CAMERA_MEMBER_UNKNOWN", "Camera access goes to this home's members only — visit grants never reach cameras.");
      }
      throw error;
    }
    if (member.access?.accessClass !== "owner-membership") {
      return fail("E_CAMERA_MEMBER_UNKNOWN", "Camera access goes to this home's members only — visit grants never reach cameras.");
    }
    if (member.role === "owner") {
      return fail("E_CAMERA_ACCESS_EXISTS", "That member already holds the owner's camera access.");
    }
    const existing = await this.cameraAccess.findOne({ homeId: String(homeId), did, revokedAt: null });
    if (existing) {
      return fail("E_CAMERA_ACCESS_EXISTS", "That member already holds camera access for this home.");
    }
    const row = {
      _id: `camacc_${crypto.randomUUID()}`,
      homeId: String(homeId),
      did,
      createdBy: ownerDid,
      deviceSignature: signature ?? null,
      createdAt: this.now(),
      revokedAt: null,
      revokedBy: null,
    };
    await this.cameraAccess.insertOne(row);
    await this.audit.record({
      type: "grant",
      homeId: row.homeId,
      actorIdentityRef: ownerDid,
      detail: { resourceType: "camera", member: did, cameraAuthorization: true },
      outcome: "confirmed",
    });
    return { access: this.accessView(row) };
  }

  /** GET /homes/:homeId/camera-access — the owner's camera-authorization list. */
  async listAccess({ accessToken, homeId } = {}) {
    await this.authorizeOwner(accessToken, homeId);
    const rows = await this.cameraAccess.find({ homeId: String(homeId) });
    return { access: rows.sort(byCreatedAtDesc).map((row) => this.accessView(row)) };
  }

  /** POST /camera-access/:accessId/revoke — camera access ends (owner). */
  async revokeAccess({ accessToken, accessId, payload, signature } = {}) {
    const row = await this.cameraAccess.findOne({ _id: accessId });
    if (!row) return fail("E_CAMERA_ACCESS_NOT_FOUND", "That camera authorization isn't here anymore.");
    const { did } = await this.authorizeOwner(accessToken, row.homeId);
    await requireSignedSession({
      accessToken, payload, signature, verifySession: this.verifySession, registeredDeviceKey: this.registeredDeviceKey,
    });
    if (row.revokedAt) {
      return fail("E_CAMERA_ACCESS_ALREADY_REVOKED", "That camera authorization already ended.");
    }
    const revokedAt = this.now();
    await this.cameraAccess.updateOne({ _id: row._id }, { $set: { revokedAt, revokedBy: did } });
    await this.audit.record({
      type: "revoke",
      homeId: row.homeId,
      actorIdentityRef: did,
      detail: { resourceType: "camera", member: row.did, cameraAuthorization: true },
      outcome: "confirmed",
    });
    return { access: this.accessView({ ...row, revokedAt, revokedBy: did }) };
  }

  // --- family surfaces -------------------------------------------------------

  /** GET /homes/:homeId/cameras — the camera list a member with camera
   * authorization reads: descriptors, health planes, no media bytes (media
   * rides the scoped view session's token on the standing engine paths).
   * With no engine connection the surface refuses plainly — never a healthy
   * blank list.
   */
  async list({ accessToken, homeId } = {}) {
    await this.authorizeRead(accessToken, homeId);
    this.requireEngine();
    const cams = await this.cameras.find({ homeId: String(homeId) });
    const rows = [];
    for (const camera of cams.sort(byCreatedAtAsc)) {
      const area = camera.areaId ? await this.areas.findOne({ _id: camera.areaId }) : null;
      rows.push({
        ...this.view(camera),
        areaName: area?.name ?? null,
        health: await this.#health(camera),
      });
    }
    return { cameras: rows };
  }

  /**
   * POST /homes/:homeId/camera-view — the bridge's scoped view session: a
   * minted engine token for exactly this home's cameras, the standing feed
   * descriptors (the engine's one-upstream fanout, never a per-viewer
   * upstream open), and the health planes each surface explains in place.
   */
  async viewSession({ accessToken, homeId } = {}) {
    const authorized = await this.authorizeRead(accessToken, homeId);
    this.requireEngine();
    if (!this.engineToken) {
      return fail("E_ENGINE_NOT_CONNECTED", "The camera bridge can't mint engine sessions yet — the engine secret isn't configured.");
    }
    const cams = (await this.cameras.find({ homeId: String(homeId) })).sort(byCreatedAtAsc);
    const descriptors = [];
    for (const camera of cams) {
      const area = camera.areaId ? await this.areas.findOne({ _id: camera.areaId }) : null;
      const feed = await this.#liveFeed(camera);
      descriptors.push({
        ...this.view(camera),
        areaName: area?.name ?? null,
        audio: feed.audio,
        portrait: cameraAspect(camera.aspect) !== null && cameraAspect(camera.aspect) < 1,
        aspect: camera.aspect,
        live: { path: feed.path },
        health: await this.#health(camera),
      });
    }
    const token = this.engineToken.mint({
      did: authorized.did,
      homeId: String(homeId),
      cameras: cams.map((cam) => cam.engineCameraId),
    });
    return { homeId: String(homeId), token, expiresIn: this.engineToken.ttl, cameras: descriptors };
  }

  /**
   * The scoped media handoff behind the <video> surfaces: the bridge
   * verifies the engine view token (home, camera set, expiry) and resolves
   * the standing engine path to stream. The bearer path exists for contract
   * tests; media tags ride the query token.
   */
  async mediaRef({ accessToken = null, token = null, homeId, cameraId, path } = {}) {
    const camera = await this.findOne(cameraId);
    if (camera.homeId !== String(homeId ?? "")) return fail("E_CAMERA_NOT_FOUND", "That camera isn't part of this home anymore.");
    if (!this.engineToken) {
      return fail("E_ENGINE_NOT_CONNECTED", "The camera bridge can't resolve engine media yet — the engine secret isn't configured.");
    }
    let claims = null;
    if (token) {
      claims = this.engineToken.verify(String(token));
      if (!claims || claims.homeId !== camera.homeId || !claims.cameras.includes(camera.engineCameraId)) {
        return fail("E_CAMERA_TOKEN_INVALID", "That camera session expired — open the camera again.");
      }
    } else {
      const authorized = await this.authorizeRead(accessToken, homeId);
      claims = { did: authorized.did };
    }
    if (typeof path !== "string" || !/^\/[^/]/.test(path) || path.includes("..") || path.includes("//")) {
      return fail("E_VALIDATION", "That media path can't be resolved — reopen the camera surface.");
    }
    return { cameraId: camera._id, engineCameraId: camera.engineCameraId, path, did: claims.did ?? null };
  }

  // --- playback ---------------------------------------------------------------

  /**
   * GET /homes/:homeId/timeline?from&to&cameraId — segments from the engine's
   * segment index plus this home's events (their evidence stills ride the
   * event rows); a camera whose segment query fails carries the gap for the
   * UI to explain in place.
   */
  async timeline({ accessToken, homeId, from, to, cameraId = null } = {}) {
    await this.authorizeRead(accessToken, homeId);
    const engine = this.requireEngine();
    const range = cleanRange(from, to);
    const cams = (await this.cameras.find({ homeId: String(homeId) }))
      .sort(byCreatedAtAsc)
      .filter((cam) => !cameraId || cam._id === String(cameraId));
    const segments = [];
    for (const camera of cams) {
      try {
        const rows = await engine.segments({ cameraId: camera.engineCameraId, from: range.from, to: range.to });
        for (const row of Array.isArray(rows) ? rows : []) {
          segments.push({
            cameraId: camera._id,
            start: row.start,
            end: row.end,
            ref: String(row.ref ?? ""),
          });
        }
      } catch {
        segments.push({ cameraId: camera._id, gap: "unavailable" });
      }
    }
    const events = (await this.events.find({ homeId: String(homeId) }))
      .filter((event) => within(event.startedAt, range))
      .sort(byStartedAtDesc)
      .map((event) => this.eventTimelineView(event));
    return { homeId: String(homeId), from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString(), segments, events };
  }

  /**
   * GET /homes/:homeId/seek?cameraId&at — seek to a known time: the engine's
   * segment index answers; footage expired or unavailable at that time
   * carries the gap reason, never a dead player.
   */
  async seek({ accessToken, homeId, cameraId, at } = {}) {
    await this.authorizeRead(accessToken, homeId);
    const engine = this.requireEngine();
    const camera = await this.findOne(cameraId);
    if (camera.homeId !== String(homeId)) return fail("E_CAMERA_NOT_FOUND", "That camera isn't part of this home anymore.");
    const epoch = Math.floor(Date.parse(at) / 1000);
    if (!Number.isFinite(epoch)) return fail("E_VALIDATION", "Choose the moment to watch — a known time is required.");
    let result = null;
    try {
      result = await engine.segmentAt({ cameraId: camera.engineCameraId, at: epoch });
    } catch {
      result = { gap: "unavailable" };
    }
    if (result?.gap) {
      return { cameraId: camera._id, at: new Date(epoch * 1000).toISOString(), gap: String(result.gap) };
    }
    return {
      cameraId: camera._id,
      at: new Date(epoch * 1000).toISOString(),
      evidence: { kind: result.kind ?? "segment", ref: String(result.ref ?? ""), path: String(result.path ?? "") },
    };
  }

  /**
   * GET /homes/:homeId/cameras/health — the three health planes tracked
   * independently (recording, playback, detection) plus the storage and
   * service planes the owner surface renders. A camera recording but not
   * detecting, or playing but not recording, reads as its own state here.
   */
  async health({ accessToken, homeId } = {}) {
    await this.authorizeRead(accessToken, homeId);
    this.requireEngine();
    const cams = (await this.cameras.find({ homeId: String(homeId) })).sort(byCreatedAtAsc);
    const cameras = [];
    for (const camera of cams) {
      const area = camera.areaId ? await this.areas.findOne({ _id: camera.areaId }) : null;
      cameras.push({
        cameraId: camera._id,
        name: camera.name,
        areaName: area?.name ?? null,
        recordingEnabled: camera.recordingEnabled === true,
        planes: await this.#health(camera),
      });
    }
    return {
      cameras,
      service: await this.#serviceHealth(),
      storage: await this.#storage(),
    };
  }

  // --- internals ---------------------------------------------------------------

  async findOne(cameraId) {
    const camera = await this.cameras.findOne({ _id: String(cameraId ?? "") });
    if (!camera) return fail("E_CAMERA_NOT_FOUND", "That camera isn't here anymore — it may have been removed.");
    return camera;
  }

  // --- the hub-level engine-camera resolution seam (PORCH-141) -------------

  /**
   * The read-only join the hub's People & Things plane rides: an engine
   * camera id → the home (and engine camera identity) it belongs to. The
   * same fact the event ingest resolves; exposed so hub-level composition
   * never reaches into the module's collections. Unknown camera → null
   * (the recognition plane ignores detections from unregistered cameras).
   * @param {string} engineCameraId
   * @returns {Promise<{ homeId: string, cameraId: string, cameraName?: string } | null>}
   */
  async homeForEngineCamera(engineCameraId) {
    const camera = await this.cameras.findOne({ engineCameraId: String(engineCameraId ?? "") });
    if (!camera || !camera.homeId) return null;
    return {
      homeId: String(camera.homeId),
      cameraId: String(camera.engineCameraId ?? engineCameraId ?? ""),
      ...(camera.name !== undefined ? { cameraName: String(camera.name) } : {}),
    };
  }

  /** One standing liveFeed descriptor per camera (the engine's own fanout). */
  async #liveFeed(camera) {
    const engine = this.requireEngine();
    const cached = this.feedCache.get(camera.engineCameraId);
    const nowMs = Date.parse(this.now());
    if (cached && nowMs - cached.at < FEED_CACHE_MS) return cached.feed;
    let feed = null;
    try {
      feed = await engine.liveFeed(camera.engineCameraId);
    } catch {
      return { path: null, audio: camera.audio === true, gap: "unavailable" };
    }
    const resolved = { path: String(feed.path ?? ""), audio: feed.audio === true };
    this.feedCache.set(camera.engineCameraId, { at: nowMs, feed: resolved });
    return resolved;
  }

  async #health(camera) {
    const engine = this.engine;
    if (!engine) {
      return { recording: { state: "unavailable" }, playback: { state: "unavailable" }, detection: { state: "unavailable" } };
    }
    try {
      const planes = await engine.health(camera.engineCameraId);
      return {
        recording: { state: planes?.recording?.state ?? "unavailable" },
        playback: { state: planes?.playback?.state ?? "unavailable" },
        detection: { state: planes?.detection?.state ?? "unavailable" },
      };
    } catch {
      return { recording: { state: "unavailable" }, playback: { state: "unavailable" }, detection: { state: "unavailable" } };
    }
  }

  async #serviceHealth() {
    if (!this.engine) return { state: "unavailable" };
    try {
      const health = await this.engine.serviceHealth();
      return { state: health?.state ?? "unavailable", detail: health?.detail ?? null };
    } catch {
      return { state: "unavailable" };
    }
  }

  async #storage() {
    if (!this.engine) return { state: "unavailable" };
    try {
      const storage = await this.engine.storage();
      return { state: storage?.state ?? "unavailable", detail: storage?.detail ?? null };
    } catch {
      return { state: "unavailable" };
    }
  }

  /** View projection: no signatures, no camera credentials ride the family surfaces. */
  view(camera) {
    return {
      _id: camera._id,
      homeId: camera.homeId,
      areaId: camera.areaId ?? null,
      name: camera.name,
      aspect: camera.aspect ?? null,
      audio: camera.audio === true,
      recordingEnabled: camera.recordingEnabled === true,
      createdAt: camera.createdAt,
    };
  }

  accessView(row) {
    return {
      _id: row._id,
      homeId: row.homeId,
      did: row.did,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      revokedAt: row.revokedAt ?? null,
      revokedBy: row.revokedBy ?? null,
    };
  }

  /** Bounded event projection for the timeline: thumbnail stills only. */
  eventTimelineView(event) {
    return {
      _id: event._id,
      homeId: event.homeId,
      areaId: event.areaId ?? null,
      state: event.state,
      startedAt: event.startedAt,
      updatedAt: event.updatedAt,
      alert: event.alert ?? null,
      observations: (event.observations ?? []).map((obs) => ({ label: obs.label, confidence: obs.confidence })),
      evidenceRefs: (event.evidenceRefs ?? []).filter((ref) => ref?.kind === "still" || ref?.kind === "gap"),
      flag: event.flag ?? null,
    };
  }
}

function cleanRange(from, to) {
  const fromMs = Date.parse(String(from ?? ""));
  const toMs = Date.parse(String(to ?? ""));
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return fail("E_VALIDATION", "Choose the playback window — from and to must be two valid times.");
  }
  return { from: Math.floor(fromMs / 1000), to: Math.floor(toMs / 1000) };
}

function within(epochIso, range) {
  const at = Date.parse(String(epochIso ?? ""));
  if (!Number.isFinite(at)) return false;
  const seconds = Math.floor(at / 1000);
  return seconds >= range.from && seconds <= range.to;
}

function byCreatedAtAsc(a, b) {
  return String(a.createdAt).localeCompare(String(b.createdAt)) || String(a._id).localeCompare(String(b._id));
}

function byCreatedAtDesc(a, b) {
  return String(b.createdAt).localeCompare(String(a.createdAt)) || String(b._id).localeCompare(String(a._id));
}

function byStartedAtDesc(a, b) {
  return String(b.startedAt).localeCompare(String(a.startedAt)) || String(b._id).localeCompare(String(a._id));
}

function defaultNow() {
  return new Date().toISOString();
}
