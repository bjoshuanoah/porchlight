// index.js — public surface of the @porchlight/recognition package
// (PORCH-141, People & Things).

// Contracts + shapes of record.
export {
	FACE_ID_PREFIX,
	VEHICLE_ID_PREFIX,
	SIGHTINGS_CAP,
	assertDescriptor,
	assertEnrollmentMeta,
	assertFrame,
	normalizePlateText,
} from "./types.js";

// The uncertainty law: cosine, the decision, the uncalibrated posture.
export {
	DEFAULT_LOOKS_LIKE_FLOOR,
	UNCALIBRATED_ASSERT_THRESHOLD,
	CALIBRATION_HINT_COSINE,
	bestMatch,
	cosine,
	decide,
} from "./gallery.js";

// The local pipeline seam + the zero-computation metrics (ac-4).
export { createRecognitionPipeline, RecognitionMetrics, VisionProviderRegistry } from "./pipeline.js";

// The registry store service (entries, switch of record, purge, export).
export {
	AUDIT_TYPES,
	COLLECTIONS,
	RegistryError,
	createRegistryService,
} from "./registry.js";

// The audit trail of record (toggles, calibration, enrollment, purges).
export { createAuditLog } from "./audit.js";

// The orchestrator (enrollment, gallery match, recognition runs).
export { createRecognitionService, createUpstreamRecognitionGate } from "./recognition.js";
