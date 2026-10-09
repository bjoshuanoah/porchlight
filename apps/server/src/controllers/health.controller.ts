import type { Request, Response } from "express";
import { HealthService } from "../services/health.service.js";

export interface HealthController {
  health(req: Request, res: Response): void;
}

/**
 * Transport-specific controller: maps the service-layer health document to
 * the HTTP response. No domain logic here.
 */
export const healthController: HealthController = {
  health(_req: Request, res: Response) {
    const service = new HealthService();
    res.json(service.getHealth());
  },
};