// config-store.js — the overwatch dial config of record (PORCH-140 ac-6).
//
// One versioned JSON document, atomically persisted (tmp file + rename in the
// target directory, same pattern as packages/config/src/store.js: a crash
// window leaves either the old or the new complete document). Zone law: zones
// are owner-authored only — this store never infers, derives, or broadens a
// coverage zone; a camera without an authored zone is never zone-eligible.
//
// Single source of truth: `adjacency` and `travelTime` live ONLY at the top
// level of the document. `correlationConfig()` derives the CorrelationConfig
// consumed by EntityMergeService from them plus the correlation tuning block;
// the persisted `correlation` object therefore carries no duplicate copies.

import fsDefault from "node:fs";
import pathDefault from "node:path";
import { pairKey as sortedPairKey } from "./correlation.js";

/** The document schema version this store reads and writes. */
export const CONFIG_VERSION = 1;

export class ConfigValidationError extends Error {
	/**
	 * @param {string} message plain-language statement of what is wrong
	 */
	constructor(message) {
		super(message);
		this.name = "ConfigValidationError";
	}
}

/** @param {unknown} v @returns {v is number} */
function isFiniteNumber(v) {
	return typeof v === "number" && Number.isFinite(v);
}

/** @param {unknown} v @returns {v is string} */
function isNonEmptyString(v) {
	return typeof v === "string" && v.trim() !== "";
}

/**
 * Recursively read camera ids that carry an authored coverage zone.
 * Internal: validated zones only, so a plain read needs no re-validation.
 * @param {{ coverageZones: Array<{ cameraId: string }> }} doc
 */
function zoneCameraIds(doc) {
	return doc.coverageZones.map((z) => z.cameraId);
}

/**
 * Validate the whole document. Throws ConfigValidationError naming the exact
 * offending field; never mutates its input.
 * @param {unknown} doc
 */
