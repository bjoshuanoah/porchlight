// provider.onnx.test.js — the onnxruntime audio-classification provider
// (PORCH-153): never-silent EP fallback, rate-contract refusal, and the
// decode of one model output window into hits.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AudioClassifierProvider } from "../src/provider.onnx.js";

/** @param {Float32Array} logits @param {number[]} dims */
function fakeOrt(logits, dims) {
	return {
		InferenceSession: {
			/** @param {string} _path @param {unknown} opts */
			create: async (_path, opts) => {
				const eps = /** @type {{ executionProviders: string[] }} */ (opts).executionProviders;
				return {
					inputNames: ["audio_input"],
					outputNames: ["class_logits"],
					/** @param {unknown} _feeds */
					run: async (_feeds) => ({
						class_logits: /** @type {any} */ ({ dims, data: logits }),
					}),
					eps,
				};
			},
		},
	};
}

const frame = { camera: "c", clipStart: 100, clipEnd: 101, sampleRate: 16000, data: new Float32Array(16000) };

test("classify decodes one [1, classes] output into hits above threshold", async () => {
	const provider = await new AudioClassifierProvider({ modelPath: "/models/audio.onnx", confThreshold: 0.5 })
		.init(fakeOrt(new Float32Array([0.7, 0.2, 0.9, 0.01]), [1, 4]), { executionProviders: ["coreml"] });
	const got = await provider.classify(frame);
	assert.deepEqual(got.map((h) => h.cls), ["glass-break", "smoke-co-alarm"]);
	assert.ok(Math.abs(got[0].conf - 0.7) < 1e-6, `conf ${got[0].conf}`);
	assert.ok(Math.abs(got[1].conf - 0.9) < 1e-6, `conf ${got[1].conf}`);
});

test("a model/class-name disagreement fails loudly, never guesses", async () => {
	const provider = await new AudioClassifierProvider({ modelPath: "/models/audio.onnx", classNames: ["only-one"] })
		.init(fakeOrt(new Float32Array([0.7, 0.2, 0.9, 0.01]), [1, 4]), { executionProviders: ["coreml", "cpu"] });
	await assert.rejects(() => provider.classify(frame), /4 classes but 1 class labels/);
});

test("window sample rate must match the model's rate — resampling is upstream's job", async () => {
	const provider = await new AudioClassifierProvider({ modelPath: "/models/audio.onnx", executionProviders: ["coreml"] }).init(fakeOrt(new Float32Array(4), [1, 4]));
	await assert.rejects(
		() => provider.classify({ ...frame, sampleRate: 8000 }),
		/resampling is the stream-serving path's responsibility/,
	);
});

test("never-silent EP fallback: accelerated rung drops, the CPU posture is stated", async () => {
	/** @type {string[][]} */
	const created = [];
	const failing = {
		InferenceSession: {
			/** @param {string} _p @param {unknown} o */
			create: async (_p, o) => {
				const list = /** @type {{ executionProviders: string[] }} */ (o).executionProviders;
				created.push(list);
				if (list.includes("coreml")) {
					throw new Error("coreml EP unavailable on this host");
				}
				return {
					inputNames: ["audio_input"],
					outputNames: ["class_logits"],
					run: async () => ({ class_logits: { dims: [1, 4], data: new Float32Array([0.7, 0.2, 0.9, 0.01]) } }),
				};
			},
		},
	};
	const provider = await new AudioClassifierProvider({ modelPath: "/models/audio.onnx", executionProviders: ["coreml", "cpu"] })
		.init(failing);
	assert.deepEqual(created, [["coreml", "cpu"], ["cpu"]], "only the accelerated rung dropped");
	const status = provider.status();
	assert.equal(status.state, "cpu");
	assert.equal(status.providerClass, "native-mlx");
	assert.match(String(status.reason ?? ""), /coreml EP unavailable.*Audio classification still runs, but not natively\./);
});

test("a native run reports state native with a null reason — status never lies", async () => {
	const provider = await new AudioClassifierProvider({ modelPath: "/models/audio.onnx", executionProviders: ["coreml"] }).init(fakeOrt(new Float32Array(4), [1, 4]));
	const status = provider.status();
	assert.equal(status.state, "native");
	assert.equal(status.reason, null);
	assert.equal(status.engine, "coreml");
	assert.equal(status.executionTarget, "coreml");
});

test("classify before init refuses; close releases the session", async () => {
	const provider = new AudioClassifierProvider({ modelPath: "/models/audio.onnx" });
	await assert.rejects(() => provider.classify(frame), /init\(\) must run/);
	const provider2 = await new AudioClassifierProvider({ modelPath: "/models/audio.onnx", executionProviders: ["coreml"] }).init(fakeOrt(new Float32Array(4), [1, 4]));
	await provider2.close();
	assert.equal(provider2.session, null);
});
