// pipeline.js — the local recognition pipeline seam (PORCH-141 TS 2).
//
// All recognition runs locally on Apple Silicon: providers self-register
// (the detection package's InferenceProvider analogue, PORCH-128 ac-3 law)
// and the setup provisions the actual models per stage — the provider is
// the boundary, never a hardcoded runtime. Names are shaping candidates
// (YuNet/RetinaFace-class detection, ArcFace-class descriptors,
// PaddleOCR-class plates); nothing here assumes one.
//
// The recognition-disabled state is enforced HERE, upstream of every
// descriptor computation: a disabled household computes zero descriptors
// and runs zero recognition — the refusal is counted in metrics, auditable
// (ac-4/ac-6).

import { assertFrame } from "./types.js";

/** @typedef {import("./types.js").VisionProvider} VisionProvider */
/** @typedef {import("./types.js").RecognitionFrame} RecognitionFrame */
/** @typedef {import("./types.js").FaceEmbedding} FaceEmbedding */
/** @typedef {import("./types.js").PlateRead} PlateRead */

/**
 * @typedef {{
 *   descriptorComputations: number,
 *   plateReads: number,
 *   recognitionRuns: number,
 *   refusedDisabled: number,
 * }} RecognitionMetricsCounters
 */

/**
 * Zero-computation audit counters of record. Monotonic per-process; the
 * audit log carries the durable companion (toggle changes land in audit).
 */
export class RecognitionMetrics {
	constructor() {
		this.counters = { descriptorComputations: 0, plateReads: 0, recognitionRuns: 0, refusedDisabled: 0 };
	}

	/** @param {keyof RecognitionMetricsCounters} key @param {number} [n] */
	bump(key, n = 1) {
		this.counters[key] += n;
	}

	/** @returns {RecognitionMetricsCounters} shallow copy */
	snapshot() {
		return { ...this.counters };
	}
}

/**
 * Provider registry (mirror of the detection package's ProviderRegistry).
 * Register-replaces; a swap is never silent — the replaced flag rides the
 * result so the caller can log it.
 */
export class VisionProviderRegistry {
	constructor() {
		/** @type {Map<string, () => VisionProvider>} */
		this.factories = new Map();
	}

	/**
	 * @param {string} name
	 * @param {() => VisionProvider} factory
	 * @returns {{ replaced: boolean }}
	 */
	register(name, factory) {
		if (typeof name !== "string" || name.trim() === "") throw new TypeError("A provider needs a name.");
		if (typeof factory !== "function") throw new TypeError("A provider registration needs a factory.");
		const replaced = this.factories.has(name);
		this.factories.set(name, factory);
		return { replaced };
	}

	has(name) {
		return this.factories.has(name);
	}

	names() {
		return [...this.factories.keys()];
	}

	/**
	 * @param {string} name
	 * @param {{ provider?: VisionProvider }} [opts]
	 * @returns {VisionProvider}
	 */
	create(name, opts = {}) {
		if (opts.provider) return opts.provider;
		const factory = this.factories.get(name);
		if (!factory) throw new Error(`No vision provider is registered as "${name}".`);
		const provider = factory();
		if (typeof provider.describeFaces !== "function") {
			throw new Error(`The "${name}" vision provider cannot describe faces.`);
		}
		return provider;
	}
}

/**
 * The pipeline of record. Every descriptor computation and plate read rides
 * computeDescriptor/computePlates — the one place the disabled state bites.
 *
 * @param {{
 *   registry?: VisionProviderRegistry,
 *   metrics?: RecognitionMetrics,
 *   now?: () => number,
 * }} [options]
 */
export function createRecognitionPipeline({ registry = new VisionProviderRegistry(), metrics = new RecognitionMetrics(), now = () => Date.now() / 1000 } = {}) {
	/**
	 * The upstream enforcement point (ac-4/ac-6): when `enabled` is false NO
	 * provider call happens at all — zero descriptor computations, zero plate
	 * reads. The refusal is counted, never silent.
	 *
	 * @param {{ enabled: boolean, provider: VisionProvider, frame: RecognitionFrame }} req
	 * @param {"face" | "plate"} stage
	 */
	async function enforceAndRun(req, stage) {
		if (!req.enabled) {
			metrics.bump("refusedDisabled");
			throw Object.assign(new Error("Recognition is switched off for this home — no recognition runs."), { code: "E_RECOGNITION_DISABLED" });
		}
		const framed = assertFrame(req.frame);
		metrics.bump(stage === "face" ? "descriptorComputations" : "plateReads");
		metrics.bump("recognitionRuns");
		if (stage === "face") {
			const embeddings = await req.provider.describeFaces(framed);
			return { provider: req.provider.name, embeddings };
		}
		const read = await req.provider.readPlates?.(framed);
		return { provider: req.provider.name, plates: read ?? [] };
	}

	/**
	 * Face descriptors from a frame (enrollment and gallery matching).
	 * @param {{ enabled: boolean, provider: VisionProvider, frame: RecognitionFrame }} req
	 */
	async function computeDescriptor(req) {
		return enforceAndRun(req, "face");
	}

	/**
	 * Plate reads from a frame.
	 * @param {{ enabled: boolean, provider: VisionProvider, frame: RecognitionFrame }} req
	 */
	async function computePlates(req) {
		return enforceAndRun(req, "plate");
	}

	return { registry, metrics, computeDescriptor, computePlates, now };
}

/** @typedef {ReturnType<typeof createRecognitionPipeline>} RecognitionPipeline */