function validateDocument(doc) {
	if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
		throw new ConfigValidationError("config document must be a JSON object");
	}
	const d = /** @type {Record<string, unknown>} */ (doc);
	if (d.configVersion !== CONFIG_VERSION) {
		throw new ConfigValidationError(
			`configVersion must be ${CONFIG_VERSION} (got ${JSON.stringify(d.configVersion)})`,
		);
	}
	if (!isNonEmptyString(d.updatedAt)) {
		throw new ConfigValidationError("updatedAt must be a non-empty ISO timestamp string");
	}

	const zones = d.coverageZones;
	if (!Array.isArray(zones)) {
		throw new ConfigValidationError("coverageZones must be an array of zone objects");
	}
	const seenCameras = new Set();
	for (const zone of zones) {
		if (!zone || typeof zone !== "object" || Array.isArray(zone)) {
			throw new ConfigValidationError("each coverage zone must be an object");
		}
		const z = /** @type {Record<string, unknown>} */ (zone);
		if (!isNonEmptyString(z.cameraId)) {
			throw new ConfigValidationError("each coverage zone needs a non-empty cameraId string");
		}
		if (seenCameras.has(z.cameraId)) {
			throw new ConfigValidationError(
				`coverage zone for camera "${z.cameraId}" appears twice — one zone per camera`,
			);
		}
		seenCameras.add(z.cameraId);
		const polygon = z.polygon;
		if (!Array.isArray(polygon) || polygon.length < 3) {
			throw new ConfigValidationError(
				`zone polygon for camera "${z.cameraId}" needs at least 3 points`,
			);
		}
		for (const point of polygon) {
			if (
				!Array.isArray(point) ||
				point.length !== 2 ||
				!isFiniteNumber(point[0]) ||
				!isFiniteNumber(point[1])
			) {
				throw new ConfigValidationError(
					`zone polygon for camera "${z.cameraId}" must be [x, y] finite number pairs in map coordinates (meters)`,
				);
			}
		}
		for (const field of ["authoredAt", "authoredBy"]) {
			if (z[field] !== undefined && z[field] !== null && !isNonEmptyString(z[field])) {
				throw new ConfigValidationError(`zone ${field} must be a non-empty string when present`);
			}
		}
	}

	const adjacency = d.adjacency;
	if (!Array.isArray(adjacency)) {
		throw new ConfigValidationError("adjacency must be an array of camera-id pairs");
	}
	for (const pair of adjacency) {
		if (!Array.isArray(pair) || pair.length !== 2) {
			throw new ConfigValidationError(
				`adjacency entry ${JSON.stringify(pair)} must be a [cameraId, cameraId] pair`,
			);
		}
		const [a, b] = pair;
		if (!isNonEmptyString(a) || !isNonEmptyString(b)) {
			throw new ConfigValidationError(
				`adjacency pair ${JSON.stringify(pair)} needs two non-empty camera ids`,
			);
		}
		if (a === b) {
			throw new ConfigValidationError(`adjacency pair ["${a}", "${b}"] is a self-pair`);
		}
	}

	const travelTime = d.travelTime;
	if (!travelTime || typeof travelTime !== "object" || Array.isArray(travelTime)) {
		throw new ConfigValidationError("travelTime must be an object keyed by sorted pair keys");
	}
	for (const [key, prior] of Object.entries(
		/** @type {Record<string, unknown>} */ (travelTime),
	)) {
		const [a, b] = key.split("|");
		if (!isNonEmptyString(a) || !isNonEmptyString(b) || sortedPairKey(a, b) !== key) {
			throw new ConfigValidationError(
				`travelTime key "${key}" must use the sorted pair form "a|b" (a < b)`,
			);
		}
		if (!prior || typeof prior !== "object") {
			throw new ConfigValidationError(`travelTime["${key}"] must be { min, max } in seconds`);
		}
		const priorRec = /** @type {Record<string, unknown>} */ (prior);
		if (!isFiniteNumber(priorRec.min) || !isFiniteNumber(priorRec.max)) {
			throw new ConfigValidationError(`travelTime["${key}"] min and max must be finite numbers`);
		}
		if (priorRec.min < 0 || priorRec.max < 0) {
			throw new ConfigValidationError(`travelTime["${key}"] values must be >= 0 seconds`);
		}
		if (priorRec.min > priorRec.max) {
			throw new ConfigValidationError(
				`travelTime["${key}"] min (${priorRec.min}) must be <= max (${priorRec.max})`,
			);
		}
	}

	const dial = d.dial;
	if (!dial || typeof dial !== "object" || Array.isArray(dial)) {
		throw new ConfigValidationError("dial must be an object");
	}
	const dialRec = /** @type {Record<string, unknown>} */ (dial);
	if (!isFiniteNumber(dialRec.frameRate)) {
		throw new ConfigValidationError("dial.frameRate must be a number");
	}
	if (dialRec.frameRate < 1) {
		throw new ConfigValidationError("dial.frameRate must be >= 1 fps");
	}
	if (!Array.isArray(dialRec.activeCameraIds) || dialRec.activeCameraIds.some((id) => !isNonEmptyString(id))) {
		throw new ConfigValidationError("dial.activeCameraIds must be an array of camera-id strings");
	}

	const correlation = d.correlation;
	if (!correlation || typeof correlation !== "object" || Array.isArray(correlation)) {
		throw new ConfigValidationError("correlation must be an object");
	}
	const corrRec = /** @type {Record<string, unknown>} */ (correlation);
	for (const field of ["trackIdleSec", "joinThreshold", "appearanceOverrideFloor", "appearanceVetoFloor"]) {
		if (!isFiniteNumber(corrRec[field]) || corrRec[field] < 0) {
			throw new ConfigValidationError(`correlation.${field} must be a finite number >= 0`);
		}
	}
	if (!Array.isArray(corrRec.separatePairs)) {
		throw new ConfigValidationError("correlation.separatePairs must be an array of pair signatures");
	}
	if (Array.isArray(corrRec.separatePairs) && corrRec.separatePairs.some((s) => typeof s !== "string")) {
		throw new ConfigValidationError("correlation.separatePairs entries must be strings");
	}
}

/**
 * Normalizing deep copy of a document for in-memory state: adjacency entries
 * sorted inside the pair, adjacency list deduped (first occurrence wins).
 * @param {Record<string, unknown>} doc live mutable document
 */
function normalizeDocument(doc) {
	const seen = new Set();
	const normalizedPairs = [];
	for (const [a, b] of doc.adjacency) {
		const pair = a < b ? [a, b] : [b, a];
		const key = sortedPairKey(a, b);
		if (!seen.has(key)) {
			seen.add(key);
			normalizedPairs.push(pair);
		}
	}
	doc.adjacency = normalizedPairs;
}

/**
 * @param {{
 *   path: string,
 *   now?: () => string,
 *   defaults?: object,
 * }} options
 */
