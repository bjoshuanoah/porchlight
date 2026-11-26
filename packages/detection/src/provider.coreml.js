// provider.coreml.js — the CoreML EP onnxruntime InferenceProvider (PORCH-128).
//
// onnxruntime-node with the CoreML Execution Provider: custom ONNX models
// (e.g. YOLO) run natively on Apple Silicon (GPU/ANE) from the Node daemon.
// Never-silent law: if the CoreML EP cannot be built, the session falls back
// to CPU and the degradation is explicit in status()/on() — never silent.

import { assertFrame } from "./types.js";
import { decodeYolo, letterbox, toModelInput } from "./nms.js";

/** @typedef {import("./types.js").Frame} Frame */
/** @typedef {import("./types.js").RawDetection} RawDetection */

export class CoreMLProvider {
	/**
	 * @param {{
	 *   modelPath: string,
	 *   classNames: string[],
	 *   inputSize?: number,
	 *   confThreshold?: number,
	 *   iouThreshold?: number,
	 *   executionProviders?: string[],
	 *   log?: (...args: unknown[]) => void,
	 *   name?: string,
	 * }} opts
	 */
	constructor(opts) {
		if (!opts.modelPath || typeof opts.modelPath !== "string") {
			throw new TypeError("CoreMLProvider: modelPath is required");
		}
		if (!Array.isArray(opts.classNames) || opts.classNames.length === 0) {
			throw new TypeError("CoreMLProvider: classNames must be a non-empty array");
		}
		this.name = opts.name ?? "coreml";
		this.modelPath = opts.modelPath;
		this.classNames = [...opts.classNames];
		this.inputSize = opts.inputSize ?? 640;
		this.confThreshold = opts.confThreshold ?? 0.45;
		this.iouThreshold = opts.iouThreshold ?? 0.45;
		this.executionProviders = opts.executionProviders ?? ["coreml", "cpu"];
		this.log = opts.log ?? (() => {});
		/** @type {unknown} */ this.session = null;
		this.cpuFallback = false;
	}

	/**
	 * Build the inference session. `ort` is injectable for tests; production
	 * imports onnxruntime-node lazily so unit suites never load the native
	 * module.
	 *
	 * @param {{ InferenceSession: { create: (path: string, o: unknown) => Promise<unknown> } }} [ortModule]
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
			if (!eps.includes("coreml")) throw err;
			eps = eps.filter((e) => e !== "coreml");
			// Never-silent law: the degradation is stated, not swallowed.
			this.cpuFallback = true;
			this.log(`[${this.name}] CoreML EP unavailable (${err instanceof Error ? err.message : String(err)}); falling back to execution providers [${eps.join(", ")}]. Detection still runs, but not on GPU/ANE.`);
			session = await ort.InferenceSession.create(this.modelPath, { executionProviders: eps });
		}
		this.session = session;
		this.engine = eps[0];
		this.inputName = /** @type {any} */ (session).inputNames[0];
		return this;
	}

	/**
	 * @param {Frame} frame
	 * @returns {Promise<RawDetection[]>}
	 */
	async detect(frame) {
		assertFrame(frame);
		if (!this.session) throw new Error("CoreMLProvider: init() must run before detect()");
		if (frame.format === "jpeg") {
			throw new TypeError("CoreMLProvider: jpeg frames are not supported — feed rgb/rgba pixel buffers (the stream manager decodes before inference)");
		}
		const lb = letterbox(frame.w, frame.h, this.inputSize, this.inputSize);
		const input = toModelInput(frame.data, frame.w, frame.h, frame.format === "rgba" ? 4 : 3, this.inputSize, this.inputSize, lb);
		/** @type {any} */
		const session = this.session;
		const inputTensor = /** @type {any} */ (this.ort)?.Tensor
			? new /** @type {any} */ (this.ort).Tensor("float32", input, [1, 3, this.inputSize, this.inputSize])
			: input; // injected test sessions take the raw Float32Array
		const results = await session.run({ [this.inputName]: inputTensor });
		const output = results[session.outputNames[0]];
		const dims = /** @type {any} */ (output).dims;
		const data = /** @type {Float32Array} */ (/** @type {any} */ (output).data);
		return decodeYolo(data, dims, this.classNames, {
			inputSize: this.inputSize,
			srcW: frame.w,
			srcH: frame.h,
			confThreshold: this.confThreshold,
			iouThreshold: this.iouThreshold,
		}).map((d) => ({ ...d, t: frame.t }));
	}

	/** Never-silent compute posture: engine + fallback state are inspectable. */
	status() {
		return { engine: this.cpuFallback ? "cpu" : "coreml", cpuFallback: this.cpuFallback, model: this.modelPath };
	}

	async close() {
		if (this.session) {
			await /** @type {any} */ (this.session).release?.();
			this.session = null;
		}
	}
}
