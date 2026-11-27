// types.js — shared JSDoc types for the stream-serving plane (PORCH-154).

/**
 * A camera entry in the platform config of record (shared with every plane;
 * the config plane writes source.width/height from the ffprobe probe at
 * registration).
 *
 * @typedef {object} StreamCamera
 * @property {string} name Safe identifier ([A-Za-z0-9][A-Za-z0-9._-]*).
 * @property {{
 *   url?: string,
 *   loop?: boolean,
 *   width?: number,
 *   height?: number,
 *   synthetic?: { size?: string, fps?: number, encoder?: string, bitrate?: string,
 *                 audio?: boolean, audioFreq?: number, audioSampleRate?: number },
 * }} source
 * @property {"transcode"|"copy"} [audioMode] Recorder-side ingest concern —
 *   the relay carries full copy mpegts so this never touches the manager.
 */

/**
 * The stream-plane knobs of record (config.streams): base int port (default
 * 8972 — control HTTP at <base>, relay listeners at <base> + 1 + sortedIndex),
 * rgb/jpeg frame rates for the decoded lanes.
 *
 * @typedef {object} StreamSettings
 * @property {number} base
 * @property {number} rgbFps
 * @property {number} jpegFps
 */

/**
 * An upstream demux handle — exactly what ffmpeg's ChildProcess exposes with
 * STREAM_STDIO and injectables may emulate in tests: the mpegts copy lane on
 * stdout (fd 1), stderr, and the decoded lanes on stdio 3 (rgb24), 4 (mjpeg),
 * 5 (f32le PCM). Never an extra camera connection: one handle per camera.
 *
 * @typedef {object} StreamHandle
 * @property {import("node:stream").Readable|null} [stdout]
 * @property {import("node:stream").Readable|null} [stderr]
 * @property {(import("node:stream").Readable|null)[]} [stdio]
 * @property {(signal?: string) => boolean|void} [kill]
 * @property {(event: string, fn: (...args: any[]) => void) => any} on
 */

/**
 * The rgb frame delivered to in-process subscribers (subscribeFrames).
 *
 * @typedef {object} StreamFrame
 * @property {string} camera
 * @property {number} w
 * @property {number} h
 * @property {number} t     epoch seconds at read
 * @property {Buffer} data  rgb24 bytes, exactly w*h*3
 */

/**
 * The audio chunk delivered to in-process subscribers (subscribeAudio).
 * Shape-identical to @porchlight/audio's AudioChunk: { camera, t,
 * sampleRate: 16000, data: Float32Array } — t is the chunk START in epoch
 * seconds, data is mono f32le PCM.
 *
 * @typedef {object} StreamAudioChunk
 * @property {string} camera
 * @property {number} t
 * @property {number} sampleRate
 * @property {Float32Array} data
 */

/**
 * The health-bus seam behind stream up/down events (transport owned by
 * {@link MqttStreamHealthPublisher}; the core depends only on this shape).
 *
 * @typedef {object} StreamHealthBus
 * @property {(topic: string, payload: unknown) => void|Promise<void>} publish
 * @property {() => Promise<void>} [close]
 */

/** One camera's health row state set of record. */
export const STREAM_STATES = Object.freeze(["opening", "live", "down"]);
