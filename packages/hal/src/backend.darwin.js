// backend.darwin.js — the macOS implementation of the HAL backend contract
// (PORCH-132).
//
// Apple Silicon is the platform's default-best target; this backend resolves
// every hardware decision a service needs:
//   - decode: VideoToolbox hardware decode via system ffmpeg (-hwaccel videotoolbox),
//   - encode: h264_videotoolbox (NV12) for synthetic/soak origins,
//   - inference: onnxruntime execution providers — CoreML EP (GPU/ANE) first,
//     CPU fallback explicit (never-silent law, the fallback is stated in status()),
//   - vision helper: the SwiftVision subprocess source owned by this package
//     (packages/hal/swift/VisionHelper.swift) speaking the framed stdin/stdout
//     protocol — the only OS-framework code in the monorepo lives under
//     packages/hal.
//
// The backend returns descriptors and argv fragments only: it owns WHAT the
// host provides, never HOW a service runs. Services stay pure TS/Node and run
// unmodified on any backend.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** macOS hardware backend — VideoToolbox decode/encode, CoreML inference. */
export class DarwinBackend {
	/** @param {{ halRoot?: string }} [opts] */
	constructor(opts) {
		/** Absolute root of this package — the Swift helper ships with it. */
		this.halRoot = opts?.halRoot ?? join(__dirname, "..");
	}

	get platform() {
		return "darwin";
	}

	/** Human-auditable posture of this host's acceleration (never-silent law). */
	status() {
		return {
			platform: "darwin",
			accelerator: "apple-silicon",
			decode: "videotoolbox",
			encode: "h264_videotoolbox",
			inference: ["coreml", "cpu"],
			visionHelper: "swift-subprocess",
		};
	}

	/**
	 * Video decode: VideoToolbox hardware decode via system ffmpeg. With
	 * -c:v copy the flag is inert on the wire but present on every real-camera
	 * ingest command — a platform capability of record, not an optimization.
	 * @returns {string[]}
	 */
	videoDecodeArgs() {
		return ["-hwaccel", "videotoolbox"];
	}

	/**
	 * Video encode: the VideoToolbox hardware H.264 encoder default for
	 * synthetic/soak origins. A camera config may still pin its own encoder.
	 * @returns {{ name: string, pixFmt: string }}
	 */
	videoEncode() {
		return { name: "h264_videotoolbox", pixFmt: "nv12" };
	}

	/**
	 * Single-frame capture (snapshots for the timeline/evidence surfaces):
	 * one ffmpeg invocation, hardware decode first, one best-quality frame
	 * written to outPath.
	 * @param {{ input: string, out: string, at?: number|string }} req
	 * @returns {{ file: string, args: string[] }} argv fragment; caller owns
	 *   spawning and cwd.
	 */
	frameCaptureCommand(req) {
		if (!req?.input || !req?.out) {
			throw new TypeError("frameCaptureCommand: input and out are required");
		}
		return {
			file: "ffmpeg",
			args: [
				...this.videoDecodeArgs(),
				...(typeof req.at === "number" || typeof req.at === "string"
					? ["-ss", String(req.at)]
					: []),
				"-i", req.input,
				"-frames:v", "1",
				"-q:v", "2",
				req.out,
			],
		};
	}

	/**
	 * ML inference: execution providers ordered for this host — CoreML EP
	 * (GPU/ANE) first, CPU last as the explicit fallback rung.
	 * @returns {string[]}
	 */
	inferenceExecutionProviders() {
		return ["coreml", "cpu"];
	}

	/**
	 * Apple Vision framework primitives: the Swift helper subprocess owned by
	 * this HAL (framed stdin/stdout protocol, see swift/README.md).
	 * @returns {{ sourcePath: string, frameworks: string[] }}
	 */
	visionHelper() {
		return {
			sourcePath: join(this.halRoot, "swift", "VisionHelper.swift"),
			frameworks: ["Foundation", "Vision", "ImageIO", "CoreGraphics"],
		};
	}
}
