// index.js — public surface of @porchlight/transcript (PORCH-155).

export {
	RECORD_STATES,
	SOURCE_TYPES,
	METHOD_CLASSES,
	ROLLING_CADENCE_BUDGET_MS,
	ROLLING_WINDOW_MS,
	EVENT_CHUNK_MS,
	ValidationError,
	assertCameraId,
	assertTranscriptRecord,
	assertVectorPayload,
	rollingRefOf,
	eventRefOf,
} from "./types.js";
export { resolveTranscriptionMethod, validateMethodDoc, BUILTIN_METHOD } from "./resolve.js";
export { RollingWindower } from "./windower.js";
export { TranscriptStore, dateKeyOf } from "./store.js";
export { LocalVectorStore, vectorIdOf } from "./vector.js";
export { OpenAiSpecEmbedder, LocalServerEmbedder, UnwiredEmbedder } from "./embedder.js";
export { OpenAiSpecTranscriptionProvider, LocalServerTranscriptionProvider } from "./provider.http.js";
export { WhisperLocalProvider } from "./provider.local.js";
export { wavOf } from "./wav.js";
export {
	TranscriptionService,
	createMethodProvider,
	createProviderResolver,
	defaultTimelineResolver,
} from "./service.js";
export { createTranscriptCascade } from "./cascade.js";
export { createTranscriptRoutes } from "./server.js";
