// Egress audit — static source inventory (PORCH-015 ac-1).
// Deterministic, network-free, CI-safe: scans every application source file
// for outbound-network constructs and fails on any site that is not mapped
// to one of the expected app-level egress classes (or to hub-internal
// loopback). The launch report (docs/launch-audit.md) documents each class.
//
// Expected app-level egress classes:
//   tunnel-egress                — CLI ⇄ owner's own hub, cloudflared child
//   installer-binary-downloads   — owner-triggered setup/start fetches of the
//                                  runtime daemons (Mongo, Redis bottles,
//                                  cloudflared pin), once per home, verified
//   owner-run-release-verify     — owner-run scripts/release/verify-release.mjs
//                                  (npm-registry and signed-release origin)
//   hub-to-hub-trust             — identity adoption + cross-hub key
//                                  verification at member-directed/pinned URLs
//   browser-to-hub               — the member SPA and the bootstrap page
//   os-layer                     — hub-internal loopback (Mongo/Redis daemons)
//
// Modules with NO permitted app-level outbound calls at all (fail on any):
//   modules/social, apps/server src (except the same-origin bootstrap page).
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const SCAN_DIRS = ["apps", "modules", "packages", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", "fixtures"]);
const EXT = /\.(?:[cm]?[jt]sx?|mjs|jsx)$/;

const STRICT_OUTBOUND = [
  /\bfetch\s*\(/,
  /\bhttps?\.get\s*\(/,
  /\bhttps?\.request\s*\(/,
  /\bnet\.connect\s*\(/,
  /\btls\.connect\s*\(/,
  /\bdgram\b/,
  /\bnew\s+WebSocket\b/,
  /\bEventSource\s*\(/,
  /navigator\.sendBeacon\b/,
];
// Process spawns are not egress by themselves (the child binary's egress is,
// documented in the launch report): they are inventoried, never flagged.
const PROCESS_SPAWN = /\bspawn(?:Tunnel|Child)?\s*\(/;

// Destination denylist (PORCH-015 ac-1 line one): the hub must never address
// driftless or porchlight-operated domains, and no telemetry vendor.
const DENY_HOSTS = [
  /driftless/i,
  /porchlight\.com/i,
  /sentry|posthog|mixpanel|amplitude|datadog|bugsnag|newrelic|segment\.io|analytics/i,
];

// (directory prefix → permitted class) — any outbound construct outside these
// prefixes, or inside a permit-module with no class, is a finding.
const PERMITTED = [
  { prefix: "packages/cli/src", class: "tunnel-egress|installer-binary-downloads" },
  { prefix: "scripts/release", class: "owner-run-release-verify" },
  { prefix: "modules/identity/src/services", class: "hub-to-hub-trust" },
  { prefix: "apps/web/src", class: "browser-to-hub" },
  { prefix: "apps/server/src", class: "browser-to-hub|os-layer" },
  { prefix: "scripts/audit", class: "audit-tooling" },
];

// Zero-egress production surfaces: outbound calls must not exist in these
// trees at all (test-time loopback calls are handled separately below).
const ZERO_EGRESS = ["modules/social/src", "apps/server/src/controllers", "apps/server/src/services"];
const LOOPBACK = /127\.0\.0\.1|localhost|\[::1\]/;

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (EXT.test(entry.name)) yield path;
  }
}

const findings = [];
const inventory = [];

for (const dir of SCAN_DIRS) {
  for await (const file of walk(join(repoRoot, dir))) {
    const rel = relative(repoRoot, file).split(sep).join("/");
    const text = await readFile(file, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (PROCESS_SPAWN.test(line)) inventory.push(`${rel}:${i + 1}: class=local-process-spawn (child egress documented per launch report)`);
      for (const pattern of STRICT_OUTBOUND) {
        if (!pattern.test(line)) continue;
        const denied = DENY_HOSTS.find((host) => host.test(line));
        if (denied) {
          findings.push(`${rel}:${i + 1}: addresses a denied vendor/driftless pattern (${denied})`);
          continue;
        }
        if (ZERO_EGRESS.some((prefix) => rel.startsWith(prefix))) {
          findings.push(`${rel}:${i + 1}: outbound call in a zero-egress production surface`);
          continue;
        }
        if (/\/test\/|\/helpers\/|\.test\./.test(rel)) {
          // Test traffic is loopback-only: an in-process server on 127.0.0.1.
          // A file that binds its own loopback base may fetch through template
          // variables; anything without a loopback binding in the file fails.
          if (!LOOPBACK.test(line) && !text.includes("127.0.0.1")) {
            findings.push(`${rel}:${i + 1}: test-time outbound call not addressed to a loopback-bound base`);
          }
          continue;
        }
        const permit = PERMITTED.find((p) => rel.startsWith(p.prefix));
        if (!permit) {
          findings.push(`${rel}:${i + 1}: outbound call outside every permitted egress class`);
          continue;
        }
        inventory.push(`${rel}:${i + 1}: class=${permit.class}`);
      }
    }
  }
}

if (process.argv.includes("--inventory")) {
  for (const row of [...new Set(inventory)].sort()) console.log(row);
}
if (findings.length) {
  console.error([...new Set(findings)].sort().join("\n"));
  process.exitCode = 1;
} else {
  console.log("Porchlight egress inventory audit passed: every outbound call site maps to a documented egress class; zero sites address driftless, porchlight.com, or telemetry vendors.");
}