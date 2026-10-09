import type { Request, Response } from "express";
import type { BootstrapService } from "../services/bootstrap.service.js";

export interface BootstrapController {
  status(req: Request, res: Response): Promise<void>;
}

/**
 * Transport-specific controller for the system bootstrap surface. No domain
 * logic: it exposes the ledger state only. Network settings (quotas,
 * retention) never ride bootstrap (PORCH-020) — they live in the owner
 * console's limits surface on the social module, from the moment the
 * network exists.
 */
export const bootstrapController = (service: BootstrapService) => ({
  async status(_req: Request, res: Response) {
    res.json(await service.status());
  },
});

export default bootstrapController;
