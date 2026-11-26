// entity-state.js — the property-entity FSM (PORCH-140 ac-1/ac-2 states).
//
// Pure functions over a PropertyEntity chain. The FSM reads the chain's own
// sighting timeline: the first sighting is an "arrival", sightings that follow
// within the movement gap are "movement" or "stationary" spans, a sighting
// that re-appears after a longer absence is a fresh "arrival", and the last
// sighting gone stale counts as "departure".
//
// Thresholds of record (each overridable per call):
// - stationaryEpsilon (default 0.02): mean squared bbox-center deviation, in
//   normalized frame units, below which a sighting carrying >= 2 position
//   samples reads "stationary". 0.02 ≈ an RMS wander of ~0.14 of the frame.
// - gapMovementSec (default 10): a gap between consecutive sightings up to
//   this many seconds — e.g. a cross-camera handoff inside the default travel
//   prior — is still one movement; a longer gap is a fresh "arrival".
// - stationaryThresholdSec (default 60): a last sighting with no later
//   activity anywhere for more than this many seconds is labeled "departure".
// - loiteringSec (default 120): a still-live stationary sighting observed
//   longer than this makes the entity LOITERING (persons only; a stationary
//   vehicle is PARKED at any duration — vehicles never loiter).
//
// Position samples are optional: chains whose sightings carry `samples`
// (normalized bboxes [x, y, w, h], centers [x, y], or objects with `bbox`)
// can establish stationarity; sightings without samples default to movement.

/** @typedef {import("./types.js").PropertyEntity} PropertyEntity */
/** @typedef {import("./types.js").EntitySighting} EntitySighting */
/** @typedef {import("./types.js").EntityStateLabel} EntityStateLabel */
/** @typedef {import("./types.js").EntityLifecycleState} EntityLifecycleState */

/** Mean squared bbox-center deviation (normalized units) for "stationary". */
export const DEFAULT_STATIONARY_EPSILON = 0.02;

/** A stationary sighting observed longer than this many seconds is LOITERING. */
export const DEFAULT_LOITERING_SEC = 120;

/** Consecutive sightings up to this many seconds apart are one movement. */
export const DEFAULT_GAP_MOVEMENT_SEC = 10;

/** A last sighting stale by more than this many seconds is a departure. */
export const DEFAULT_STATIONARY_THRESHOLD_SEC = 60;

/** State labels a sighting can carry. */
const STATE_LABELS = {
	arrival: "arrival",
	movement: "movement",
	stationary: "stationary",
	departure: "departure",
};

/** @returns {number} epoch seconds on the host clock */
function defaultNow() {
	return Date.now() / 1000;
}

/**
 * Position samples of a sighting (optional FSM augmentation of EntitySighting:
 * an optional `samples` field — bboxes, centers, or objects with `bbox`).
 *
 * @param {EntitySighting} sighting
 * @returns {unknown[]}
 */
function samplesOf(sighting) {
	return /** @type {{samples?: unknown[]}} */ (sighting).samples ?? [];
}

/** @param {unknown} sample @returns {[number, number]|null} bbox center */
function sampleCenter(sample) {
	if (Array.isArray(sample) && sample.length >= 4) {
		return [sample[0] + sample[2] / 2, sample[1] + sample[3] / 2];
	}
	if (Array.isArray(sample) && sample.length === 2) return [sample[0], sample[1]];
	if (sample && typeof sample === "object" && Array.isArray(sample.bbox) && sample.bbox.length === 4) {
		return [sample.bbox[0] + sample.bbox[2] / 2, sample.bbox[1] + sample.bbox[3] / 2];
	}
	return null;
}

/**
 * Mean squared deviation of the sample centers from their mean, in normalized
 * frame units. Infinity when fewer than 2 usable samples — stationarity needs
 * at least two positions to compare ("over >= 2 samples").
 *
 * @param {unknown[]|undefined} samples
 * @returns {number}
 */
export function positionVariance(samples) {
	const centers = (samples ?? []).map(sampleCenter).filter((center) => center !== null);
	if (centers.length < 2) return Number.POSITIVE_INFINITY;
	let meanX = 0;
	let meanY = 0;
	for (const [x, y] of centers) {
		meanX += x;
		meanY += y;
	}
	meanX /= centers.length;
	meanY /= centers.length;
	let acc = 0;
	for (const [x, y] of centers) acc += (x - meanX) ** 2 + (y - meanY) ** 2;
	return acc / centers.length;
}

