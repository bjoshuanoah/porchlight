// service.js — the detection service orchestration (PORCH-128).
//
// One InferenceProvider (the TS 5 seam), per-camera ByteTrack-style trackers,
// and a DetectionSink publish path: frame → provider.detect →
// trackers.update → sink.publish. Per-camera trackers keep the trackId
// namespace per camera; the sink (transport) is injected so the PORCH-129
// vetting decision can re-point without core changes.

import { DetectionTracker } from "./tracker.js";
import { assertDetectedObject, assertFrame } from "./types.js";

/** @typedef {import("./types.js").Frame} Frame */
/** @typedef {import("./types.js").DetectedObject} DetectedObject */
/** @typedef {import("./types.js").InferenceProvider} InferenceProvider */
/** @typedef {import("./types.js").DetectionSink} DetectionSink */

export class DetectionService {
	/**
	 * @param {{
	 *   provider: InferenceProvider,
	 *   sink: DetectionSink,
	 *   trackerFactory?: () => DetectionTracker,
	 *   log?: (...args: unknown[]) => void,
	 * }} opts
	 */
	constructor(opts) {
		if (!opts.provider || typeof opts.provider.detect !== "function") {
			throw new TypeError("DetectionService: provider must implement InferenceProvider");
		}
		if (!opts.sink || typeof opts.sink.publish !== "function") {
			throw new TypeError("DetectionService: sink must implement DetectionSink");
		}
		this.provider = opts.provider;
		this.sink = opts.sink;
		this.trackerFactory = opts.trackerFactory ?? (() => new DetectionTracker());
		this.log = opts.log ?? (() => {});
		/** @type {Map<string, DetectionTracker>} */
		this.trackers = new Map();
		this.frames = 0;
		this.published = 0;
		// Compute re-pointing generation (PORCH-152): 0 until the first repoint.
		this.generation = 0;
	}

	/**
	 * Re-point the live provider (compute re-pointing, PORCH-152): validates
	 * the InferenceProvider protocol, closes the old provider (close errors
	 * are logged, never fatal), and swaps it in. Trackers and sink continue
	 * unchanged — subsequent publishes carry the new provider's name, and
	 * every re-point bumps `generation` (visible in status()).
	 *
	 * @param {InferenceProvider} provider
	 * @returns {Promise<{ name: string, generation: number }>}
	 */
	async repoint(provider) {
		if (
			!provider ||
			typeof provider.name !== "string" ||
			provider.name.length === 0 ||
			typeof provider.detect !== "function"
		) {
			throw new TypeError("DetectionService.repoint: provider must implement InferenceProvider (a name string plus a detect(frame) function)");
		}
		// Swap first so the live seam never sits on a provider that is already
		// closed; the old provider is released only after its replacement is live.
		const previous = this.provider;
		this.provider = provider;
		this.generation += 1;
		try {
			await previous.close?.();
		} catch (err) {
			// Close errors never fail the re-point — the new seam is already
			// live; the failure is logged, never silent.
			this.log(`[detection] provider close during repoint failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
		}
		return { name: provider.name, generation: this.generation };
	}

	/**
	 * Run one frame through the pipeline: detect → track → publish.
	 * Returns the published objects plus the wall latency (ms) from call to
	 * last publish (the ac-2 "within 1 second of frame availability" budget).
	 *
	 * @param {Frame} frame
	 * @returns {Promise<{ objects: DetectedObject[], latencyMs: number }>}
	 */
	async submit(frame) {
		assertFrame(frame);
		const started = performance.now();
		const raw = await this.provider.detect(frame);
		let tracker = this.trackers.get(frame.camera);
		if (!tracker) {
			tracker = this.trackerFactory();
			this.trackers.set(frame.camera, tracker);
		}
		const objects = tracker.update(raw, frame.t);
		/** @type {DetectedObject[]} */
		const publishedObjects = [];
		for (const object of objects) {
			/** @type {DetectedObject} */
			const withProvider = { ...object, camera: frame.camera, provider: this.provider.name };
			assertDetectedObject(withProvider);
			await this.sink.publish(withProvider);
			this.published += 1;
			publishedObjects.push(withProvider);
		}
		this.frames += 1;
		return { objects: publishedObjects, latencyMs: performance.now() - started };
	}

	/**
	 * Compute posture (never-silent law): stage tag, provider status + sink
	 * status, the frame/publish counters, and the re-point generation.
	 * @returns {{ stage: string, provider: Record<string, unknown>, sink: Record<string, unknown>, frames: number, published: number, generation: number }}
	 */
	status() {
		return {
			stage: "detection",
			provider: this.provider.status?.() ?? { engine: "unknown" },
			sink: this.sink.status?.() ?? {},
			frames: this.frames,
			published: this.published,
			generation: this.generation,
		};
	}

	async close() {
		for (const fn of [this.provider.close?.(), this.sink.close?.()]) {
			if (fn) await fn;
		}
	}
}
