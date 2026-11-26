import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { HUB_MIGRATIONS } from "./migrations/index.js";
import { versionRank, type UpdateMigrator } from "./update.service.js";

/**
 * Versioned data-migration runner (PORCH-156). The hub's one migration
 * machinery: every data change that needs a migration declares a versioned
 * step in the Service's migration catalog, and the runner applies each hub's
 * pending set exactly once, in declared version order, on the owner-run
 * update path only.
 *
 * Binding rulings carried here (Brian, Nov 26, 2026 — Operations and Owner
 * Tooling amendment "Data migrations on update"):
 * - Once and only once per hub: idempotent; a re-run or restart through a
 *   partially applied set never double-applies or skips. Every completed
 *   step is recorded in the hub's own migration ledger before the next step
 *   starts, so an interrupted set resumes at the incomplete step.
 * - The set completes BEFORE the server accepts traffic: the boot gate runs
 *   the pending set before the listener binds, and the update-time phase
 *   runs the freshly installed release's own set before that restart is
 *   scheduled — a failed migration keeps the prior release serving, with
 *   plain-language diagnostics naming the failing step. Hub data is never
 *   silently half-migrated: the ledger records exactly how far the set got.
 * - Update path only: the runner rides the shared update service (npm
 *   install plus the install-time restart, the owner-console update action,
 *   and the `porchlight update` CLI) or the boot that follows it. No
 *   background fetch loop, no scheduled cadence, no timers anywhere.
 * - Family-archive safety: a destructive-capable step refuses to run without
 *   an owner-initiated run, and a step whose activating release has not
 *   shipped yet stays inert (declared, ordered, exercised in tests — never
 *   applied on a hub update ahead of its release cut).
 * - Outcome counts (documents read, written, and collision resolutions)
 *   are recorded per step, bound to the step's identity (version + name)
 *   on the ledger, and land on the carrier task trail of the change that
 *   required the migration.
 */

export interface MigrationOutcome {
  /** Documents the step examined (its declared workset). */
  read: number;
  /** Documents the step actually wrote. */
  written: number;
  /** Multi-value conflicts the step resolved under its declared mapping. */
  collisions: number;
}

/** A migration update: the driver's `$set` / `$unset` pair, nothing more. */
export interface MigrationWrite {
  $set?: Record<string, unknown>;
  $unset?: Record<string, unknown>;
}

/**
 * The store surface a migration step may use. Deliberately wider than the
 * read/store services' `CollectionLike` (migrations need `$or`, `$exists`,
 * `$unset`, and bulk writes) and deliberately not the raw driver: the
 * runner tests substitute one in-memory store, so the Mongo adapter is the
 * only place the real driver appears.
 */
export interface MigrationCollectionLike {
  find(filter?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  insertOne(document: Record<string, unknown>): Promise<unknown>;
  updateOne(
    filter: Record<string, unknown>,
    update: MigrationWrite,
    options?: { upsert?: boolean },
  ): Promise<{ matchedCount: number; modifiedCount: number }>;
  updateMany(
    filter: Record<string, unknown>,
    update: MigrationWrite,
  ): Promise<{ matchedCount: number; modifiedCount: number }>;
  countDocuments(filter?: Record<string, unknown>): Promise<number>;
}

export interface MigrationStore {
  collection(name: string): MigrationCollectionLike;
}

export interface MigrationContext {
  store: MigrationStore;
  log(line: string): void;
}

export interface MigrationStep {
  /** Positive integer, unique across the catalog; execution follows it. */
  version: number;
  /** Stable name bound into the ledger record together with the version. */
  name: string;
  /**
   * The release cut that activates the step for hub updates. `null` marks a
   * declared-but-unreleased step: ordered and exercised in tests, but never
   * applied on a hub update until its cut (the release-ledger call stays
   * with the human ruling, per the sequencing note on the first passenger).
   */
  activatesIn: string | null;
  /** Destructive steps refuse to run without an owner-initiated run. */
  destructive: boolean;
  /**
   * The cheap completion check for the settle pass. Steps whose workset can
   * still grow while the prior release keeps serving (the update-time pass
   * runs during the live hub's serving window, so the old code can write
   * new legacy-shaped documents until the swap) declare this: each boot
   * re-checks the count and, when it is non-zero, re-runs the step — the
   * step's own once-per-document guard makes that a completion, never a
   * double-apply. Absent = the settle pass never touches the step.
   */
  workRemaining?: (ctx: Pick<MigrationContext, "store" | "log">) => Promise<number>;
  apply(ctx: MigrationContext): Promise<MigrationOutcome>;
}

/** The per-step application record: the run's outcome, bound to the step. */
export interface MigrationRunRecord {
  version: number;
  name: string;
  appliedAt: string;
  release: string | null;
  outcome: MigrationOutcome;
  /**
   * The per-pass counts of a settled step, in order (first = the original
   * pass). The cumulative `outcome` is the sum of the passes.
   */
  passes: Array<MigrationOutcome & { at: string }>;
}

export interface MigrationSetResult {
  applied: MigrationRunRecord[];
  /** Destructive steps that refused to run without an owner-initiated path. */
  skippedDestructive: string[];
  /** Declared steps whose activating release has not shipped yet. */
  skippedUnactivated: string[];
}

export interface MigrationRunOptions {
  /**
   * Marks the run owner-initiated: the only path a destructive-capable step
   * accepts. Automatic boot/update runs never set it.
   */
  ownerInitiated?: boolean;
  /**
   * Versions forced on for this run regardless of their activating release
   * (the explicit owner hook the deployed-hub stage-2 checklist uses). Never
   * set by automatic runs.
   */
  forceVersions?: number[];
}

/** The hub's migration ledger: one record per applied step, keyed uniquely. */
export const MIGRATION_LEDGER_COLLECTION = "hub_migrations";

const LEDGER_ID = (version: number): string => `migration_v${version}`;

/** The one failure class that stops a set, carrying the plain-language name. */
export class MigrationStepFailure extends Error {
  readonly version: number;
  readonly stepName: string;

