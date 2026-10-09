import type { Request, Response } from "express";
import type { BootstrapService } from "../services/bootstrap.service.js";

export interface BootstrapController {
  status(req: Request, res: Response): Promise<void>;
}

/**
 * Transport-specific controller for the system bootstrap surface. No domain
 * logic: it exposes the ledger state and delegates quota writes to the
 * service (runtime config, phase-configuration architecture).
 */
export const bootstrapController = (service: BootstrapService) => ({
  async status(_req: Request, res: Response) {
    res.json(await service.status());
  },

  async setQuotas(req: Request, res: Response) {
    try {
      const config = await service.setQuotas(req.body ?? {});
      await service.record("quota", {
        detail: `quota settings: ${JSON.stringify(config.quota)}`,
      });
      res.status(201).json({ quota: config.quota });
    } catch (error) {
      const status = (error as { code?: string }).code === "E_INVALID_QUOTA" ? 400 : 500;
      res.status(status).json({ error: (error as Error).message });
    }
  },
});

export default bootstrapController;