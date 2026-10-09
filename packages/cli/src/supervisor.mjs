// Supervisor: owns the hub's single user-managed process group (Porchlight
// Server TS 2) — mongod, redis-server, the hub server, and the tunnel child.
// Children restart automatically with capped exponential backoff; every
// spawn, restart, and failure is journaled to the daemon state files and the
// home logs (local-only diagnostics, zero phone-home).
//
// Crash-loop fallback (PORCH-016 ac-5): a child that fails to REACH readiness
// on consecutive starts exhausts its restart budget and the supervisor stops
// the whole group into a NAMED fallback state (state/fallback.json) instead
// of silently restarting forever. The supervisor process stays alive — under
// launchd KeepAlive a dead supervisor would just be respawned into the same
// crash-loop, so the stable nameable state is a live-but-idle supervisor
// with the process group stopped and the fallback diagnostics on disk.
// Recovery is the documented previous-version reinstall: npm install -g
// porchlight@<previous>, then porchlight stop + porchlight start.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@porchlight/shared";
import { clearStateFile, isOurPid, logsPath, readJson, readState, stateFile, writeJson } from "./state.mjs";

/** Consecutive failed starts (never reaching readiness) before give-up. */
export const DEFAULT_MAX_FAILED_STARTS = 5;
/** Children spawned with a readiness probe get this deadline per start. */
export const DEFAULT_READINESS_TIMEOUT_MS = 90_000;

const fallbackStateFile = (paths) => join(paths.state, "fallback.json");

const log = (paths, name, message) => {
  const line = `[${new Date().toISOString()}] ${name}: ${message}`;
  process.stdout.write(line + "\n");
  appendFileSync(logsPath(paths, "supervisor"), line + "\n");
};

function journalChildState(paths, name, patch) {
  const previous = readJson(stateFile(paths, name)) ?? {};
  writeJson(stateFile(paths, name), {
    name,
    pid: null,
    startedAt: null,
    restarts: 0,
    lastExitCode: null,
    lastError: null,
    ...previous,
    ...patch,
  });
}

export function serverEntryPath() {
  // The published porchlight package carries @porchlight/server in its
  // install closure (bundled dependency); in the monorepo it resolves through
  // the workspace link in the ROOT node_modules. Node-style upward walk:
  // <dir>[/node_modules]/@porchlight/server/dist/index.js
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(
      current,
      current.endsWith("node_modules") ? "@porchlight" : join("node_modules", "@porchlight"),
      "server",
      "dist",
      "index.js",
    );
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("hub server entry @porchlight/server/dist/index.js not found — reinstall porchlight or run `npm run build` in the repo");
}

export class Supervisor {
  #children = new Map();
  #stopping = false;
  #fallback = null;
  #options;

