import { healthModel } from "../models/health.model.js";

export interface HealthDoc {
  status: string;
  service: string;
}

/**
 * Health service — the system module's model owner. This completes the
 * vertical slice: route -> controller -> service -> model. Health is a thin
 * system check, so the model is a trivial status document, but the layering
 * is exactly what every domain module mirrors.
 */
export class HealthService {
  readonly models = healthModel;

  getHealth(): HealthDoc {
    return { status: "ok", service: "porchlight-server" };
  }
}

export default HealthService;