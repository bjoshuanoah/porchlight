import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";

/**
 * Update service (PORCH-040). One shared npm-backed update path serves BOTH
 * owner-initiated surfaces: the owner console's update action and the
 * `porchlight update` CLI command (the CLI reaches it over HTTP — the CLI
 * imports no domain code, and there is exactly one service, not one per
 * surface).
 *
 * Binding rulings carried here (Brian):
 * - npm is the version source of record and the only install surface (Oct 13,
 *   2026): the check resolves the latest release from the npm registry; the
 *   apply runs `npm install -g porchlight@<latest>`; npm's rollback semantics
 *   cover a failed install.
 * - Owner-initiated only (Oct 13, 2026): this service owns NO timers, no
 *   background fetch, no background apply. The registry is consulted ONLY
 *   inside an owner-initiated request (the owner opened the console's update
 *   surface, or ran `porchlight update`). A newer release is visible to the
 *   owner without ever being applied or downloaded unprompted.
 * - Failed apply must never leave the hub unreachable: a registry failure or
 *   an install failure changes nothing and exits before the restart is
 *   scheduled — the prior release keeps serving. npm's rollback semantics
 *   cover the failed install itself.
 * - Already-latest is a version statement only: no install, no restart.
 * - The actual restart rides the install-time process supervision: the hub
 *   performs its graceful shutdown (injected `restart`), and the supervisor /
 *   launchd-class KeepAlive that spawned it respawns the freshly installed
 *   release on the same address. If a freshly installed release cannot reach
 *   readiness, the supervisor's named crash-loop fallback state (PORCH-016
 *   ac-5) names the failure in plain language with the hub log path — the
 *   documented recovery (reinstall the previous release, stop + start) is the
 *   npm-era answer; automatic rollback stays a phase-2 candidate.
 */

export interface UpdateReleaseStatus {
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  /** Plain-language note when the registry could not be reached. */
  note?: string;
}

export type ApplyResult =
  | { status: "latest"; release: { current: string | null; latest: string | null } }
  | { status: "applied"; release: { from: string | null; to: string } }
  | { status: "failed"; error: string; release: { current: string | null } };

export interface UpdateDeps {
  /** The running hub release version — fixed for the life of the process. */
  version: string | null;
  /**
   * npm registry resolution — the version source of record. Resolves the
   * latest published version; REJECTS when the registry is unreachable
   * (the caller turns the rejection into plain language, never a crash).
   */
  registry: { latest: () => Promise<string> };
  /** The npm-backed apply. Rejects on a failed install; nothing was changed. */
  installer: { install: (version: string) => Promise<void> };
  /**
   * Machine-local ops token file (CLI trust). The hub minted it for the
   * operator's own machine: <home>/state/ops-token.json, mode 0600. Null
   * disables ops-token authentication (owner sessions still work).
   */
  opsTokenFile: string | null;
  /** Graceful self-restart after a successful apply (server shutdown). */
  restart: () => void;
  /** Delay between the apply response and the restart, so the response flushes. */
  restartDelayMs?: number;
  log?: ((line: string) => void) | null;
}

const NPM_REGISTRY_TIMEOUT_MS = 30_000;
const NPM_INSTALL_TIMEOUT_MS = 15 * 60_000;

interface ExecOptions {
  timeout: number;
  encoding: "utf8";
}

/** Default registry resolution: npm's own view of the npm registry. */
export function npmRegistry(): { latest: () => Promise<string> } {
  return {
    latest: () =>
      new Promise<string>((resolve, reject) => {
        execFile(
          "npm",
          ["view", "porchlight", "version"],
          { timeout: NPM_REGISTRY_TIMEOUT_MS, encoding: "utf8" } satisfies ExecOptions,
          (error, stdout, stderr) => {
            if (error) {
              reject(new Error(stderr?.trim() || error.message));
              return;
            }
            const version = String(stdout).trim();
            if (!version) {
              reject(new Error("npm returned no version"));
              return;
            }
            resolve(version);
          },
        );
      }),
  };
}

/** Default apply: npm installs the release globally, replacing the install closure. */
export function npmInstaller(): { install: (version: string) => Promise<void> } {
  return {
    install: (version: string) =>
      new Promise<void>((resolve, reject) => {
        execFile(
          "npm",
          ["install", "-g", `porchlight@${version}`],
          { timeout: NPM_INSTALL_TIMEOUT_MS, encoding: "utf8" } satisfies ExecOptions,
          (error, _stdout, stderr) => {
            if (error) {
              reject(new Error(stderr?.trim() || error.message));
              return;
            }
            resolve();
          },
        );
      }),
  };
}

/**
 * Release comparison for the update decision. Numeric triples; a prerelease
 * tag ranks below the plain release of the same triple. Unparsable input
 * ranks below everything (the update decision refuses to act on it).
 */
