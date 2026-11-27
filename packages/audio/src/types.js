// types.js — contract types for the audio event detection plane (PORCH-153;
// PORCH-I-009 PRD 8 / TS 8).
//
// AudioEvent is the engine's normalized audio output contract: per-camera
// audio event classes detected locally, published on the engine's event bus
// in the SAME family as DetectedObject (the
// `porchlight/engine/detections/<camera>/<class>` two-segment topic of
// record) with the TS 8 field set {camera, timestamp, class, confidence,
// clipStart, clipEnd}. Clip references resolve through the segment index
// (clipStart/clipEnd are epoch seconds into the camera's recording);
// timeline evidence links ride the SAME evidence path as visual detection
// events — the hub's event ingest resolves evidence via engine.evidenceAt.

/** The audio event class set of record — a BUILD DECISION (TS 8: "the class
 * set is a build decision, never a spec constant"). Cut from the PRD 8's
 * validated candidates: glass break, dog bark, smoke/CO alarm patterns,
 * raised audio. Changing the set is a build-time change to this list and to
 * the provisioned model's classNames, never a schema change. */
export const AUDIO_CLASSES = Object.freeze([
	"glass-break",
	"dog-bark",
	"smoke-co-alarm",
	"raised-voice",
]);

/**
 * A decoded audio chunk handed to the audio analysis consumer. The chunks
 * come from the stream-serving path (TS 8 / TS 9): the re-streaming service
 * delivers each camera's decoded audio track — the audio plane NEVER opens
 * a camera connection of its own (stream-manager law: one upstream
 * connection per camera, every consumer fed).
 *
 * @typedef {object} AudioChunk
 * @property {string} camera      engine camera id
 * @property {number} t           epoch seconds of chunk availability
 * @property {number} sampleRate  Hz (the recording tier's AAC/16 kHz class)
 * @property {Float32Array} data  mono PCM samples in [-1, 1]
 */

/**
 * A classification-ready window: contiguous samples for one camera covering
 * [clipStart, clipEnd]. Built by the service's windower from AudioChunks.
 *
 * @typedef {object} AudioFrame
 * @property {string} camera      engine camera id
 * @property {number} clipStart   epoch seconds of the window's first sample
 * @property {number} clipEnd     epoch seconds past the window's last sample
 * @property {number} sampleRate  Hz
 * @property {Float32Array} data  mono PCM samples in [-1, 1]
 */

/**
 * A provider-internal classification before publishing.
 *
 * @typedef {object} AudioHit
 * @property {string} cls    class label (the class set of record, AUDIO_CLASSES)
 * @property {number} conf   confidence in [0,1]
 */

/**
 * The normalized bus contract (PORCH-I-009 TS 8).
 *
 * @typedef {object} AudioEvent
 * @property {string} camera      engine camera id
 * @property {number} timestamp   epoch seconds the event was confirmed
 *                                (the window's close — the moment the sound
 *                                was known; evidence resolution keys on it)
 * @property {string} class       class label (AUDIO_CLASSES)
 * @property {number} confidence  confidence in [0,1]
 * @property {number} clipStart   epoch seconds; resolves through the segment index
 * @property {number} clipEnd     epoch seconds; resolves through the segment index
 * @property {string} [provider]  name of the AudioProvider that produced it
 */

/**
 * AudioProvider protocol — the classification seam (TS 5's per-stage model
 * selection, audio per TS 8). A plain object:
 *   - `name: string` — registry/label id (e.g. "onnx-audio")
 *   - `classify(frame: AudioFrame): Promise<AudioHit[]>`
 *   - optional `status()` — the never-silent compute posture (PORCH-152
 *     law carries): engine, providerClass (the three classes of record),
 *     model, executionTarget, state, reason. A degradation states its
 *     reason; a fully native run reports `reason: null`.
 *   - optional `close(): Promise<void>`
 *
 * @typedef {object} AudioProvider
 * @property {string} name
 * @property {(frame: import("./types.js").AudioFrame) => Promise<import("./types.js").AudioHit[]>} classify
 * @property {() => {
 *   engine: string,
 *   providerClass: "native-mlx"|"openai-spec"|"local-server",
 *   model: string|null,
 *   executionTarget: string|null,
 *   state: "native"|"cpu"|"degraded"|"failed",
 *   reason: string|null,
 * } & Record<string, unknown>} [status]
 * @property {() => Promise<void>} [close]
 */

/**
 * AudioSink protocol — the transport seam behind audio publishing. The
 * engine's event-bus transport decision (PORCH-129 vetting: MQTT, docs/event-bus-transport.md) is owned
 * by the sink implementation; the audio core depends only on this
 * interface, so the bus can re-point without core changes.
 *
 * @typedef {object} AudioSink
 * @property {(event: import("./types.js").AudioEvent) => Promise<void>} publish
 * @property {() => Promise<void>} [close]
 * @property {() => Record<string, unknown>} [status]
 */

