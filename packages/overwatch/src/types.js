// types.js — PORCH-126 spike contracts.
//
// The engine's DetectedObject bus contract is defined by PORCH-I-009 TS 3; it is
// not part of this repository yet. The spike consumes the minimum fields that
// contract guarantees are available on every bus detection, plus one optional
// ReID descriptor the spike's capture harness attaches per crop. Field-level
// mapping notes live in docs/overwatch-cross-camera-spike.md so the production
// engine integration can align them without a rewrite.

/**
 * One engine detection on the per-camera bus stream.
 *
 * @typedef {object} DetectedObject
 * @property {string} camera      engine camera id (keys the zone graph)
 * @property {string} trackId     per-camera track id from the engine detector
 * @property {string} cls         engine class label ("person", "car", ...)
 * @property {number} conf        detector confidence 0..1
 * @property {[number, number, number, number]} bbox normalized [x, y, w, h] 0..1
 * @property {number} t           epoch seconds on the hub clock
 * @property {number[]|undefined} [reid]  optional appearance descriptor (unit-ish
 *   length vector; the spike's harness emits 38 dims: 3x12 hue/sat hist + 2
 *   shape ratios; production replaces this with the vision-encoder embedding)
 */

/**
 * A closed per-camera track assembled from the stream, before correlation.
 *
 * @typedef {object} CameraTrack
 * @property {string} camera
 * @property {string} trackId
 * @property {string} cls
 * @property {number} seq   occurrence sequence assigned by the service
 * @property {number} t0   first seen
 * @property {number} t1   last seen
 * @property {DetectedObject[]} objects   every stream sample in the track
 * @property {number[]|undefined} reid    appearance descriptor mean (undefined
 *   when the stream carried no reid data)
 * @property {boolean} closed
 */

/**
 * Zone-handoff record between two cameras inside one entity chain.
 *
 * @typedef {object} ZoneHandoff
 * @property {string} fromCamera
 * @property {string} toCamera
 * @property {number} fromT    exit time on the from-camera
 * @property {number} toT      entry time on the to-camera
 * @property {number} gapSec   toT - fromT
 * @property {number} score    correlation score the join was accepted at
 * @property {DetectedObject} exitObject   last sample of the exiting track
 * @property {DetectedObject} entryObject  first sample of the entering track
 */

/**
 * One entity sighting: a per-camera track (or track fragment) attributed to
 * one property entity, with the handoff evidence when it entered from an
 * adjacent camera.
 *
 * @typedef {object} EntitySighting
 * @property {string} camera
 * @property {string} trackId
 * @property {number} t0
 * @property {number} t1
 * @property {number} sampleCount
 * @property {string|undefined} [cls]
 * @property {number|undefined} [seq]  occurrence sequence (spike evaluation)
 * @property {ZoneHandoff|undefined} [handoff]
 */

/**
 * PropertyEntity event chain: one entity, one trajectory, many camera
 * appearances (PORCH-I-010 TS 1 outputs).
 *
 * @typedef {object} PropertyEntity
 * @property {string} entityId
 * @property {string} cls          dominant class across sightings
 * @property {number} t0           chain start
 * @property {number} t1           chain end
 * @property {EntitySighting[]} sightings   ordered chronologically
 */

/**
 * Correlation configuration. Adjacency and travel-time priors are deployment
 * inputs (PORCH-I-010 TS 1: authored by the owner, never inferred); the spike
 * harness writes them like the coverage-zone surface eventually will.
 *
 * @typedef {object} CorrelationConfig
 * @property {ReadonlyArray<readonly [string, string]>} adjacency
 *   unordered camera-id pairs whose coverage zones touch; only these pairs may
 *   produce cross-camera joins.
 * @property {Record<string, {min: number, max: number}>} [travelTime]
 *   per ordered pair key "a|b" handoff gap prior in seconds ({min,max}); pairs
 *   absent get DEFAULT_TRAVEL_TIME.
 * @property {Record<string, Partial<Record<string, "left"|"right"|"top"|"bottom"|"any">>>} [overlapSide]
 *   per pair key "a|b", per camera id, which edge of that camera's frame the
 *   shared overlap touches; absent entries are "any" (no spatial evidence).
 * @property {number} [edgeGate]       0..1 max distance of exit/entry from the
 *   shared-overlap side hint (0.5 by default).
 * @property {number} [joinThreshold]  correlation score minimum to merge.
 * @property {number} [trackIdleSec]   per-camera track closes after no samples
 *   for this long.
 * @property {number} [appearanceWeight]
 * @property {number} [timingWeight]
 * @property {number} [spatialWeight]
 */

/** Default travel-time prior for adjacent pairs with no authored entry. */
export const DEFAULT_TRAVEL_TIME = { min: 0, max: 10 };

/** Track-close idle threshold default: the engine's per-camera track ids are
 * stable for an object's lifetime and are only recycled after a long absence,
 * so a gap shorter than this is treated as the same ongoing track. */
export const DEFAULT_TRACK_IDLE_SEC = 15;

/** Correlation score floor default. */
export const DEFAULT_JOIN_THRESHOLD = 0.5;

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
	if (!Array.isArray(o.bbox) || o.bbox.length !== 4 || o.bbox.some((c) => typeof c !== "number")) {
		throw new TypeError("DetectedObject.bbox must be [x, y, w, h] numbers");
	}
	const [x, y, w, h] = o.bbox;
	if (x < 0 || y < 0 || w < 0 || h < 0 || x + w > 1 + 1e-9 || y + h > 1 + 1e-9) {
		throw new TypeError("DetectedObject.bbox must be normalized within [0,1]");
	}
	if (o.reid !== undefined && !Array.isArray(o.reid)) {
		throw new TypeError("DetectedObject.reid, when present, must be a number[]");
	}
}

// --- PORCH-140 entity-surface contracts (added by the entity-FSM wave) ---

/**
 * FSM label of one sighting within its chain: the first sighting (or one
 * re-appearing after a longer absence) is "arrival"; sightings continuing
 * within the movement gap are "movement" or "stationary"; the last sighting
 * gone stale by no later activity is "departure".
 *
 * @typedef {"arrival"|"movement"|"stationary"|"departure"} EntityStateLabel
 */

/**
 * Live lifecycle state of a chain, derived from the newest sighting's label
 * plus activity recency. A stationary vehicle is PARKED; a stationary person
 * observed past the loitering threshold is LOITERING.
 *
 * @typedef {"ARRIVED"|"MOVING"|"STATIONARY"|"PARKED"|"DEPARTED"|"LOITERING"} EntityLifecycleState
 */

/**
 * Optional position samples for the entity FSM, carried as a `samples` field
 * on an EntitySighting (EntitySighting itself is unchanged): normalized
 * bboxes [x, y, w, h] 0..1, center points [x, y], or objects with `bbox`.
 * Stationarity needs at least two usable samples.
 *
 * @typedef {[number, number, number, number]|[number, number]|{bbox: [number, number, number, number]}} EntityStateSample
 */
