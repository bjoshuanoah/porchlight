#!/usr/bin/env node
// stream CLI — supervise (launchd entrypoint) + lane-port debug aid (PORCH-154).

import { loadPlatformConfig, resolveStreamBase } from "../src/config.js";
import { StreamManager } from "../src/manager.js";

const USAGE = `usage: stream <command> --config <file>

commands:
  supervise   run the stream manager headless (launchd entrypoint)
  ports       print the lane ports derived from one config (debug aid)

flags: --config FILE`;

/** @param {string[]} argv */
function parseArgs(argv) {
	/** @type {Record<string, string>} */
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i]?.startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] ?? "";
	}
	return out;
}

function die(msg) {
	console.error(msg);
	process.exit(2);
}

const command = process.argv[2];
const flags = parseArgs(process.argv.slice(3));
const configFile = flags.config;
if (!command || command === "--help" || command === "-h") {
	console.log(USAGE);
	process.exit(command ? 0 : 2);
}
if (!configFile) die("missing --config FILE");

if (command === "supervise") {
	const config = loadPlatformConfig(configFile);
	const manager = new StreamManager({
		config,
		log: (line) => console.log(line),
	});
	void manager.applyPromise?.then((applied) => {
		const fleet = Object.keys(applied.ports).length;
		console.log(`[stream] supervising ${fleet} camera(s) — control HTTP on 127.0.0.1:${resolveStreamBase(config)}`);
	});
	manager.start();
	let stopping = false;
	const shutdown = async () => {
		if (stopping) return;
		stopping = true;
		await manager.stop();
		process.exit(0);
	};
	process.on("SIGTERM", () => void shutdown());
	process.on("SIGINT", () => void shutdown());
} else if (command === "ports") {
	const config = loadPlatformConfig(configFile);
	const base = resolveStreamBase(config);
	const names = /** @type {{name: string}[]} */ (config.cameras ?? []).map((c) => c.name).sort();
	console.log(JSON.stringify({ base, relays: Object.fromEntries(names.map((n, i) => [n, base + 1 + i])) }, null, 2));
} else {
	die(`unknown command: ${command}\n\n${USAGE}`);
}
