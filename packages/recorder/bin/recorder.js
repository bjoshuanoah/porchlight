#!/usr/bin/env node
// recorder CLI — supervise / audit / prune / launchd (PORCH-127).

import fsDefault from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditStorage, probeCorrupt } from "../src/audit.js";
import { loadConfig, resolveDefaults } from "../src/config.js";
import { buildLaunchAgentPlist } from "../src/launchd.js";
import { pruneRolling } from "../src/retention.js";
import { RecorderSupervisor } from "../src/supervisor.js";

const USAGE = `usage: recorder <command> --config <file> [flags]

commands:
  supervise   run the per-camera recorders headless (launchd entrypoint)
  audit       gap audit [+ --probe corruption scan] [+ --since/--until ISO]
  prune       one rolling-retention sweep
  launchd     print the LaunchAgent plist for supervise [--out FILE]

flags: --config FILE --probe --since ISO --until ISO --out FILE`;

/** @param {string[]} argv */
function parseArgs(argv) {
	/** @type {Record<string, string|string[]>} */
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const key = a.slice(2);
		if (key === "probe") {
			out[key] = true;
			continue;
		}
		out[key] = argv[++i] ?? "";
	}
	return out;
}

function die(msg) {
	console.error(msg);
	process.exit(2);
}

const command = process.argv[2];
const flags = parseArgs(process.argv.slice(3));
const arg = (k) => (typeof flags[k] === "string" ? flags[k] : "");
if (!command || command === "--help" || command === "-h") {
	console.log(USAGE);
	process.exit(command ? 0 : 2);
}
const configFile = arg("config");
if (!configFile) die("missing --config FILE");
const config = loadConfig(configFile);
const d = resolveDefaults(config);

if (command === "supervise") {
	const supervisor = new RecorderSupervisor({ config });
	supervisor.start();
	let stopping = false;
	const shutdown = async () => {
		if (stopping) return;
		stopping = true;
		await supervisor.stop();
		process.exit(0);
	};
	process.on("SIGTERM", () => void shutdown());
	process.on("SIGINT", () => void shutdown());
} else if (command === "audit") {
	const sinceMs = arg("since") ? Date.parse(arg("since")) : null;
	const untilMs = arg("until") ? Date.parse(arg("until")) : null;
	if (Number.isNaN(sinceMs ?? 0) || Number.isNaN(untilMs ?? 0)) die("bad --since/--until ISO value");
	const result = auditStorage({
		root: config.storageRoot,
		cameras: config.cameras.map((c) => c.name),
		segmentSeconds: d.segmentSeconds,
		sinceMs,
		untilMs,
		fs: fsDefault,
	});
	if (arg("probe")) {
		const probe = await probeCorrupt({
			root: config.storageRoot,
			cameras: config.cameras.map((c) => c.name),
			ffprobePath: d.ffprobePath,
			segmentSeconds: d.segmentSeconds,
			sinceMs,
			untilMs,
			fs: fsDefault,
		});
		result.probe = probe;
	}
	console.log(JSON.stringify(result, null, 2));
	const ok = result.ok && (result.probe?.ok ?? true);
	process.exit(ok ? 0 : 1);
} else if (command === "prune") {
	const result = pruneRolling({
		root: config.storageRoot,
		retentionDays: d.retentionDays,
		nowMs: Date.now(),
		coldRoot: config.coldRoot ?? null,
		fs: fsDefault,
	});
	console.log(JSON.stringify(result, null, 2));
} else if (command === "launchd") {
	const binPath = fileURLToPath(new URL("./recorder.js", import.meta.url));
	const root = path.dirname(path.resolve(configFile));
	const logPath = path.join(d.statePath, "..", "supervisor.log");
	const plist = buildLaunchAgentPlist({
		label: "com.porchlight.recorder",
		program: process.execPath,
		args: [binPath, "supervise", "--config", path.resolve(configFile)],
		workingDirectory: root,
		stdoutPath: path.resolve(logPath),
		stderrPath: path.resolve(logPath),
		environment: { TZ: "UTC" },
	});
	if (arg("out")) {
		fsDefault.writeFileSync(arg("out"), plist);
		console.log(`plist written: ${arg("out")}`);
	} else {
		console.log(plist);
	}
} else {
	die(`unknown command: ${command}\n\n${USAGE}`);
}
