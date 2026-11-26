// types.js — the People & Things recognition contracts of record (PORCH-141).
//
// The registry is the household's named-entity store: face entries and
// vehicle entries, built locally, owned by the household. Every recognition
// artifact (descriptors, plate reads, sighting histories) stays on the hub —
// the biometric privacy law; nothing in this package ever opens a network
// connection (the REST plane binds an already-open server's requests).

/**
 * @typedef {{
 *   format: "jpeg" | "rgba",
 *   data: Uint8Array,
 *   w?: number,
 *   h?: number,
 *   t?: number,
 * }} RecognitionFrame
 * A cropped or full image the local pipeline embeds or OCRs. `data` is
 * JPEG bytes (`jpeg`) or raw RGBA pixels (`rgba`). Enrollment uploads and
 * engine-side crop plumbing produce the same shape.
 *
 * @typedef {number[]} FaceDescriptor
 *
 * @typedef {{
 *   descriptor: FaceDescriptor,
 *   conf?: number,
 *   box?: [number, number, number, number],
 * }} FaceEmbedding
 * One local detection result: the descriptor plus optional crop evidence.
 *
 * @typedef {{
 *   text: string,
 *   conf?: number,
 *   box?: [number, number, number, number],
 * }} PlateRead
/**
 * @typedef {{
 *   name: string,
 *   describeFaces(frame: RecognitionFrame): Promise<FaceEmbedding[]>,
 *   readPlates?(frame: RecognitionFrame): Promise<PlateRead[]>,
 *   embedImage?(frame: RecognitionFrame): Promise<number[][]>,
 *   status?(): { engine: string, [k: string]: unknown },
 *   close?: () => Promise<void>,
 * }} VisionProvider
 * The local pipeline seam (the recognition-side analogue of the detection
 * package's InferenceProvider): a CoreML/onnxruntime-class face embedder, an
 * OCR-class plate reader, or the deterministic test provider. Model names
 * are shaping candidates supplied by setup's per-stage selection law — the
 * provider is the boundary, never a hardcoded runtime.
 *
 * `embedImage` (PORCH-142, the watchlist stage): the exemplar embedder for
 * the household-trained few-shot classes — qwen3-embedding-class per-crop
 * vectors of every uploaded example image. The cosine/classifier mechanics
 * live in watchlists.js; the provider is the boundary. A provider without
 * embedImage cannot teach a watchlist class — training refuses closed with
 * plain language (never a silent fallback), exactly like the other stages.
 *
 * @typedef {{
 *   at: number,
 *   cameraId?: string,
 *   trackId?: string,
 *   eventId?: string,
 *   entityId?: string,
 *   confidence?: number,
 *   decision?: "asserted" | "looks-like",
 *   evidenceRef?: { kind: "segment" | "still", ref: string } | { kind: "gap", reason: string },
 * }} Sighting
 * One sighting of an entry. It references the event/track/evidence chain so
 * every sighting opens its evidence — never a copy of the artifact.
 *
 * @typedef {{
 *   _id: string,
 *   homeId: string,
 *   kind: "face",
 *   name: string,
 *   descriptors: FaceDescriptor[],
 *   sightings: Sighting[],
 *   enrolledFor?: "household" | "visit",
 *   accountabilityNote?: string,
 *   createdAt: string,
 *   updatedAt: string,
 * }} FaceEntry
 *
 * @typedef {{
 *   _id: string,
 *   homeId: string,
 *   kind: "vehicle",
 *   name: string,
 *   descriptors: FaceDescriptor[],
 *   plateText?: string,
 *   sightings: Sighting[],
 *   createdAt: string,
 *   updatedAt: string,
 * }} VehicleEntry
 * (FaceEntry.descriptors and VehicleEntry.descriptors are the same local
 * embedding space; vehicles match by plate text where recognized and by
 * descriptor similarity otherwise.)
 *
 * @typedef {{
 *   _id: string,
 *   homeId: string,
 *   entryId: string,
 *   targetKind: "event" | "entity" | "track" | "visit",
 *   targetId: string,
 *   cameraId?: string,
 *   trackId?: string,
 *   confidence: number,
 *   decision: "asserted" | "looks-like",
 *   at: string,
 * }} Annotation
 * The annotation is a REFERENCE to the registry entry, not a duplicated
 * copy: renaming the entry renames history at render time. Deleting the
 * entry removes the annotation row; the annotated event keeps its factual
 * content with the identity reference gone.
 *
 * @typedef {{
 *   homeId: string,
 *   enabled: boolean,
 *   assertThreshold: number | null,
 *   updatedAt: string | null,
 *   updatedBy: string | null,
 * }} RecognitionSettings
 * The recognition switch of record — opt-in per household (biometric
 * privacy law): a household that never opted in has enabled=false.
 * assertThreshold is the calibrated gallery threshold of record; null
 * (uncalibrated) fails toward uncertainty: matches render "looks like",
 * never asserted.
 */

