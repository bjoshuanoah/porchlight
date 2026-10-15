import { execFile } from "node:child_process";
import { createGunzip } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

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
 * - Notes on the surfaces (PORCH-077, Brian Oct 14, 2026): both surfaces show
 *   the pending release's notes read verbatim from the release's own
 *   published content — the GitHub release body for the target version on
 *   the canonical repo (the signed-release anchor), falling back to that
 *   version's CHANGELOG section in the published package, then a plain
 *   named-unavailable line. Never generated, never summarized. The notes
 *   fetch is hub-side only and rides the same owner-initiated window as the
 *   version check (notes resolve ONLY when a newer release is actually
 *   shown); npm stays the version source of record; and notes never gate or
 *   alter the apply path.
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
  /**
   * The pending release's notes (PORCH-077), resolved ONLY when a newer
   * release is actually shown to the owner — never on an already-latest
   * read, never on a timer.
   */
  notes?: ReleaseNotes;
}

/**
 * The release's own published content, rendered where the update surfaces
 * show it (PORCH-077). `text` is always verbatim published content (size-
 * capped) or a plain named-unavailable line — never a synthesized summary.
 */
export interface ReleaseNotes {
  source: "github-release" | "package-changelog" | "unavailable";
  text: string;
}

/** The notes source chain: injectable seams for the build-time evidence. */
export interface NotesResolvers {
  /** The GitHub release body for the target version, or null when empty/unavailable/oversized. */
  githubReleaseBody: (version: string) => Promise<string | null>;
  /** The version's CHANGELOG section from the published package, or null when absent or unreadable. */
  changelogSection: (version: string) => Promise<string | null>;
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
   * Release-notes source chain (PORCH-077). Optional: when omitted the
   * published-source chain below is used (GitHub release body on the
   * canonical repo, then the published package tarball's CHANGELOG section).
   */
  notes?: NotesResolvers;
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

// Release-notes chain (PORCH-077). The cap is the [Assumed] ~10 KB of plain
// text from the spec bullet, tuned here to 10,000 characters. The tarball
// read budget covers the one-time fallback path: the published closure is
// large (PORCH-067), and the CHANGELOG member may sit behind it in the tar.
export const NOTES_MAX_CHARS = 10_000;
const GITHUB_RELEASES_TIMEOUT_MS = 15_000;
const TARBALL_URL_TIMEOUT_MS = 30_000;
const TARBALL_READ_BUDGET_MS = 120_000;
/** Canonical repo (Brian, Oct 8, 2026) — the signed-release anchor. */
const CANONICAL_REPO = "bjoshuanoah/porchlight";

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

function execText(command: string, args: string[], timeout: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(command, args, { timeout, encoding: "utf8" } satisfies ExecOptions, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Notes source 1 (PORCH-077): the GitHub release body for the target version
 * on the canonical repo (the signed-release anchor; the npm-publish workflow
 * copy's the cut's CHANGELOG entry into the release notes and fails loudly
 * when it is missing). Returns null when the release is unavailable or its
 * body is empty; an oversized body also returns null — the chain falls back
 * to the published package's CHANGELOG section (ac-3), and whatever body is
 * finally rendered is capped under NOTES_MAX_CHARS there.
 */
export async function githubReleaseBody(version: string): Promise<string | null> {
  const tag = `v${String(version).replace(/^v/, "")}`;
  try {
    const response = await fetch(`https://api.github.com/repos/${CANONICAL_REPO}/releases/tags/${tag}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "porchlight-hub" },
      signal: AbortSignal.timeout(GITHUB_RELEASES_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    const release = (await response.json()) as { body?: unknown };
    const body = typeof release?.body === "string" ? release.body.trim() : "";
    if (!body || body.length > NOTES_MAX_CHARS) {
      return null;
    }
    return body;
  } catch {
    return null;
  }
}

/**
 * Notes source 2 (PORCH-077): the target version's CHANGELOG section from
 * the published package. The tarball URL resolves through npm (the version
 * source of record; npm egress only), the tarball streams through gunzip
 * (the published closure runs large, so the member is extracted streaming,
 * never buffered whole), and the section is parsed verbatim.
 */
export async function packageChangelogSection(version: string): Promise<string | null> {
  const clean = version.replace(/^v/, "");
  let tarballUrl: string;
  try {
    tarballUrl = (await execText("npm", ["view", `porchlight@${clean}`, "dist.tarball"], TARBALL_URL_TIMEOUT_MS)).trim();
  } catch {
    return null;
  }
  if (!tarballUrl) {
    return null;
  }
  let member: Buffer | null = null;
  try {
    member = await readTarballMember(tarballUrl, ["package/CHANGELOG.md", "CHANGELOG.md", "package/CHANGELOG"]);
  } catch {
    return null;
  }
  if (!member) {
    return null;
  }
  return changelogSectionFor(member.toString("utf8"), clean);
}

/**
 * The CHANGELOG section for one version: the entry under the heading that
 * names the version (## v0.3.0 class), running to the next heading at the
 * same or higher level. Verbatim text; null when the version carries no
 * section (the unavailable line then names it — never a synthesized entry).
 */
export function changelogSectionFor(changelog: string, version: string): string | null {
  const clean = version.replace(/^v/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingPattern = new RegExp(`^(#{1,6})\\s*\\**\\s*\\[?\\s*v?${clean}[\\] ]*(?:$|[\\s—-])`);
  const lines = changelog.split("\n");
  let started = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const match = headingPattern.exec(lines[i]);
    if (!match) continue;
    started = i + 1;
    level = match[1].length;
    break;
  }
  if (started === -1) {
    return null;
  }
  const body: string[] = [];
  for (let i = started; i < lines.length; i += 1) {
    const heading = /^#{1,6}\s/.exec(lines[i]);
    if (heading && heading[0].length - 1 <= level) break;
    body.push(lines[i]);
  }
  const section = body.join("\n").trim();
  return section ? section : null;
}

/**
 * Default notes chain (PORCH-077): GitHub release body first, then the
 * published package's CHANGELOG section. Used whenever the wiring does not
 * inject resolvers (the production router); tests inject seams.
 */
export function publishedNotesResolvers(): NotesResolvers {
  return {
    githubReleaseBody: (version) => githubReleaseBody(version),
    changelogSection: (version) => packageChangelogSection(version),
  };
}

/**
 * Stream-read one member from an npm registry tarball (gzip-compressed tar).
 * The published closure is large, so the gunzip stream is consumed
 * incrementally, the member's bytes are never buffered beyond themselves,
 * and the download is abandoned the moment the member is complete. Returns
 * null when the member is absent from the archive.
 */
export async function readTarballMember(url: string, memberNames: string[]): Promise<Buffer | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(TARBALL_READ_BUDGET_MS) });
  if (!response.ok || !response.body) {
    return null;
  }
  const gunzip = createGunzip();
  const source = Readable.fromWeb(response.body as WebReadableStream);
  source.pipe(gunzip);
  source.on("error", () => gunzip.destroy());
  try {
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    for await (const chunk of gunzip) {
      buffer = buffer.length === 0 ? (chunk as Buffer) : Buffer.concat([buffer, chunk as Buffer]);
      for (;;) {
        if (buffer.length < 512) break;
        // End-of-archive marker (consecutive zero blocks): nothing more to scan.
        if (buffer.subarray(0, 512).every((byte) => byte === 0)) {
          return null;
        }
        const name = buffer.subarray(0, 100).toString("utf8").replace(/\0.*$/, "").trim();
        const size = Number.parseInt(buffer.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim() || "0", 8) || 0;
        const type = buffer.subarray(156, 157).toString("utf8");
        const dataStart = 512;
        const dataBlocks = Math.ceil(size / 512) * 512;
        if (memberNames.includes(name) && (type === "0" || type === "\0")) {
          if (buffer.length < dataStart + size) break;
          return Buffer.from(buffer.subarray(dataStart, dataStart + size));
        }
        if (buffer.length < dataStart + dataBlocks) break;
        buffer = buffer.subarray(dataStart + dataBlocks);
      }
    }
    return null;
  } finally {
    gunzip.destroy();
    void source.unpipe(gunzip);
    void response.body.cancel().catch(() => {});
  }
}

/** Renders the notes size cap (PORCH-077): oversized bodies truncate under the cap, never summarized. */
function capNotesText(text: string): string {
  if (text.length <= NOTES_MAX_CHARS) {
    return text;
  }
  return (
    text.slice(0, NOTES_MAX_CHARS) +
    `\n\n(The release notes run longer than the ${NOTES_MAX_CHARS}-character size cap — they are truncated here, never summarized.)`
  );
}

/** The plain named-unavailable line (PORCH-077 ac-3): the state named, never a generated summary. */
function unavailableNotes(version: string, detail?: string): ReleaseNotes {
  const reason = detail ? ` (${detail})` : "";
  return {
    source: "unavailable",
    text:
      `Release notes for v${version} are unavailable${reason} — the GitHub release body and the published ` +
      "package's CHANGELOG section both could not be read. Notes are always the release's own published " +
      "content and are never generated.",
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
  readonly notes: NotesResolvers;
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
    this.notes = deps.notes ?? publishedNotesResolvers();
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
   *
   * Notes (PORCH-077) resolve in this same owner-initiated window and ONLY
   * when a newer release is actually being shown: an already-latest read
   * fetches nothing beyond the registry version, and apply() never reads
   * notes at all — they never gate the apply path.
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
    const updateAvailable = Boolean(latest && this.version && isNewerVersion(latest, this.version));
    const notes = updateAvailable && latest ? await this.#resolveNotes(latest) : undefined;
    return {
      current: this.version,
      latest,
      updateAvailable,
      ...(note ? { note } : {}),
      ...(notes ? { notes } : {}),
    };
  }

  /**
   * The shared notes source chain (PORCH-077): the GitHub release body for
   * the target version on the canonical repo, then that version's CHANGELOG
   * section in the published package, then the plain named-unavailable
   * line. Every rendered text is verbatim published content size-capped;
   * nothing is ever generated or summarized. The chain's own failures are
   * a named state, never an error and never an apply-path input.
   */
  async #resolveNotes(version: string): Promise<ReleaseNotes> {
    try {
      const body = await this.notes.githubReleaseBody(version);
      if (body) {
        return { source: "github-release", text: capNotesText(body) };
      }
      const section = await this.notes.changelogSection(version);
      if (section) {
        return { source: "package-changelog", text: capNotesText(section) };
      }
      return unavailableNotes(version);
    } catch (error) {
      return unavailableNotes(version, (error as Error).message);
    }
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