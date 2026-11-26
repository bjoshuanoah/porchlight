// index.js — public surface of @porchlight/detection (PORCH-128).

export { assertFrame, assertRawDetection, assertDetectedObject } from "./types.js";
export { ProviderRegistry } from "./registry.js";
export { DetectionTracker, iou, associate } from "./tracker.js";
export { DetectionService } from "./service.js";
export { CoreMLProvider } from "./provider.coreml.js";
export { VisionProvider } from "./provider.vision.js";
export { MqttDetectionSink, NullDetectionSink } from "./sink.mqtt.js";
export { letterbox, modelBoxToFrame, nms, boxesIou, decodeYolo, toModelInput } from "./nms.js";