export function versionRank(version: string | null | undefined): number[] | null {
  if (!version) return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewerVersion(candidate: string | null | undefined, current: string | null | undefined): boolean {
  const next = versionRank(candidate);
  const now = versionRank(current);
  if (!next || !now) return false;
  for (let i = 0; i < 3; i += 1) {
    if (next[i] !== now[i]) return next[i] > now[i];
  }
  // Equal triples: a plain release outranks its own prerelease (the
  // candidate with the prerelease tag is older).
  const nextPre = Boolean(candidate && /-/.test(candidate.trim().replace(/^v/, "")));
  const nowPre = Boolean(current && /-/.test(current.trim().replace(/^v/, "")));
  return !nextPre && nowPre;
}

export class UpdateService {
  readonly version: string | null;
  readonly registry: UpdateDeps["registry"];
  readonly installer: UpdateDeps["installer"];
  readonly opsTokenFile: string | null;
  readonly restart: () => void;
  readonly restartDelayMs: number;
  readonly log: ((line: string) => void) | null;
  #opsToken: string | null = null;
  #applying: Promise<ApplyResult> | null = null;

  constructor(deps: UpdateDeps) {
    this.version = deps.version ?? null;
    this.registry = deps.registry;
    this.installer = deps.installer;
    this.opsTokenFile = deps.opsTokenFile ?? null;
    this.restart = deps.restart;
    this.restartDelayMs = deps.restartDelayMs ?? 250;
    this.log = deps.log ?? null;
    if (this.opsTokenFile) this.#ensureOpsToken();
  }

  /**
   * The owner-initiated release check: the running release plus the npm
   * registry's latest, both as plain facts. Registry failure is a note, not
   * an error — the owner-run npm path remains available either way.
   */
  async status(): Promise<UpdateReleaseStatus> {
    let latest: string | null = null;
    let note: string | undefined;
    try {
      latest = await this.registry.latest();
    } catch (error) {
      note =
        "the npm registry could not be reached, so the latest release is unknown " +
        `(${(error as Error).message}). Nothing was fetched, installed, or changed — ` +
        "the owner-run update path (npm install -g porchlight) remains available.";
    }
    return {
      current: this.version,
      latest,
      updateAvailable: Boolean(latest && this.version && isNewerVersion(latest, this.version)),
      ...(note ? { note } : {}),
    };
  }

  /**
   * The single owner action: resolve the latest release, install it through
   * npm, and (only on success) schedule the restart that the supervisor
   * turns into a respawn of the freshly installed release. Any failure is a
   * named no-op: nothing was downloaded or installed beyond npm's own atomic
   * step, and the restart is never scheduled — the prior release keeps
   * serving. Concurrent applies share one flight.
   */
  async apply(): Promise<ApplyResult> {
    if (this.#applying) return this.#applying;
    this.#applying = this.#applyOnce().finally(() => {
      this.#applying = null;
    });
    return this.#applying;
  }

  async #applyOnce(): Promise<ApplyResult> {
    const current = this.version;
    if (!current) {
      return {
        status: "failed",
        error:
          "the running release version is unknown on this hub, so an update cannot be applied safely. " +
          "Nothing was changed — the hub keeps serving.",
        release: { current },
      };
    }
    let latest: string;
    try {
      latest = await this.registry.latest();
    } catch (error) {
      return {
        status: "failed",
        error:
          `could not reach the npm registry to resolve the latest release (${(error as Error).message}). ` +
          `Nothing was downloaded, installed, or restarted — the hub keeps serving the current release v${current}.`,
        release: { current },
      };
    }
    if (!isNewerVersion(latest, current)) {
      return { status: "latest", release: { current, latest } };
    }
    try {
      await this.installer.install(latest);
    } catch (error) {
      return {
        status: "failed",
        error:
          `the update to v${latest} could not be installed (${(error as Error).message}). ` +
          `npm leaves the previous release in place on a failed install — the hub keeps serving ` +
          `v${current} and was not restarted.`,
        release: { current },
      };
    }
    // Success: respond first, then hand the process to its supervisor. The
    // graceful shutdown lets the response flush; the supervisor restarts the
    // freshly installed release automatically (launchd-class supervision) and
    // a release that cannot reach readiness lands in the named crash-loop
    // fallback state (PORCH-016 ac-5) — never a silent unreachable hub.
    setTimeout(() => {
      this.log?.(`update v${current} → v${latest} installed — restarting the hub (supervisor respawn)`);
      this.restart();
    }, this.restartDelayMs);
    return { status: "applied", release: { from: current, to: latest } };
  }

  /**
   * Machine-local ops-token check for the CLI surface. The token lives only
   * on the hub machine (0600, owner-read) — it can never be presented from
   * a tunnel or LAN peer (PORCH-025: the LAN boundary receives zero trust).
   */
  verifyToken(token: string): boolean {
    const expected = this.#ensureOpsToken();
    if (!expected || !token) return false;
    const a = Buffer.from(token, "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  #ensureOpsToken(): string | null {
    if (this.#opsToken) return this.#opsToken;
    if (!this.opsTokenFile) return null;
    try {
      if (existsSync(this.opsTokenFile)) {
        const row = JSON.parse(readFileSync(this.opsTokenFile, "utf8")) as { token?: string };
        this.#opsToken = row.token ?? null;
      } else {
        this.#opsToken = randomBytes(32).toString("hex");
        mkdirSync(dirname(this.opsTokenFile), { recursive: true });
        writeFileSync(
          this.opsTokenFile,
          JSON.stringify({ token: this.#opsToken, createdAt: new Date().toISOString() }, null, 2) + "\n",
          { mode: 0o600 },
        );
      }
    } catch (error) {
      this.log?.(`ops-token unavailable (${(error as Error).message}) — CLI update falls back to owner sessions`);
      return null;
    }
    return this.#opsToken;
  }
}

export default UpdateService;