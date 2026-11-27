/**
 * Engine transport adapters (PORCH-139). The engine (PORCH-I-009) is
 * consumed, never built here: these adapters speak the engine's documented
 * contract from the runtime config of record. Absent config → the hub
 * builds no adapters and the bridge fails closed with plain language.
 *
 *   createHttpEngineAdapter — the camera/seam client against the engine's
 *     HTTP surface. The engine's landing (PORCH-152) now serves
 *     POST /cameras, GET /cameras/:id/health, GET /service, and GET
 *     /storage; the /live, /segments, /segment, and /evidence media/seam
 *     paths remain pending (stream manager, PORCH-154/155) and still answer
 *     the adapter's gap states. Read failures answer
 *     `{ gap: "unavailable" }` rather than throwing where a family surface
 *     can explain the gap.
 *
 *   createMqttEngineConsumer — the detection bus subscription (DetectedObject
 *     publish contract, PORCH-I-009 TS 3, transport per the PORCH-129
 *     vetting: MQTT with the topic family of record — ENGINE_DETECTIONS_PREFIX-owned —
 *     `porchlight/engine/detections/<camera>/<cls>`, DETECTIONS_PATTERN
 *     `+/+`). The payload's camera field is authoritative; the topic's
 *     camera segment is the fallback.
 */
import mqtt from "mqtt";
import { CAMERA_GAPS } from "./camera.service.js";
import { fail } from "./errors.js";

/**
 * PORCH-142: the topic contract's prefix of record — one copy. Every
 * producer and subscriber of the engine's DetectionObject bus builds the
 * family from this constant (the recorder publishes, the home hub
 * subscribes `${ENGINE_DETECTIONS_PREFIX}/+/+`, and the recognition plane's
 * trained-class emission re-rides the SAME family).
 */
export const ENGINE_DETECTIONS_PREFIX = "porchlight/engine/detections";

const DETECTIONS_PATTERN = `${ENGINE_DETECTIONS_PREFIX}/+/+`;

export function createHttpEngineAdapter({ baseUrl, fetchImpl = globalThis.fetch } = {}) {
  if (!baseUrl || typeof fetchImpl !== "function") {
    return fail("E_VALIDATION", "The engine adapter needs the engine's base URL.");
  }
  const root = String(baseUrl).replace(/\/+$/, "");
  const call = async (path, init) => {
    const response = await fetchImpl(root + path, init);
    if (!response.ok) {
      const error = new Error(`engine ${path} answered ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };
  return {
    /** Engine onboarding validation (add-camera flow). */
    async validateCamera({ url }) {
      try {
        const answer = await call("/cameras", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
        if (answer?.ok === false) return { ok: false, reason: String(answer.reason ?? "validation failed at the engine") };
        return answer;
      } catch (error) {
        return { ok: false, reason: error?.status === 404 ? "the camera URL was refused by the engine" : "the engine couldn't be reached" };
      }
    },
    /** The standing one-upstream re-stream descriptor per camera. */
    async liveFeed(engineCameraId) {
      const answer = await call(`/live/${encodeURIComponent(engineCameraId)}`);
      return { upstreamId: answer?.upstreamId ?? null, path: String(answer?.path ?? ""), audio: answer?.audio === true };
    },
    /** The standing media path, streamed through the bridge on demand. */
    async openMedia(path) {
      const response = await fetchImpl(root + String(path), { headers: { accept: "video/mp4,audio/mp4,image/jpeg" } });
      if (response.status === 410) return { gap: "retention-expired" };
      if (!response.ok || !response.body) return { gap: "unavailable" };
      return { body: response.body, contentType: response.headers.get("content-type") ?? undefined };
    },
    /** The engine's segment index (UTC epoch seconds). */
    async segments({ cameraId, from, to }) {
      const answer = await call(`/segments?camera=${encodeURIComponent(cameraId)}&from=${Math.floor(from)}&to=${Math.floor(to)}`);
      return Array.isArray(answer?.segments) ? answer.segments : (Array.isArray(answer) ? answer : []);
    },
    async segmentAt({ cameraId, at }) {
      try {
        const answer = await call(`/segment?camera=${encodeURIComponent(cameraId)}&at=${Math.floor(at)}`);
        if (answer?.gap) return gapOf(answer.gap);
        return { ref: String(answer?.ref ?? ""), path: String(answer?.path ?? ""), kind: answer?.kind ?? "segment" };
      } catch (error) {
        return { gap: error?.status === 410 ? "retention-expired" : "unavailable" };
      }
    },
    /** Event-time evidence resolution (stills/clip refs). */
    async evidenceAt({ cameraId, at }) {
      try {
        const answer = await call(`/evidence?camera=${encodeURIComponent(cameraId)}&at=${Math.floor(at)}`);
        if (answer?.gap) return gapOf(answer.gap);
        return { kind: answer?.kind ?? "still", ref: String(answer?.ref ?? ""), path: answer?.path ? String(answer.path) : null };
      } catch {
        return { gap: "unavailable" };
      }
    },
    /** The three health planes answer independently (PORCH-I-009 health contract). */
    async health(engineCameraId) {
      const answer = await call(`/cameras/${encodeURIComponent(engineCameraId)}/health`);
      return {
        recording: answer?.recording ?? { state: "unavailable" },
        playback: answer?.playback ?? { state: "unavailable" },
        detection: answer?.detection ?? { state: "unavailable" },
      };
    },
    async serviceHealth() {
      try {
        const answer = await call("/service");
        return { state: answer?.state ?? "unavailable", detail: answer?.detail ?? null };
      } catch {
        return { state: "unavailable" };
      }
    },
    async storage() {
      try {
        const answer = await call("/storage");
        return { state: answer?.state ?? "unavailable", detail: answer?.detail ?? null };
      } catch {
        return { state: "unavailable" };
      }
    },
  };
}

function gapOf(reason) {
  const gap = String(reason);
  return { gap: CAMERA_GAPS.includes(gap) ? gap : "unavailable" };
}

/**
 * The engine's detection bus subscription. Returns a consumer the hub
 * starts/stops with the hub runtime; every parsed DetectedObject fans to
 * the injected handler (the home module's engine-event seam). An optional
 * `client` mirrors the detection sink's injectable-client seam (unit tests).
 */
export function createMqttEngineConsumer({ url, clientId = "porchlight-home", log = () => {}, onEvent, client }) {
  if (!url) {
    return fail("E_VALIDATION", "The engine bus consumer needs a bus URL.");
  }
  const conn = client ?? mqtt.connect(url, { clientId, reconnectPeriod: 5000, clean: true });
  conn.on("error", (error) => log(`[engine-bus] connection error: ${error.message}`));
  conn.on("connect", () => {
    conn.subscribe(DETECTIONS_PATTERN);
  });
  conn.on("message", (topic, buf) => {
    let detection = null;
    try {
      detection = JSON.parse(buf.toString("utf8"));
    } catch {
      return;
    }
    // Camera resolution: the payload field is authoritative; the topic's
    // camera segment is the fallback — index [3] of the family of record
    // `porchlight/engine/detections/<camera>/<cls>`.
    const camera = detection?.camera ?? topic.split("/")[3] ?? null;
    if (camera) void onEvent({ ...detection, camera }).catch(() => {});
  });
  return {
    status() {
      return { connected: conn.connected, url, pattern: DETECTIONS_PATTERN };
    },
    close() {
      return new Promise((resolve) => {
        if (!conn.connected) {
          conn.end(true);
          resolve();
          return;
        }
        conn.end(false, {}, () => resolve());
      });
    },
  };
}
