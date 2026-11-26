// backend.linux.js — the first-cut Linux backend of the HAL contract
// (PORCH-132).
//
// Porchlight-132's directive: the Linux tier is "V4L2, VA-API/NVDEC,
// ONNX/OpenVINO — whatever the host needs", with a test double acceptable at
// first. This backend is exactly that first cut: a deterministic, dependency-
// free CPU-backed descriptor set every engine service runs on unmodified.
//
// Deliberate posture (never-silent law): the native Linux acceleration slots
// (VA-API decode, NVDEC, CUDA/OpenVINO execution providers) are named here as
// the slots this backend fills when hardware probing lands; until a probe
// ships they do NOT silently claim acceleration — status() reports the CPU
// reality. A service that runs against this backend runs against any future
// probed backend unchanged.

/** Linux first-cut backend — CPU-backed, deterministic, probe-free. */
export class LinuxBackend {
	get platform() {
		return "linux";
	}

	/** Human-auditable posture of this host's acceleration (never-silent law). */
	status() {
		return {
			platform: "linux",
			accelerator: "cpu (vaapi/nvdec/openvino probes land with the Linux follow-on)",
			decode: "none (cpu)",
			encode: "libx264",
			inference: ["cpu"],
			visionHelper: "none (darwin-only primitive)",
		};
	}

	/**
	 * Video decode: no hwaccel flags — plain software decode, correct on every
	 * Linux host. VA-API/NVDEC argv replaces this when hardware probing lands.
	 * @returns {string[]}
	 */
	videoDecodeArgs() {
		return [];
	}

	/**
	 * Video encode: the universal software encoder default for synthetic/soak
	 * origins; a camera config may still pin its own encoder.
	 * @returns {{ name: string, pixFmt: string }}
	 */
	videoEncode() {
		return { name: "libx264", pixFmt: "yuv420p" };
	}

	/**
	 * Single-frame capture: same command shape as the darwin backend, without
	 * hwaccel flags. Portable by construction.
	 * @param {{ input: string, out: string, at?: number|string }} req
	 * @returns {{ file: string, args: string[] }}
	 */
	frameCaptureCommand(req) {
		if (!req?.input || !req?.out) {
			throw new TypeError("frameCaptureCommand: input and out are required");
		}
		return {
			file: "ffmpeg",
			args: [
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
	 * ML inference: CPU execution provider only, on any Linux host with the
	 * portable runtime. CUDA/OpenVINO EPs join via the probe follow-on.
	 * @returns {string[]}
	 */
	inferenceExecutionProviders() {
		return ["cpu"];
	}

	/**
	 * Apple Vision primitives are darwin-only platform features; a Linux host
	 * reports their absence explicitly (never-silent law) — services resolve
	 * their own portable substitutes per the InferenceProvider protocol.
	 * @returns {{ sourcePath: null, frameworks: string[] }}
	 */
	visionHelper() {
		return { sourcePath: null, frameworks: [] };
	}
}
