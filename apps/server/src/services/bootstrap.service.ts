import { saveConfig, type PorchlightConfig, type CollectionLike, type StoreLike } from "@porchlight/shared";

export type BootstrapStep = "account" | "network" | "invite" | "quota";

export const BOOTSTRAP_STEPS: readonly BootstrapStep[] = ["account", "network", "invite", "quota"];

export interface StepRecord {
  status: "complete" | "pending" | "failed";
  at: string | null;
  detail: string | null;
}

export interface DiagnosticEntry {
  at: string;
  source: string;
  message: string;
}

export interface BootstrapStatus {
  resumable: boolean;
  lastError: string | null;
  steps: Record<BootstrapStep, StepRecord>;
  diagnostics: DiagnosticEntry[];
  config: {
    mode: PorchlightConfig["mode"];
    quota: PorchlightConfig["quota"];
    hubUrl: string | null;
  };
}

interface BootstrapLedgerDoc {
  _id: string;
  steps: Record<BootstrapStep, StepRecord>;
  diagnostics: DiagnosticEntry[];
  updatedAt: string;
}

const STEP_ORDER: ReadonlyArray<BootstrapStep> = BOOTSTRAP_STEPS;

function freshLedger(): BootstrapLedgerDoc {
  const steps = {} as Record<BootstrapStep, StepRecord>;
  for (const step of STEP_ORDER) {
    steps[step] = { status: "pending", at: null, detail: null };
  }
  return { _id: "hub", steps, diagnostics: [], updatedAt: new Date().toISOString() };
}

/**
 * Bootstrap ledger — the system-owned resumability + diagnostics store
 * (Porchlight Server TS 2: bootstrap resumable and re-runnable; a crashed
 * attempt never leaves a half-configured hub without diagnostics). Lives in
 * Mongo so it survives supervisor restarts; every domain bootstrap endpoint
 * records through this service.
 */
export class BootstrapService {
  readonly config: PorchlightConfig;
  readonly configDir: string;
  private readonly ledger: CollectionLike;

  constructor(store: StoreLike, config: PorchlightConfig, configDir: string) {
    this.ledger = store.collection("bootstrap_state");
    this.config = config;
    this.configDir = configDir;
  }

  async load(): Promise<BootstrapLedgerDoc> {
    const doc = (await this.ledger.findOne({ _id: "hub" })) as BootstrapLedgerDoc | null;
    if (doc) {
      for (const step of STEP_ORDER) {
        doc.steps[step] ??= { status: "pending", at: null, detail: null };
      }
      return doc;
    }
    return freshLedger();
  }

  async status(): Promise<BootstrapStatus> {
    const doc = await this.load();
    const failed = Object.values(doc.steps).some((step) => step.status === "failed");
    const complete = STEP_ORDER.every((step) => doc.steps[step].status === "complete");
    const lastError = failed
      ? (doc.diagnostics[doc.diagnostics.length - 1]?.message ?? "a bootstrap step failed")
      : null;
    return {
      resumable: !complete && Object.values(doc.steps).some((step) => step.status === "complete"),
      lastError,
      steps: doc.steps,
      diagnostics: doc.diagnostics,
      config: {
        mode: this.config.mode,
        quota: this.config.quota,
        hubUrl: this.config.hub.tunnel.url,
      },
    };
  }

  /** Record a completed (or failed) step; idempotent per completed step. */
  async record(
    step: BootstrapStep,
    options: { detail?: string; source?: string; failed?: boolean } = {},
  ): Promise<void> {
    const { detail, source = "bootstrap", failed = false } = options;
    const doc = await this.load();
    const at = new Date().toISOString();
    if (failed) {
      doc.steps[step] = { status: "failed", at, detail: detail ?? null };
      doc.diagnostics.push({ at, source, message: detail ?? `${step} failed during bootstrap` });
    } else {
      doc.steps[step] = { status: "complete", at, detail: detail ?? null };
    }
    doc.updatedAt = at;
    const { _id, ...settable } = doc;
    await this.ledger.updateOne(
      { _id: "hub" },
      // Plain equality upsert keeps a re-run from failing on a missing
      // document; both the mongodb driver and the in-memory store honor it.
      { $set: { ...settable }, upsert: true },
    );
  }

  /** Owner-set quota ceilings (quantity-only rule) into the runtime config. */
  async setQuotas(
    quotas: { storageCeilingMb?: number | null; retentionDays?: number | null },
  ): Promise<PorchlightConfig> {
    const entries = [
      ["storageCeilingMb", quotas.storageCeilingMb],
      ["retentionDays", quotas.retentionDays],
    ] as const;
    for (const [name, value] of entries) {
      if (value === undefined) continue;
      if (value !== null && (typeof value !== "number" || value <= 0 || !Number.isFinite(value))) {
        throw Object.assign(new Error(`quota ${name} must be a positive number or null (unset)`), {
          code: "E_INVALID_QUOTA",
        });
      }
    }
    const updated = structuredClone(this.config);
    if (quotas.storageCeilingMb !== undefined) updated.quota.storageCeilingMb = quotas.storageCeilingMb;
    if (quotas.retentionDays !== undefined) updated.quota.retentionDays = quotas.retentionDays;
    // Quotas are settings of the phase-configuration runtime config — written
    // back to the same file setup created; the server never forks config.
    this.config.quota = updated.quota;
    return saveConfig(this.configDir, updated);
  }
}

export default BootstrapService;