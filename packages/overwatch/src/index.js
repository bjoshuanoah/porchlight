// index.js — public surface of the PORCH-126 spike package.

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