  constructor(paths, config, options = {}) {
    this.paths = paths;
    this.config = config;
    // maxFailedStarts + readinessTimeoutMs are tunable for tests; the
    // production defaults are the exported constants above.
    this.#options = {
      maxFailedStarts: options.maxFailedStarts ?? DEFAULT_MAX_FAILED_STARTS,
      backoffScale: options.backoffScale ?? 1,
    };
  }

  /** The resolved crash-loop fallback state, or null while not in fallback. */
  fallbackState() {
    return this.#fallback;
  }

  spawnChild(name, command, args, { ready, onReady, readinessTimeoutMs = null } = {}) {
    const state = { attempt: 0, ready: false, proc: null, timer: null, deadlineTimer: null, failedStarts: 0 };
    this.#children.set(name, state);

    // One failure path for exits without readiness and for spawn errors
    // (a deleted install closure resolves to ENOENT after an owner-run npm
    // update — exactly the composed failure this journaling must name).
    // Bookkeeping is per child GENERATION: a late exit of a replaced child
    // (its SIGTERM from the readiness deadline, processed after the next
    // spawn) must never count or kill the new generation.
    const noteFailure = (generation, message, exitCode) => {
      if (generation.counted) return; // deadline + exit fire in tandem
      generation.counted = true;
      clearTimeout(state.deadlineTimer);
      state.failedStarts += 1;
      journalChildState(this.paths, name, {
        pid: null,
        lastExitCode: exitCode ?? null,
        restarts: (readJson(stateFile(this.paths, name))?.restarts ?? 0) + 1,
        lastError: message,
      });
      if (state.failedStarts >= this.#options.maxFailedStarts) {
        this.#declareFallback(name, message, state);
        return;
      }
      const backoffSeconds = Math.round(Math.min(2 ** state.attempt, 30) * this.#options.backoffScale);
      log(
        this.paths,
        name,
        `exited without readiness (attempt ${state.failedStarts}) — restarting in ${backoffSeconds}s (automatic restart)`,
      );
      state.timer = setTimeout(startChild, backoffSeconds * 1000);
    };

    const startChild = () => {
      if (this.#stopping || this.#fallback) return;
      state.attempt += 1;
      const logStream = appendFileStream(logsPath(this.paths, name));
      const proc = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PORCHLIGHT_HOME: this.paths.root },
      });
      state.proc = proc;
      state.ready = false;
      const generation = { counted: false, readied: false };
      log(this.paths, name, `pid ${proc.pid} spawn ${command} (attempt ${state.attempt})`);
      journalChildState(this.paths, name, {
        pid: proc.pid,
        startedAt: new Date().toISOString(),
        lastError: null,
      });
      proc.stdout?.pipe(logStream);
      proc.stderr?.pipe(logStream);
      // Spawn failures (ENOENT on a vanished entry, EACCES) surface here,
      // not as an exit — journal them loud and count the failed start.
      proc.on("error", (error) => {
        logStream.close();
        if (state.proc !== proc) return; // stale generation
        noteFailure(generation, `spawn failed: ${error.code ?? error.message} (${command})`, null);
      });
      proc.on("exit", (code, signal) => {
        logStream.close();
        // A stale generation's late exit must neither count toward the
        // crash-loop budget nor cancel the CURRENT child's deadline timer.
        if (state.proc !== proc) return;
        clearTimeout(state.deadlineTimer);
        if (this.#stopping) return; // group stop
        if (!generation.readied) {
          noteFailure(generation, `exited code=${code ?? "null"} signal=${signal ?? "null"}`, code);
          return;
        }
        journalChildState(this.paths, name, {
          pid: null,
          lastExitCode: code,
          restarts: (readJson(stateFile(this.paths, name))?.restarts ?? 0) + 1,
          lastError: `exited code=${code} signal=${signal}`,
        });
        const backoffSeconds = Math.round(Math.min(2 ** state.attempt, 30) * this.#options.backoffScale);
        log(
          this.paths,
          name,
          `exited (code=${code ?? "null"} signal=${signal ?? "null"}) — restarting in ${backoffSeconds}s (automatic restart)`,
        );
        const timer = setTimeout(startChild, backoffSeconds * 1000);
        state.timer = timer;
      });
      if (ready) {
        ready(name, proc, () => {
          clearTimeout(state.deadlineTimer);
          if (!state.ready) {
            state.ready = true;
            generation.readied = true;
            state.attempt = 0;
            state.failedStarts = 0; // a ready start resets the crash-loop streak
            this.journalReady(name);
            onReady?.(name);
          }
        });
        const deadline = readinessTimeoutMs ?? (name === "hub" ? DEFAULT_READINESS_TIMEOUT_MS : null);
        if (deadline) {
          state.deadlineTimer = setTimeout(() => {
            if (state.proc !== proc || this.#stopping || this.#fallback) return;
            if (!state.ready && !generation.counted) {
              log(this.paths, name, `reached the ${Math.round(deadline / 1000)}s readiness deadline without reporting ready`);
              noteFailure(
                generation,
                `readiness deadline exceeded (${Math.round(deadline / 1000)}s without a passing ready probe)`,
              );
              try {
                proc.kill("SIGTERM");
              } catch {
                /* already gone */
              }
            }
          }, deadline);
        }
      }
    };
    startChild();
  }

  /**
   * The restart budget is exhausted: stop the whole process group into the
   * named fallback state. The supervisor process itself STAYS ALIVE —
   * under launchd KeepAlive an exited supervisor would be respawned into
   * the same crash-loop, thrashing forever; an idle-but-live supervisor is
   * the stable, nameable state an owner can diagnose away.
   */
  #declareFallback(childName, lastError, state) {
    if (this.#fallback) return;
    const fallback = {
      state: "crash-loop-fallback",
      child: childName,
      failedAttempts: state.failedStarts,
      lastError,
      log: logsPath(this.paths, childName),
      stoppedAt: new Date().toISOString(),
      supervisorPid: process.pid,
    };
    this.#fallback = fallback;
    log(
      this.paths,
      childName,
      `crash-loop exhausted (${state.failedStarts} failed starts without readiness) — stopping the process group into the named fallback state: ${fallback.stoppedAt}`,
    );
    void this.stop().then(() => {
      writeJson(fallbackStateFile(this.paths), fallback);
    });
  }

  journalFailure(name, message) {
    journalChildState(this.paths, name, { lastError: message });
  }

  journalReady(name) {
    journalChildState(this.paths, name, { running: true });
  }

  async stop() {
    this.#stopping = true;
    for (const [name, state] of this.#children) {
      clearTimeout(state.timer);
      const proc = state.proc;
      if (proc && proc.exitCode == null && proc.signalCode == null && !proc.killed) {
        log(this.paths, name, `stopping pid ${proc.pid}`);
        proc.kill("SIGTERM");
      }
    }
    for (const [name, state] of this.#children) {
      const proc = state.proc;
      // Liveness from the child handle, never from the OS pid: a recycled
      // pid must not make us signal an unrelated process.
      const alive = proc && proc.exitCode == null && proc.signalCode == null && !proc.killed;
      if (alive) {
        await new Promise((resolveKill) => {
          const forceTimer = setTimeout(() => {
            proc.kill("SIGKILL");
          }, 4000);
          proc.once("exit", () => {
            clearTimeout(forceTimer);
            clearStateFile(this.paths, name);
            resolveKill();
          });
          proc.kill("SIGTERM");
        });
      } else {
        clearTimeout(state.timer);
        clearStateFile(this.paths, name);
      }
    }
  }
}

// One shared append stream per log path so restarts don't leak fds.
const LOG_STREAMS = new Map();
function appendFileStream(path) {
  mkdirSync(dirname(path), { recursive: true });
  const existing = LOG_STREAMS.get(path);
  if (!existing || existing.writableEnded) {
    const stream = createWriteStream(path, { flags: "a" });
    LOG_STREAMS.set(path, stream);
    return stream;
  }
  return existing;
}

export function supervisorRunningState(paths) {
  return readState(paths, "supervisor");
}

/** The named crash-loop fallback state written at give-up (or null). */
export function hubFallbackState(paths) {
  return readJson(fallbackStateFile(paths));
}

/** Clear the fallback state (an owner-run stop/start is a fresh cycle). */
export function clearHubFallbackState(paths) {
  rmSync(fallbackStateFile(paths), { force: true });
}

/**
 * Readiness probe for the hub child: polls the loopback health surface and
 * signals ready on the first passing health check (status ok + daemons ok).
 * Gives up silently at the supervisor's readiness deadline (the deadline
 * then kills the child and counts the failed start).
 */
export function hubReadyProbe(config) {
  const base = `http://127.0.0.1:${config.hub.httpPort}`;
  return async (name, proc, signalReady) => {
    for (;;) {
      try {
        const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (health.status === 200) {
          const body = await health.json();
          if (body?.status === "ok") {
            signalReady(name);
            return;
          }
        }
      } catch {
        /* not healthy yet — keep polling until the deadline */
      }
      if (proc.exitCode != null) return; // failed to start; supervisor restarts
      await new Promise((wait) => setTimeout(wait, 500));
    }
  };
}

export function writeSupervisorState(paths, extra = {}) {
  writeJson(stateFile(paths, "supervisor"), { pid: process.pid, startedAt: new Date().toISOString(), ...extra });
}

/**
 * A supervisor killed outright (SIGKILL/crash) leaves orphaned children with
 * port bindings — without this reclaim a restarted supervisor would loop on
 * "address already in use". Reclaim = kill journaled children whose command
 * line still belongs to THIS porchlight home, then clear the pidfiles.
 */
export function reclaimStaleChildren(paths) {
  const names = ["mongo", "redis", "hub", "tunnel"];
  for (const name of names) {
    const previous = readJson(stateFile(paths, name));
    if (!previous?.pid) continue;
    if (isOurPid(previous.pid, paths.root)) {
      try {
        process.kill(previous.pid, "SIGKILL");
      } catch {
        /* died between the checks */
      }
    }
    clearStateFile(paths, name);
  }
}

export function readChildStateByPaths(paths, name) {
  return readJson(stateFile(paths, name));
}

export function configFromPathsOrThrow(paths) {
  const config = loadConfig(paths.root);
  if (!config) {
    throw new Error(`no porchlight runtime config at ${paths.root} — run \`porchlight setup\` first`);
  }
  return config;
}

export function assertBinary(paths, name) {
  const bin = join(paths.bin, name, process.platform === "win32" ? `${name}.exe` : name);
  if (!existsSync(bin)) {
    throw new Error(`${name} binary missing under ${paths.bin} — re-run \`porchlight setup\``);
  }
  return bin;
}