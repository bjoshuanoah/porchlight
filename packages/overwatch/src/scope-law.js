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

/** True when a detected/entity class is tracked (persons, vehicles, large objects). */
export function isTrackedClass(cls) {
	return TRACKED_CLASSES.includes(cls);
}

/** True when a class may be followed (person or vehicle only). */
export function isFollowableClass(cls) {
	return FOLLOWABLE_CLASSES.includes(cls);
}
