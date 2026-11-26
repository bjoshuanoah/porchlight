// scope-law.js — the tracking scope law (PORCH-140 ac-3): the entity layer
// only sees objects in the tracked class set. Everything else the detector
// emits stays a raw detection and never becomes a track, a sighting, or a
// property entity. This module is the single choke point over the scope
// constants (src/scope.js); services consume the predicates below.

import { TRACKED_CLASSES, FOLLOWABLE_CLASSES } from "./scope.js";

/**
 * @typedef {import("./types.js").DetectedObject} DetectedObject
 */

/** True when `detectedObject`'s class belongs in the tracked scope. */
export function filterTracked(detectedObject) {
	return isTrackedClass(detectedObject.cls);
}

/**
 * PORCH-142: the trained tracked-vocabulary extension. A watchlist class the
 * household trains with trackingScope "tracked" joins the tracked set for
 * the entity layer — the static constants stay the base of record, and the
 * extension holds ONLY what a trained class added. The vocabulary arrives
 * as the fresh full list on every change (extend), so a deleted class stops
 * tracking without a removal call and the hub never ships a stale label
 * into the entity plane.
 */
const extension = new Set();

/** True when a detected/entity class is tracked (persons, vehicles, large objects, trained tracked classes). */
export function isTrackedClass(cls) {
	return TRACKED_CLASSES.includes(cls) || extension.has(cls);
}

/**
 * PORCH-142: replace the trained tracked-vocabulary extension with `labels`
 * (the recognition plane's trackedTrainedLabels() result of record).
 */
export function extendTrackedVocabulary(labels) {
	extension.clear();
	for (const label of Array.isArray(labels) ? labels : []) {
		if (typeof label === "string" && label.trim() !== "") extension.add(label);
	}
}

/** PORCH-142: clear the trained extension (hub cold boot + test isolation). */
export function resetTrackedVocabulary() {
	extension.clear();
}

/** True when a class may be followed (person or vehicle only). */
export function isFollowableClass(cls) {
	return FOLLOWABLE_CLASSES.includes(cls);
}
