// provider.onnx.js — the onnxruntime audio-classification AudioProvider
// (PORCH-153; PORCH-I-009 TS 5 / TS 8).
//
// onnxruntime-node with the platform HAL's execution providers (CoreML EP on
// Apple Silicon): window-class audio classification models run natively from
// the Node daemon. The default EP list comes from `@porchlight/hal` — never
// hardcoded here. Never-silent law: if the accelerated EPs cannot be built,
// the session falls back to CPU and the degradation is explicit in status()
// — never silent.
//
// Input contract: one mono float32 window at the model's sample rate (the
// recording tier's AAC/16 kHz class). The provider refuses a window whose
// rate disagrees — resampling is an upstream (stream-manager) responsibility,
// never invented here.

import { resolveHal } from "@porchlight/hal";
import { assertAudioFrame } from "./types.js";
import { AUDIO_CLASSES } from "./types.js";

/** @typedef {import("./types.js").AudioFrame} AudioFrame */
/** @typedef {import("./types.js").AudioHit} AudioHit */

export class AudioClassifierProvider {
	/**
	 * @param {{
	 *   modelPath: string,
	 *   classNames?: string[],
	 *   sampleRate?: number,
	 *   confThreshold?: number,
	 *   executionProviders?: string[],
	 *   log?: (...args: unknown[]) => void,
	 *   name?: string,
	 * }} opts
	 */
	constructor(opts) {
		if (!opts.modelPath || typeof opts.modelPath !== "string") {
			throw new TypeError("AudioClassifierProvider: modelPath is required");
		}
		if (opts.classNames !== undefined && (!Array.isArray(opts.classNames) || opts.classNames.length === 0)) {
			throw new TypeError("AudioClassifierProvider: classNames must be a non-empty array");
		}
		this.name = opts.name ?? "onnx-audio";
		this.modelPath = opts.modelPath;
		// The class set of record by default (a build decision, TS 8); a
		// deployed model re-points classNames to its own labels.
		this.classNames = [...(opts.classNames ?? AUDIO_CLASSES)];
		this.sampleRate = opts.sampleRate ?? 16000;
		this.confThreshold = opts.confThreshold ?? 0.4;
		this.executionProviders = opts.executionProviders ?? resolveHal().inferenceExecutionProviders();
		this.log = opts.log ?? (() => {});
		/** @type {unknown} */ this.session = null;
		this.cpuFallback = false;
		/** @type {string|null} */ this.reason = null;
	}

	/**
	 * Build the inference session. `ort` is injectable for tests; production
	 * imports onnxruntime-node lazily so unit suites never load the native
	 * module.
	 *
	 * @param {{ InferenceSession: { create: (path: string, o: unknown) => Promise<unknown> } }} [ortModule]
	 * @returns {Promise<this>}
	 */
	async init(ortModule) {
		const ort = ortModule ?? (await import("onnxruntime-node"));
		this.ort = ort;
		/** @type {any} */
		let session = null;
		/** @type {string[]} */
		let eps = [...this.executionProviders];
		try {
			session = await ort.InferenceSession.create(this.modelPath, { executionProviders: eps });
		} catch (err) {
			// Never-silent law: the degradation is stated, not swallowed. The
			// accelerated rung (any EP the HAL placed before "cpu") drops first;
			// "cpu" is the terminal rung that always exists. An EP list without
			// a cpu rung fails loudly — no silent substitution is invented here.
			const accelerated = eps.filter((e) => e !== "cpu");
			if (accelerated.length === 0) throw err;
			eps = eps.filter((e) => !accelerated.includes(e));
			this.cpuFallback = true;
			const detail = err instanceof Error ? err.message : String(err);
			this.reason =
				`${accelerated.join("/")} EPs unavailable (${detail}); ` +
				`falling back to execution providers [${eps.join(", ")}]. Audio classification still runs, but not natively.`;
			this.log(`[${this.name}] ${this.reason}`);
			session = await ort.InferenceSession.create(this.modelPath, { executionProviders: eps });
		}
		this.session = session;
		this.engine = eps[0];
		this.inputName = /** @type {any} */ (session).inputNames[0];
		// A cpu-only build (forced ["cpu"] or a cpu-only HAL) never hit the
		// fallback path, but it is still not native compute — the never-silent
		// law states the cpu posture here too, so status() can never lie.
		if (eps[0] === "cpu" && !this.cpuFallback) {
			this.cpuFallback = true;
			this.reason = `session built for cpu (execution providers [${eps.join(", ")}]) — no accelerated EP; audio classification runs on CPU only.`;
			this.log(`[${this.name}] ${this.reason}`);
		}
		return this;
	}

