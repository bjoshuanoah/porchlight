// config.js — platform config bootstrap for the fresh deployment (PORCH-134).
//
// Config of record lives at <root>/config/config.yaml; it survives restarts
// because the daemon reads the same document every boot. First-run bootstrap
// writes it once and never overwrites an existing document on reinstall —
// the config of record is the deployment's, not the installer's.

import fsDefault from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { validateConfig } from "@porchlight/recorder";

export const DEFAULT_ROOT = "/Library/Porchlight";
export const DEFAULT_LABEL = "com.porchlight.home";
export const DEFAULT_STATUS_PORT = 8970;
export const DEFAULT_STATUS_HOST = "0.0.0.0";

const KNOWN_INPUT_KEYS = [
	"storageRoot",
	"cameras",
	"segmentSeconds",
	"retentionDays",
	"coldRoot",
	"highWaterFraction",
	"port",
	"statePath",
	"ffmpegPath",
	"ffprobePath",
	"statusPort",
	"statusHost",
	"failoverRoot",
	"eventRetentionDays",
	"retentionRules",
	"busUrl",
];

/**
 * Validate a platform config: every recorder field rides the recorder
 * contract (an empty camera fleet is legal — the fresh deployment boots
 * idle), plus the platform's own status-surface fields.
 * @param {Record<string, unknown>} cfg
 * @returns {Record<string, unknown> & {statusPort: number, statusHost: string}}
 */
export function validatePlatformConfig(cfg) {
	validateConfig(cfg);
	let statusPort = DEFAULT_STATUS_PORT;
	if (cfg.statusPort !== undefined) {
		if (!Number.isInteger(cfg.statusPort) || cfg.statusPort < 1 || cfg.statusPort > 65535) {
			throw new Error("config.statusPort: must be an integer in [1, 65535]");
		}
		statusPort = cfg.statusPort;
	}
	let statusHost = DEFAULT_STATUS_HOST;
	if (cfg.statusHost !== undefined) {
		if (typeof cfg.statusHost !== "string" || !cfg.statusHost) {
			throw new Error("config.statusHost: required non-empty string");
		}
		statusHost = cfg.statusHost;
	}
	return { ...cfg, statusPort, statusHost };
}

/**
 * Load a platform config document (YAML or JSON).
 * @param {string} file
 * @param {{fs?: typeof fsDefault}} [opts]
 */
export function loadPlatformConfig(file, opts = {}) {
	const fs = opts.fs ?? fsDefault;
	const raw = fs.readFileSync(file, "utf8");
	const parsed = /\.ya?ml$/i.test(file) ? parseYaml(raw) : JSON.parse(raw);
	return validatePlatformConfig(parsed);
}

/**
 * The default config of record for a fresh deployment. Property-agnostic
 * (zero cameras, no fleet shape), green-field (the bootstrap writes the
 * storage location explicitly into the config of record — the admin
 * console's storage question refines it later, never a hidden assumption).
 * @param {Record<string, unknown>} [inputs] deployment inputs from the
 *        payload's config.inputs.yaml (or the CLI flag), if any.
 */
export function defaultConfigDocument(inputs = {}) {
	const merge = { statusPort: DEFAULT_STATUS_PORT, statusHost: DEFAULT_STATUS_HOST };
	const doc = {
		version: 1,
		storageRoot: `${DEFAULT_ROOT}/recordings`,
		cameras: [],
		segmentSeconds: 600,
		retentionDays: 7,
		...Object.fromEntries(Object.entries(inputs ?? {}).filter(([k]) => KNOWN_INPUT_KEYS.includes(k))),
	};
	// Only merge the platform fields when the inputs did not set them.
	if (inputs?.statusPort === undefined) Object.assign(doc, { statusPort: merge.statusPort });
	if (inputs?.statusHost === undefined) Object.assign(doc, { statusHost: merge.statusHost });
	return validatePlatformConfig(doc);
}

/**
 * Render the config of record as YAML text (deterministic key order).
 * @param {Record<string, unknown>} cfg
 */
export function renderConfigYaml(cfg) {
	return JSON.stringify(cfg, null, "\t") + "\n";
}

/**
 * First-run config bootstrap: creates <configDir>/config.yaml from the
 * defaults plus any deployment inputs — never overwrites an existing
 * config of record (idempotent across reinstall/upgrade).
 * @param {string} configDir
 * @param {Record<string, unknown>} inputs
 * @param {{fs?: typeof fsDefault}} [opts]
 * @returns {{path: string, created: boolean}}
 */
export function ensureBootstrapConfig(configDir, inputs = {}, opts = {}) {
	const fs = opts.fs ?? fsDefault;
	fs.mkdirSync(configDir, { recursive: true });
	const target = path.join(configDir, "config.yaml");
	if (fs.existsSync(target)) {
		// Reinstall: the deployment's config of record wins; validate it so a
		// broken document fails loudly here, not at daemon boot.
		loadPlatformConfig(target, { fs });
		return { path: target, created: false };
	}
	const inputsPath = path.join(configDir, "config.inputs.yaml");
	if (fs.existsSync(inputsPath)) {
		inputs = { ...inputs, ...parseInputs(fs.readFileSync(inputsPath, "utf8"), "config.inputs.yaml") };
	}
	fs.writeFileSync(target, renderConfigYaml(defaultConfigDocument(inputs)), "utf8");
	return { path: target, created: true };
}

/**
 * @param {string} raw
 * @param {string} sourceName
 */
export function parseInputs(raw, sourceName = "inputs") {
	let parsed;
	try {
		parsed = raw.trim().startsWith("{")
			? JSON.parse(raw)
			: parseYaml(raw);
	} catch (err) {
		throw new Error(`config ${sourceName}: unparseable deployment inputs (${/** @type {Error} */ (err).message})`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`config ${sourceName}: expected an object of deployment inputs`);
	}
	return parsed;
}
