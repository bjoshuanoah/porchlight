// index.js — public surface of @porchlight/stream (PORCH-154).

export {
	PCM_SAMPLE_RATE,
	STREAM_LANE,
	STREAM_STDIO,
	buildStreamArgs,
	resolveStreamDimensions,
} from "./args.js";
export {
	NullStreamHealthBus,
	STREAM_HEALTH_PREFIX,
	MqttStreamHealthPublisher,
	streamHealthTopic,
} from "./health-bus.js";
export {
	loadPlatformConfig,
	resolveStreamBase,
	resolveStreamSettings,
	validateCameras,
	validatePlatformDoc,
	STREAM_BASE_DEFAULT,
} from "./config.js";
export { CameraSource, spawnFactory } from "./source.js";
export { StreamManager } from "./manager.js";
export { STREAM_STATES } from "./types.js";
