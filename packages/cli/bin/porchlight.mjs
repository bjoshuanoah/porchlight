#!/usr/bin/env node
// porchlight — global CLI (npm is the only install surface, Brian Oct 13, 2026).
// Post-install run shape: the binary runs from PATH immediately after
// `npm install -g porchlight` with no further setup steps (PORCH-002 ac-3).
//
// The CLI is a process/ops surface only: it manages the hub's daemon
// processes and drives the remote bootstrap over HTTP. It performs no domain
// logic and imports no domain models (all domain behavior lives in the
// services the hub server exposes).
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const HELP = `porchlight v${version}

Usage: porchlight <command>

Commands:
  setup        one-time bring-up prep: runtime config, Mongo+Redis+tunnel binaries, dirs
  start        start the hub process group (daemons, server, tunnel) under the supervisor
  stop         stop the hub process group
  status       supervisor/daemon/bootstrap diagnostics (local-only, zero phone-home)
  update       check the npm registry for a newer release and apply it (owner-initiated; restart included)
  bootstrap    drive the remaining bootstrap steps over the hub URL (resumable)
  service      install/uninstall the launchd-class supervisor service (auto-restart on boot/crash)
  tunnel       tunnel identity: status (default) | mint [--hostname <host>] | reset

Options:
  --version, -v  print the version and exit 0
  --help,    -h  print this help and exit 0
  --home <dir>   override the porchlight home directory (PORCHLIGHT_HOME)

Called with no arguments it prints this help and exits 0 — the post-install
"binary runs" check. The owner's first-run flow is: porchlight setup, then
porchlight start (bootstrap prompts work from any device over the tunnel).

License: MIT — https://github.com/bjoshuanoah/porchlight/blob/main/LICENSE`;

const flags = (argv) => {
  const out = { _: [], home: void 0, foreground: false, tunnel: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--home") out.home = argv[++i];
    else if (arg === "--foreground") out.foreground = true;
    else if (arg === "--no-tunnel") out.tunnel = false;
    else if (arg === "--name" || arg === "--network" || arg === "--hub" || arg === "--hostname") {
      out[arg.slice(2)] = argv[++i];
    } else if (arg === "--firstName" || arg === "--lastName") {
      // Required owner names at bootstrap (PORCH-024): first and last, both
      // non-empty; the hub composes the display name from them.
      out[arg.slice(2)] = argv[++i];
    } else if (arg === "--host") out.host = argv[++i];
    else if (arg === "--install" || arg === "--uninstall") out.action = arg.slice(2);
    else out._.push(arg);
  }
  return out;
};

const args = process.argv.slice(2);
const [command = ""] = args;

if (args.length === 0 || command === "--help" || command === "-h" || command === "help") {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}
if (command === "--version" || command === "-v") {
  process.stdout.write(`porchlight v${version}\n`);
  process.exit(0);
}

const commands = {
  setup: async () => (await import("../src/setup.mjs")).run(flags(args.slice(1))),
  start: async () => (await import("../src/start.mjs")).run(flags(args.slice(1))),
  stop: async () => (await import("../src/stop.mjs")).run(flags(args.slice(1))),
  status: async () => (await import("../src/status.mjs")).run(flags(args.slice(1))),
  update: async () => (await import("../src/update.mjs")).run(flags(args.slice(1))),
  bootstrap: async () => (await import("../src/bootstrap.mjs")).run(flags(args.slice(1))),
  service: async () => (await import("../src/service.mjs")).run(flags(args.slice(1))),
  tunnel: async () => (await import("../src/tunnel.mjs")).run(flags(args.slice(1))),
};

const handler = commands[command];
if (!handler) {
  process.stderr.write(`porchlight: unknown argument: ${args.join(" ")}\n${HELP}\n`);
  process.exit(1);
}

handler().catch((error) => {
  process.stderr.write(`porchlight: ${command} failed — ${error.message}\n`);
  process.exit(1);
});