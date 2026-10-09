import type { Request, Response } from "express";
import { HealthService } from "../services/health.service.js";

export interface HealthController {
  health(req: Request, res: Response): Promise<void>;
}

/**
 * Transport-specific controller: maps the service-layer health document to
 * the HTTP response. No domain logic here.
 */
export const healthController = (service: HealthService) => ({
  async health(_req: Request, res: Response) {
    res.json(await service.getHealth());
  },
});

export default healthController;