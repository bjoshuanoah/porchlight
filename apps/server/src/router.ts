import { Router } from "express";
import { healthRouter } from "./routes/health.routes.js";
import { createIdentityRouter } from "@porchlight/identity";
import { createSocialRouter } from "@porchlight/social";

/**
 * The /api router aggregates the module routers plus the thin health system
 * route. Server performs no domain logic — routes stay thin, controllers are
 * transport-specific, services own the models (inside the modules).
 */
export const router = Router();

router.use("/health", healthRouter);
router.use("/identity", createIdentityRouter());
router.use("/social", createSocialRouter());