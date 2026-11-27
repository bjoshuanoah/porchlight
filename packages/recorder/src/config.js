// config.js — recorder configuration load + validation (PORCH-127).
//
// Config survives restarts because the daemon reads the same document every
// boot (launchd autostart) — no hidden defaults, nothing assumed pre-deployed.

import fsDefault from "node:fs";
import { parse as parseYaml } from "yaml";

const CAMERA_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Load a recorder config from a JSON or YAML file path.
 * @param {string} file
 * @param {{fs?: typeof fsDefault}} [opts]
 * @returns {import("./types.js").RecorderConfig}
 */
export function loadConfig(file, opts = {}) {
	const fs = opts.fs ?? fsDefault;
	const raw = fs.readFileSync(file, "utf8");
	const parsed = /\.ya?ml$/i.test(file)
		? parseYaml(raw)
		: JSON.parse(raw);
	return validateConfig(parsed);
}

/**
 * Validate a recorder config; throws with the full field path on error.
 * @param {import("./types.js")} cfg
 * @returns {import("./types.js").RecorderConfig}
 */
export function validateConfig(cfg) {
	if (!cfg || typeof cfg !== "object") throw new Error("config: expected an object");
	intField(cfg, "segmentSeconds", 1, Infinity, true);
	intField(cfg, "retentionDays", 1, Infinity, true);
	if (!cfg.storageRoot || typeof cfg.storageRoot !== "string") {
		throw new Error("config.storageRoot: required absolute path");
	}
	if (cfg.highWaterFraction !== undefined) {
		const f = cfg.highWaterFraction;
		if (typeof f !== "number" || !(f > 0 && f < 1)) {
			throw new Error("config.highWaterFraction: must be a fraction between 0 and 1");
		}
	}
	if (cfg.failoverRoot !== undefined) {
		if (typeof cfg.failoverRoot !== "string" || !cfg.failoverRoot.startsWith("/")) {
			throw new Error("config.failoverRoot: must be an absolute path (or omit it)");
		}
	}
	if (cfg.eventRetentionDays !== undefined) intField(cfg, "eventRetentionDays", 1, Infinity);
	if (cfg.healthProbeMs !== undefined) intField(cfg, "healthProbeMs", 1000, Infinity);
	if (cfg.busUrl !== undefined && (typeof cfg.busUrl !== "string" || !cfg.busUrl)) {
		throw new Error("config.busUrl: must be a non-empty MQTT URL");
	}
	// PORCH-154: the stream manager's ONE config knob (`streams.base`) rides
	// in the same config of record. The recorder consumes it only when a url
	// camera derives its relay port, but a bad value refuses at load — never
	// a silently half-shared config misplacing every relay socket.
	if (cfg.streams !== undefined) {
		if (!cfg.streams || typeof cfg.streams !== "object" || Array.isArray(cfg.streams)) {
			throw new Error("config.streams: expected an object with an optional integer `base` port (the stream manager's base port)");
		}
		if (cfg.streams.base !== undefined && (!Number.isInteger(cfg.streams.base) || cfg.streams.base < 1024)) {
			throw new Error("config.streams.base: must be an integer >= 1024 (the stream manager's base port)");
		}
	}
	if (cfg.retentionRules !== undefined) {
		if (!Array.isArray(cfg.retentionRules)) throw new Error("config.retentionRules: must be an array");
		cfg.retentionRules.forEach((rule, i) => {
			if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
				throw new Error(`config.retentionRules[${i}]: expected an object`);
			}
			for (const key of ["cameraId", "eventClass", "zoneId"]) {
				if (rule[key] !== undefined && (typeof rule[key] !== "string" || !CAMERA_NAME_RE.test(rule[key]))) {
					throw new Error(`config.retentionRules[${i}].${key}: invalid identifier ${JSON.stringify(rule[key])}`);
				}
			}
			if (rule.cameraId === undefined && rule.eventClass === undefined && rule.zoneId === undefined) {
				throw new Error(`config.retentionRules[${i}]: needs at least one scope key (cameraId, eventClass, zoneId)`);
			}
			if (!Number.isInteger(rule.keepDays) || rule.keepDays < 1) {
				throw new Error(`config.retentionRules[${i}].keepDays: must be an integer >= 1`);
			}
		});
	}
	if (!Array.isArray(cfg.cameras)) {
		throw new Error("config.cameras: required array");
	}
	// An empty fleet is valid (PORCH-134 ac-1): the fresh deployment Mac boots
	// headless before any camera is configured, and the supervisor must start
	// idle so the platform auto-starts with the bootstrap config of record.
	// The status surfaces render the awaiting-configuration state in plain
	// language — never a silent stall.
	const names = new Set();
	for (const c of cfg.cameras) {
		if (!c || typeof c !== "object") throw new Error("config.cameras[]: expected an object");
		if (!CAMERA_NAME_RE.test(c.name ?? "")) {
			throw new Error(`config.cameras[].name: invalid camera name ${JSON.stringify(c?.name)} (safe path component required)`);
		}
		if (names.has(c.name)) throw new Error(`config.cameras: duplicate camera name ${c.name}`);
		names.add(c.name);
		if (!c.source || (typeof c.source !== "object")) {
			throw new Error(`config.cameras[${c.name}].source: required`);
		}
		if (typeof c.source.url !== "string" && typeof c.source.synthetic !== "object") {
			throw new Error(`config.cameras[${c.name}].source: needs url or synthetic`);
		}
		if (c.audioMode !== undefined && c.audioMode !== "transcode" && c.audioMode !== "copy") {
			throw new Error(`config.cameras[${c.name}].audioMode: must be "transcode" or "copy"`);
		}
		if (c.recordingMode !== undefined && c.recordingMode !== "continuous" && c.recordingMode !== "event") {
			throw new Error(`config.cameras[${c.name}].recordingMode: must be "continuous" or "event"`);
		}
		for (const key of ["preRollSeconds", "postRollSeconds"]) {
			if (c[key] !== undefined && (!Number.isInteger(c[key]) || c[key] < 0 || c[key] > 86400)) {
				throw new Error(`config.cameras[${c.name}].${key}: must be an integer in [0, 86400]`);
			}
		}
	}
	return cfg;
}

/** @param {Record<string, unknown>} cfg */
function intField(cfg, key, min, max, optional = false) {
	const v = cfg[key];
	if (v === undefined) {
		if (optional) return;
		throw new Error(`config.${key}: required integer`);
	}
	if (!Number.isInteger(v) || v < min || v > max) {
		throw new Error(`config.${key}: must be an integer in [${min}, ${max === Infinity ? "∞" : max}]`);
	}
}

/** Resolved defaults after validation (config itself is never mutated). */
export function resolveDefaults(cfg) {
	return {
		segmentSeconds: cfg.segmentSeconds ?? 600,
		retentionDays: cfg.retentionDays ?? 7,
		highWaterFraction: cfg.highWaterFraction ?? 0.9,
		eventRetentionDays: cfg.eventRetentionDays ?? 30,
		healthProbeMs: cfg.healthProbeMs ?? 30000,
		port: cfg.port ?? 8971,
		statePath: cfg.statePath ?? `${cfg.storageRoot}/recorder-state.json`,
		ffmpegPath: cfg.ffmpegPath ?? "ffmpeg",
		ffprobePath: cfg.ffprobePath ?? "ffprobe",
	};
}
