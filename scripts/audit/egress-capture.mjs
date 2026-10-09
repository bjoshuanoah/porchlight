// Egress capture — runtime companion to scripts/audit/egress-audit.mjs (PORCH-015 ac-1).
// Runs a command (the representative-traffic run, typically the bring-up e2e)
// under two app-level instruments and fails when an app-level destination
// falls outside the documented egress classes:
//
//   1. DNS-name ledger (primary, app-level by construction): every node
//      process in the tree loads scripts/audit/egress-preload.mjs via
//      NODE_OPTIONS (inherited by node children), which records each outbound
//      connection ATTEMPT with its hostname. OS-layer traffic (NTP, mDNS) is
//      not node application code and never enters the ledger.
//   2. Socket corroboration: per-second lsof samples of the tree's binary
//      children — cloudflared (tunnel-egress) and the local daemons mongod /
//      redis-server (hub-internal loopback; any non-loopback remote fails).
//
// Reproduce:  node scripts/audit/egress-capture.mjs --out capture.json \
//               -- <wrapped command> <args...>
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const preloadPath = join(repoRoot, "scripts/audit/egress-preload.mjs");

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
const cmdIdx = args.indexOf("--");
if (cmdIdx < 0 || cmdIdx + 1 >= args.length) {
  console.error("usage: node egress-capture.mjs [--out capture.json] -- <command> [args...]");
  process.exit(2);
}
const command = args.slice(cmdIdx + 1);

const LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\]|::1)/;
const HUB_HOSTNAMES = [
  { class: "installer-binary-downloads", re: /pkg-containers\.githubusercontent\.com$/ },
  { class: "owner-run-release-verify|installer-binary-downloads", re: /(?:^|\.)github\.com$|release-assets\.githubusercontent\.com$/i },
  { class: "owner-run-release-verify", re: /(?:^|\.)npmjs\.org$|(?:^|\.)npmjs\.com$/ },
  { class: "owner-run-release-verify", re: /sigstore\.dev$|rekor|fulcio/i },
  { class: "installer-binary-downloads", re: /(?:^|\.)mongodb\.(?:com|net|org)$|fastdl\.mongodb\./ },
  { class: "installer-binary-downloads", re: /(?:^|\.)ghcr\.io$|(?:^|\.)brew\.sh$/ },
];

function classifyHostname(host) {
  if (LOOPBACK.test(host)) return "hub-internal loopback";
  for (const rule of HUB_HOSTNAMES) if (rule.re.test(host)) return rule.class;
  return null; // UNEXPECTED — must be justified in the launch report
}

async function readLedger(logPath) {
  const text = await readFile(logPath, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

const { execFile } = await import("node:child_process");
async function treeRows() {
  const ps = await new Promise((resolve) =>
    execFile("ps", ["-axo", "pid=,ppid=,command="], { timeout: 5000 }, (e, stdout) => resolve(e ? [] : stdout.split("\n"))),
  );
  return ps.map((line) => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return m ? { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] } : null;
  }).filter(Boolean);
}

function lsofRows() {
  return new Promise((resolve) =>
    execFile("lsof", ["-n", "-P", "-i"], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (e, stdout) => {
      if (e) return resolve([]);
      const rows = [];
      for (const line of stdout.split("\n")) {
        const m = line.match(/^(.+?)\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(?:TCP|UDP)\s+(\S+)/);
        if (m) rows.push({ pid: Number(m[2]), cmd: m[1], addr: m[3] });
      }
      resolve(rows);
    }),
  );
}

const tmp = await mkdtemp(join(tmpdir(), "porchlight-egress-"));
const logPath = join(tmp, "egress.jsonl");

const child = spawn(command[0], command.slice(1), {
  stdio: "inherit",
  env: {
    ...process.env,
    PORCHLIGHT_EGRESS_LOG: logPath,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${preloadPath}`,
  },
});
const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c ?? 1)));

// Corroborate binary children while sockets are still open — sample during
// the run; sockets close at exit. pid→command mapping resolved from ps rows
// captured in the same interval.
const treeSamples = []; // [{ rows, sockets }] — collected per interval
const sampler = (async () => {
  while (child.exitCode === null && child.signalCode === null) {
    const [psRows, socketRows] = await Promise.all([treeRows(), lsofRows()]);
    treeSamples.push({ rows: psRows, sockets: socketRows });
    await new Promise((wait) => setTimeout(wait, 500));
  }
})();
await sampler.catch(() => {});

const cmdByPid = new Map();
for (const sample of treeSamples) {
  for (const row of sample.rows) if (!cmdByPid.has(row.pid)) cmdByPid.set(row.pid, row.command);
}
const inTree = new Set(
  treeSamples.flatMap((sample) => {
    const byId = new Map(sample.rows.map((r) => [r.pid, r]));
    const found = new Set();
    for (const row of sample.rows) {
      let cursor = row;
      while (cursor) {
        if (cursor.pid === child.pid) { found.add(row.pid); break; }
        cursor = byId.get(cursor.ppid);
      }
    }
    return [...found];
  }),
);
const sockets = [];
for (const sample of treeSamples) {
  for (const sock of sample.sockets) {
    if (!inTree.has(sock.pid)) continue;
    const addr = sock.addr;
    if (!addr.includes("->")) continue;
    const cmd = sock.cmd ?? (inTree.has(sock.pid) ? String(cmdByPid.get(sock.pid) ?? "").split(" ")[0] : "");
    const remote = addr.split("->").pop();
    if (cmd === "cloudflared") sockets.push({ cmd, remote, class: "tunnel-egress" });
    else if (cmd === "mongod" || cmd === "redis-server") {
      sockets.push({
        cmd,
        remote,
        class: LOOPBACK.test(remote.split(":")[0]) ? "hub-internal loopback" : "UNEXPECTED-non-loopback-daemon-socket",
      });
    } else if (/node|porchlight/.test(cmd)) continue; // app-level ledger covers node processes
    else sockets.push({ cmd, remote, class: "UNEXPECTED-tree-process" });
  }
}

const ledger = await readLedger(logPath);
const byHost = new Map();
const unexpected = [];
for (const entry of ledger) {
  const cls = classifyHostname(String(entry.host));
  byHost.set(entry.host, (byHost.get(entry.host) ?? 0) + 1);
  if (!cls) {
    unexpected.push({ source: "hostname-ledger", pid: entry.pid, host: entry.host, port: entry.port, what: entry.what });
    continue;
  }
  byHost.set(`__class__:${entry.host}`, cls);
}
const unexpectedSockets = sockets.filter((sock) => typeof sock.class !== "string" || sock.class.startsWith("UNEXPECTED"));

const report = {
  method: [
    "hostname-level app-egress ledger: every node process runs scripts/audit/egress-preload.mjs (NODE_OPTIONS --require, inherited by children) recording each outbound attempt's hostname; OS-layer traffic (NTP, mDNS) is not node application code and cannot enter the ledger",
    "socket corroboration: lsof samples of the wrapped command's process tree; cloudflared → tunnel-egress; mongod/redis-server → hub-internal loopback only; node processes are covered by the ledger",
  ],
  command,
  hostLedger: Object.fromEntries([...byHost.entries()].filter(([k]) => !k.startsWith("__class__:")).map(([k, v]) => [k, { count: v, class: byHost.get(`__class__:${k}`) ?? "UNEXPECTED" }])),
  binaryChildren: sockets,
  unexpected: [...unexpected, ...unexpectedSockets],
};
if (outPath) await writeFile(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(unexpected.length || unexpectedSockets.length ? 1 : code);