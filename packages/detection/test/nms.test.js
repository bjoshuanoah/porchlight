// nms.test.js — letterbox geometry, NMS, and the YOLO output decode (PORCH-128).

import { test } from "node:test";
import assert from "node:assert/strict";

import { decodeYolo, letterbox, modelBoxToFrame, nms, toModelInput } from "../src/nms.js";

test("letterbox: 16:9 frame into a square input centers with side padding", () => {
	const lb = letterbox(1920, 1080, 640, 640);
	assert.equal(lb.scale.toFixed(4), "0.3333"); // 640/1920 < 640/1080
	assert.equal(lb.padY.toFixed(1), "140.0"); // (640 - 1080*0.3333)/2 = 140
	assert.equal(lb.padX.toFixed(1), "0.0");
});

test("modelBoxToFrame maps letterboxed model pixels back to normalized frame coords", () => {
	const lb = letterbox(320, 320, 640, 640); // scale 2, no padding
	const frameBox = modelBoxToFrame([240, 240, 160, 160], lb, 320, 320);
	assert.deepEqual(frameBox.map((v) => v.toFixed(3)), ["0.375", "0.375", "0.250", "0.250"]);
});

test("nms suppresses overlapping boxes, keeps distant ones", () => {
	const kept = nms(
		[[0, 0, 0.2, 0.2], [0.01, 0, 0.2, 0.2], [0.8, 0.8, 0.2, 0.2]],
		[0.9, 0.8, 0.7],
		0.45,
	);
	assert.deepEqual(kept, [0, 2]);
});

test("decodeYolo boxes-first [1, 4+C, N]: detection, letterbox mapping, class label", () => {
	const classes = ["person", "dog"];
	const n = 3;
	const data = new Float32Array((4 + classes.length) * n);
	// Candidate 0: person at model-input center (input 640, src 1920x1080).
	const put = (i, off, v) => {
		data[off * n + i] = v;
	};
	put(0, 0, 320); // cx — frame horizontal center
	put(0, 1, 320); // cy — center of the 360px-tall letterbox band (140+180)
	put(0, 2, 128); // w
	put(0, 3, 128); // h
	put(0, 4, 0.93); // person
	put(0, 5, 0.03); // dog
	// Candidate 1: duplicate box slightly shifted (should NMS away)
	put(1, 0, 330);
	put(1, 1, 320);
	put(1, 2, 128);
	put(1, 3, 128);
	put(1, 4, 0.6);
	put(1, 5, 0.2);
	// Candidate 2: below threshold
	put(2, 0, 100);
	put(2, 1, 100);
	put(2, 2, 50);
	put(2, 3, 50);
	put(2, 4, 0.1);
	put(2, 5, 0.1);
	const dets = decodeYolo(data, [1, 4 + classes.length, n], classes, {
		inputSize: 640,
		srcW: 1920,
		srcH: 1080,
		confThreshold: 0.45,
		iouThreshold: 0.45,
	});
	assert.equal(dets.length, 1);
	assert.equal(dets[0].cls, "person");
	assert.ok(dets[0].conf > 0.9);
	// 128 model px wide at scale 0.3333 over 1920 px frame:
	assert.equal(dets[0].bbox[2].toFixed(3), "0.200");
	// centered horizontally (model cx 320 = frame center)
	assert.equal((dets[0].bbox[0] + dets[0].bbox[2] / 2).toFixed(3), "0.500");
	// vertically centered inside the letterbox band
	assert.equal((dets[0].bbox[1] + dets[0].bbox[3] / 2).toFixed(3), "0.500");
});

test("decodeYolo sequence-first [1, N, 4+C] layout decodes identically", () => {
	const classes = ["person"];
	const stride = 5;
	const n = 2;
	const data = new Float32Array(n * stride);
	data[0] = 320; data[1] = 320; data[2] = 100; data[3] = 100; data[4] = 0.9;
	data[5] = 320; data[6] = 320; data[7] = 100; data[8] = 100; data[9] = 0.5;
	const dets = decodeYolo(data, [1, n, stride], classes, {
		inputSize: 640,
		srcW: 640,
		srcH: 640,
		confThreshold: 0.45,
		iouThreshold: 0.45,
	});
	assert.equal(dets.length, 1);
	assert.equal(dets[0].cls, "person");
});

test("decodeYolo rejects unexpected output shapes", () => {
	assert.throws(() => decodeYolo(new Float32Array(12), [1, 3, 4], ["person"], {
		inputSize: 640, srcW: 640, srcH: 640, confThreshold: 0.5, iouThreshold: 0.45,
	}), /stride/);
});

test("toModelInput packs rgb CHW and maps dst pixels back to source", () => {
	// 2x2 frame into a 4x4 input: scale 2, no padding. dst(x,y)→src(x/2, y/2).
	const src = new Uint8Array([
		200, 0, 0, // src(0,0)
		0, 255, 0, // src(0,1)
		0, 0, 255, // src(1,0)
		255, 255, 255, // src(1,1)
	]);
	const lb = letterbox(2, 2, 4, 4);
	const out = toModelInput(src, 2, 2, 3, 4, 4, lb);
	const plane = 4 * 4;
	const f32 = (/** @type {number} */ x) => Math.fround(x / 255);
	assert.equal(out.length, 3 * plane);
	assert.equal(out[0], f32(200)); // dst(0,0).R → src(0,0).R
	assert.equal(out[1], f32(200)); // dst(1,0).R → src(0,0).R
	assert.equal(out[2], f32(0)); // dst(2,0).R → src(1,0).R
	assert.equal(out[3], f32(0)); // dst(3,0).R → src(1,0).R
	assert.equal(out[16], f32(0)); // dst(0,0).G
	assert.equal(out[16 + 2], f32(255)); // dst(2,0).G → src(1,0).G
	assert.equal(out[2 * plane], f32(0)); // dst(0,0).B → src(0,0).B
	assert.equal(out[2 * plane + 2], f32(0)); // dst(2,0).B → src(1,0).B = (0,255,0).B
});

test("toModelInput zeroes letterbox padding rows/cols", () => {
	// 4x2 (16:9-ish) frame into 4x4 input: scale 1, padY = 1.
	const src = new Uint8Array(4 * 2 * 3).fill(120);
	const lb = letterbox(4, 2, 4, 4);
	assert.equal(lb.padY, 1);
	const out = toModelInput(src, 4, 2, 3, 4, 4, lb);
	const plane = 4 * 4;
	// Pad row y=0 is all zero; content rows are y=1,2; pad row y=3 zero.
	for (let x = 0; x < 4; x++) {
		assert.equal(out[0 * 4 + x], 0);
		assert.equal(out[3 * 4 + x], 0);
		assert.equal(out[1 * 4 + x], Math.fround(120 / 255));
	}
	assert.equal(out[plane + 1 * 4 + 2], Math.fround(120 / 255)); // G plane inside content
});
