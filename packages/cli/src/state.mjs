// Porchlight home layout + durable state helpers. The home directory is the
// installer-managed state root: config.json (runtime config, phase
// configuration — never forks), bin/ (daemon + tunnel binaries), data/
// (mongod/redis data), state/ (supervisor + pidfiles + tunnel), logs/.
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
import { join } from "node:path";
import { homePaths } from "@porchlight/shared";

export function home(env = process.env) {
  return homePaths(env);
}

export function ensureDirs(paths) {
  for (const dir of [paths.root, paths.bin, paths.state, paths.pidfiles, paths.logs, paths.mongoData, paths.redisData]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { __corrupt: true, error: error.message };
  }
}

export function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function stateFile(paths, name) {
  return join(paths.pidfiles, `${name}.json`);
}

export function clearStateFile(paths, name) {
  rmSync(stateFile(paths, name), { force: true });
}

export function logsPath(paths, name) {
  return join(paths.logs, `${name}.log`);
}

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function pidCommand(pid) {
  try {
    const { execFileSync } = require("node:child_process");
    return execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** A journaled pid is only "ours" while a porchlight process still owns it. */
export function isOurPid(pid, homeRoot) {
  if (!isPidAlive(pid)) return false;
  const command = pidCommand(pid);
  // The supervisor's own spawn always carries --home; hub children carry an
  // explicit marker arg; both contain "porchlight" somewhere in argv.
  return command.includes("porchlight") || (homeRoot ? command.includes(homeRoot) : false);
}

export function readState(paths, name) {
  const state = readJson(stateFile(paths, name));
  if (!state) return null;
  if (state.__corrupt) return state;
  return isOurPid(state.pid, paths.root) ? state : null;
}