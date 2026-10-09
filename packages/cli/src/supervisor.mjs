// Supervisor: owns the hub's single user-managed process group (Porchlight
// Server TS 2) — mongod, redis-server, the hub server, and the tunnel child.
// Children restart automatically with capped exponential backoff; every
// spawn, restart, and failure is journaled to the daemon state files and the
// home logs (local-only diagnostics, zero phone-home).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@porchlight/shared";
import { clearStateFile, isOurPid, logsPath, readJson, readState, stateFile, writeJson } from "./state.mjs";

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

  constructor(paths, config) {
    this.paths = paths;
    this.config = config;
  }

  spawnChild(name, command, args, { ready, onReady } = {}) {
    const state = { attempt: 0, ready: false, proc: null, timer: null };
    this.#children.set(name, state);

    const startChild = () => {
      if (this.#stopping) return;
      const logStream = appendFileStream(logsPath(this.paths, name));
      const proc = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PORCHLIGHT_HOME: this.paths.root },
      });
      state.proc = proc;
      state.ready = false;
      log(this.paths, name, `pid ${proc.pid} spawn ${command} (attempt ${state.attempt + 1})`);
      journalChildState(this.paths, name, {
        pid: proc.pid,
        startedAt: new Date().toISOString(),
        lastError: null,
      });
      proc.stdout?.pipe(logStream);
      proc.stderr?.pipe(logStream);
      if (ready) {
        ready(name, proc, () => {
          if (!state.ready) {
            state.ready = true;
            state.attempt = 0;
            onReady?.(name);
          }
        });
      }
      proc.on("exit", (code, signal) => {
        logStream.close();
        if (this.#stopping) return;
        state.attempt += 1;
        const backoffSeconds = Math.min(2 ** state.attempt, 30);
        log(
          this.paths,
          name,
          `exited (code=${code ?? "null"} signal=${signal ?? "null"}) — restarting in ${backoffSeconds}s (automatic restart)`,
        );
        journalChildState(this.paths, name, {
          pid: null,
          lastExitCode: code,
          restarts: (readJson(stateFile(this.paths, name))?.restarts ?? 0) + 1,
          lastError: `exited code=${code} signal=${signal}`,
        });
        const timer = setTimeout(startChild, backoffSeconds * 1000);
        state.timer = timer;
      });
    };
    startChild();
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