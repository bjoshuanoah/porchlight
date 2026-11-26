import { Router } from "express";

/**
 * Home routes. Thin REST surface that owns no domain logic — the server
 * (or assembleHomeModule in tests) injects the fully assembled controllers.
 * Route → controller → service → model lives self-contained under the
 * /api/home prefix (PORCH-137).
 *
 * @param {{
 *   home: import("./controllers/home.controller.js").HomeController,
 *   device: import("./controllers/device.controller.js").DeviceController,
 *   automation: import("./controllers/automation.controller.js").AutomationController,
 *   camera: import("./controllers/camera.controller.js").CameraController,
 *   event: import("./controllers/event.controller.js").EventController,
 * }} controllers
 */
export function createHomeRouter(controllers) {
  const router = Router();
  const { home, device, automation, camera, event } = controllers;

  // Homes: create, list, rename, and the in-view read the home switch rides.
  router.post("/homes", home.create);
  router.get("/homes", home.list);
  router.get("/homes/:homeId", home.get);
  router.put("/homes/:homeId", home.rename);

  // The property audit trail (per-home page, newest first, bounded).
  router.get("/homes/:homeId/audit", home.auditList);

  // Areas: rooms and outdoor areas are ONE collection, one grouping surface.
  router.post("/homes/:homeId/areas", home.createArea);
  router.get("/homes/:homeId/areas", home.listAreas);
  router.put("/areas/:areaId", home.updateArea);

  // Devices: register, rename/move, list, read-back refresh, and the
  // confirmed-state command lifecycle.
  router.post("/homes/:homeId/devices", device.register);
  router.get("/homes/:homeId/devices", device.list);
  router.get("/homes/:homeId/devices/:deviceId", device.get);
  router.get("/homes/:homeId/devices/:deviceId/state", device.readState);
  router.put("/devices/:deviceId", device.update);
  router.post("/devices/:deviceId/command", device.command);

  // Scenes: create, list, run (per-action outcomes).
  router.post("/homes/:homeId/scenes", automation.createScene);
  router.get("/homes/:homeId/scenes", automation.listScenes);
  router.post("/scenes/:sceneId/run", automation.runScene);

  // Automations: plain-form event-driven rules with the audit's fires.
  router.post("/homes/:homeId/automations", automation.createAutomation);
  router.get("/homes/:homeId/automations", automation.listAutomations);
  router.put("/automations/:automationId", automation.updateAutomation);

  // Grants (PORCH-138): the owner grants an existing identity or a family
  // from the Access surface; the parent distributes within a family grant's
  // envelope; the owner revokes — all audit-landing writes.
  router.post("/homes/:homeId/grants", home.createGrant);
  router.get("/homes/:homeId/grants", home.listGrants);
  router.post("/grants/:grantId/revoke", home.revokeGrant);
  router.post("/grants/:grantId/distributions", home.distributeGrant);

  // Cameras (PORCH-139): the association store, the owner's camera surfaces,
  // and the bridge's scoped view session. Camera authorization is its own
  // grant scope class — visit grants resolve no camera surface.
  router.post("/homes/:homeId/cameras", camera.register);
  router.get("/homes/:homeId/cameras", camera.list);
  router.post("/homes/:homeId/cameras/recording", camera.bulkRecording);
  router.get("/homes/:homeId/cameras/health", camera.health);
  router.post("/homes/:homeId/cameras/view", camera.viewSession);
  router.get("/homes/:homeId/cameras/:cameraId/media", camera.media);
  router.get("/homes/:homeId/camera-access", camera.listAccess);
  router.post("/homes/:homeId/camera-access", camera.grantAccess);
  router.post("/camera-access/:accessId/revoke", camera.revokeAccess);
  router.put("/cameras/:cameraId", camera.update);
  router.post("/cameras/:cameraId/recording", camera.setRecording);

  // Playback (PORCH-139): segments from the engine's segment index, seek to
  // a known time, and the explained gap when the footage cannot carry it.
  router.get("/homes/:homeId/timeline", camera.timeline);
  router.get("/homes/:homeId/seek", camera.seek);

  // Events (PORCH-139): the alert surface of record and the flag control.
  router.get("/homes/:homeId/events", event.list);
  router.get("/events/:eventId", event.get);
  router.post("/events/:eventId/flag", event.flag);

  return router;
}

export default createHomeRouter;
