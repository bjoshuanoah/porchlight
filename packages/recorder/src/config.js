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
		port: cfg.port ?? 8971,
		statePath: cfg.statePath ?? `${cfg.storageRoot}/recorder-state.json`,
		ffmpegPath: cfg.ffmpegPath ?? "ffmpeg",
		ffprobePath: cfg.ffprobePath ?? "ffprobe",
	};
}
