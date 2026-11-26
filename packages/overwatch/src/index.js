// index.js — public surface of the @porchlight/overwatch package.

export { EntityMergeService } from "./service.js";
export {
	correlate,
	cosine,
	overlapSide,
	pairKey,
	travelPrior,
} from "./correlation.js";
export {
	DEFAULT_JOIN_THRESHOLD,
	DEFAULT_TRACK_IDLE_SEC,
	DEFAULT_TRAVEL_TIME,
	assertDetectedObject,
} from "./types.js";

// PORCH-140: scope law constants of record.
export { TRACKED_CLASSES, FOLLOWABLE_CLASSES } from "./scope.js";

// PORCH-140: dial config of record (ac-6).
export { createConfigStore, ConfigValidationError, CONFIG_VERSION } from "./config-store.js";

// PORCH-140: audit log (F3/F12).
export { createAuditLog } from "./audit.js";

// PORCH-140: composite dial (ac-4).
export {
	DEFAULT_BENCHMARK_CAP_FPS,
	BUMP_DELTA_FPS,
	createDial,
} from "./dial.js";
export {
	DEFAULT_LAYOUT_VERSION,
	TILE_MAX_WIDTH,
	MissingFrameError,
	LayoutStabilityError,
	createCompositeEvaluator,
	createCompositeScheduler,
	buildLayout,
	stitchComposite,
	resolveAnnotation,
} from "./compositor.js";

// PORCH-140: entity plane (ac-1/ac-2/ac-3/ac-5).
// (EntityLifecycleState / EntityStateLabel are JSDoc typedefs on types.js —
// type-only, no runtime values to re-export.)
export { filterTracked, isTrackedClass, isFollowableClass } from "./scope-law.js";
// PORCH-142: the trained tracked-vocabulary extension seam.
export { extendTrackedVocabulary, resetTrackedVocabulary } from "./scope-law.js";
export { liveState, statesOf } from "./entity-state.js";
export { createTrackedObjectsService } from "./tracked.js";
export { createFollowService } from "./follow.js";
// (openVisitSurface is a method on the visit service, not a module function.)
export { createVisitService, visitIdFor } from "./visits.js";
