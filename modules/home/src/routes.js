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
 * }} controllers
 */
export function createHomeRouter(controllers) {
  const router = Router();
  const { home, device, automation } = controllers;

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

  return router;
}

export default createHomeRouter;
