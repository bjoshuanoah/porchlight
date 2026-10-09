#!/usr/bin/env node
// porchlight — global CLI (npm is the only install surface, Brian Oct 13, 2026).
// Post-install run shape: the binary runs from PATH immediately after
// `npm install -g porchlight` with no further setup steps (PORCH-002 ac-3).
// Domain behavior (porchlight start, remote bootstrap) lands with PORCH-003
// bring-up; this entrypoint intentionally performs no domain logic.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const HELP = `porchlight v${version}

Usage: porchlight [options]

Options:
  --version, -v  print the version and exit 0
  --help,    -h  print this help and exit 0

Called with no arguments it prints this help and exits 0 — the post-install
"binary runs" check.

License: MIT — https://github.com/bjoshuanoah/porchlight/blob/main/LICENSE`;

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}
if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write(`porchlight v${version}\n`);
  process.exit(0);
}
process.stderr.write(`porchlight: unknown argument: ${args.join(" ")}\n${HELP}\n`);
process.exit(1);