// `porchlight update` — the CLI half of the two owner-initiated update
// surfaces (PORCH-040). Running the command IS the owner action: it drives
// the hub's ONE shared update service over HTTP — the same npm-backed path
// the owner console's update button uses — then waits for the hub to come
// back healthy after the supervised restart. Nothing runs on a timer and the
// hub is never touched when the owner does not run this command. Already-
// latest is a version statement only; a failed apply changes nothing and the
// prior release keeps serving.
import { join } from "node:path";
import { readJson } from "./state.mjs";
import { loadHomeConfig, hubJson, hubUrl } from "./httpx.mjs";

const UPDATE_PATH = "/api/social/console/update";
const HEALTH_PATH = "/api/health";

/** The machine-local ops token the hub minted for its own CLI (0600 file). */
function opsToken(paths) {
  const row = readJson(join(paths.state, "ops-token.json"));
  return row?.token ?? null;
}

export async function run(args = {}, impl = {}) {
  const write = impl.write ?? ((line) => process.stdout.write(line));
  const delay = impl.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const waitMs = impl.waitMs ?? 150_000;
  const fail = (lines) => {
    for (const line of lines) write(`porchlight update: ${line}\n`);
    process.exitCode = 1;
  };

  let paths;
  let config;
  try {
    ({ paths, config } = loadHomeConfig(args));
  } catch (error) {
    fail([error.message]);
    return;
  }
  const headers = (() => {
    const token = opsToken(paths);
    return token ? { "x-porchlight-ops-token": token } : {};
  })();

  let check;
  try {
    const response = impl.fetchStatus
      ? await impl.fetchStatus(config, headers)
      : await hubJson(config, UPDATE_PATH, { headers });
    if (response.status === 401 || response.status === 403) {
      fail([
        "the hub refused this command — no owner session and no machine ops token. " +
          `If this was run on another machine, open the owner console instead; ops token file: ${join(paths.state, "ops-token.json")}`,
      ]);
      return;
    }
    check = response.body;
  } catch (error) {
    fail([
      `the hub is unreachable (${error.message}). porchlight update applies updates through the running hub, ` +
        "so nothing was checked or changed. If an earlier update failed to start, run `porchlight status` — " +
        "a named fallback state names the failure and the recovery there.",
    ]);
    return;
  }

  const release = check?.release ?? {};
  if (release.latest == null) {
    write(`current release: v${release.current ?? "unknown"}\n`);
    fail([release.note ?? "the npm registry could not be reached — nothing was checked further"]);
    return;
  }
  if (!release.updateAvailable) {
    write(`porchlight v${release.current} is the latest release — nothing to do.\n`);
    return;
  }

  write(`current release: v${release.current}\n`);
  write(`latest release:  v${release.latest} (npm registry)\n`);
  write("applying the update through the hub's update service...\n");

  let applied;
  try {
    const response = impl.fetchApply
      ? await impl.fetchApply(config, headers)
      : await hubJson(config, UPDATE_PATH, {
          headers: { ...headers, "content-type": "application/json" },
          method: "POST",
          body: JSON.stringify({}),
        });
    if (response.status === 401 || response.status === 403) {
      fail(["the hub refused this command — no owner session and no machine ops token."]);
      return;
    }
    applied = response.body;
  } catch (error) {
    fail([`the apply request itself failed (${error.message}) — nothing is known changed`]);
    return;
  }

  if (applied?.status === "failed") {
    fail([applied.error ?? "the update could not be applied"]);
    return;
  }
  if (applied?.status === "latest") {
    write(`porchlight v${applied.release?.current ?? release.current} is the latest release — nothing to do.\n`);
    return;
  }

  const from = applied?.release?.from ?? release.current;
  const to = applied?.release?.to ?? release.latest;
  write(`update installed — the hub is restarting (v${from} → v${to})...\n`);

  const cameBack = await (impl.waitForHub ??
    ((deadline) => waitUntilHealthy(config, deadline, delay)))(waitMs);
  if (!cameBack) {
    fail([
      `the hub has not come back healthy within ${Math.round(waitMs / 1000)}s of the restart. ` +
        "It may still be starting, or the new release may not reach readiness — run `porchlight status`, " +
        "which names any fallback state and its recovery.",
    ]);
    return;
  }
  write(`porchlight updated: v${from} → v${to} — the hub is serving again at ${hubUrl(config)}\n`);
}

/**
 * Poll the hub's health surface (no credentials, no tunnel dependency beyond
 * the CLI's own base resolution) until the restarted release answers. The
 * supervisor's readiness deadline is 90s; the wait is the apply-side mirror
 * of that budget, ending in a plain-language report either way.
 */
async function waitUntilHealthy(config, deadlineMs, delay) {
  const startedAt = Date.now();
  for (;;) {
    await delay(2000);
    try {
      const response = await hubJson(config, HEALTH_PATH);
      if (response.status === 200) return true;
    } catch {
      // still restarting
    }
    if (Date.now() - startedAt >= deadlineMs) return false;
  }
}