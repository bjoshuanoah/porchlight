// Resume-parity unit tests for `porchlight bootstrap` (PORCH-021): the
// driver's resume classification runs against the ledger state the hub
// serves at /api/bootstrap/state — the same stored state the web setup
// wizard's stage derivation reads. Deterministic: a stub hub holds the
// ledger and answers the same endpoints the real hub does; no daemons,
// no network, no prompts (the paths are passed as flags). The stub lives
// in the test process, so the driver is spawned asynchronously — a
// synchronous spawn would block this loop and deadlock the stub.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { saveConfig } from "@porchlight/shared";

const BIN = fileURLToPath(new URL("../bin/porchlight.mjs", import.meta.url));

/**
 * Stub hub: one ledger, one client-visible account row. GET /state answers
 * exactly what the real system route answers (resumable, lastError, steps,
 * diagnostics, config); the POST endpoints record completed steps into the
 * ledger the next GET serves — mirroring the hub's ledger.record path.
 */
function stubHub(t, ledger, state = {}) {
  const postCalls = [];
  const server = http.createServer((req, res) => {
    const done = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/api/bootstrap/state") {
        const statuses = [ledger.account, ledger.network].map((entry) => entry.status);
        const anyComplete = statuses.includes("complete");
        const allComplete = statuses.every((status) => status === "complete");
        return done(200, {
          resumable: anyComplete && !allComplete,
          lastError: state.lastError ?? null,
          steps: { account: ledger.account, network: ledger.network },
          diagnostics: state.diagnostics ?? [],
          config: { mode: {}, quota: {}, hubUrl: null },
        });
      }
      if (req.method === "POST" && req.url === "/api/identity/bootstrap/account") {
        postCalls.push("account");
        if (ledger.account.status === "complete") return done(200, { created: false, account: state.accountRow ?? { did: state.accountDid ?? "did:porch:stub", _id: "ident_stub" } });
        ledger.account = { status: "complete", at: new Date().toISOString(), detail: null };
        state.accountRow = { did: state.accountDid ?? "did:porch:stub", _id: "ident_stub" };
        return done(201, { created: true, account: state.accountRow });
      }
      if (req.method === "GET" && req.url === "/api/identity/account") {
        return done(200, { exists: Boolean(state.accountRow), account: state.accountRow });
      }
      if (req.method === "POST" && req.url === "/api/social/bootstrap/network") {
        postCalls.push("network");
        if (ledger.network.status === "complete") {
          return done(200, { created: false, network: { name: JSON.parse(raw).name } });
        }
        ledger.network = { status: "complete", at: new Date().toISOString(), detail: null };
        const bind = state.ownerBindToken
          ? { ownerBind: { did: state.accountRow?.did ?? state.accountDid ?? "did:porch:stub", token: state.ownerBindToken, expiresAt: "2026-10-10T12:00:00.000Z" } }
          : {};
        return done(201, { created: true, network: { name: JSON.parse(raw).name }, membership: { role: "owner" }, ...bind });
      }
      return done(404, { error: "not found" });
    });
  });
  return new Promise((resolveHub) => server.listen(0, () => resolveHub({
    base: `http://127.0.0.1:${server.address().port}`,
    postCalls,
    close: () => server.close(),
  })));
}

const row = { status: "pending", at: null, detail: null };
const freshLedger = () => ({ account: { ...row }, network: { ...row } });

async function tempHome(t, base) {
  const paths = await mkdtemp(join(tmpdir(), "porchlight-resume-"));
  // The stub hub is the tunnel from the CLI's point of view: hubUrl() then
  // returns the stub base, so the whole drive stays local and deterministic.
  saveConfig(paths, { hub: { tunnel: { url: base } } });
  t.after(() => void rm(paths, { recursive: true, force: true }));
  return paths;
}

/** Run the real CLI driver; answer nothing interactively (args cover it). */
async function drive(t, homeUrl, args = {}) {
  const home = await tempHome(t, homeUrl);
  const child = spawn(
    process.execPath,
    [BIN, "bootstrap", "--home", home, ...Object.entries(args).flatMap(([flag, value]) => [`--${flag}`, String(value)])],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const lines = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => lines.push(...chunk.split("\n")));
  const errors = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => errors.push(chunk));
  const code = await new Promise((resolve, reject) => {
    const keepAlive = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("driver hung for 25s")); }, 25_000);
    child.on("close", (exitCode) => { clearTimeout(keepAlive); resolve(exitCode); });
  });
  assert.equal(code, 0, `driver failed: ${errors.join("")}`);
  return lines.filter(Boolean);
}

