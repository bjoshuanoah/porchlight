// types.js — validation for the config console domain objects (PORCH-135).
//
// Every violation is a plain-language ValidationError (HTTP 422); the console
// surfaces the message verbatim. Percent geometry is the domain law (TS 11/12):
// zone/mask polygons are stored in 0–100 frame coordinates so they survive
// resolution changes by construction.

export const KNOB_WHITELIST = Object.freeze([
	"recordingMode",
	"detectionEnabled",
	"detectionClasses",
	"audioDetectionEnabled",
	"transcriptionEnabled",
	"alertRouting",
	"zoneEnabled",
]);

// Knob defaults apply when neither the camera layer nor the `_default` layer
// sets a value (TS 12 layer resolution: base → active profile → resolved).
export const KNOB_DEFAULTS = Object.freeze({
	recordingMode: "continuous",
	detectionEnabled: true,
	detectionClasses: [],
	audioDetectionEnabled: false,
	transcriptionEnabled: false,
	alertRouting: [],
	zoneEnabled: true,
});

const RECORDING_MODES = ["continuous", "event"];
const DETECTION_CLASSES = ["person", "animal", "vehicle"];
const ALERT_ROUTINGS = ["bus", "webhook"];
const SCOPE_LIST = ["global", "camera"];

/** Safe path/URL component (same discipline as the recorder camera names). */
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class ValidationError extends Error {
	constructor(message) {
		super(message);
		this.name = "ValidationError";
	}
}

export class NotFoundError extends Error {
	constructor(message) {
		super(message);
		this.name = "NotFoundError";
	}
}

/** Assert an object; returns the value for chaining. */
export function assertObject(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ValidationError(`${label}: expected an object`);
	}
	return value;
}

/** Assert a non-empty string. */
export function assertString(value, label) {
	if (typeof value !== "string" || value.trim() === "") {
		throw new ValidationError(`${label}: required non-empty string`);
	}
	return value;
}

/** Assert a boolean. */
export function assertBoolean(value, label) {
	if (typeof value !== "boolean") throw new ValidationError(`${label}: must be true or false`);
	return value;
}

/** Assert a safe identifier (URL segment + file-safe). */
export function assertId(value, label) {
	if (typeof value !== "string" || !ID_RE.test(value)) {
		throw new ValidationError(`${label}: expected a safe identifier (letters, digits, dot, underscore, dash)`);
	}
	return value;
}

/** Assert a finite percent coordinate in [0, 100]. */
export function assertCoordinate(value, label) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
		throw new ValidationError(`${label}: must be a number in [0, 100] (percent frame coordinates)`);
	}
	return value;
}

/** Assert a strictly positive finite number. */
export function assertPositiveNumber(value, label) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new ValidationError(`${label}: must be a number greater than 0`);
	}
	return value;
}

/** Validate one percent point: exactly two coordinates, each in [0, 100]. */
export function validatePoint(value, label) {
	if (!Array.isArray(value) || value.length !== 2) {
		throw new ValidationError(`${label}: expected [x, y] percent coordinates`);
	}
	return [assertCoordinate(value[0], `${label}[0]`), assertCoordinate(value[1], `${label}[1]`)];
}

/**
 * Validate a percent polygon: 3+ vertex pairs, coords in [0, 100].
 * Returns a normalized deep copy so stored docs never alias request bodies.
 * @returns {Array<[number, number]>}
 */
export function validatePolygon(value, label = "polygon") {
	if (!Array.isArray(value) || value.length < 3) {
		throw new ValidationError(`${label}: needs at least 3 [x, y] percent points`);
	}
	return value.map((pt, i) => validatePoint(pt, `${label}[${i}]`));
}

/** Validate a single knob value against its closed enum/type. */
export function validateKnobValue(knob, value) {
	switch (knob) {
		case "recordingMode":
			if (!RECORDING_MODES.includes(value)) {
				throw new ValidationError(`knob "recordingMode": must be one of ${RECORDING_MODES.map((m) => `"${m}"`).join(" | ")}`);
			}
			return value;
		case "detectionEnabled":
		case "audioDetectionEnabled":
		case "transcriptionEnabled":
		case "zoneEnabled":
			return assertBoolean(value, `knob "${knob}"`);
		case "detectionClasses":
			if (!Array.isArray(value) || value.some((c) => !DETECTION_CLASSES.includes(c))) {
				throw new ValidationError(`knob "detectionClasses": must be a list of ${DETECTION_CLASSES.map((c) => `"${c}"`).join(" | ")}`);
			}
			return [...value];
		case "alertRouting":
			if (!Array.isArray(value) || value.some((r) => !ALERT_ROUTINGS.includes(r))) {
				throw new ValidationError(`knob "alertRouting": must be a list of ${ALERT_ROUTINGS.map((r) => `"${r}"`).join(" | ")}`);
			}
			return [...value];
		default:
			// Unreachable via validateKnobs (whitelist check first); defensive for
			// direct callers — the whitelist is closed (TS 12).
			throw new ValidationError(`knob "${knob}": not in the knob whitelist`);
	}
}

