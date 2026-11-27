// service.test.js — the audio analysis service orchestration (PORCH-153):
// windowed classification (ac-1), off-by-default enablement + the
// disabled-camera zero-analysis proof (ac-3), consumer-loss degradation with
// visual detection continuing (ac-4), and the compute re-point seam.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AudioAnalysisService, AudioWindower } from "../src/service.js";
import { NullAudioSink } from "../src/sink.mqtt.js";
import { DetectionService, DetectionTracker, NullDetectionSink } from "@porchlight/detection";

/** @param {string} camera @param {number} t @param {number} seconds @param {number} [rate] */
function chunk(camera, t, seconds = 1, rate = 16000) {
	const n = Math.round(seconds * rate);
	return { camera, t, sampleRate: rate, data: new Float32Array(n).fill(0.25) };
}

/** Provider spy: counts classify calls, answers configurable hits. */
function spyProvider(/** @type {{cls: string, conf: number}[]} */ hits, name = "spy-audio") {
	let calls = 0;
	return {
		name,
		calls: () => calls,
		/** @param {unknown} _frame */
		async classify(_frame) {
			calls += 1;
			return hits.map((h) => ({ ...h }));
		},
		status: () => ({ engine: "test", providerClass: "native-mlx", model: null, executionTarget: "gpu/ane", state: "native", reason: null }),
		close: async () => {},
	};
}

function service(opts = {}) {
	return new AudioAnalysisService({
		provider: opts.provider ?? spyProvider([{ cls: "dog-bark", conf: 0.93 }]),
		sink: opts.sink ?? new NullAudioSink(),
		enabledFor: opts.enabledFor ?? (() => true),
		windowMs: opts.windowMs ?? 1000,
		now: opts.now ?? (() => 1764200000 + 1),
		log: () => {},
	});
}

test("ac-1: an enabled camera classifies a sample clip and publishes the exact AudioEvent contract", async () => {
	const sink = new NullAudioSink();
	const svc = service({ sink, now: () => 1764200001 });
	// One full 1-second window from two chunks (the stream-serving path
	// delivers the decoded track in arbitrary chunk sizes).
	await svc.submit(chunk("cam-front", 1000, 0.4));
	const result = await svc.submit(chunk("cam-front", 1000.4, 0.7));
	assert.equal(result.refused, null);
	assert.equal(sink.published.length, 1, "one window → one classification → one event");
	const event = sink.published[0];
	// The TS 8 field set of record, verbatim.
	assert.deepEqual(Object.keys(event).sort(), ["camera", "class", "clipEnd", "clipStart", "confidence", "provider", "timestamp"]);
	assert.equal(event.camera, "cam-front");
	assert.equal(event.class, "dog-bark");
	assert.equal(event.confidence, 0.93);
	assert.equal(event.provider, "spy-audio");
	// Clip references resolve through the segment index: the window spans
	// [clipStart, clipEnd] and the timestamp is the confirmation moment.
	assert.equal(event.clipStart, 1000);
	assert.ok(Math.abs((event.clipEnd - event.clipStart) - 1) < 0.001, "the window is the full second");
	assert.equal(event.timestamp, 1764200001);
	// Latency is measured — the observable the benchmark-gated target reads
	// (no number commits before the benchmark run, PORCH-153 ac-1).
	assert.ok(typeof result.latencyMs === "number" && result.latencyMs >= 0);
});

test("ac-1 (latency guard): the publish pass stays inside the CI regression budget", async () => {
	const svc = service({ now: () => 1764200002 });
	await svc.submit(chunk("cam-a", 2000, 0.5));
	const result = await svc.submit(chunk("cam-a", 2000.5, 0.6));
	// NOTE: not the benchmark latency number of record — a generous CI
	// regression guard only. The latency TARGET gates on the benchmark run.
	assert.ok(result.latencyMs < 5000, `classify→publish took ${result.latencyMs}ms`);
});