test("a fully completed ledger prints both skips and does nothing (PORCH-021)", async (t) => {
  const ledger = freshLedger();
  ledger.account.status = "complete";
  ledger.network.status = "complete";
  const hub = await stubHub(t, ledger);
  const lines = await drive(t, hub.base);
  assert.deepEqual(hub.postCalls, [], "a completed bootstrap must not re-drive any step");
  assert.ok(lines.includes("[skip] account — already complete (bootstrap resumed)"));
  assert.ok(lines.includes("[skip] network — already complete (bootstrap resumed)"));
  assert.ok(lines.some((line) => line.startsWith("bootstrap already complete —")));
  hub.close();
});

test("a partial ledger skips only the completed step and resumes the other", async (t) => {
  const ledger = freshLedger();
  ledger.account.status = "complete";
  const hub = await stubHub(t, ledger);
  const lines = await drive(t, hub.base, { network: "Family" });
  assert.deepEqual(hub.postCalls, ["network"], "the account step stays skipped; only network is driven");
  assert.ok(lines.includes("[skip] account — already complete (bootstrap resumed)"));
  assert.ok(lines.includes('[done] network — "Family" created (or already present)'));
  assert.ok(lines.some((line) => line.startsWith("bootstrap complete —")));
  // the resumed network step still binds the founder: the owner DID comes
  // from the hub account surface, never the (missing) account-step response
  assert.ok(lines.includes("  owner bound to this network (role: owner)"));
  hub.close();
});

test("a fresh ledger prints no skips and drives account then network", async (t) => {
  const hub = await stubHub(t, freshLedger());
  const lines = await drive(t, hub.base, { firstName: "Owner", lastName: "Name", network: "Family" });
  assert.ok(!lines.some((line) => line.includes("[skip]")), "nothing is complete, so nothing may print skip");
  assert.deepEqual(hub.postCalls, ["account", "network"]);
  assert.ok(lines.includes("[done] account — owner account ident_stub created"));
  assert.ok(lines.some((line) => line.startsWith("bootstrap complete —")));
  hub.close();
});

test("a previously failed step warns with its recorded detail, then retries", async (t) => {
  const ledger = freshLedger();
  ledger.account.status = "failed";
  ledger.account.detail = "the owner never finished first-account creation";
  const hub = await stubHub(t, ledger, { lastError: "the owner never finished first-account creation" });
  const lines = await drive(t, hub.base, { firstName: "Owner", lastName: "Name", network: "Family" });
  assert.ok(lines.includes("[warn] account previously failed: the owner never finished first-account creation — retrying (completed steps are kept)"));
  assert.deepEqual(hub.postCalls, ["account", "network"]);
  hub.close();
});
test("a fresh bootstrap prints the labeled one-time owner-bind URL (PORCH-031 ac-1)", async (t) => {
  const hub = await stubHub(t, freshLedger(), { ownerBindToken: "bind-tok-alpha" });
  const lines = await drive(t, hub.base, { firstName: "Owner", lastName: "Name", network: "Family" });
  assert.ok(lines.includes("To open the network on the owner's device, open this one-time link in a browser:"));
  assert.ok(lines.includes(`  ${hub.base}/device-link/bind-tok-alpha`), "the printed URL embeds the grant token under the hub base");
  assert.ok(lines.some((line) => line.includes("It signs the device in — no password, no login form anywhere. It works once and expires in 24 hours.")));
  hub.close();
});

test("a reset hub's fresh bootstrap prints a fresh bind URL, never a stale one (PORCH-031 ac-4)", async (t) => {
  // First bring-up: the original identity's bind URL.
  const first = await stubHub(t, freshLedger(), { ownerBindToken: "tok_first", accountDid: "did:porch:first-owner" });
  const firstLines = await drive(t, first.base, { firstName: "Owner", lastName: "Name", network: "Family" });
  assert.ok(firstLines.includes(`  ${first.base}/device-link/tok_first`));
  first.close();

  // The hub is wiped and re-bootstrapped: fresh ledger, fresh identity, fresh
  // grant — the printed URL comes from THIS run's founder-bound response.
  const second = await stubHub(t, freshLedger(), { ownerBindToken: "tok_second", accountDid: "did:porch:second-owner" });
  const secondLines = await drive(t, second.base, { firstName: "Newer", lastName: "Owner", network: "Family" });
  assert.ok(secondLines.includes(`  ${second.base}/device-link/tok_second`), "the new bootstrap prints its own grant");
  assert.ok(secondLines.every((line) => !line.includes("tok_first")), "no stale link from the prior state survives");
  second.close();
});

test("resumed network creation still hands over a bind URL (PORCH-031 ac-4)", async (t) => {
  // Account complete from a prior run; the resumed network step mints and
  // the run prints exactly that grant.
  const ledger = freshLedger();
  ledger.account.status = "complete";
  const hub = await stubHub(t, ledger, { ownerBindToken: "tok_resumed", accountDid: "did:porch:resumed-owner" });
  const lines = await drive(t, hub.base, { network: "Family" });
  assert.ok(lines.includes(`  ${hub.base}/device-link/tok_resumed`));
  hub.close();
});