/**
 * Registry entry id prefixes.
 */
export const FACE_ID_PREFIX = "fce_";
export const VEHICLE_ID_PREFIX = "veh_";
/** Sighting history cap per entry (bounded registry — the store stays a store). */
export const SIGHTINGS_CAP = 200;
/** Watchlist trained-class id prefix + its detection-row prefix (PORCH-142). */
export const WATCHLIST_ID_PREFIX = "wtl_";
export const WATCHLIST_DETECTION_ID_PREFIX = "wdx_";
/** Exemplar cap per trained class (bounded artifact set — the store stays a store). */
export const EXEMPLARS_CAP = 64;
/** Per-class bounded ring of recorded trained-detection rows (correction lookup + surface). */
export const DETECTION_RING_CAP = 20;
/** Asserted-emission cooldown, in seconds: one asserted trained-label detection per
 * track per window — the family event pipeline's own dedup window (PORCH-139). */
export const EMISSION_COOLDOWN_SEC = 300;
/** Class label shape of record: the text the household types, capped; it rides the
 * detection vocabulary as the detection `cls`, so it stays printable and small. */
const CLASS_LABEL_RE = /^[\p{L}\p{N}][\p{L}\p{N} '’&.,-]{0,47}$/u;
/** Plate text shape of record: uppercase alphanumerics + hyphen, 2-12 chars. */
const PLATE_TEXT_RE = /^[A-Z0-9-]{2,12}$/;

/**
 * @param {unknown} v
 * @returns {v is string}
 */
function isNonEmptyString(v) {
	return typeof v === "string" && v.trim() !== "";
}

/**
 * @param {unknown} v
 * @returns {v is number}
 */
function isFiniteNumber(v) {
	return typeof v === "number" && Number.isFinite(v);
}

/**
 * A plain-language shape refusal that carries its own transport status —
 * the plane maps typed refusals straight onto the response (still a
 * TypeError: callers keep instanceof TypeError).
 * @param {string} message
 * @returns {never}
 */
export function refusal(message) {
	throw Object.assign(new TypeError(message), { status: 422, code: "E_INVALID" });
}

/**
 * Validate a recognition frame. Plain-language refusal on bad shape — the
 * caller decides how it reaches transport.
 * @param {unknown} frame
 * @returns {RecognitionFrame}
 */
export function assertFrame(frame) {
	if (!frame || typeof frame !== "object") {
		refusal("A recognition frame is required.");
	}
	const f = /** @type {RecognitionFrame} */ (frame);
	if (f.format !== "jpeg" && f.format !== "rgba") {
		refusal("Unsupported frame format: use jpeg or rgba.");
	}
	if (!(f.data instanceof Uint8Array) || f.data.byteLength === 0) {
		refusal("The frame needs image data.");
	}
	if (f.format === "rgba" && f.w !== undefined) {
		if (!isFiniteNumber(f.w) || f.w <= 0 || !isFiniteNumber(f.h) || f.h <= 0) {
			refusal("RGBA frames carry positive w and h.");
		}
	}
	return f;
}

/**
 * Validate a descriptor vector (non-empty, finite floats).
 * @param {unknown} d
 * @returns {FaceDescriptor}
 */
export function assertDescriptor(d) {
	if (!Array.isArray(d) || d.length === 0 || !d.every(isFiniteNumber)) {
		refusal("A descriptor is a non-empty array of finite numbers.");
	}
	return /** @type {FaceDescriptor} */ (d);
}

/**
 * @param {unknown} text
 * @returns {string}
 */
export function normalizePlateText(text) {
	if (!isNonEmptyString(text)) {
		refusal("A plate read needs text.");
	}
	const normalized = text.trim().toUpperCase();
	if (!PLATE_TEXT_RE.test(normalized)) {
		refusal('Plate text is 2-12 letters, digits, or hyphens (e.g. "6TRI889").');
	}
	return normalized;
}

/**
 * Validate the upsert body an enrollment carries (shared by service + plane).
 * @param {unknown} body
 * @returns {{
 *   homeId: string, kind: "face" | "vehicle", name: string,
 *   enrolledFor?: "household" | "visit", accountabilityNote?: string,
 * }}
 */
export function assertEnrollmentMeta(body) {
	if (!body || typeof body !== "object") {
		refusal("Enrollment needs a body.");
	}
	const b = /** @type {Record<string, unknown>} */ (body);
	if (!isNonEmptyString(b.homeId)) {
		refusal("Enrollment is scoped to a home.");
	}
	if (b.kind !== "face" && b.kind !== "vehicle") {
		refusal("Enrollment kind is face or vehicle.");
	}
	if (!isNonEmptyString(b.name)) {
		refusal("Every entry carries a name.");
	}
	if (b.enrolledFor !== undefined && b.enrolledFor !== "household" && b.enrolledFor !== "visit") {
		refusal("enrolledFor is household or visit.");
	}
	if (/** @type {{enrolledFor?: string}} */ (b).enrolledFor === "visit" && !isNonEmptyString(b.accountabilityNote)) {
		refusal("A visit-enrolled entry carries the enrolling member's accountability note.");
	}
	return {
		homeId: /** @type {string} */ (b.homeId),
		kind: /** @type {"face" | "vehicle"} */ (b.kind),
		name: /** @type {string} */ (b.name),
		enrolledFor: /** @type {"household" | "visit" | undefined} */ (b.enrolledFor),
		accountabilityNote: /** @type {string | undefined} */ (b.accountabilityNote),
	};
}

/**
 * Validate + normalize a trained-class label (PORCH-142). Plain-language
 * refusal on junk — the plane maps typed refusals onto 422.
 * @param {unknown} label
 * @returns {string}
 */
export function assertClassLabel(label) {
	if (!isNonEmptyString(label) || !CLASS_LABEL_RE.test(label.trim())) {
		refusal('A trained class needs a name — 1 to 48 letters, digits, spaces, or \' - & . , Characters ("a 63 Chevy Impala").');
	}
	return label.trim();
}

/**
 * Validate one exemplar descriptor row bound to a trained class.
 * @param {unknown} d
 * @returns {FaceDescriptor}
 */
export function assertExemplarDescriptor(d) {
	return assertDescriptor(d);
}

/**
 * Validate the body a watchlist train/retrain call carries (shared by
 * service + plane).
 * @param {unknown} body
 * @returns {{ homeId: string, label?: string, trackingSource?: string | null }}
 */
export function assertWatchlistBody(body) {
	if (!body || typeof body !== "object") {
		refusal("Training needs a body.");
	}
	const b = /** @type {Record<string, unknown>} */ (body);
	if (!isNonEmptyString(b.homeId)) {
		refusal("Training is scoped to a home.");
	}
	const trackingSource = typeof b.trackingSource === "string" && b.trackingSource.trim() !== ""
		? b.trackingSource.trim()
		: null;
	return {
		homeId: /** @type {string} */ (b.homeId),
		...(b.label !== undefined ? { label: assertClassLabel(b.label) } : {}),
		trackingSource,
	};
}

/**
 * @param {unknown} settings
 * @returns {boolean}
 */
export function isEntryDoc(settings) {
	return Boolean(settings && typeof settings === "object" && /** @type {{_id?: unknown}} */ (settings)._id);
}

/**
 * @typedef {{
 *   descriptor: FaceDescriptor,
 *   image: string | null,
 *   origin: "train" | "correction",
 *   at: string,
 * }} WatchExemplar
 * One uploaded example of a trained class. `descriptor` is the LOCAL
 * embedding (computed on-device via the provider's embedImage stage);
 * `image` is the example's data URL — both stay on the hub (the privacy
 * law: no training artifact or example image ever leaves it).
 *
 * @typedef {{
 *   _id: string,
 *   homeId: string,
 *   label: string,
 *   exemplars: WatchExemplar[],
 *   assertThreshold: number | null,
 *   trackingScope: "tracked" | "detection-only",
 *   trackingSource: string | null,
 *   heldReplay: { hitRate: number | null, heldOut: number, exemplars: number, at: string } | null,
 *   createdAt: string,
 *   updatedAt: string,
 * }} WatchlistClass
 * The trained-class artifact set of record: the exemplar pool IS the
 * few-shot classifier (embeddings + cosine); retraining replaces it in one
 * write. assertThreshold is the per-class calibrated bar of record —
 * null (uncalibrated) never asserts, the shared uncertainty law.
 *
 * @typedef {{
 *   _id: string,
 *   homeId: string,
 *   classId: string,
 *   label: string,
 *   decision: "asserted" | "looks-like",
 *   confidence: number,
 *   similarity: number,
 *   descriptor: FaceDescriptor,
 *   emitted: boolean,
 *   cameraId?: string,
 *   trackId?: string,
 *   eventId?: string,
 *   at: string,
 * }} TrainingDetection
 * One recorded trained-class classification of a bus-borne crop descriptor
 * (bounded ring per class). The descriptors ride ONLY as the correction
 * loop's raw material; views never surface them.
 */