test("privacy posture: with no enablement injected, nothing analyzes (off by default)", async () => {
	const sink = new NullAudioSink();
	const provider = spyProvider([{ cls: "dog-bark", conf: 0.9 }]);
	const svc = new AudioAnalysisService({
		provider, sink, windowMs: 1000,
		// no enabledFor — the off-by-default privacy posture
		now: () => 1764200003, log: () => {},
	});
	const result = await svc.submit(chunk("cam-x", 3000));
	assert.ok(result.refused && /off for camera/.test(result.refused), `a refused chunk names why: ${result.refused}`);
	assert.equal(provider.calls(), 0, "zero analysis runs");
	assert.equal(sink.published.length, 0, "no audio events publish");
	assert.equal(svc.windower.retained().samples, 0, "no audio frames retained for analysis");
});

test("ac-3: a disabled camera is refused at the gate — zero execution, zero retention, zero events, observable", async () => {
	const sink = new NullAudioSink();
	const provider = spyProvider([{ cls: "glass-break", conf: 0.97 }]);
	const svc = service({
		sink, provider,
		// The knob reader of record returns the resolved audioDetectionEnabled
		// (base default false) WITH its source layer.
		enabledFor: (camera) => camera === "cam-disabled"
			? { value: false, source: "base" }
			: { value: true, source: "base" },
		now: () => 1764200004,
	});
	for (const at of [4000, 4000.4, 4000.9]) {
		const result = await svc.submit(chunk("cam-disabled", at));
		assert.ok(result.refused, "every chunk of a disabled camera refuses at the gate");
	}
	assert.match(String((await svc.submit(chunk("cam-disabled", 4001))).refused ?? ""), /off for camera "cam-disabled".*"base"/, "the refusal names the knob and its source layer");
	// ZERO EXECUTION observable: the provider was never invoked for the
	// disabled camera, no frames were retained, and no event published.
	assert.equal(provider.calls(), 0);
	assert.deepEqual(svc.windower.retained().cameras, []);
	assert.equal(svc.windower.retained().samples, 0);
	assert.equal(sink.published.length, 0);
	assert.equal(svc.status().refused, 4);
	// An enabled camera in the same fleet still analyzes normally.
	await svc.submit(chunk("cam-enabled", 4000, 1));
	assert.equal(provider.calls(), 1);
	assert.equal(sink.published.length, 1);
	// A partially filled window for the enabled camera is the only retained
	// audio — the disabled camera left no windower state at all.
	await svc.submit(chunk("cam-enabled", 4001, 0.4));
	assert.deepEqual(svc.windower.retained().cameras, ["cam-enabled"]);
});

test("windowing reassembles partial chunks and keeps the remainder", () => {
	const w = new AudioWindower({ windowMs: 1000 });
	assert.equal(w.push(chunk("cam-1", 5000, 0.4)).length, 0, "nothing completes before a full window");
	assert.equal(w.push(chunk("cam-1", 5000.4, 0.5)).length, 0, "0.4s + 0.5s still windowed under");
	const windows = w.push(chunk("cam-1", 5000.9, 0.2));
	assert.equal(windows.length, 1, "0.9s + 0.2s completes one window and keeps 0.1s");
	assert.equal(windows[0].clipStart, 5000);
	assert.ok(Math.abs((windows[0].clipEnd - windows[0].clipStart) - 1) < 0.001);
	// The remainder stays retained — observable, bounded, per camera.
	const state = w.retained();
	assert.deepEqual(state.cameras, ["cam-1"]);
	assert.ok(Math.abs(state.samples / 16000 - 0.1) < 0.001, "the 0.1s remainder is the only retained audio");
	// The remainder's first clip epoch advanced past the consumed span:
	// the next window starts where the samples actually continue.
	const next = w.push(chunk("cam-1", 5001.1, 1));
	assert.equal(next.length, 1);
	assert.equal(next[0].clipStart, 5001.0, "the 0.1s remainder opened the next window");
});

test("retention cap: an over-max bucket drops oldest samples, counted and stated", () => {
	const w = new AudioWindower({ windowMs: 1000, maxMs: 1500 });
	// 2s of samples with a 1.5s cap: the earliest 0.5s drops before windowing.
	w.push(chunk("cam-1", 6000, 2));
	const state = w.retained();
	assert.equal(state.droppedSamples, 0.5 * 16000);
});

