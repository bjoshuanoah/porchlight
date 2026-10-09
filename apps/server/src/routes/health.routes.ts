import { Router } from "express";
import { healthController } from "../controllers/health.controller.js";

/**
 * Health routes — the thin system route. Every domain module mirrors this
 * path: routes (this file) -> controllers -> services -> models.
 */
export const healthRouter: Router = Router();

healthRouter.get("/", healthController.health);