export function createConfigStore({ path, now = () => new Date().toISOString(), defaults = {} }) {
	/** @type {Record<string, unknown>} */
	let doc;

	/** Baseline document: the contract shape with zero-authored content. */
	function defaultDocument() {
		return {
			configVersion: CONFIG_VERSION,
			updatedAt: now(),
			coverageZones: [],
			adjacency: [],
			travelTime: {},
			dial: { frameRate: 5, activeCameraIds: [] },
			correlation: {
				trackIdleSec: 15,
				joinThreshold: 0.5,
				appearanceOverrideFloor: 0.5,
				appearanceVetoFloor: 0.2,
				separatePairs: [],
			},
			...defaults,
		};
	}

	/**
	 * Atomic persist: write to a tmp file in the target's directory, then
	 * rename over it. Rename within one filesystem is the atomic step.
	 * @param {Record<string, unknown>} document
	 */
	function persist(document) {
		fsDefault.mkdirSync(pathDefault.dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
		fsDefault.writeFileSync(tmp, `${JSON.stringify(document, null, "\t")}\n`, "utf8");
		fsDefault.renameSync(tmp, path);
	}

	function loadFromDisk() {
		let raw;
		try {
			raw = fsDefault.readFileSync(path, "utf8");
		} catch (error) {
			if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return null;
			throw error;
		}
		try {
			return JSON.parse(raw);
		} catch {
			throw new ConfigValidationError(`${path}: file exists but is not valid JSON`);
		}
	}

	{
		const loaded = loadFromDisk();
		doc = loaded ?? defaultDocument();
		if (loaded === null) persist(doc);
		validateDocument(doc);
		normalizeDocument(doc);
	}

	/**
	 * @param {((draft: object) => void) | object} mutation patch object or in-place mutator
	 * @returns {object} the new live state
	 */
	function update(mutation) {
		const previous = doc;
		const draft = structuredClone(previous);
		if (typeof mutation === "function") {
			mutation(draft);
		} else if (mutation && typeof mutation === "object") {
			Object.assign(draft, structuredClone(mutation));
		} else {
			throw new ConfigValidationError("update() needs a mutator function or a patch object");
		}
		draft.configVersion = CONFIG_VERSION;
		validateDocument(draft);
		normalizeDocument(draft);
		draft.updatedAt = now();
		persist(draft);
		doc = draft;
		return structuredClone(doc);
	}

	return {
		/** @returns {object} the live document (defensive copy) */
		getState() {
			return structuredClone(doc);
		},

		/**
		 * @param {((draft: object) => void) | object} mutation
		 * @returns {object} the new live state
		 * @throws {ConfigValidationError} when the mutated state is invalid — nothing persists
		 */
		update,

		/** Re-read the document from disk (the restart / external-change path). */
		reload() {
			const loaded = loadFromDisk();
			if (loaded === null) {
				throw new ConfigValidationError(`${path}: document file disappeared — cannot reload`);
			}
			validateDocument(loaded);
			doc = loaded;
			normalizeDocument(doc);
			return structuredClone(doc);
		},

		/**
		 * @param {string} cameraId owner-authored zone for one camera
		 * @param {Array<[number, number]>} polygon map coordinates (meters)
		 * @param {{ authoredBy?: string }} [meta]
		 */
		setZone(cameraId, polygon, meta = {}) {
			return update((draft) => {
				const zone = {
					cameraId,
					polygon: polygon.map((p) => [p[0], p[1]]),
					authoredAt: now(),
					authoredBy: meta.authoredBy ?? null,
				};
				const existing = draft.coverageZones.findIndex((z) => z.cameraId === cameraId);
				if (existing >= 0) draft.coverageZones[existing] = zone;
				else draft.coverageZones.push(zone);
			});
		},

		/** @param {string} cameraId */
		removeZone(cameraId) {
			return update((draft) => {
				draft.coverageZones = draft.coverageZones.filter((z) => z.cameraId !== cameraId);
			});
		},

		/** Camera ids WITH an authored zone — others are never zone-eligible. */
		eligibleCameraIds() {
			return zoneCameraIds(doc);
		},

		/**
		 * Derive a CorrelationConfig for EntityMergeService from the single
		 * top-level source plus the correlation tuning block.
		 */
		correlationConfig() {
			const corr = doc.correlation;
			return {
				adjacency: structuredClone(doc.adjacency),
				travelTime: structuredClone(doc.travelTime),
				trackIdleSec: corr.trackIdleSec,
				joinThreshold: corr.joinThreshold,
				appearanceOverrideFloor: corr.appearanceOverrideFloor,
				appearanceVetoFloor: corr.appearanceVetoFloor,
				separatePairs: structuredClone(corr.separatePairs),
			};
		},
	};
}
