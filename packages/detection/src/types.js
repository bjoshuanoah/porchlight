// types.js — contract types for the detection service (PORCH-128).
//
// DetectedObject is the engine's normalized detection output contract
// (PORCH-I-009 TS 3): every published detection carries label (cls), bbox
// (normalized [0,1] x,y,w,h), confidence, track id, timestamp (epoch
// seconds), and camera id. Field names/following the PORCH-126 spike's
// consumer contract (packages/overwatch/src/types.js) so the Overwatch
// entity layer can consume the bus stream unchanged.

/**
 * A decoded video frame handed to an InferenceProvider.
 *
 * @typedef {object} Frame
 * @property {string} camera    engine camera id
 * @property {number} w         frame width in pixels
 * @property {number} h         frame height in pixels
 * @property {number} t         epoch seconds of frame availability
 * @property {"rgb"|"rgba"|"jpeg"} format   pixel/packed encoding of `data`
 * @property {Uint8Array} data  frame payload per `format`
 */

/**
 * A provider-internal detection before tracking: coordinates are already
 * normalized to the frame ([0,1] origin top-left), matching DetectedObject.
 *
 * @typedef {object} RawDetection
 * @property {string} cls    class label ("person", "dog", ...)
 * @property {number} conf   confidence in [0,1]
 * @property {[number, number, number, number]} bbox  [x, y, w, h] normalized
 * @property {number} [t]    epoch seconds (defaults to the frame's t)
 * @property {number[]} [reid]  optional appearance descriptor
 */

/**
 * The normalized bus contract (PORCH-I-009 TS 3).
 *
 * @typedef {object} DetectedObject
 * @property {string} camera      engine camera id
 * @property {string} trackId     per-camera track id from the tracker
 * @property {string} cls         class label ("person", "dog", ...)
 * @property {number} conf        confidence in [0,1]
 * @property {[number, number, number, number]} bbox  [x, y, w, h] normalized
 * @property {number} t           epoch seconds
 * @property {string} [provider]  name of the InferenceProvider that produced it
 * @property {number[]} [reid]    optional appearance descriptor
 */

/**
 * InferenceProvider protocol (the central seam, PORCH-I-009 TS 5).
 *
 * A provider is a plain object:
 *   - `name: string` — registry id (e.g. "coreml", "vision", "ollama")
 *   - `detect(frame: Frame): Promise<RawDetection[]>`
 *   - optional `status()` — the never-silent compute posture (PORCH-152):
 *     every provider reports all five of engine, providerClass, model,
 *     executionTarget, and state. `providerClass` mirrors the engine's three
 *     compute classes of record (@porchlight/agent-runtime constants.js
 *     PROVIDER_CLASSES — mirrored by cross-reference, never imported). A
 *     degradation (CPU fallback, helper respawn, forced CPU) always carries a
 *     `reason` stating it; a fully native run reports `reason: null`. A
 *     provider that cannot say all five is a defect, not a blank.
 *   - optional `close(): Promise<void>` — release resources
 *
 * Registering a new provider is `registry.register(name, factory)` — no core
 * file changes (PORCH-128 ac-3).
 *
 * @typedef {object} InferenceProvider
 * @property {string} name
 * @property {(frame: import("./types.js").Frame) => Promise<import("./types.js").RawDetection[]>} detect
 * @property {() => {
 *   engine: string,
 *   providerClass: "native-mlx"|"openai-spec"|"local-server",
 *   model?: string|null,
 *   executionTarget?: string|null,
 *   state: "native"|"cpu"|"degraded"|"failed",
 *   reason?: string|null,
 * } & Record<string, unknown>} [status]
 * @property {() => Promise<void>} [close]
 */

/**
 * DetectionSink protocol — the transport seam behind detection publishing.
 * The engine's event-bus transport is owned by the PORCH-129 vetting
 * decision; the detection core depends only on this interface, so the bus
 * implementation can re-point without core changes.
 *
 * @typedef {object} DetectionSink
 * @property {(object: import("./types.js").DetectedObject) => Promise<void>} publish
 * @property {() => Promise<void>} [close]
 * @property {() => Record<string, unknown>} [status]
 */

/**
 * @param {unknown} maybe
 * @returns {asserts maybe is Frame}
 */
