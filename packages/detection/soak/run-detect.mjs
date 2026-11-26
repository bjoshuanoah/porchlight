// run-detect.mjs — the detection CPU harness (PORCH-128 ac-1 measurement).
//
// Runs the production detection pipeline (CoreMLProvider → DetectionTracker →
// sink publishes) against N synthetic-fleet cameras at a fixed fps for a
// bounded duration, then prints a JSON summary with process CPU% and
// throughput. The ac-1 full-fleet 24h number gates on the joint benchmark run
// (M4 Pro host of record); this harness is the local measurement slice.
//
// Usage:
//   node soak/run-detect.mjs --model /path/yolo.onnx --classes person,dog \
//        --cameras 3 --fps 5 --duration-ms 30000 [--mqtt-url mqtt://...] \
//        [--width 1920 --height 1080]
//
// The synthetic frames exercise the real preprocessing path (rgb buffer →
// letterbox/bilinear → inference); no camera hardware is required.

import fs from "node:fs";
import process from "node:process";
import { CoreMLProvider } from "../src/provider.coreml.js";
import { MqttDetectionSink, NullDetectionSink } from "../src/sink.mqtt.js";
import { DetectionService } from "../src/service.js";

const args = new Map(process.argv.slice(2).reduce((acc, v, i, arr) => {
	if (v.startsWith("--")) acc.push([v.slice(2), arr[i + 1]]);
	return acc;
}, []));
const num = (k, d) => (args.has(k) ? Number(args.get(k)) : d);
const str = (k, d) => (args.has(k) ? String(args.get(k)) : d);

const W = num("width", 1920);
const H = num("height", 1080);
const cameras = num("cameras", 3);
const fps = num("fps", 5);
const durationMs = num("duration-ms", 30000);
const modelPath = args.get("model");
if (!modelPath || !fs.existsSync(modelPath)) {
	console.error("run-detect: --model must point at a YOLO-class ONNX file");
	process.exit(1);
}
const classNames = str("classes", "all") === "all"
	? // Default: the ultralytics COCO-class head (yolo11n-class exports).
		["person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush"]
	: str("classes").split(",").map((s) => s.trim()).filter(Boolean);

const provider = await new CoreMLProvider({
	modelPath,
	classNames,
	confThreshold: 0.45,
	iouThreshold: 0.45,
	log: (...a) => console.log(...a),
}).init();

const sink = str("mqtt-url")
	? await new MqttDetectionSink({ url: str("mqtt-url"), log: console.log }).start()
	: new NullDetectionSink();
const service = new DetectionService({ provider, sink, log: console.log });

console.log(JSON.stringify({ event: "harness-start", cameras, fps, durationMs, width: W, height: H, classes: classNames, sink: sink.status() }));

const perCamera = [];
for (let c = 0; c < cameras; c++) perCamera.push({ buffer: syntheticBuffer(W, H), phase: c / cameras });

// Sample one frame per camera per tick at the requested fps; frames are the
// previous camera buffer with a moving square overlay (real pixel work).
const started = process.hrtime.bigint();
const cpuStart = process.cpuUsage();
const framesIn = perCamera.map(() => 0);
let detections = 0;
const intervalMs = 1000 / fps;
const deadline = started + BigInt(durationMs) * 1_000_000n;
let tick = 0;
while (process.hrtime.bigint() < deadline) {
	const t0 = process.hrtime.bigint();
	await Promise.all(perCamera.map((cam, i) => {
		framesIn[i] += 1;
		overlaySquare(cam.buffer, W, H, tick, i);
		return service.submit({ camera: `soak-cam-${i + 1}`, w: W, h: H, t: Date.now() / 1000, format: "rgb", data: cam.buffer });
	}));
	detections += service.published;
	tick += 1;
	const spent = Number(process.hrtime.bigint() - t0) / 1e6;
	const wait = intervalMs - spent;
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	else if (tick % fps === 0) console.log(`[harness] frame budget exceeded: pipeline took ${spent.toFixed(1)}ms of ${intervalMs}ms`);
}

const cpu = process.cpuUsage(cpuStart);
const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
const cpuPercent = ((cpu.user + cpu.system) / 1_000 / wallMs) * 100;
const summary = {
	event: "harness-summary",
	cameras,
	fps,
	durationMs,
	framesSubmitted: framesIn.reduce((a, b) => a + b, 0),
	framesPerCamera: framesIn,
	detectionsPublished: detections,
	tracksOpen: [...service.trackers.values()].reduce((n, t) => n + t.tracks.length, 0),
	processCpuPercent: Number(cpuPercent.toFixed(2)),
	wallMs: Math.round(wallMs),
	provider: service.status().provider,
	sink: sink.status?.() ?? {},
};
console.log(JSON.stringify(summary, null, 2));
await service.close();

/** @param {number} w @param {number} h @returns {Uint8Array} */
function syntheticBuffer(w, h) {
	const buf = new Uint8Array(w * h * 3);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 3;
			buf[i] = (x * 255) / w;
			buf[i + 1] = (y * 255) / h;
			buf[i + 2] = 64;
		}
	}
	return buf;
}

/** @param {Uint8Array} buf @param {number} w @param {number} h @param {number} t @param {number} cam */
function overlaySquare(buf, w, h, t, cam) {
	const size = Math.round(w / 12);
	const x0 = Math.round((w / 3) + (Math.sin(t / 10 + cam) * w) / 4);
	const y0 = Math.round(h / 2 - size / 2);
	for (let y = Math.max(0, y0); y < Math.min(h, y0 + size); y++) {
		for (let x = Math.max(0, x0); x < Math.min(w, x0 + size); x++) {
			const i = (y * w + x) * 3;
			buf[i] = 255;
			buf[i + 1] = 255;
			buf[i + 2] = 255;
		}
	}
}