  constructor(step: Pick<MigrationStep, "version" | "name">, appliedSoFar: string[], cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const prefix =
      appliedSoFar.length > 0
        ? ` Completed before it: ${appliedSoFar.join(", ")}, recorded once-only in the hub's ${MIGRATION_LEDGER_COLLECTION} ledger.`
        : ` No step had applied yet when it failed.`;
    super(
      `the data migration step v${step.version} (${step.name}) failed: ${detail}.${prefix} The set is incomplete, so the ` +
        `server must not accept traffic; the set resumes exactly at v${step.version} on the next boot, and completed ` +
        `steps never double-apply.`,
    );
    this.name = "MigrationStepFailure";
    this.version = step.version;
    this.stepName = step.name;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function compareRanks(a: number[] | null, b: number[] | null): number {
  if (!a || !b) return 0;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

export interface MigrationRunnerOptions {
  /** The running release version (the version-of-process at the boot gate). */
  release?: string | null;
  log?: ((line: string) => void) | null;
}

export class MigrationRunner {
  readonly #steps: readonly MigrationStep[];
  readonly #store: MigrationStore;
  readonly #release: string | null;
  readonly #ledger: MigrationCollectionLike;
  readonly #log: (line: string) => void;

  constructor(steps: readonly MigrationStep[], store: MigrationStore, options: MigrationRunnerOptions = {}) {
    const seen = new Set<number>();
    const sorted = [...steps].sort((a, b) => a.version - b.version);
    for (const step of sorted) {
      if (!Number.isInteger(step.version) || step.version < 1) {
        throw new Error(`migration step "${step.name}" carries a non-positive version (${step.version}) — a catalog entry must declare a positive integer version`);
      }
      if (seen.has(step.version)) {
        throw new Error(`migration catalog declares v${step.version} twice ("${step.name}" reuses a taken version) — each step needs its own version`);
      }
      if (typeof step.name !== "string" || step.name.trim().length === 0) {
        throw new Error(`migration v${step.version} carries an empty name — the ledger binds the run's identity to version + name`);
      }
      seen.add(step.version);
    }
    this.#steps = sorted;
    this.#store = store;
    this.#release = options.release ?? null;
    this.#ledger = store.collection(MIGRATION_LEDGER_COLLECTION);
    this.#log = options.log ?? (() => {});
  }

  /**
   * The runner's read-only diagnostic: the declared steps whose activating
   * release is active in this release, in version order. Never touches the hub.
   */
  activeSteps(): MigrationStep[] {
    return this.#steps.filter((step) => this.#isActive(step));
  }

  #isActive(step: MigrationStep): boolean {
    if (step.activatesIn === null) return false;
    const releaseRank = versionRank(this.#release);
    if (!releaseRank) {
      throw new Error(
        `the running release version is unknown on this hub, so the migration runner cannot tell whether ` +
          `v${step.version} (${step.name}) is active in this release — refusing to run any migration against the family archive`,
      );
    }
    const activationRank = versionRank(step.activatesIn);
    if (!activationRank) {
      throw new Error(`migration step v${step.version} (${step.name}) declares an unparsable activating release "${step.activatesIn}"`);
    }
    return compareRanks(releaseRank, activationRank) >= 0;
  }

  /**
   * The one ordered pass over the pending set. Each completed step is
   * recorded on the ledger BEFORE the next step starts; a failure stops the
   * set at the incomplete step and carries the step's plain-language name,
   * so the caller (boot gate or update-time phase) either refuses traffic or
   * keeps the prior release serving — never a half-migrated hub.
   */
  async runPending(options: MigrationRunOptions = {}): Promise<MigrationSetResult> {
    const skippedDestructive: string[] = [];
    const skippedUnactivated: string[] = [];
    const chosen: MigrationStep[] = [];
    for (const step of this.#steps) {
      const forced = options.forceVersions?.includes(step.version) ?? false;
      if (!forced && !this.#isActive(step)) {
        skippedUnactivated.push(`v${step.version} (${step.name})`);
        continue;
      }
      if (step.destructive && !options.ownerInitiated && !forced) {
        skippedDestructive.push(`v${step.version} (${step.name})`);
        this.#log(
          `migration v${step.version} (${step.name}) refuses to run: it is a destructive-capable step and this is ` +
            `not an owner-initiated run — it stays inert until the owner explicitly initiates it`,
        );
        continue;
      }
      chosen.push(step);
    }
    // No DB touch when nothing is runnable: a hub with an empty active set
    // never pays a ledger read at boot.
    if (chosen.length === 0) {
      return { applied: [], skippedDestructive, skippedUnactivated };
    }
    const ledgerRows = (await this.#ledger.find({})) as Array<Record<string, unknown>>;
    const recorded = new Map<number, Record<string, unknown>>();
    for (const row of ledgerRows) {
      if (Number.isInteger(Number(row.version))) recorded.set(Number(row.version), row);
    }
    const context = { store: this.#store, log: this.#log };
    const records: MigrationRunRecord[] = [];
    const appliedSoFar: string[] = [];
    const work: Array<{ step: MigrationStep; settleOf?: Record<string, unknown> }> = [];
    for (const step of chosen) {
      const prior = recorded.get(step.version);
      if (!prior) {
        work.push({ step });
        continue;
      }
      // The settle pass: a recorded step whose declared completion check
      // finds work left (documents the still-serving prior release wrote
      // inside the update-time pass's serving window) re-runs once here —
      // its once-per-document guard keeps this a completion, no double-apply.
      if (step.workRemaining) {
        const remaining = await step.workRemaining(context);
        if (remaining > 0) {
          this.#log(
            `migration v${step.version} (${step.name}): ${remaining} document(s) still match its workset — re-applying the idempotent step to settle the pass`,
          );
          work.push({ step, settleOf: prior });
        }
      }
    }
    for (const { step, settleOf } of work) {
      const label = `v${step.version} (${step.name})${settleOf ? " (settle)" : ""}`;
      if (!settleOf) this.#log(`migration ${label} applying…`);
      let outcome: MigrationOutcome;
      try {
        outcome = normalizeOutcome(await step.apply(context));
      } catch (error) {
        if (error instanceof MigrationStepFailure) throw error;
        throw new MigrationStepFailure(step, appliedSoFar, error);
      }
      if (settleOf) {
        const settledAt = new Date().toISOString();
        const passes = this.#passesOf(settleOf, outcome, settledAt);
        const cumulative = this.#sumOutcome(settleOf, outcome);
        await this.#ledger.updateOne(
          { _id: LEDGER_ID(step.version) },
          {
            $set: { outcome: cumulative, passes, settledAt },
            $unset: {},
          },
        );
        const record: MigrationRunRecord = {
          version: step.version,
          name: step.name,
          appliedAt: String(settleOf.appliedAt),
          release: this.#release,
          // The run outcome is this pass's work; the LEDGER record carries
          // the cumulative sum across passes.
          outcome,
          passes,
        };
        this.#log(
            `migration ${label}: settled — read=${outcome.read} written=${outcome.written} collisions=${outcome.collisions}`,
        );
        records.push(record);
        appliedSoFar.push(label);
        continue;
      }
      const record: MigrationRunRecord = {
        version: step.version,
        name: step.name,
        appliedAt: new Date().toISOString(),
        release: this.#release,
        outcome,
        passes: [{ ...outcome, at: new Date().toISOString() }],
      };
      await this.#ledger.insertOne({
        _id: LEDGER_ID(step.version),
        ...record,
      });
      this.#log(
        `migration ${label}: applied — read=${outcome.read} written=${outcome.written} collisions=${outcome.collisions}`,
      );
      records.push(record);
      appliedSoFar.push(label);
    }
    if (records.length === 0) {
      this.#log(`migration scan: pending set empty — every active step is already recorded once-only on this hub`);
    }
    return { applied: records, skippedDestructive, skippedUnactivated };
  }

  #passesOf(prior: Record<string, unknown>, outcome: MigrationOutcome, at: string): Array<MigrationOutcome & { at: string }> {
    const carries = Array.isArray(prior.passes) ? (prior.passes as Array<Record<string, unknown>>) : [];
    const passes = carries.map((pass) => ({
      read: Number(pass.read ?? 0),
      written: Number(pass.written ?? 0),
      collisions: Number(pass.collisions ?? 0),
      at: String(pass.at ?? ""),
    }));
    passes.push({ ...outcome, at });
    return passes;
  }

  #sumOutcome(prior: Record<string, unknown>, pass: MigrationOutcome): MigrationOutcome {
    const previous = (prior.outcome ?? {}) as Partial<MigrationOutcome>;
    return {
      read: Number(previous.read ?? 0) + pass.read,
      written: Number(previous.written ?? 0) + pass.written,
      collisions: Number(previous.collisions ?? 0) + pass.collisions,
    };
  }
}