/** @param {EntitySighting} sighting @param {number} epsilon */
function isStationary(sighting, epsilon) {
	return samplesOf(sighting).length >= 2 && positionVariance(samplesOf(sighting)) < epsilon;
}

/**
 * @param {PropertyEntity} chain
 * @param {EntitySighting[]} ordered sightings sorted chronologically
 * @param {number} at epoch seconds
 * @param {{stationaryEpsilon: number, loiteringSec: number, gapMovementSec: number, stationaryThresholdSec: number}} t thresholds
 * @returns {EntityStateLabel[]} one label per sighting, same order
 */
function labelSightings(chain, ordered, at, t) {
	return ordered.map((sighting, i) => {
		if (i === ordered.length - 1 && at - sighting.t1 > t.stationaryThresholdSec) {
			return STATE_LABELS.departure;
		}
		if (i === 0) return STATE_LABELS.arrival;
		const gap = sighting.t0 - ordered[i - 1].t1;
		if (gap > t.gapMovementSec) return STATE_LABELS.arrival;
		if (isStationary(sighting, t.stationaryEpsilon)) return STATE_LABELS.stationary;
		return STATE_LABELS.movement;
	});
}

/**
 * Live lifecycle state: derived from the newest sighting's label + position +
 * activity recency. DEPARTED (stale last sighting) wins; a still-active
 * positionally-stationary sighting reads PARKED (vehicle) or STATIONARY →
 * LOITERING past `loiteringSec` (person); otherwise the newest label maps
 * arrival → ARRIVED and movement → MOVING.
 *
 * @param {PropertyEntity} chain
 * @param {EntitySighting[]} ordered sightings sorted chronologically
 * @param {EntityStateLabel[]} labels labels per sighting (same order)
 * @param {number} at epoch seconds
 * @param {{stationaryEpsilon: number, loiteringSec: number}} t thresholds
 * @returns {EntityLifecycleState}
 */
function deriveEntityState(chain, ordered, labels, at, { stationaryEpsilon, loiteringSec }) {
	if (ordered.length === 0) return "DEPARTED";
	const last = ordered[ordered.length - 1];
	const newestLabel = labels[labels.length - 1];
	if (newestLabel === STATE_LABELS.departure) return "DEPARTED";
	if (isStationary(last, stationaryEpsilon)) {
		if (chain.cls === "vehicle") return "PARKED";
		if (at - last.t0 > loiteringSec) return "LOITERING";
		return "STATIONARY";
	}
	if (newestLabel === STATE_LABELS.movement) return "MOVING";
	return "ARRIVED";
}

/**
 * Per-sighting FSM labels, ordered chronologically, plus the live lifecycle
 * state of the chain. Label precedence for one sighting: a last sighting
 * stale beyond `stationaryThresholdSec` is "departure"; a first sighting (or
 * one re-appearing after a gap longer than `gapMovementSec`) is "arrival";
 * low bbox variance over >= 2 samples is "stationary"; everything else that
 * continues within the gap window is "movement".
 *
 * @param {PropertyEntity} chain
 * @param {{now?: number, stationaryEpsilon?: number, loiteringSec?: number, gapMovementSec?: number, stationaryThresholdSec?: number}} [options]
 * @returns {{sightings: Array<EntitySighting & {state: EntityStateLabel}>, entityState: EntityLifecycleState}}
 */
export function statesOf(chain, options = {}) {
	const {
		now,
		stationaryEpsilon = DEFAULT_STATIONARY_EPSILON,
		loiteringSec = DEFAULT_LOITERING_SEC,
		gapMovementSec = DEFAULT_GAP_MOVEMENT_SEC,
		stationaryThresholdSec = DEFAULT_STATIONARY_THRESHOLD_SEC,
	} = options;
	const at = now ?? defaultNow();
	const ordered = [...(chain?.sightings ?? [])].sort((a, b) => (a.t0 - b.t0) || (a.t1 - b.t1));
	const labels = ordered.length === 0 ? [] : labelSightings(chain, ordered, at, { stationaryEpsilon, gapMovementSec, stationaryThresholdSec });
	const sightings = ordered.map((sighting, i) => ({ ...sighting, state: labels[i] }));
	const entityState = deriveEntityState(chain, ordered, labels, at, { stationaryEpsilon, loiteringSec });
	return { sightings, entityState };
}

/**
 * Current single state string for the chain at epoch seconds `at`
 * (defaults to the host clock when omitted).
 *
 * @param {PropertyEntity} chain
 * @param {number} [at]
 * @returns {EntityLifecycleState}
 */
export function liveState(chain, at) {
	return statesOf(chain, { now: at }).entityState;
}
