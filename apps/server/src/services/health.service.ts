import type { ProbeResult, Probe } from "../dependencies.js";

export interface DepsHealth {
  mongo: ProbeResult;
  redis: ProbeResult;
}

export interface HealthDoc {
  status: "ok" | "degraded";
  service: string;
  deps: DepsHealth;
  mode: { deploymentMode: string; socialServingEnabled: boolean; identityServingEnabled: boolean };
  hubUrl: string | null;
  /**
   * PORCH-054 (ac-1): the configured media root with its readiness state
   * (ready / volume not ready) — wired late, after the social module
   * assembles; null when no media pipeline is assembled.
   */
  media: MediaReadiness | null;
}

export interface MediaReadiness {
  root: string | null;
  state: string;
  check: string | null;
  reason: string | null;
  flag: string | null;
}

/**
 * Health service — the system module. Reports live dependency probes (Mongo,
 * Redis) plus the phase-configuration mode and the tunnel-bound hub URL the
 * owner dashboard consumes. Zero external telemetry: probes are local-only.
 */
export class HealthService {
  private readonly probes: { mongo: Probe; redis: Probe };
  private readonly phase: { deploymentMode: string; socialServingEnabled: boolean; identityServingEnabled: boolean };
  private readonly hubUrl: () => string | null;
  private mediaStatus: (() => Promise<MediaReadiness>) | null = null;

  constructor(
    probes: { mongo: Probe; redis: Probe },
    phase: { deploymentMode: string; socialServingEnabled: boolean; identityServingEnabled: boolean },
    hubUrl: () => string | null,
  ) {
    this.probes = probes;
    this.phase = phase;
    this.hubUrl = hubUrl;
  }

  /**
   * Late-bound media readiness (PORCH-054 ac-1): apps/server wires the
   * social module's volume status after assembly so the health surface
   * always names the CURRENT configured root and its state.
   */
  setMediaStatus(provider: () => Promise<MediaReadiness>) {
    this.mediaStatus = provider;
  }

  async getHealth(): Promise<HealthDoc> {
    const deps = { mongo: await this.probes.mongo(), redis: await this.probes.redis() };
    return {
      status: deps.mongo === "ok" && deps.redis === "ok" ? "ok" : "degraded",
      service: "porchlight-server",
      deps,
      mode: {
        deploymentMode: this.phase.deploymentMode,
        socialServingEnabled: this.phase.socialServingEnabled,
        identityServingEnabled: this.phase.identityServingEnabled,
      },
      hubUrl: this.hubUrl(),
      media: this.mediaStatus ? await this.mediaStatus() : null,
    };
  }
}

export default HealthService;