// types.js — contracts for the transcription plane (PORCH-155; PORCH-I-009
// PRD 13 / TS 13).
//
// The transcription consumer rides the stream-serving path (TS 9): it
// subscribes to each camera's decoded audio exactly like the audio
// classification consumer — NOTHING opens a second camera connection
// (stream-manager law). Two regimes of record:
//   - rolling: aligned ~1-minute windows transcribed while recording, the
//     cadence of record being "transcribes in well under its wall-clock
//     length"; per-window text lands with write-time embedding.
//   - event: full-span event audio, split into sequential chunks when the
//     span exceeds one window, text joined — the record carries the FULL
//     span or an EXPLICIT partiality state (never-truncate-silently law).
//
// Absence of stored text is always an explicit state, never a missing
// field: a non-speech span records state "no-speech", and surfaces render
// it. The desc-and-transcript law: an event page renders description and
// transcript together or neither — the store refuses a one-sided write.

/** The transcript record states of record — closed set (never silent). */
export const RECORD_STATES = Object.freeze(["text", "no-speech", "partial"]);

/** The transcript source families of record — closed set. */
export const SOURCE_TYPES = Object.freeze(["rolling", "event"]);

/**
 * The transcription method classes of record (TS 13): whisper-class local
 * binary, OpenAI-spec HTTP endpoint, or a local-server endpoint. The method
 * doc of record selects per scope; the provider plumbing (model + endpoint
 * reference) rides the engine compute posture (PRD 5 / TS 5
 * InferenceProvider via the "transcription" stage of the Models/Compute
 * surface).
 */
export const METHOD_CLASSES = Object.freeze(["whisper-local", "openai-spec", "local-server"]);

/** Rolling cadence budget of record (build decision, TS 13 [Assumed]): a
 * rolling window must transcribe in well under its wall-clock length. The
 * benchmark run on the M4 Pro host of record gates before this number
 * commits to capacity claims; until then it is the observability budget —
 * every window exceeding it is counted and stated, never silent. */
export const ROLLING_CADENCE_BUDGET_MS = 25_000;

/** Rolling window length of record (TS 13: "~1-minute windows"). */
export const ROLLING_WINDOW_MS = 60_000;

/** Event chunk length of record (TS 13: "sequential chunks" of one window). */
export const EVENT_CHUNK_MS = ROLLING_WINDOW_MS;

/**
 * Validation failure — plain language, HTTP 422 upstream.
 */
export class ValidationError extends Error {
	constructor(message) {
		super(message);
		this.name = "ValidationError";
	}
}

/**
 * One transcribed chunk. Text records carry `text`; a no-speech chunk
 * carries `text: null` with state "no-speech" — an explicit state, never a
 * missing field. A failed chunk stays explicitly incomplete (state
 * "partial" at record level with the reason).
 *
 * @typedef {object} TranscriptChunkState
 * @property {number} startOffset epoch seconds of the chunk's first sample
 * @property {number} endOffset   epoch seconds past the chunk's last sample
 * @property {string|null} text   transcript text; null = no speech detected
 * @property {"text"|"no-speech"|"partial"} state
 * @property {string} [reason]    required on partial chunks
 */

/**
 * A transcript record of record. Vector payload refs carry the
 * TS 13 field set {cameraId, sourceType, sourceRef, startOffset, endOffset,
 * text}. Rolling sourceRef is the window id `window-<cameraId>-<startMs>`;
 * event sourceRef is the event id `event-<cameraId>-<eventId>`.
 *
 * @typedef {object} TranscriptRecord
 * @property {string} cameraId      engine camera id
 * @property {"rolling"|"event"} sourceType
 * @property {string} sourceRef     window id / event id (see above)
 * @property {number} startOffset   epoch seconds of the span's first sample
 * @property {number} endOffset     epoch seconds past the span's last sample
 * @property {string|null} text     joined transcript text; null when nothing spoke
 * @property {"text"|"no-speech"|"partial"} state
 * @property {{completedChunks: number, totalChunks: number, reason: string}} [partial] explicit partiality (required on state "partial")
 * @property {TranscriptChunkState[]} [chunks] per-chunk detail (multi-chunk spans)
 * @property {number} transcribedAt epoch seconds the transcription completed
 * @property {string} provider      the provider name that produced the text
 * @property {string} [description] event records only — desc-and-transcript law
 */

/**
 * Vector payload ref — the TS 13 field set. The vector store of record
 * indexes transcripts at WRITE TIME (never lazy) with exactly this payload.
 *
 * @typedef {object} VectorPayload
 * @property {string} cameraId
 * @property {"rolling"|"event"} sourceType
 * @property {string} sourceRef
 * @property {number} startOffset
 * @property {number} endOffset
 * @property {string|null} text
 */

/**
 * The transcription provider seam (TS 5 InferenceProvider posture for the
 * "transcription" stage). transcribe returns { text } — null text is the
 * explicit no-speech answer; a THROWN error is a failed chunk the service
 * records as explicit partiality, never a silent truncation.
 *
 * @typedef {object} TranscriptionProvider
 * @property {string} name
 * @property {(frame: {camera: string, clipStart: number, clipEnd: number, sampleRate: number, data: Float32Array}) => Promise<{text: string|null, language?: string}>} transcribe
 * @property {() => Record<string, unknown>} [status]
 * @property {() => Promise<void>} [close]
 */

/**
 * The embedder seam (TS 5 InferenceProvider posture for the "embedding"
 * stage; the transcript store's embedder of record — the same class of
 * model semantic search uses, qwen3-embedding-class).
 *
 * @typedef {object} Embedder
 * @property {string} name
 * @property {(text: string) => Promise<{data: Float32Array}>} embed
 * @property {() => Record<string, unknown>} [status]
 */

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {void}
 */
