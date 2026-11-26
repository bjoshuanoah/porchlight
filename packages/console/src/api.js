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

    // Manual recording (PORCH-136 ac-3): a 200 body passes through as-is,
    // including a { ok: false, reason } refusal the recorder itself sent.
    // A refused request (409/422) still throws ApiError so the server's
    // plain-language error surfaces verbatim; a fetch that never reaches
    // the service resolves to { ok: false, reason } instead of throwing,
    // so the console always has something plain-language to show.
    manualRecord: (cameraId, action) =>
      failSafe(() => request(`/api/cameras/${encodeURIComponent(cameraId)}/record/${action === "stop" ? "stop" : "start"}`, { method: "POST" })),
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
