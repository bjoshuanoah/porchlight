// config.js — stream-plane configuration load + resolution (PORCH-154).
//
// The platform config of record (<root>/config/config.yaml) is ONE document
// shared across planes: cameras[] (the fleet), streams (this plane's port
// knob), busUrl (the engine event bus). The stream manager consumes the whole
// doc — it never mutates it; the config plane owns writes (registerStreamCamera
// adds source.{width,height} from the ffprobe probe).

import fsDefault from "node:fs";
import { parse as parseYaml } from "yaml";

/** Default base port: control HTTP at <base>, relay listeners above it. */
export const STREAM_BASE_DEFAULT = 8972;

const CAMERA_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Load the platform config doc from a JSON or YAML file path.
 * @param {string} file
 * @param {{fs?: typeof fsDefault}} [opts]
 * @returns {Record<string, unknown>}
 */
export function loadPlatformConfig(file, opts = {}) {
	const fs = opts.fs ?? fsDefault;
	const raw = fs.readFileSync(file, "utf8");
	const parsed = /\.ya?ml$/i.test(file) ? parseYaml(raw) : JSON.parse(raw);
	return validatePlatformDoc(parsed);
}

/**
 * Validate the parts of the platform doc the stream plane consumes. Fields
 * this plane does not own (storage, detection, …) are ignored here — their
 * planes validate them on their own boots.
 * @param {unknown} doc
 * @returns {Record<string, unknown>}
 */
export function validatePlatformDoc(doc) {
	if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
		throw new Error("config: expected an object (the platform config of record)");
	}
	resolveStreamBase(doc);
	if (doc.busUrl !== undefined && doc.busUrl !== null && (typeof doc.busUrl !== "string" || !doc.busUrl)) {
		throw new Error("config.busUrl: must be a non-empty MQTT URL (or omit it)");
	}
	const streams = doc.streams;
	if (streams !== undefined) {
		if (!streams || typeof streams !== "object" || Array.isArray(streams)) {
			throw new Error("config.streams: expected an object");
		}
		if (streams.rgbFps !== undefined && (!Number.isInteger(streams.rgbFps) || streams.rgbFps < 1)) {
			throw new Error("config.streams.rgbFps: must be an integer ≥ 1");
		}
		if (streams.jpegFps !== undefined && (!Number.isInteger(streams.jpegFps) || streams.jpegFps < 1)) {
			throw new Error("config.streams.jpegFps: must be an integer ≥ 1");
		}
	}
	validateCameras(doc.cameras ?? []);
	return /** @type {Record<string, unknown>} */ (doc);
}

/**
 * Relay-port law (PORCH-154 contract): the control HTTP listens at
 * <base>, every camera relay listener at <base + 1 + sortedIndex(name)> —
 * sortedIndex over the codepoint-sorted fleet (plain Array.prototype.sort(),
 * NOT localeCompare). Both the manager and every consumer derive ports with
 * this same function; never a second formula.
 * @param {unknown} doc the platform config doc (streams.base optional)
 * @returns {number}
 */
export function resolveStreamBase(doc) {
	const base = /** @type {any} */ (doc)?.streams?.base;
	if (base === undefined || base === null) return STREAM_BASE_DEFAULT;
	if (!Number.isInteger(base) || base < 1024 || base > 65535) {
		throw new Error(`config.streams.base: must be an integer in [1024, 65535] (got ${JSON.stringify(base)})`);
	}
	return base;
}

/** The fleet doc shape check for live apply: throws with the full path. */
export function validateCameras(cameras) {
	if (!Array.isArray(cameras)) {
		throw new Error("cameras: expected an array of camera objects");
	}
	const names = new Set();
	for (const c of cameras) {
		if (!c || typeof c !== "object" || Array.isArray(c)) {
			throw new Error("cameras[]: expected an object");
		}
		if (!CAMERA_NAME_RE.test(c.name ?? "")) {
			throw new Error(`cameras[].name: invalid camera name ${JSON.stringify(c?.name)} (a safe identifier is required)`);
		}
		if (names.has(c.name)) throw new Error(`cameras: duplicate camera name ${JSON.stringify(c.name)}`);
		names.add(c.name);
		if (!c.source || typeof c.source !== "object" || Array.isArray(c.source)) {
			throw new Error(`cameras[${c.name}].source: required`);
		}
		if (typeof c.source.url !== "string" && typeof c.source.synthetic !== "object") {
			throw new Error(`cameras[${c.name}].source: needs source.url or source.synthetic`);
		}
	}
}

/**
 * The stream-plane settings of record: { base, rgbFps, jpegFps }.
 * @param {unknown} doc
 * @returns {{ base: number, rgbFps: number, jpegFps: number }}
 */
export function resolveStreamSettings(doc) {
	const streams = /** @type {any} */ (doc)?.streams ?? {};
	return {
		base: resolveStreamBase(doc),
		rgbFps: streams.rgbFps ?? 10,
		jpegFps: streams.jpegFps ?? 5,
	};
}