export function assertFrame(maybe) {
	if (typeof maybe !== "object" || maybe === null) {
		throw new TypeError("Frame must be an object");
	}
	const f = /** @type {Record<string, unknown>} */ (maybe);
	for (const key of ["camera"]) {
		if (typeof f[key] !== "string" || f[key].length === 0) {
			throw new TypeError(`Frame.${key} must be a non-empty string`);
		}
	}
	for (const key of ["w", "h", "t"]) {
		if (typeof f[key] !== "number" || !Number.isFinite(f[key]) || f[key] <= 0) {
			throw new TypeError(`Frame.${key} must be a finite positive number`);
		}
	}
	if (f.format !== "rgb" && f.format !== "rgba" && f.format !== "jpeg") {
		throw new TypeError('Frame.format must be "rgb" | "rgba" | "jpeg"');
	}
	const need = f.format === "rgb" ? f.w * f.h * 3 : f.format === "rgba" ? f.w * f.h * 4 : 1;
	if (!(f.data instanceof Uint8Array)) {
		throw new TypeError("Frame.data must be a Uint8Array");
	}
	if (f.format !== "jpeg" && f.data.length < need) {
		throw new TypeError(`Frame.data must hold at least ${need} bytes for ${f.format} at ${f.w}x${f.h}`);
	}
}

/**
 * @param {unknown} maybe
 * @returns {asserts maybe is RawDetection}
 */
export function assertRawDetection(maybe) {
	if (typeof maybe !== "object" || maybe === null) {
		throw new TypeError("RawDetection must be an object");
	}
	const d = /** @type {Record<string, unknown>} */ (maybe);
	if (typeof d.cls !== "string" || d.cls.length === 0) {
		throw new TypeError("RawDetection.cls must be a non-empty string");
	}
	if (typeof d.conf !== "number" || d.conf < 0 || d.conf > 1) {
		throw new TypeError("RawDetection.conf must be in [0,1]");
	}
	assertBBox(d.bbox, "RawDetection.bbox");
	if (d.t !== undefined && (typeof d.t !== "number" || !Number.isFinite(d.t))) {
		throw new TypeError("RawDetection.t must be a finite epoch-seconds number");
	}
	if (d.reid !== undefined && !Array.isArray(d.reid)) {
		throw new TypeError("RawDetection.reid, when present, must be a number[]");
	}
}

/**
 * @param {unknown} maybe
 * @returns {asserts maybe is DetectedObject}
 */
export function assertDetectedObject(maybe) {
	if (typeof maybe !== "object" || maybe === null) {
		throw new TypeError("DetectedObject must be an object");
	}
	const o = /** @type {Record<string, unknown>} */ (maybe);
	for (const key of ["camera", "trackId", "cls"]) {
		if (typeof o[key] !== "string" || o[key].length === 0) {
			throw new TypeError(`DetectedObject.${key} must be a non-empty string`);
		}
	}
	if (typeof o.t !== "number" || !Number.isFinite(o.t)) {
		throw new TypeError("DetectedObject.t must be a finite epoch-seconds number");
	}
	if (typeof o.conf !== "number" || o.conf < 0 || o.conf > 1) {
		throw new TypeError("DetectedObject.conf must be in [0,1]");
	}
	assertBBox(o.bbox, "DetectedObject.bbox");
	if (o.provider !== undefined && (typeof o.provider !== "string" || o.provider.length === 0)) {
		throw new TypeError("DetectedObject.provider, when present, must be a non-empty string");
	}
	if (o.reid !== undefined && !Array.isArray(o.reid)) {
		throw new TypeError("DetectedObject.reid, when present, must be a number[]");
	}
}

/**
 * @param {unknown} box
 * @param {string} label
 */
function assertBBox(box, label) {
	if (!Array.isArray(box) || box.length !== 4 || box.some((c) => typeof c !== "number" || !Number.isFinite(c))) {
		throw new TypeError(`${label} must be [x, y, w, h] finite numbers`);
	}
	const [x, y, w, h] = box;
	if (x < 0 || y < 0 || w < 0 || h < 0 || x + w > 1 + 1e-9 || y + h > 1 + 1e-9) {
		throw new TypeError(`${label} must be normalized within [0,1]`);
	}
}