/**
 * Coerce the step-reported counts into plain non-negative integers and
 * reject a step returning no counts — a run's outcome record must always
 * carry complete counts, never partial or invented numbers.
 */
function normalizeOutcome(outcome: MigrationOutcome | undefined): MigrationOutcome {
  const raw = outcome ?? ({} as Partial<MigrationOutcome>);
  const read = raw.read;
  const written = raw.written;
  const collisions = raw.collisions;
  for (const [label, value] of [
    ["read", read],
    ["written", written],
    ["collisions", collisions],
  ] as Array<[string, unknown]>) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`the step returned an invalid "${label}" outcome count — a run's record carries complete read/written/collisions counts`);
    }
  }
  return {
    read: Math.max(0, Math.trunc(read as number)),
    written: Math.max(0, Math.trunc(written as number)),
    collisions: Math.max(0, Math.trunc(collisions as number)),
  };
}

/**
 * The one call the boot gate and the migration CLI share: the full declared
 * catalog, once-only per hub, with the hub's own ledger. Throws (with the
 * failing step named in plain language) when the set cannot complete — the
 * caller then refuses traffic.
 */
export async function runHubMigrations(args: {
  store: MigrationStore;
  release: string | null;
  log?: ((line: string) => void) | null;
  options?: MigrationRunOptions;
}): Promise<MigrationSetResult> {
  const runner = new MigrationRunner(HUB_MIGRATIONS, args.store, { release: args.release, log: args.log });
  return runner.runPending(args.options ?? {});
}

