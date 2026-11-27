// Console → config-service REST calls, in one place (PORCH-135).
//
// `api` (the default export surface) talks to same-origin `/api/...` —
// the dev server proxies to the config service, and production serves the
// SPA from the config service itself. `createApi(base)` rebinds every
// wrapper to another base URL so the test suite can point them at a live
// config service on an ephemeral port.
//
// Error contract: non-2xx responses throw an `ApiError` carrying the HTTP
// status and the plain-language `error` reason the service sends.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function createApi(baseUrl = "") {
  const url = (path) => `${baseUrl}${path}`;

  async function request(path, { method = "GET", body } = {}) {
    const response = await fetch(url(path), {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      throw new ApiError(response.status, payload?.error ?? `Request failed with status ${response.status}`);
    }
    return payload;
  }

  return {
    // Cameras
    listCameras: () => request("/api/cameras"),
    upsertCamera: (id, camera) => request(`/api/cameras/${encodeURIComponent(id)}`, { method: "PUT", body: camera }),
    cameraSnapshotUrl: (id, width) => url(`/api/cameras/${encodeURIComponent(id)}/snapshot?w=${width}`),

    // Zones
    listZones: (cameraId) => request(`/api/cameras/${encodeURIComponent(cameraId)}/zones`),
    createZone: (cameraId, zone) => request(`/api/cameras/${encodeURIComponent(cameraId)}/zones`, { method: "POST", body: zone }),
    updateZone: (zoneId, zone) => request(`/api/zones/${encodeURIComponent(zoneId)}`, { method: "PUT", body: zone }),
    deleteZone: (zoneId) => request(`/api/zones/${encodeURIComponent(zoneId)}`, { method: "DELETE" }),

    // Masks
    listMasks: (cameraId) => request(`/api/cameras/${encodeURIComponent(cameraId)}/masks`),
    createMask: (cameraId, mask) => request(`/api/cameras/${encodeURIComponent(cameraId)}/masks`, { method: "POST", body: mask }),
    updateMask: (maskId, mask) => request(`/api/masks/${encodeURIComponent(maskId)}`, { method: "PUT", body: mask }),
    deleteMask: (maskId) => request(`/api/masks/${encodeURIComponent(maskId)}`, { method: "DELETE" }),

    // Composition
    getComposition: (cameraId) => request(`/api/cameras/${encodeURIComponent(cameraId)}/composition`),

    // Speed calibration
    getSpeed: (cameraId) => request(`/api/cameras/${encodeURIComponent(cameraId)}/speed`),
    putSpeed: (cameraId, speed) => request(`/api/cameras/${encodeURIComponent(cameraId)}/speed`, { method: "PUT", body: speed }),
    testSpeed: (cameraId, track) => request(`/api/cameras/${encodeURIComponent(cameraId)}/speed/test`, { method: "POST", body: { track } }),

    // Profiles
    listProfiles: () => request("/api/profiles"),
    createProfile: (profile) => request("/api/profiles", { method: "POST", body: profile }),
    updateProfile: (profileId, profile) => request(`/api/profiles/${encodeURIComponent(profileId)}`, { method: "PUT", body: profile }),
    deleteProfile: (profileId) => request(`/api/profiles/${encodeURIComponent(profileId)}`, { method: "DELETE" }),
    activateProfile: (profileId) => request(`/api/profiles/${encodeURIComponent(profileId)}/activate`, { method: "POST" }),

    // Base config
    getBaseConfig: () => request("/api/config/base"),
    putBaseConfig: (base) => request("/api/config/base", { method: "PUT", body: base }),

    // Layer inspector
    getKnobs: (cameraId) => request(`/api/config/knobs?cameraId=${encodeURIComponent(cameraId)}`),
    getActive: () => request("/api/config/active"),

    // Scheduler control
    tickScheduler: (now) => request("/api/config/tick", { method: "POST", body: { now } }),

    // Storage backend (PORCH-136): status, first-run configuration, the
    // location probe, and the manual failback a degraded write demands.
    getStorage: () => request("/api/storage"),
    configureStorage: (storage) => request("/api/storage", { method: "PUT", body: storage }),
    testStorageLocation: (location) => request("/api/storage/test", { method: "POST", body: { location } }),
    storageFailback: () => failSafe(() => request("/api/storage/failback", { method: "POST" })),

    // Retention rules: which recordings outlive the rolling window.
    listStorageRules: () => request("/api/storage/rules"),
    addStorageRule: (rule) => request("/api/storage/rules", { method: "POST", body: rule }),
    updateStorageRule: (ruleId, rule) => request(`/api/storage/rules/${encodeURIComponent(ruleId)}`, { method: "PUT", body: rule }),
    deleteStorageRule: (ruleId) => request(`/api/storage/rules/${encodeURIComponent(ruleId)}`, { method: "DELETE" }),

    // Compute posture (PORCH-152): the per-stage provider plan of record
    // and the live status each stage reports. Refusals (422/404) surface
    // the service's plain-language error verbatim; PUT applies the admin
    // layer live server-side, DELETE restores the layered default.
    getComputeStages: () => request("/api/compute/stages"),
    getComputeStage: (stage) => request(`/api/compute/stages/${encodeURIComponent(stage)}`),
    setComputeStage: (stage, value) => request(`/api/compute/stages/${encodeURIComponent(stage)}`, { method: "PUT", body: value }),
    resetComputeStage: (stage) => request(`/api/compute/stages/${encodeURIComponent(stage)}`, { method: "DELETE" }),

    // Stream probe (PORCH-152): a refused URL comes back as a 200 body
    // { ok: false, reason } so the reason renders verbatim; a malformed
    // request (422) keeps the service's words via ApiError.
    validateCameraUrl: (url) => request("/api/cameras/validate", { method: "POST", body: { url } }),

    // Manual recording (PORCH-136 ac-3): a 200 body passes through as-is,
    // including a { ok: false, reason } refusal the recorder itself sent.
    // A refused request (409/422) still throws ApiError so the server's
    // plain-language error surfaces verbatim; a fetch that never reaches
    // the service resolves to { ok: false, reason } instead of throwing,
    // so the console always has something plain-language to show.
    manualRecord: (cameraId, action) =>
      failSafe(() => request(`/api/cameras/${encodeURIComponent(cameraId)}/record/${action === "stop" ? "stop" : "start"}`, { method: "POST" })),

    // Transcription plane (PORCH-155): the method doc of record across the
    // three scopes (global / recording types / cameras), per-camera
    // inspection with the winning layer, the stage's never-silent status,
    // stored records with their explicit states, semantic search, and the
    // cascade audit. Refusals (503 when the part isn't wired, 422 for bad
    // method docs or an unwired embedder) surface verbatim via ApiError.
    getTranscriptionMethod: () => request("/api/transcription/method"),
    putTranscriptionMethod: (doc) => request("/api/transcription/method", { method: "PUT", body: doc }),
    inspectTranscriptionMethod: (cameraId, type) =>
      request(`/api/transcription/method/inspect?cameraId=${encodeURIComponent(cameraId)}&type=${encodeURIComponent(type)}`),
    getTranscriptionStatus: () => request("/api/transcription/status"),
    listTranscripts: ({ cameraId, sourceType, limit } = {}) => {
      // Undefined params are omitted so the service's own defaults apply.
      const params = new URLSearchParams();
      if (cameraId !== undefined) params.set("cameraId", cameraId);
      if (sourceType !== undefined) params.set("sourceType", sourceType);
      if (limit !== undefined) params.set("limit", String(limit));
      const query = params.toString();
      return request(`/api/transcripts${query ? `?${query}` : ""}`);
    },
    searchTranscripts: ({ query, k, cameraId, sourceType } = {}) => {
      // Only present keys POST — the service reads what's in the body.
      const body = { query };
      if (k !== undefined) body.k = k;
      if (cameraId !== undefined) body.cameraId = cameraId;
      if (sourceType !== undefined) body.sourceType = sourceType;
      return request("/api/transcripts/search", { method: "POST", body });
    },
    transcriptCascadeAudit: () => request("/api/transcripts/cascade/audit"),

    // First-run wizard (PORCH-130): the setup state gate, the two inputs
    // (deployment name, who you are with an optional picture as a data
    // URL), and the completion step. Refusals (422) surface the service's
    // plain-language words verbatim via ApiError.
    getSetup: () => request("/api/setup"),
    putSetupDeployment: (name) => request("/api/setup/deployment", { method: "PUT", body: { name } }),
    putSetupOwner: (owner) => request("/api/setup/owner", { method: "PUT", body: owner }),
    getSetupPhoto: () => request("/api/setup/photo"),
    completeSetup: () => request("/api/setup/complete", { method: "POST" }),

    // Timeline plane (PORCH-130): recording coverage, hour segments, and
    // detection events — epoch seconds UTC throughout, matching the engine
    // contract. A refused moment-lookup comes back 200 with
    // { gap: "unavailable" } and passes through as data, never an error.
    listRecordingDays: (cameraId) => request(`/api/segments/days?cameraId=${encodeURIComponent(cameraId)}`),
    listHourSegments: ({ cameraId, date, hour } = {}) => {
      const params = new URLSearchParams();
      if (cameraId !== undefined) params.set("cameraId", cameraId);
      if (date !== undefined) params.set("date", date);
      if (hour !== undefined) params.set("hour", hour);
      const query = params.toString();
      return request(`/api/segments${query ? `?${query}` : ""}`);
    },
    segmentAt: ({ cameraId, at } = {}) => {
      const params = new URLSearchParams();
      if (cameraId !== undefined) params.set("cameraId", cameraId);
      if (at !== undefined) params.set("at", String(at));
      const query = params.toString();
      return request(`/api/segment${query ? `?${query}` : ""}`);
    },
    listEvents: ({ cameraId, from, to, limit } = {}) => {
      const params = new URLSearchParams();
      if (cameraId !== undefined) params.set("cameraId", cameraId);
      if (from !== undefined) params.set("from", String(from));
      if (to !== undefined) params.set("to", String(to));
      if (limit !== undefined) params.set("limit", String(limit));
      const query = params.toString();
      return request(`/api/events${query ? `?${query}` : ""}`);
    },
    // A recorded clip's same-origin path — the browser <video> handles the
    // Range requests itself, so the wrapper only prefixes the base.
    mediaUrl: (path) => url(path),

    // Engine health seams (PORCH-130): the engine plane's liveness plus the
    // two service rows ({state, detail} plain-language health documents).
    getHealth: () => request("/api/health"),
    getService: () => request("/service"),
    getSystemStorage: () => request("/storage"),

    // Live MJPEG seams (PORCH-130): the same-origin stream each <img>
    // consumes — the stream manager owns the framing, the SPA just points
    // at it.
    liveUrl: (id) => url(`/live/${encodeURIComponent(id)}`),

    // Engine camera registration seam (PORCH-130): after a successful probe
    // this registers the camera on the recorder and stream planes live —
    // POST /cameras {url} hands the fleet to both supervisors. A refused
    // registration may be a 200 {ok:false, reason} or a 422; both surface
    // plain language.
    registerCamera: (body) =>
      failSafe(() => request("/cameras", { method: "POST", body })),
  };

  async function failSafe(call) {
    try {
      return await call();
    } catch (failure) {
      if (failure instanceof ApiError) throw failure;
      return { ok: false, reason: failure.message };
    }
  }
}

export const api = createApi();
