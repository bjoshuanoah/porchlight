import { Router } from "express";
import { healthController } from "../controllers/health.controller.js";
import { bootstrapController } from "../controllers/bootstrap.controller.js";
import type { HealthService } from "../services/health.service.js";
import type { BootstrapService } from "../services/bootstrap.service.js";

/** System routes (health probes + bootstrap ledger). No quota writes here:
 *  network settings live only in the owner console's limits surface (PORCH-020),
 *  never in the bootstrap flow. */
export function createSystemRouter(health: HealthService, bootstrap: BootstrapService): Router {
  const router: Router = Router();
  const healthCtl = healthController(health);
  const bootstrapCtl = bootstrapController(bootstrap);
  router.get("/health", (req, res) => void healthCtl.health(req, res));
  router.get("/bootstrap/state", (req, res) => void bootstrapCtl.status(req, res));
  return router;
}