	/**
	 * @param {AudioFrame} frame
	 * @returns {Promise<AudioHit[]>}
	 */
	async classify(frame) {
		assertAudioFrame(frame);
		if (!this.session) throw new Error("AudioClassifierProvider: init() must run before classify()");
		if (frame.sampleRate !== this.sampleRate) {
			throw new TypeError(
				`AudioClassifierProvider: window sampleRate ${frame.sampleRate} Hz disagrees with the model's ${this.sampleRate} Hz — ` +
				"resampling is the stream-serving path's responsibility, not the provider's",
			);
		}
		if (frame.data.length === 0) return [];
		/** @type {any} */
		const session = this.session;
		const inputTensor = /** @type {any} */ (this.ort)?.Tensor
			? new /** @type {any} */ (this.ort).Tensor("float32", frame.data, [1, frame.data.length])
			: frame.data; // injected test sessions take the raw Float32Array
		const results = await session.run({ [this.inputName]: inputTensor });
		return decodeProbs(results[session.outputNames[0]], this.classNames, this.confThreshold);
	}

	/** The never-silent compute posture: all five fields, always. */
	status() {
		return {
			engine: this.engine ?? "unknown",
			providerClass: /** @type {"native-mlx"} */ ("native-mlx"),
			model: this.modelPath,
			executionTarget: this.engine ?? null,
			// A CPU run is still native execution on the host (the CoreML/CPU EP
			// decision is the HAL's) — "cpu" states it per the never-silent law.
			state: this.cpuFallback ? "cpu" : "native",
			reason: this.reason,
		};
	}

	async close() {
		/** @type {any} */
		const session = this.session;
		if (!session) return;
		this.session = null;
		await session.release?.();
	}
}

/**
 * Decode one model output window into hits above threshold. The output is
 * [batch, numClasses] class probabilities; dims drive the stride, never a
 * guess.
 * @param {unknown} raw
 * @param {string[]} classNames
 * @param {number} threshold
 * @returns {AudioHit[]}
 */
function decodeProbs(raw, classNames, threshold) {
	const output = /** @type {any} */ (raw);
	if (!output || !output.data || !output.dims) {
		throw new TypeError("AudioClassifierProvider: the model's output window is missing dims/data");
	}
	const [batch, numClasses] = /** @type {number[]} */ (output.dims);
	if (numClasses !== classNames.length) {
		throw new TypeError(
			`AudioClassifierProvider: the model outputs ${numClasses} classes but ${classNames.length} class labels were supplied — the class set of record and the model must agree`,
		);
	}
	const perBatch = /** @type {number[]} */ (output.dims).slice(1).reduce((a, b) => a * b, 1);
	/** @type {AudioHit[]} */
	const hits = [];
	for (let b = 0; b < batch; b += 1) {
		for (let c = 0; c < numClasses; c += 1) {
			const conf = /** @type {Float32Array} */ (output.data)[b * perBatch + c];
			if (typeof conf !== "number" || Number.isNaN(conf)) {
				throw new TypeError(`AudioClassifierProvider: the model returned a non-numeric score for class ${classNames[c] ?? c}`);
			}
			if (conf >= threshold) {
				hits.push({ cls: classNames[c], conf: Math.min(1, Math.max(0, conf)) });
			}
		}
	}
	return hits;
}
