// wav.test.js — wavOf() container law (PORCH-155): a RIFF/WAVE header of
// record over a 16-bit mono PCM data chunk, with clipping at ±full scale.
// Injected seams: none — wavOf is a pure function; every assertion reads
// the produced bytes.

import test from "node:test";
import assert from "node:assert/strict";
import { wavOf } from "../src/wav.js";

/** Assert a full 44-byte WAV header against a given sample rate / data size. */
function assertHeader(buf, sampleRate, dataBytes) {
	assert.equal(buf.byteLength, 44 + dataBytes, "WAV length is exactly 44 header bytes + 2 per sample");
	assert.equal(buf.subarray(0, 4).toString("ascii"), "RIFF", "RIFF marker at byte 0");
	assert.equal(buf.readUInt32LE(4), 36 + dataBytes, "RIFF chunk size covers header remainder + data");
	assert.equal(buf.subarray(8, 12).toString("ascii"), "WAVE", "WAVE marker at byte 8");
	assert.equal(buf.subarray(12, 16).toString("ascii"), "fmt ", "fmt chunk id at byte 12");
	assert.equal(buf.readUInt32LE(16), 16, "fmt chunk size is 16");
	assert.equal(buf.readUInt16LE(20), 1, "format tag is PCM (1)");
	assert.equal(buf.readUInt16LE(22), 1, "channel count is mono (1)");
	assert.equal(buf.readUInt32LE(24), sampleRate, "sample rate is LE at offset 24");
	assert.equal(buf.readUInt32LE(28), sampleRate * 2, "byte rate (offset 28) is sampleRate * 2 bytes");
	assert.equal(buf.readUInt16LE(32), 2, "block align (offset 32) is 2 bytes per frame");
	assert.equal(buf.readUInt16LE(34), 16, "bits per sample (offset 34) is 16");
	assert.equal(buf.subarray(36, 40).toString("ascii"), "data", "data chunk id at byte 36");
	assert.equal(buf.readUInt32LE(40), dataBytes, "data chunk size (offset 40) is LE bytes");
}

test("wavOf builds the RIFF/WAVE container of record at 16 kHz mono", () => {
	const data = new Float32Array(16000);
	const buf = wavOf(data, 16_000);
	assertHeader(buf, 16_000, 16000 * 2);
});

test("wavOf header follows the sample rate it is given", () => {
	const buf = wavOf(new Float32Array(4), 44_100);
	assertHeader(buf, 44_100, 8);
});

test("wavOf packs float [-1, 1] samples into 16-bit PCM with clipping", () => {
	// 0.5 in the mid-scale band, -1.0 and +1.0 at the rails.
	const data = new Float32Array([0.5, -1.0, 1.0]);
	const buf = wavOf(data, 16_000);
	const pcm0 = buf.readInt16LE(44);
	const pcm1 = buf.readInt16LE(46);
	const pcm2 = buf.readInt16LE(48);
	assert.ok(Math.abs(pcm0 - 0.5 * 0x7fff) <= 1, `0.5 maps near +16384-ish (got ${pcm0})`);
	assert.equal(pcm1, -32768, "-1.0 maps to the negative full-scale sample -32768");
	assert.equal(pcm2, 32767, "+1.0 clips to the positive full-scale sample 32767");
});

test("wavOf clips out-of-range input samples to ±full scale", () => {
	const data = new Float32Array([2.0, -2.0]);
	const buf = wavOf(data, 16_000);
	assert.equal(buf.readInt16LE(44), 32767, "+2.0 clips to 32767");
	assert.equal(buf.readInt16LE(46), -32768, "-2.0 clips to -32768");
});

test("wavOf payload is exactly 2 bytes per input sample after the 44-byte header", () => {
	const n = 321;
	const buf = wavOf(new Float32Array(n), 16_000);
	assert.equal(buf.byteLength, 44 + 2 * n);
	assert.equal(buf.length - 44, 2 * n);
});

test("wavOf rejects a zero sample rate", () => {
	assert.throws(() => wavOf(new Float32Array(2), 0), /sampleRate/);
});

test("wavOf rejects a NaN sample rate", () => {
	assert.throws(() => wavOf(new Float32Array(2), NaN), /sampleRate/);
});

test("wavOf rejects negative / non-finite sample rates", () => {
	assert.throws(() => wavOf(new Float32Array(2), -8000), /sampleRate/);
	assert.throws(() => wavOf(new Float32Array(2), Infinity), /sampleRate/);
});
