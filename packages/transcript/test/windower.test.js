// windower.test.js — the rolling windower (aligned ~1-minute windows,
// TS 13). Alignment is the stability law of the window id used by vectors
// and the retention cascade.

import test from "node:test";
import assert from "node:assert/strict";
import { RollingWindower } from "../src/windower.js";
import { chunk } from "./helpers.js";

test("windows align to wall-clock minute boundaries and carry stable ids", () => {
	const w = new RollingWindower({ windowMs: 60_000 });
	// Alignment rides the first span's start, so the id carries the true
	// start (recording-relative truth); a full chunk completes its window.
	const t0 = 1764244800.5;
	const out = w.push(chunk("cam", t0, 60));
	assert.equal(out.length, 1);
	assert.equal(out[0].clipStart, t0);
	assert.equal(out[0].clipEnd, t0 + 60);
	assert.match(out[0].ref, /^window-cam-\d+$/);
	assert.equal(out[0].data.length, 60 * 16_000);
});

test("a window emits only when its span is fully covered", () => {
	const w = new RollingWindower({ windowMs: 60_000 });
	assert.deepEqual(w.push(chunk("cam", 1000, 59)), []); // 59 s: not covered
	assert.equal(w.retained().cam.pendingSec > 58, true);
	const done = w.push(chunk("cam", 1059, 1.5)); // closes window 1
	assert.equal(done.length, 1);
	assert.equal(done[0].clipStart, 1000);
	assert.equal(done[0].clipEnd, 1060);
	// The pending remainder survives the partial chunk (truthful head time).
	assert.equal(w.retained().cam.pendingSec.toFixed(1), "0.5");
});

test("per-camera buckets keep each camera's cadence its own", () => {
	const two = new RollingWindower({ windowMs: 10_000 });
	// A full window-chunk emits immediately within its OWN bucket; the other
	// camera's bucket is untouched by it (per-camera buckets are independent).
	assert.deepEqual(two.push(chunk("a", 0, 10)).map((w) => w.camera), ["a"]);
	assert.deepEqual(two.push(chunk("b", 0, 10)).map((w) => w.camera), ["b"]);
	assert.deepEqual(two.retained().a, undefined, "a fully emitted bucket retains nothing");
	assert.deepEqual(two.retained().b, undefined);
	// A mid-window chunk opens a pending span in its own bucket only — it
	// cannot complete the window (the span is 6 s short) and emits nothing.
	assert.equal(two.push(chunk("a", 5, 6)).length, 0);
	assert.equal(two.push(chunk("b", 5, 6)).length, 0);
	assert.equal(two.retained().a.pendingSec, 6);
	assert.equal(two.retained().b.pendingSec, 6);
});

test("flush closes a camera's pending remainder as a final short window", () => {
	const w = new RollingWindower({ windowMs: 60_000 });
	w.push(chunk("cam", 1000, 25));
	const tail = w.flush("cam");
	assert.equal(tail.clipStart, 1000);
	assert.equal(tail.clipEnd, 1025);
	assert.match(tail.ref, /^window-cam-\d+$/);
	assert.equal(w.flush("cam"), null);
	assert.deepEqual(w.retained(), {});
});

test("a catch-up chunk after a stall drains sequentially in time order", () => {
	const w = new RollingWindower({ windowMs: 10_000 });
	assert.equal(w.push(chunk("cam", 0, 10)).length, 1); // window 1 completes
	// One 35-second chunk covering windows 2–4 in order.
	const out = w.push(chunk("cam", 10, 35));
	assert.deepEqual(out.map((x) => x.clipStart), [10, 20, 30]);
	assert.deepEqual(out.map((x) => x.clipEnd), [20, 30, 40]);
	assert.equal(w.retained().cam.pendingSec.toFixed(1), "5.0");
});

test("malformed chunks refuse in plain language", () => {
	const w = new RollingWindower({});
	assert.throws(() => w.push({ camera: "", t: 0, sampleRate: 16_000, data: new Float32Array(1) }), /camera/);
	assert.throws(() => w.push({ camera: "c", t: NaN, sampleRate: 16_000, data: new Float32Array(1) }), /sampleRate|t/);
	assert.throws(() => w.push({ camera: "c", t: 0, sampleRate: 0, data: new Float32Array(1) }), /sampleRate/);
	assert.throws(() => w.push({ camera: "c", t: 0, sampleRate: 16_000, data: [1, 2] }), /Float32Array/);
});
