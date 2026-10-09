import { Router } from "express";
import { healthController } from "./controllers/health.controller.js";

export const router = Router();

// Health is a thin system route; every domain module mirrors this path:
// routes (this file) → controllers (health.controller.ts) → services → models.
router.get("/health", healthController.health);
