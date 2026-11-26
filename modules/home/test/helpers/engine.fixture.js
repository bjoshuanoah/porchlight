import { homeFixture } from "./home.fixture.js";

/**
 * Engine fixture (PORCH-139): the home module's REAL camera bridge and
 * event pipeline over the fixture store, with a fake engine adapter — the
 * engine (PORCH-I-009) is consumed here, never built. The fake records the
 * seam calls the bridge makes (liveFeed once per camera per window; the
 * standing re-stream serves every viewer), and the tests control its
 * health planes, segment answers, and validation.
 */
export function engineFixture({ now, interpreter, dedupWindowSec, ...rest } = {}) {
  const counts = { validateCamera: 0, liveFeed: 0, openMedia: 0, segments: 0, segmentAt: 0, evidenceAt: 0, health: 0 };

  const engine = {
    // The engine's onboarding validation answers: ok by default, per-call
    // overrides register on `nextValidate`.
    nextValidate: null,
    openMediaImpl: null,
    /** liveFeed answers from this registry; a camera not listed fails. */
    feeds: new Map(),
    segmentsImpl: () => [],
    segmentAtImpl: () => ({ ref: "seg_main_at", path: "/media/seg.m4s", kind: "segment" }),
    evidenceAtImpl: () => ({ kind: "still", ref: "still_main_at", path: "/media/still.jpg" }),
    /** The three planes answer independently — that IS the health contract. */
    planes: { recording: { state: "recording" }, playback: { state: "live" }, detection: { state: "ok" } },
    serviceState: { state: "ok", detail: null },
    storageState: { state: "ok", detail: null },

    async validateCamera({ url }) {
      counts.validateCamera += 1;
      if (engine.nextValidate) return engine.nextValidate({ url });
      const id = `eng_cam${counts.validateCamera}`;
      const doorbell = String(url).includes("doorbell");
      engine.feeds.set(id, { upstreamId: `up_${id}`, path: `/live/${id}`, audio: doorbell });
      return {
        ok: true,
        cameraId: id,
        aspect: doorbell ? { width: 9, height: 16 } : { width: 16, height: 9 },
        audio: doorbell,
      };
    },
    /**
     * ONE upstream per camera: the standing feed. The count is the
     * upstream-connection law (PORCH-I-009 PRD 9) — added viewers must
     * never move it.
     */
    async liveFeed(engineCameraId) {
      counts.liveFeed += 1;
      const feed = engine.feeds.get(String(engineCameraId));
      if (!feed) return { path: null, audio: false, gap: "unavailable" };
      return feed;
    },
    async openMedia(path) {
      counts.openMedia += 0; // the bridge never opens an upstream for viewers
      if (engine.openMediaImpl) return engine.openMediaImpl(path);
      return { body: ReadableStreamFromString("frame"), contentType: "video/mp4" };
    },
    async segments({ cameraId }) {
      counts.segments += 1;
      return engine.segmentsImpl({ cameraId });
    },
    async segmentAt({ cameraId, at }) {
      counts.segmentAt += 1;
      return engine.segmentAtImpl({ cameraId, at });
    },
    async evidenceAt({ cameraId, at }) {
      counts.evidenceAt += 1;
      return engine.evidenceAtImpl({ cameraId, at });
    },
    async health(engineCameraId) {
      counts.health += 1;
      const recording = engine.disabledCameras?.has(String(engineCameraId))
        ? { state: "disabled" }
        : engine.planes.recording;
      return { recording, playback: engine.planes.playback, detection: engine.planes.detection };
    },
    async serviceHealth() {
      return engine.serviceState;
    },
    async storage() {
      return engine.storageState;
    },
  };

  const fx = homeFixture({
    now, interpreter, dedupWindowSec, ...rest,
    engine, engineSecret: "engine-secret-of-record",
  });

  return { ...fx, engine, counts, engineSecret: "engine-secret-of-record" };
}

/** A small ReadableStream helper for fake media bodies. */
function ReadableStreamFromString(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/** Register one camera through the REAL owner surface (engine-validated). */
export async function addCameraFor(fx, owner, home, areaId, url, name = "Driveway cam") {
  const { camera } = await fx.mod.cameraService.register({
    accessToken: owner.token,
    homeId: home._id,
    ...owner.write({ name, areaId, rtsp: url ?? "rtsp://cam-main/stream" }),
  });
  return camera;
}

/** Grant one home member camera authorization through the REAL owner surface. */
export async function grantCameraAccessFor(fx, owner, home, memberDid) {
  const { access } = await fx.mod.cameraService.grantAccess({
    accessToken: owner.token,
    homeId: home._id,
    ...owner.write({ did: memberDid }),
  });
  return access;
}
