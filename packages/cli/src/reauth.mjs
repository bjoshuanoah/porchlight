// `porchlight reauth` — the CLI half of the address-change owner re-auth
// unlock (PORCH-065). The zero-session escape hatch for when no console
// session exists at any origin the hub serves.
//
//   porchlight reauth link    mint the owner's device grant, print the
//                             consume URL (the hub's serving origin + code)
//   porchlight reauth status  the serving origin, the last re-point, and
//                             any residue lines (diagnostics only)
//
// The mint is a machine-local, operator-authenticated act: it speaks to the
// hub's LOCAL listener only — never the tunnel URL, which may already be the
// new host or a dead old origin mid-move — with the same 0600 ops token the
// update surface carries. The mint re-points nothing; the re-point fires
// when the owner consumes the grant (grant consumption is owner action).
// No member data is touched, no join link is issued, no settings change:
// one grant per invocation is the entire surface.
import { join } from "node:path";
import { readJson } from "./state.mjs";
import { loadHomeConfig, hubBases } from "./httpx.mjs";

const REAUTH_LINK_PATH = "/api/reauth/link";
const REAUTH_STATUS_PATH = "/api/reauth/status";
const USAGE = "usage: porchlight reauth link | porchlight reauth status";

/** The machine-local ops token the hub minted for its own CLI (0600 file). */
function opsToken(paths) {
  const row = readJson(join(paths.state, "ops-token.json"));
  return row?.token ?? null;
}

/**
 * The local listener base — machine-local by construction. The tunnel URL
 * is deliberately absent: mid-move it may be an old or not-yet-serving
 * address, and the mint must never depend on network access to any of them.
 */
function localBase(config) {
  return `http://127.0.0.1:${config.hub.httpPort}`;
}

async function hubLocalJson(config, path, init = {}) {
  const base = localBase(config);
  const response = await fetch(new URL(path, base), init);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    throw new Error(`non-JSON response from the hub (HTTP ${response.status})`);
  }
  return { status: response.status, body: await response.json() };
}

function localHeaders(paths) {
  const token = opsToken(paths);
  return { "content-type": "application/json", ...(token ? { "x-porchlight-ops-token": token } : {}) };
}

async function mintLink({ paths, config, impl, fail, write }) {
  let minted;
  try {
    minted = impl.fetch
      ? await impl.fetch(config, REAUTH_LINK_PATH, { method: "POST", headers: localHeaders(paths) })
      : await hubLocalJson(config, REAUTH_LINK_PATH, { method: "POST", headers: localHeaders(paths) });
  } catch (error) {
    fail([
      `the hub is not reachable on this machine (${error.message}). The reauth grant binds to the hub's live serving state, ` +
        `so start the hub first (porchlight start) and run this again. Nothing was minted or changed.`,
    ]);
    return;
  }
  if (minted.status === 401) {
    fail([
      "the hub refused this command — no machine ops token. Run it on the hub's own machine; " +
        `ops token file: ${join(paths.state, "ops-token.json")}`,
    ]);
    return;
  }
  if (minted.status !== 201) {
    fail([minted.body?.error ?? "the hub refused the mint — nothing was minted or changed."]);
    return;
  }
  const expiry = new Date(minted.body.expiresAt);
  const expires = Number.isNaN(expiry.getTime()) ? minted.body.expiresAt : expiry.toISOString().replace("T", " ").replace(/\..+$/, "Z");
  write(`owner re-auth grant minted (grant ${minted.body.grantId}).\n`);
  write(`\nOpen this link in any browser and the device binds itself to the owner identity:\n\n  ${minted.body.linkUrl}\n\n`);
  write(`The grant is single-use and expires ${expires}. One link per invocation, nothing else touched.\n`);
  write("If it leaks or expires, re-running `porchlight reauth link` mints a fresh grant (the old one stays harmless or dies on its own).\n");
  write(`The device re-auth fires the address re-point from the hub's serving state (currently ${minted.body.base}).\n`);
}

async function showStatus({ paths, config, impl, fail, write }) {
  let status;
  try {
    status = impl.fetch
      ? await impl.fetch(config, REAUTH_STATUS_PATH, { headers: localHeaders(paths) })
      : await hubLocalJson(config, REAUTH_STATUS_PATH, { headers: localHeaders(paths) });
  } catch (error) {
    fail([`the hub is not reachable on this machine (${error.message}). No live status — the hub may be stopped.`]);
    return;
  }
  if (status.status === 401) {
    fail(["the hub refused this command — no machine ops token: " + `ops token file: ${join(paths.state, "ops-token.json")}`]);
    return;
  }
  if (status.status !== 200) {
    fail([status.body?.error ?? "the hub could not report its status."]);
    return;
  }
  const report = status.body;
  const last = report.lastRepoint;
  write(`serving origin: ${report.servingOrigin ?? "(none recorded — the tunnel is not bound)"}\n`);
  if (last) {
    write(`last re-point:  ${last.origin} at ${last.at} (${last.surface})\n`);
  } else {
    write("last re-point:  none recorded\n");
  }
  const residues = report.residue ?? [];
  if (residues.length === 0) {
    write("residue:        none — every hub-held self-reference carries the current origin\n");
  } else {
    write(`residue:        ${residues.length} hub-held self-reference(s) still carrying a prior origin:\n`);
    for (const residue of residues) {
      write(`  - ${residue.kind} ${residue.ref} → ${residue.endpoint ?? "(none)"}\n`);
    }
    write("residue lines are diagnostics; re-running the address action re-points them.\n");
  }
}

export async function run(args = {}, impl = {}) {
  const write = impl.write ?? ((line) => process.stdout.write(line));
  const fail = (lines) => {
    for (const line of lines) write(`porchlight reauth: ${line}\n`);
    process.exitCode = 1;
  };

  const [subcommand = ""] = args._ ?? [];
  if (subcommand !== "link" && subcommand !== "status") {
    fail([`unknown reauth command: ${subcommand || "(none)"} — ${USAGE}`]);
    return;
  }

  let paths;
  let config;
  try {
    ({ paths, config } = loadHomeConfig(args));
  } catch (error) {
    fail([error.message]);
    return;
  }
  const hubBasesChecked = hubBases(config);
  const local = hubBasesChecked[hubBasesChecked.length - 1];
  if (!local) {
    fail(["no local hub listener is configured — run `porchlight setup` first."]);
    return;
  }

  if (subcommand === "link") {
    await mintLink({ paths, config, impl, fail, write });
    return;
  }
  await showStatus({ paths, config, impl, fail, write });
}

export default run;