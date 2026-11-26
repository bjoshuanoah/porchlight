// provider.coreml.test.js — CoreML EP provider behavior with a stub session
// (the real-model e2e lives in e2e.detection.test.js, env-gated) (PORCH-128).

import { test } from "node:test";
import assert from "node:assert/strict";

import { CoreMLProvider } from "../src/provider.coreml.js";
import { decodeYolo } from "../src/nms.js";

/** @param {{ failCoreml?: boolean }} [opts] */
function fakeOrt(opts = {}) {
	/** @type {string[][]} */
	const createdWith = [];
	const session = {
		inputNames: ["images"],
		outputNames: ["output0"],
		/** @param {Record<string, Float32Array>} inputs */
		run: async (inputs) => {
			assert.equal(Object.keys(inputs)[0], "images");
			return {
				output0: {
					dims: [1, 5, 2],
					data: buildPersonOutput(),
				},
			};
		},
		release: async () => {},
	};
	return {
		createdWith,
		InferenceSession: {
			/** @param {string} path @param {{ executionProviders: string[] }} o */
			create: async (path, o) => {
				createdWith.push([...o.executionProviders]);
				if (opts.failCoreml && o.executionProviders[0] === "coreml") {
					throw new Error("coreml EP not supported on this platform");
				}
				return session;
			},
		},
	};
}

/** One high-confidence person detection at model-input center (640x640). */
function buildPersonOutput() {
	// boxes-first [1, 5, 2]: rows are (cx, cy, w, h, personScore), columns candidates
	const data = new Float32Array(10);
	data[0] = 320; data[1] = 600; // cx cand0, cand1
	data[2] = 320; data[3] = 600; // cy
	data[4] = 100; data[5] = 60; // w
	data[6] = 100; data[7] = 60; // h
	data[8] = 0.92; data[9] = 0.2; // person score
	return data;
}

const rgbFrame = (overrides = {}) => ({
	camera: "cam-1",
	w: 640,
	h: 640,
	t: 12.5,
	format: "rgb",
	data: new Uint8Array(640 * 640 * 3),
	...overrides,
});

test("init builds the session with the CoreML EP first; detect decodes normalized output", async () => {
	const fake = fakeOrt();
	const provider = await new CoreMLProvider({ modelPath: "/models/yolo11n.onnx", classNames: ["person"], executionProviders: ["coreml", "cpu"], log: console.log }).init(fake);
	assert.equal(fake.createdWith[0][0], "coreml");
	assert.equal(provider.status().engine, "coreml");
	assert.equal(provider.status().cpuFallback, false);
	const dets = await provider.detect(rgbFrame());
	assert.equal(dets.length, 1);
	assert.equal(dets[0].cls, "person");
	assert.ok(Math.abs(dets[0].conf - Math.fround(0.92)) < 1e-6);
	assert.deepEqual(dets[0].bbox.map((v) => v.toFixed(3)), ["0.422", "0.422", "0.156", "0.156"]);
	assert.equal(dets[0].t, 12.5);
});

test("CoreML EP failure falls back to CPU with an explicit never-silent log line", async () => {
	/** @type {string[]} */
	const lines = [];
	const provider = await new CoreMLProvider({
		modelPath: "/models/yolo11n.onnx",
		classNames: ["person"],
		executionProviders: ["coreml", "cpu"],
		log: (...a) => lines.push(a.join(" ")),
	}).init(fakeOrt({ failCoreml: true }));
	assert.equal(provider.cpuFallback, true);
	assert.equal(provider.status().engine, "cpu");
	assert.equal(provider.status().cpuFallback, true);
	assert.ok(lines.some((l) => l.includes("EPs unavailable") && l.includes("not on GPU/ANE")), "explicit CPU fallback line present");
});

test("detect rejects jpeg frames (pixels must arrive decoded) and before init", async () => {
	const provider = new CoreMLProvider({ modelPath: "/m.onnx", classNames: ["person"] });
	await assert.rejects(() => provider.detect(rgbFrame()), /init\(\)/);
	const inited = await provider.init(fakeOrt());
	await assert.rejects(() => inited.detect(rgbFrame({ format: "jpeg", data: new Uint8Array(10) })), /jpeg/);
});

test("constructor validates modelPath and classNames", () => {
	assert.throws(() => new CoreMLProvider({ classNames: ["person"] }), /modelPath/);
	assert.throws(() => new CoreMLProvider({ modelPath: "/m.onnx", classNames: [] }), /classNames/);
});

test("decode consistency: the provider path and raw decodeYolo agree", async () => {
	const fake = fakeOrt();
	const provider = await new CoreMLProvider({ modelPath: "/m.onnx", classNames: ["person"], confThreshold: 0.5 }).init(fake);
	const viaProvider = await provider.detect(rgbFrame());
	const viaDecode = decodeYolo(buildPersonOutput(), [1, 5, 2], ["person"], {
		inputSize: 640,
		srcW: 640,
		srcH: 640,
		confThreshold: 0.5,
		iouThreshold: 0.45,
	});
	const providerWithoutT = viaProvider.map(({ t: _t, ...rest }) => rest);
	assert.deepEqual(providerWithoutT, viaDecode);
});

// PORCH-132: the default execution-provider order is the host HAL's decision,
// never a hardcoded service list — this is the ac-1 portability seam.
test("default execution providers come from the platform HAL, not the service", async () => {
	const { resolveHal } = await import("@porchlight/hal");
	const provider = new CoreMLProvider({ modelPath: "/m.onnx", classNames: ["person"] });
	assert.deepEqual(provider.executionProviders, resolveHal().inferenceExecutionProviders());
});
