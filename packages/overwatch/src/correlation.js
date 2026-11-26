// correlation.js — PORCH-126 spike correlation core (pure functions).
//
// Approach per the task directive: ReID appearance features + the zone handoff
// matrix (adjacency) + timing priors, scored per cross-camera candidate pair.
// Weak evidence keeps sightings separate (ambiguity law): temporal feasibility
// gates the candidate, appearance can veto a join, and below the join
// threshold nothing merges.

import { DEFAULT_TRAVEL_TIME } from "./types.js";

/**
 * @typedef {import("./types.js").DetectedObject} DetectedObject
 * @typedef {import("./types.js").CameraTrack} CameraTrack
 * @typedef {import("./types.js").CorrelationConfig} CorrelationConfig
 */

/** @param {string} a @param {string} b */
export function pairKey(a, b) {
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Travel-time prior for an unordered camera pair.
 *
 * @param {CorrelationConfig} config
 * @param {string} a @param {string} b
 * @returns {{min: number, max: number}}
 */
export function travelPrior(config, a, b) {
	return config.travelTime?.[pairKey(a, b)] ?? DEFAULT_TRAVEL_TIME;
}

/**
 * Side hint of `camera` toward the shared overlap with `other` ("left",
 * "right", "top", "bottom" from that camera's own frame, or "any").
 *
 * @param {CorrelationConfig} config
 * @param {string} camera @param {string} other
 */
export function overlapSide(config, camera, other) {
	return config.overlapSide?.[pairKey(camera, other)]?.[camera] ?? "any";
}

/**
 * Normalized distance of a point from the named image side (0 = on the edge).
 *
 * @param {[number, number]} point
 * @param {"left"|"right"|"top"|"bottom"|"any"} side
 */
export function distanceToSide(point, side) {
	const [cx, cy] = point;
	switch (side) {
		case "left":
			return cx;
		case "right":
			return 1 - cx;
		case "top":
			return cy;
		case "bottom":
			return 1 - cy;
		default:
			return 0;
	}
}

/**
 * Cosine similarity guarded for missing/mismatched descriptors.
 *
 * @param {number[]|undefined} a @param {number[]|undefined} b
 */
export function cosine(a, b) {
	if (!a || !b || a.length !== b.length || a.length === 0) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) return 0;
	return Math.max(0, dot / (Math.sqrt(na) * Math.sqrt(nb)));
}

/** @param {DetectedObject} object @returns {[number, number]} */
export function bboxCenter(object) {
	const [x, y, w, h] = object.bbox;
	return [x + w / 2, y + h / 2];
}

/**
 * Correlation of one cross-camera candidate: an exiting track in one camera
 * and an entering track in an adjacent camera.
 *
 * @param {CorrelationConfig} config
 * @param {CameraTrack} exitTrack
 * @param {CameraTrack} entryTrack
 * @returns {{score: number, temporal: number, spatial: number, appearance: number, appearanceKnown: boolean, rejected: string|undefined}}
 */
export function correlate(config, exitTrack, entryTrack) {
	const gap = entryTrack.t0 - exitTrack.t1;
	const prior = travelPrior(config, exitTrack.camera, entryTrack.camera);
	const slack = JOIN_SLACK_SEC;
	if (gap < -slack) return reject("entry precedes exit beyond simultaneity slack");
	if (gap > prior.max + slack) return reject("gap exceeds travel-time prior");

	const temporal = gap <= 0 ? 1 : Math.max(0, 1 - (gap - prior.min) / Math.max(0.001, prior.max - prior.min));

	const exitSide = overlapSide(config, exitTrack.camera, entryTrack.camera);
	const entrySide = overlapSide(config, entryTrack.camera, exitTrack.camera);
	const exitObject = exitTrack.objects.at(-1);
	const entryObject = entryTrack.objects.at(0);
	const exitDist = exitObject ? distanceToSide(bboxCenter(exitObject), exitSide) : 1;
	const entryDist = entryObject ? distanceToSide(bboxCenter(entryObject), entrySide) : 1;
	const spatial = 1 - Math.max(0, Math.min(1, (exitDist + entryDist) / 2));

	const appearance = cosine(exitTrack.reid, entryTrack.reid);
	const appearanceKnown = !!(exitTrack.reid && entryTrack.reid);

	// Only gate when the deployment hinted the sides (an "any" hint carries no
	// spatial evidence, so spatial must not veto either).
	const edgeGate = config.edgeGate ?? 0.5;
	if (exitSide !== "any" && entrySide !== "any" && exitDist > edgeGate && entryDist > edgeGate) {
		return { score: 0, temporal, spatial, appearance, appearanceKnown, rejected: "exit and entry sit away from the shared-overlap side" };
	}

	// Appearance veto: two descriptors known to be dissimilar keep the
	// sightings separate no matter how well the timing fits.
	const appearanceFloor = config.appearanceVetoFloor ?? 0.35;
	if (appearanceKnown && appearance < appearanceFloor) {
		return { score: 0, temporal, spatial, appearance, appearanceKnown, rejected: "appearance below veto floor" };
	}

	const spatialWeight = config.spatialWeight ?? 0.5;
	const timingWeight = config.timingWeight ?? 0.3;
	const appearanceWeight = config.appearanceWeight ?? 0.2;
	const totalWeight = spatialWeight + timingWeight + (appearanceKnown ? appearanceWeight : 0);
	const weighted = spatial * spatialWeight + temporal * timingWeight;
	const score = appearanceKnown ? (weighted + appearance * appearanceWeight) / totalWeight : weighted / totalWeight;

	const joinThreshold = config.joinThreshold ?? DEFAULT_JOIN_THRESHOLD;
	if (score < joinThreshold) {
		return { score, temporal, spatial, appearance, appearanceKnown, rejected: "score below join threshold" };
	}
	return { score, temporal, spatial, appearance, appearanceKnown, rejected: undefined };

	/**
	 * @param {string} why
	 * @returns {{score: number, temporal: number, spatial: number, appearance: number, appearanceKnown: boolean, rejected: string|undefined}}
	 */
	function reject(why) {
		return { score: 0, temporal: 0, spatial: 0, appearance: 0, appearanceKnown: false, rejected: why };
	}
}

const JOIN_SLACK_SEC = 2;
const DEFAULT_JOIN_THRESHOLD = 0.5;