test("ac-4: a stopped consumer degrades audio events only — visual detection and recording continue", async () => {
	const detectionSink = new NullDetectionSink();
	const detection = new DetectionService({
		provider: {
			name: "visual-spy",
			detect: async () => [{ cls: "person", conf: 0.9, bbox: [0.1, 0.1, 0.4, 0.4] }],
			status: () => ({ engine: "test", providerClass: "native-mlx", model: null, executionTarget: "gpu/ane", state: "native", reason: null }),
		},
		sink: detectionSink,
		trackerFactory: () => new DetectionTracker({ minHits: 1 }),
	});
	const sink = new NullAudioSink();
	const provider = spyProvider([{ cls: "dog-bark", conf: 0.9 }]);
	const svc = service({ sink, provider, now: () => 1764200005 });

	svc.stop("the analysis worker crashed after the audio provider threw");
	const audioResult = await svc.submit(chunk("cam-a", 7000));
	assert.ok(audioResult.refused, "the stopped consumer refuses chunks");
	assert.equal(provider.calls(), 0, "no analysis runs while stopped");
	assert.equal(sink.published.length, 0);

	// The never-silent degradation of record: the stage's status reports the
	// failure with the explained reason — audio degraded, the rest stated.
	const posture = svc.computeStatus();
	assert.equal(posture.state, "failed");
	assert.match(
		String(posture.reason),
		/audio event analysis stopped \(the analysis worker crashed after the audio provider threw\) — sounds no longer raise camera events; recording and visual detection continue\./,
	);
	assert.equal(svc.status().stopped, true);

	// Visual detection runs UNAFFECTED through the same window of time.
	const visual = await detection.submit({ camera: "cam-a", w: 8, h: 8, t: 7000, format: "rgb", data: new Uint8Array(8 * 8 * 3).fill(200) });
	assert.equal(visual.objects.length, 1, "visual detection keeps publishing");
	assert.equal(visual.objects[0].cls, "person");
	assert.equal(detectionSink.published.length, 1);

	// Restart clears the degradation without restarting anything else.
	svc.restart();
	const again = await svc.submit(chunk("cam-a", 7001, 1));
	assert.equal(again.refused, null);
	assert.equal(provider.calls(), 1, "the consumer analyzes again after the clear");
});

test("compute re-point seam: the provider swaps live without a restart, generation bumps", async () => {
	const sink = new NullAudioSink();
	const svc = service({ sink, now: () => 1764200006 });
	await svc.submit(chunk("cam-a", 8000, 1));
	assert.equal(sink.published[0].provider, "spy-audio");

	const next = spyProvider([{ cls: "glass-break", conf: 0.8 }], "next-audio");
	const repointed = await svc.repoint(next);
	assert.equal(repointed.name, "next-audio");
	assert.equal(repointed.generation, 1);
	assert.equal(svc.generation, 1);
	await svc.submit(chunk("cam-a", 8001, 1));
	assert.equal(sink.published[1].provider, "next-audio", "the re-point applied live");
	assert.equal(svc.provider, next);
});

test("computeStatus carries the provider's posture; an unreporting provider states unknown", async () => {
	const svc = new AudioAnalysisService({
		provider: /** @type {any} */ ({ name: "bare", classify: async () => [] }),
		sink: new NullAudioSink(),
		enabledFor: () => true,
		now: () => 1764200007,
		log: () => {},
	});
	const posture = svc.computeStatus();
	assert.equal(posture.state, "unknown");
	assert.match(String(posture.reason), /reports no status/);
	assert.match(String(svc.status().provider.reason ?? ""), /reports no status/);
});

test("a mid-stream sample-rate change is refused, never guessed", async () => {
	const svc = service({ now: () => 1764200008 });
	await svc.submit(chunk("cam-a", 9000, 0.4, 16000));
	await assert.rejects(() => svc.submit(chunk("cam-a", 9000.4, 0.4, 8000)), /sample-rate change/);
});

test("the provider's classification output is validated before any publish", async () => {
	const sink = new NullAudioSink();
	const svc = service({ sink, provider: spyProvider([{ cls: "dog-bark", conf: 4 }]), now: () => 1764200009 });
	// The first chunk windowing completes on the second chunk, where the
	// invalid confidence throws before anything publishes.
	await svc.submit(chunk("cam-a", 9500, 0.5));
	await assert.rejects(() => svc.submit(chunk("cam-a", 9500.5, 0.6)), /confidence outside \[0,1\]/);
	assert.equal(sink.published.length, 0);
});