/**
 * Validate a knobs object against the closed whitelist; unknown knobs are
 * rejected outright (TS 12: profiles knob whitelist is closed). Returns a
 * normalized copy.
 */
export function validateKnobs(value, label = "knobs") {
	assertObject(value, label);
	const out = {};
	for (const knob of Object.keys(value)) {
		if (!KNOB_WHITELIST.includes(knob)) {
			throw new ValidationError(`${label}: unknown knob "${knob}" — the whitelist is ${KNOB_WHITELIST.map((k) => `"${k}"`).join(", ")}`);
		}
		out[knob] = validateKnobValue(knob, value[knob]);
	}
	return out;
}

/**
 * Validate a schedule window: { start: "HH:MM", end: "HH:MM", days: [0-6] }.
 * Midnight-crossing windows (start > end) are allowed.
 * @returns {{ start: string, end: string, days: number[] }}
 */
export function validateSchedule(value, label = "schedule") {
	assertObject(value, label);
	const hours = (v) => {
		if (typeof v !== "string" || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(v)) {
			throw new ValidationError(`${label}: start and end must be "HH:MM" (24h)`);
		}
		return v;
	};
	const start = hours(value.start);
	const end = hours(value.end);
	if (!Array.isArray(value.days) || value.days.length === 0 || value.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
		throw new ValidationError(`${label}: days must be a non-empty list of weekdays 0–6 (0 = Sunday)`);
	}
	return { start, end, days: [...value.days].sort((a, b) => a - b) };
}

/**
 * Validate camera fields for create (name/width/height required) or partial
 * upsert (only provided fields validated). Returns a normalized copy.
 */
export function validateCameraFields(source, { forCreate = false } = {}) {
	assertObject(source, "camera body");
	const out = {};
	if (source.name !== undefined || forCreate) out.name = assertString(source.name, "camera name");
	if (source.width !== undefined || forCreate) {
		if (!Number.isInteger(source.width) || source.width <= 0) {
			throw new ValidationError("camera width: must be a positive integer (stream pixels)");
		}
		out.width = source.width;
	}
	if (source.height !== undefined || forCreate) {
		if (!Number.isInteger(source.height) || source.height <= 0) {
			throw new ValidationError("camera height: must be a positive integer (stream pixels)");
		}
		out.height = source.height;
	}
	if (source.snapshotUrl !== undefined) {
		if (typeof source.snapshotUrl !== "string") throw new ValidationError("camera snapshotUrl: must be a string URL");
		out.snapshotUrl = source.snapshotUrl;
	}
	return out;
}

/**
 * Validate a definition (zone/mask) body: name + polygon, optional enabled.
 * @returns {{ name: string, polygon: Array<[number, number]>, enabled?: boolean }}
 */
export function validateDefinitionFields(source, kind, { forCreate = false } = {}) {
	assertObject(source, `${kind} body`);
	const out = {};
	const wantName = source.name !== undefined || forCreate;
	if (wantName) out.name = assertString(source.name, `${kind} name`);
	const wantPolygon = source.polygon !== undefined || forCreate;
	if (wantPolygon) out.polygon = validatePolygon(source.polygon, `${kind} polygon`);
	if (source.enabled !== undefined) out.enabled = assertBoolean(source.enabled, `${kind} enabled`);
	return out;
}

/**
 * Validate a profile body (create = full validation). Returns a normalized
 * { name, scope, cameraId?, knobs, schedule? } copy.
 */
export function validateProfileFields(source) {
	assertObject(source, "profile body");
	const out = {};
	out.name = assertString(source.name, "profile name");
	if (source.scope === undefined) {
		out.scope = SCOPE_LIST[0];
	} else if (SCOPE_LIST.includes(source.scope)) {
		out.scope = source.scope;
	} else {
		throw new ValidationError(`profile scope: must be one of ${SCOPE_LIST.map((s) => `"${s}"`).join(" | ")}`);
	}
	if (source.cameraId !== undefined) {
		if (out.scope === "camera") {
			out.cameraId = assertId(source.cameraId, "profile cameraId");
		}
		// A global profile simply ignores a stray cameraId (keeps PUT merges
		// like { scope: "global" } from wedging a camera-scoped row).
	} else if (out.scope === "camera") {
		throw new ValidationError(`profile cameraId: required when scope is "camera"`);
	}
	out.knobs = validateKnobs(source.knobs ?? {}, "profile knobs");
	if (source.schedule !== undefined && source.schedule !== null) {
		out.schedule = validateSchedule(source.schedule, "profile schedule");
	}
	return out;
}