export function assertCameraId(value, label = "cameraId") {
	if (typeof value !== "string" || value.trim() === "") {
		throw new ValidationError(`${label}: required (a non-empty string)`);
	}
}

/**
 * Validate one transcript record; returns the record unchanged on success.
 * The desc-and-transcript law lives HERE for event records: description and
 * transcript land together or neither — a one-sided write refuses with the
 * law named.
 * @param {unknown} value
 * @returns {TranscriptRecord}
 */
export function assertTranscriptRecord(value) {
	if (!value || typeof value !== "object") throw new ValidationError("transcript record: required");
	const r = /** @type {any} */ (value);
	assertCameraId(r.cameraId);
	if (!SOURCE_TYPES.includes(r.sourceType)) {
		throw new ValidationError(`sourceType: must be one of ${SOURCE_TYPES.join(", ")}`);
	}
	if (typeof r.sourceRef !== "string" || r.sourceRef.trim() === "") {
		throw new ValidationError("sourceRef: required (the window id or event id)");
	}
	if (!Number.isFinite(r.startOffset) || !Number.isFinite(r.endOffset) || r.endOffset < r.startOffset) {
		throw new ValidationError("startOffset/endOffset: startOffset must be epoch seconds and endOffset not before it");
	}
	if (!RECORD_STATES.includes(r.state)) {
		throw new ValidationError(`state: must be one of ${RECORD_STATES.join(", ")}`);
	}
	if (r.state === "text") {
		if (typeof r.text !== "string" || r.text.trim() === "") {
			throw new ValidationError('text: required (non-empty) when state is "text" — absence of text is always an explicit state, never a missing field');
		}
	}
	if (r.state === "no-speech" && r.text !== null) {
		throw new ValidationError('text: must be exactly null when state is "no-speech"');
	}
	if (r.state === "partial") {
		const p = r.partial;
		if (!p || !Number.isInteger(p.completedChunks) || !Number.isInteger(p.totalChunks) || typeof p.reason !== "string" || p.reason.trim() === "") {
			throw new ValidationError('partial: { completedChunks, totalChunks, reason } is required on state "partial" — never-truncate-silently');
		}
		if (p.completedChunks >= p.totalChunks || p.completedChunks < 0) {
			throw new ValidationError("partial.completedChunks: must be less than totalChunks and not negative");
		}
	}
	if (typeof r.transcribedAt !== "number" || !Number.isFinite(r.transcribedAt)) {
		throw new ValidationError("transcribedAt: required (epoch seconds)");
	}
	if (typeof r.provider !== "string" || r.provider.trim() === "") {
		throw new ValidationError("provider: required (the name of the provider that produced the text)");
	}
	if (r.sourceType === "event") {
		// Desc-and-transcript law (PRD 13): the event page renders description
		// and transcript together or neither. The store refuses a write whose
		// transcript side exists without a description to render beside it.
		if (typeof r.description !== "string" || r.description.trim() === "") {
			throw new ValidationError("description: required on event records — the desc-and-transcript law renders them together or neither");
		}
	}
	if (r.sourceType === "rolling" && r.description !== undefined) {
		throw new ValidationError("description: event records only — rolling windows carry no description");
	}
	if (r.chunks !== undefined) {
		if (!Array.isArray(r.chunks)) throw new ValidationError("chunks: must be an array of per-chunk states when present");
		for (const c of r.chunks) {
			if (!c || typeof c !== "object") throw new ValidationError("chunks: each entry must be an object");
			if (!Number.isFinite(c.startOffset) || !Number.isFinite(c.endOffset)) throw new ValidationError("chunks: each entry needs numeric startOffset/endOffset");
			if (!RECORD_STATES.includes(c.state)) throw new ValidationError(`chunks: state must be one of ${RECORD_STATES.join(", ")}`);
			if (c.state === "partial" && (typeof c.reason !== "string" || c.reason.trim() === "")) {
				throw new ValidationError("chunks: a partial chunk needs its reason — never silent");
			}
			if (c.state === "text" && (typeof c.text !== "string" || c.text.trim() === "")) {
				throw new ValidationError('chunks: a text chunk needs non-empty text');
			}
			if (c.state === "no-speech" && c.text !== null) {
				throw new ValidationError('chunks: a no-speech chunk carries text exactly null');
			}
		}
	}
	return r;
}

/**
 * Validate one vector payload ref — the TS 13 field set exactly.
 * @param {unknown} value
 * @returns {VectorPayload}
 */
export function assertVectorPayload(value) {
	if (!value || typeof value !== "object") throw new ValidationError("vector payload: required");
	const p = /** @type {any} */ (value);
	assertCameraId(p.cameraId);
	if (!SOURCE_TYPES.includes(p.sourceType)) {
		throw new ValidationError(`sourceType: must be one of ${SOURCE_TYPES.join(", ")}`);
	}
	if (typeof p.sourceRef !== "string" || p.sourceRef.trim() === "") throw new ValidationError("sourceRef: required");
	if (!Number.isFinite(p.startOffset) || !Number.isFinite(p.endOffset)) throw new ValidationError("startOffset/endOffset: required numbers");
	if (typeof p.text !== "string" && p.text !== null) throw new ValidationError("text: string or exactly null (explicit no-speech)");
	return p;
}

/**
 * Rolling window id of record.
 * @param {string} cameraId
 * @param {number} startMs aligned window start, epoch ms
 * @returns {string}
 */
export function rollingRefOf(cameraId, startMs) {
	return `window-${cameraId}-${startMs}`;
}

/**
 * Event source ref of record.
 * @param {string} cameraId
 * @param {string} eventId
 * @returns {string}
 */
export function eventRefOf(cameraId, eventId) {
	return `event-${cameraId}-${eventId}`;
}
