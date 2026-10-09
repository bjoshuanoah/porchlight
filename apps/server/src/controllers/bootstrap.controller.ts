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

  /**
   * Bootstrap-era write, guarded fail-closed in transport: once the quota
   * step is complete in the ledger (or the ledger is unreadable), the era
   * is closed and quota management moves to the owner console. The state
   * read (`status`) intentionally stays open — the bootstrap page and the
   * recovery flow need it after the era closes.
   */
  async setQuotas(req: Request, res: Response) {
    let open = false;
    try {
      const doc = await service.load();
      const quota = doc?.steps?.quota;
      open = quota != null && quota.status !== "complete";
    } catch {
      open = false;
    }
    if (!open) {
      return res
        .status(403)
        .json({ error: "Bootstrap is closed; quotas now live in the owner console.", code: "E_BOOTSTRAP_CLOSED" });
    }
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