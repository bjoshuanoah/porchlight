// index.js — public surface of @porchlight/audio (PORCH-153).

export { AUDIO_CLASSES, assertAudioChunk, assertAudioFrame, assertAudioEvent } from "./types.js";
export { AudioWindower, AudioAnalysisService } from "./service.js";
export { AudioClassifierProvider } from "./provider.onnx.js";
export { MqttAudioSink, NullAudioSink } from "./sink.mqtt.js";
