// run-soak.mjs — the endurance soak harness (PORCH-127).
//
// Runs the FULL production recorder stack (RecorderSupervisor → one ffmpeg
// daemon per camera) against synthetic fleet cameras for a duration, sweeps
// rolling retention, and audits the store on an interval and at exit.
//
// Default duration: unbounded — the deployment soak is a real wall-clock run
// under launchd KeepAlive supervision (PORCH-127 ac-2), with periodic audit
// summaries in the log. A bounded run (--duration-ms) exits nonzero if the
// final audit finds gaps or corrupt files.
//
// camera names are a deployment input ("deployment fleet" shape): pass
// --cameras as a comma list or rely on the default three-camera shape.

import fsDefault from "node:fs";
import path from "node:path";
import { auditStorage, probeCorrupt } from "../src/audit.js";
import { resolveDefaults } from "../src/config.js";
import { pruneRolling } from "../src/retention.js";
import { RecorderSupervisor } from "../src/supervisor.js";

/** @param {string[]} argv */
function parseArgs(argv) {
	/** @type {Record<string, string>} */
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith("--")) continue;
		out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true";
	}
	return out;
}

const flags = parseArgs(process.argv.slice(2));
const num = (k, fallback) => {
	const v = flags[k];
	return v === undefined || v === "true" ? fallback : Number(v);
};
if (!flags.root) {
	console.error("usage: node run-soak.mjs --root STORE [options]");
	console.error("  --root DIR              storage root (required)");
	console.error("  --cameras a,b,c         camera names (deployment fleet input)");
	console.error("  --segment-seconds N     default 600");
	console.error("  --retention-days N      rolling buffer window, default 7");
	console.error("  --duration-ms N         default: unbounded (launchd soak)");
	console.error("  --audit-interval-ms N   default 1800000");
	console.error("  --fps, --size, --bitrate, --encoder, --audio-freq, --audio-sample-rate");
	process.exit(2);
}

const cameraNames = flags.cameras
	? flags.cameras.split(",").map((s) => s.trim()).filter(Boolean)
	: ["soak-cam-1", "soak-cam-2", "soak-cam-3"];
const storageRoot = path.resolve(flags.root);
const startedAt = Date.now();
const durationMs = flags["duration-ms"] ? Number(flags["duration-ms"]) : null;
const auditIntervalMs = num("audit-interval-ms", 30 * 60 * 1000);
const segmentSeconds = num("segment-seconds", 600);
const retentionDays = num("retention-days", 7);

/** @type {import("../src/types.js").RecorderConfig} */
const config = {
	storageRoot,
	segmentSeconds,
	retentionDays,
	cameras: cameraNames.map((name, i) => ({
		name,
		source: {
			synthetic: {
				size: flags.size ?? "1280x720",
				fps: num("fps", 12),
				encoder: i === 2 ? "hevc_videotoolbox" : (flags.encoder ?? "h264_videotoolbox"),
				bitrate: flags.bitrate ?? "500k",
				audio: true,
				audioFreq: num("audio-freq", 440 + i * 110),
				audioSampleRate: num("audio-sample-rate", 8000),
			},
		},
	})),
};

/** @param {unknown} x */
const iso = (x) => new Date(/** @type {number} */ (x)).toISOString();

/** @param {number|null} [untilMs] */
function runAudit(untilMs = null) {
	const result = auditStorage({
		root: storageRoot,
		cameras: cameraNames,
		segmentSeconds,
		sinceMs: startedAt,
		untilMs: untilMs ?? (durationMs ? startedAt + durationMs : Date.now()),
		fs: fsDefault,
	});
	console.log(
		`soak-audit at=${iso(Date.now())} ok=${result.ok} segments=${result.totals.segments} `
		+ `inProgress=${result.totals.inProgress} gaps=${result.totals.gaps}`,
	);
	if (!result.ok) {
		for (const c of result.cameras) {
			for (const g of c.gaps) {
				console.log(`  GAP ${c.camera} ${iso(g.from)} → ${iso(g.to)} (${g.ms}ms)`);
			}
		}
	}
	return result;
}

fsDefault.mkdirSync(storageRoot, { recursive: true });
const supervisor = new RecorderSupervisor({ config, log: console.log });
supervisor.start();
const auditTimer = setInterval(() => runAudit(), auditIntervalMs);
auditTimer.unref?.();
console.log(`soak started at=${iso(startedAt)} cameras=${cameraNames.join(",")} segmentSeconds=${segmentSeconds} retentionDays=${retentionDays}${durationMs ? ` durationMs=${durationMs}` : " (unbounded — launchd soak)"}`);

let stopping = false;
async function shutdown() {
	if (stopping) return;
	stopping = true;
	console.log(`soak stopping at=${iso(Date.now())}`);
	const untilMs = Date.now();
	await supervisor.stop();
	// final retention sweep + audit after settle
	pruneRolling({
		root: storageRoot,
		retentionDays,
		nowMs: untilMs,
		coldRoot: config.coldRoot ?? null,
		fs: fsDefault,
	});
	// let the last .part settle, then recover/audit
	setTimeout(async () => {
		const result = runAudit(untilMs);
		const probe = await probeCorrupt({
			root: storageRoot,
			cameras: cameraNames,
			ffprobePath: resolveDefaults(config).ffprobePath,
			segmentSeconds,
			sinceMs: startedAt,
			untilMs,
			fs: fsDefault,
		});
		console.log(`soak-probe checked=${probe.checked} corrupt=${probe.corrupt.length}`);
		for (const c of probe.corrupt) console.log(`  CORRUPT ${c.file}: ${c.reason}`);
		console.log(`soak done at=${iso(Date.now())} ok=${result.ok && probe.ok}`);
		process.exit(result.ok && probe.ok ? 0 : 1);
	}, 2000);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
if (durationMs) {
	setTimeout(() => void shutdown(), durationMs).unref?.();
}