/**
 * The enablement seam (TS 8: per-camera enable, off by default): the
 * composition root injects the knob reader so the plane rides the TS 12
 * layer resolution (base → profile, audioDetectionEnabled, default false)
 * instead of re-implementing config. A disabled camera means NO analysis
 * runs and NO audio frames are retained for analysis.
 *
 * @typedef {(cameraId: string) => { value: boolean, source: string } | boolean
 *   | Promise<{ value: boolean, source: string } | boolean>} AudioEnabledFor
 */

/** @param {unknown} maybe @returns {asserts maybe is AudioChunk} */
export function assertAudioChunk(maybe) {
	if (typeof maybe !== "object" || maybe === null) {
		throw new TypeError("AudioChunk must be an object");
	}
	const c = /** @type {Record<string, unknown>} */ (maybe);
	if (typeof c.camera !== "string" || c.camera.length === 0) {
		throw new TypeError("AudioChunk.camera must be a non-empty string");
	}
	for (const key of ["t", "sampleRate"]) {
		if (typeof c[key] !== "number" || !Number.isFinite(c[key]) || c[key] <= 0) {
			throw new TypeError(`AudioChunk.${key} must be a finite positive number`);
		}
	}
	if (!(c.data instanceof Float32Array) || c.data.length === 0) {
		throw new TypeError("AudioChunk.data must be a non-empty Float32Array");
	}
}

/** @param {unknown} maybe @returns {asserts maybe is AudioFrame} */
export function assertAudioFrame(maybe) {
	if (typeof maybe !== "object" || maybe === null) {
		throw new TypeError("AudioFrame must be an object");
	}
	const f = /** @type {Record<string, unknown>} */ (maybe);
	if (typeof f.camera !== "string" || f.camera.length === 0) {
		throw new TypeError("AudioFrame.camera must be a non-empty string");
	}
	let samples = 0;
	if (f.data instanceof Float32Array) samples = f.data.length;
	if (
		typeof f.clipStart !== "number" || !Number.isFinite(f.clipStart) ||
		typeof f.clipEnd !== "number" || !Number.isFinite(f.clipEnd) ||
		f.clipEnd <= f.clipStart
	) {
		throw new TypeError("AudioFrame.clipStart/clipEnd must be epoch seconds with clipEnd > clipStart");
	}
	if (typeof f.sampleRate !== "number" || !Number.isFinite(f.sampleRate) || f.sampleRate <= 0) {
		throw new TypeError("AudioFrame.sampleRate must be a finite positive number");
	}
	if (!(f.data instanceof Float32Array) || samples === 0) {
		throw new TypeError("AudioFrame.data must be a non-empty Float32Array");
	}
	// The window's wall span must be consistent with its sample count — a
	// window that claims a longer span than its samples encode is malformed,
	// never silently classified.
	const span = (f.clipEnd - f.clipStart) * f.sampleRate;
	if (span < samples * 0.5 || span > samples * 2) {
		throw new TypeError(`AudioFrame span (${(span / f.sampleRate).toFixed(3)}s) disagrees with its sample count (${(samples / f.sampleRate).toFixed(3)}s at ${f.sampleRate} Hz)`);
	}
}

/** @param {unknown} maybe @returns {asserts maybe is AudioEvent} */
export function assertAudioEvent(maybe) {
	if (typeof maybe !== "object" || maybe === null) {
		throw new TypeError("AudioEvent must be an object");
	}
	const e = /** @type {Record<string, unknown>} */ (maybe);
	if (typeof e.camera !== "string" || e.camera.length === 0) {
		throw new TypeError("AudioEvent.camera must be a non-empty string");
	}
	if (typeof e.class !== "string" || e.class.length === 0) {
		throw new TypeError("AudioEvent.class must be a non-empty string");
	}
	for (const key of ["timestamp", "clipStart", "clipEnd"]) {
		if (typeof e[key] !== "number" || !Number.isFinite(e[key]) || e[key] <= 0) {
			throw new TypeError(`AudioEvent.${key} must be a finite epoch-seconds number`);
		}
	}
	if (e.clipEnd < e.clipStart) {
		throw new TypeError("AudioEvent.clipEnd must not precede clipStart");
	}
	if (typeof e.confidence !== "number" || e.confidence < 0 || e.confidence > 1) {
		throw new TypeError("AudioEvent.confidence must be in [0,1]");
	}
	if (e.provider !== undefined && (typeof e.provider !== "string" || e.provider.length === 0)) {
		throw new TypeError("AudioEvent.provider, when present, must be a non-empty string");
	}
}
