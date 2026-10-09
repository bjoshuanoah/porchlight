import type { Request, Response } from "express";

export interface HealthController {
  health(req: Request, res: Response): void;
}

export const healthController: HealthController = {
  health(_req: Request, res: Response) {
    res.json({ status: "ok", service: "porchlight-server" });
  },
};
