// `porchlight stop` — stop the hub process group. Sends SIGTERM to the
// running supervisor (which stops and journals its children); when the
// supervisor is not running, clears stale state files so the next start is
// clean.
import { supervisorRunningState, clearHubFallbackState } from "./supervisor.mjs";
import { clearStateFile, home } from "./state.mjs";

const SIGNALS = ["SIGTERM", "SIGTERM", "SIGKILL"];

export async function run(args = {}) {
  const paths = home({ PORCHLIGHT_HOME: args.home ?? process.env.PORCHLIGHT_HOME });
  const running = supervisorRunningState(paths);
  if (!running) {
    process.stdout.write("porchlight is not running.\n");
    clearStateFile(paths, "supervisor");
    clearStateFile(paths, "tunnel");
    clearHubFallbackState(paths);
    return;
  }
  const pid = running.pid;
  for (const signal of SIGNALS) {
    process.kill(pid, signal);
    await new Promise((wait) => setTimeout(wait, 1200));
    if (!isAlive(pid)) break;
  }
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  clearStateFile(paths, "supervisor");
  clearStateFile(paths, "tunnel");
  clearHubFallbackState(paths);
  process.stdout.write("porchlight stopped.\n");
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}