/**
 * The running release version, read from the server package file that
 * carries it (the same source-of-truth the update service uses: npm swaps
 * the package between restarts, so the version is static for the life of
 * the process).
 */
export function runtimeReleaseVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/** The owner-initiated knobs of the migration CLI mode (`--migrate`). */
export interface MigrationCliOptions {
  ownerInitiated: boolean;
  forceVersions: number[];
}

export function parseMigrationCliArgs(argv: string[]): MigrationCliOptions {
  const ownerInitiated = argv.includes("--owner-initiated");
  const flag = argv.find((arg) => arg.startsWith("--force-version="));
  const forceVersions = flag
    ? (flag.slice("--force-version=".length) ?? "")
        .split(",")
        .map((part) => Number.parseInt(part.trim(), 10))
        .filter((value) => Number.isInteger(value))
    : [];
  return { ownerInitiated, forceVersions };
}

/**
 * Default update-time migrator: spawn the freshly installed release's own
 * entry in `--migrate` mode against the hub's own data. npm swaps the
 * on-disk closure in place before the restart is scheduled, so the entry
 * path resolves to the NEW release's runner even inside the previously
 * running process — the pending set always executes with the release that
 * declared it, before that release ever accepts traffic. Any failure (nonzero
 * exit, plain-language stderr from the failing step, a hung run) rejects, so
 * the prior release keeps serving.
 */
const MIGRATION_SPAWN_TIMEOUT_MS = 30 * 60_000;

export function spawnMigrator(seam: { entry: string | null; timeoutMs?: number }): UpdateMigrator | null {
  const entry = seam.entry;
  if (!entry || !existsSync(entry)) return null;
  return {
    async run() {
      const exec = promisify(execFile);
      try {
        const { stdout } = await exec(process.execPath, [entry, "--migrate"], {
          timeout: seam.timeoutMs ?? MIGRATION_SPAWN_TIMEOUT_MS,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        });
        const lines = stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("migration "));
        const applied = lines.reduce((count, line) => count + (/^migration v\d+ \S+: applied/.test(line) ? 1 : 0), 0);
        return { applied, lines };
      } catch (error) {
        const err = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
        const diagnostics = err.killed
          ? `the migration runner was stopped after its time budget without completing`
          : `the migration runner exited with code ${String(err.code ?? "unknown")}`;
        const stderr = typeof err.stderr === "string" ? err.stderr.trim() : "";
        const detail = stderr ? ` — the failing step's diagnostics: ${stderr}` : "";
        throw new Error(`the freshly installed release's update-time data migration did not complete (${diagnostics})${detail}`);
      }
    },
  };
}
