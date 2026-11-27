// service.js — the audio analysis service orchestration (PORCH-153; PRD 8 /
// TS 8). One AudioProvider (the TS 5 classification seam, audio per TS 8) and
// an AudioSink publish path: chunk → enablement gate → window → classify →
// publish. Per-camera enablement rides the injected knob reader (the TS 12
// audioDetectionEnabled knob, off by default); a disabled camera has NO
// analysis run and NO frames retained for analysis. The sink (transport) is
// injected so the bus can re-point without core changes.
//
// Degradation law (TS 8): audio analysis is a consumer of the stream
// manager. Losing it degrades AUDIO EVENTS ONLY — visual detection and
// recording continue. stop(reason) marks the consumer stopped; the stage's
// status reports the failure with the explained reason (never-silent law),
// and the reason names what still works.

import { assertAudioChunk, assertAudioEvent, assertAudioFrame } from "./types.js";

/** @typedef {import("./types.js").AudioChunk} AudioChunk */
/** @typedef {import("./types.js").AudioFrame} AudioFrame */
/** @typedef {import("./types.js").AudioEvent} AudioEvent */
/** @typedef {import("./types.js").AudioProvider} AudioProvider */
/** @typedef {import("./types.js").AudioSink} AudioSink */
/** @typedef {import("./types.js").AudioEnabledFor} AudioEnabledFor */

/**
 * Per-camera windower: accumulates decoded chunks into ~windowMs windows
 * (TS 8: "windowed classification over PCM frames"). Buckets are per
 * camera; a bounded cap prevents unbounded retention when a provider stalls
 * — the oldest samples drop first with a counted, stated reason.
 */
export class AudioWindower {
	/**
	 * @param {{ windowMs?: number, maxMs?: number, log?: (...args: unknown[]) => void }} [opts]
	 */
	constructor(opts = {}) {
		this.windowMs = opts.windowMs ?? 1000;
		this.maxMs = Math.max(opts.maxMs ?? 5000, this.windowMs);
		this.log = opts.log ?? (() => {});
		/** @type {Map<string, { chunks: { t: number, data: Float32Array }[], samples: number, sampleRate: number }>} */
		this.buckets = new Map();
		/** Counted, stated retention overflow (never-silent law). */
		this.dropped = 0;
	}

	/**
	 * Push one chunk; returns completed windows for that camera.
	 * @param {AudioChunk} chunk
	 * @returns {AudioFrame[]}
	 */
	push(chunk) {
		assertAudioChunk(chunk);
		const bucket = this.buckets.get(chunk.camera) ?? { chunks: [], samples: 0, sampleRate: chunk.sampleRate };
		if (chunk.sampleRate !== bucket.sampleRate) {
			throw new TypeError(`AudioWindower: a mid-stream sample-rate change on camera "${chunk.camera}" (${bucket.sampleRate} → ${chunk.sampleRate} Hz) is refused — the windower's span math is rate-bound, never guessed`);
		}
		bucket.chunks.push({ t: chunk.t, data: chunk.data });
		bucket.samples += chunk.data.length;
		// Retention cap: a stalled consumer never grows without bound. The
		// oldest samples drop first (a head chunk truncates in place, its
		// time advancing truthfully); the loss is counted, never silent.
		const maxSamples = Math.round((this.maxMs / 1000) * chunk.sampleRate);
		while (bucket.samples > maxSamples && bucket.chunks.length > 0) {
			const head = bucket.chunks[0];
			const surplus = bucket.samples - maxSamples;
			if (surplus >= head.data.length) {
				bucket.chunks.shift();
				bucket.samples -= head.data.length;
				this.dropped += head.data.length;
			} else {
				const take = surplus;
				bucket.chunks[0] = { t: head.t + take / bucket.sampleRate, data: head.data.subarray(take) };
				bucket.samples -= take;
				this.dropped += take;
			}
		}
		const windowSamples = Math.round((this.windowMs / 1000) * chunk.sampleRate);
		/** @type {AudioFrame[]} */
		const windows = [];
		while (bucket.samples >= windowSamples) {
			const window = coalesce(bucket.chunks, windowSamples, chunk.sampleRate);
			bucket.chunks = window.remainder;
			bucket.samples = window.remainder.reduce((sum, c) => sum + c.data.length, 0);
			windows.push({
				camera: chunk.camera,
				clipStart: window.clipStart,
				clipEnd: window.clipStart + windowSamples / chunk.sampleRate,
				sampleRate: chunk.sampleRate,
				data: window.data,
			});
		}
		if (windowChunksPending(bucket)) {
			this.buckets.set(chunk.camera, bucket);
		} else {
			this.buckets.delete(chunk.camera);
		}
		return windows;
	}

	/**
	 * Observable retention state — the disabled-camera zero-retention proof
	 * reads this (PORCH-153 ac-3): a disabled camera's chunks never reach the
	 * windower at all, and a fully consumed bucket leaves no state.
	 * @returns {{ cameras: string[], samples: number, droppedSamples: number, windowMs: number }}
	 */
	retained() {
		/** @type {string[]} */
		const cameras = [];
		let samples = 0;
		for (const [camera, bucket] of this.buckets) {
			cameras.push(camera);
			samples += bucket.samples;
		}
		return { cameras, samples, droppedSamples: this.dropped, windowMs: this.windowMs };
	}
}

/** A partially consumed head chunk is still pending classification input. */
function windowChunksPending(bucket) {
	return bucket.chunks.length > 0;
}

/**
 * Concatenate exactly `want` samples from the head of chronological chunks.
 * Returns the window payload, its first-sample epoch (clipStart), and the
 * remainder chunks (a partially consumed head keeps its residual samples
 * with its time advanced by the consumed span).
 * @param {{ t: number, data: Float32Array }[]} chunks
 * @param {number} want
 * @param {number} sampleRate
 */
function coalesce(chunks, want, sampleRate) {
	const data = new Float32Array(want);
	const clipStart = chunks[0].t;
	let filled = 0;
	let i = 0;
	while (i < chunks.length && filled < want) {
		const chunk = chunks[i];
		const remain = want - filled;
		if (chunk.data.length <= remain) {
			data.set(chunk.data, filled);
			filled += chunk.data.length;
			i += 1;
		} else {
			const take = remain;
			data.set(chunk.data.subarray(0, take), filled);
			// The partial head chunk keeps time truthfully: its remaining
			// samples start `take` samples later, and it stays on the remainder.
			chunks[i] = { t: chunk.t + take / sampleRate, data: chunk.data.subarray(take) };
			filled = want;
			break;
		}
	}
	return { data, clipStart, remainder: chunks.slice(i) };
}

export class AudioAnalysisService {
	/**
	 * @param {{
	 *   provider: AudioProvider,
	 *   sink: AudioSink,
	 *   enabledFor?: AudioEnabledFor,
	 *   windowMs?: number,
	 *   maxMs?: number,
	 *   now?: () => number,
	 *   log?: (...args: unknown[]) => void,
	 * }} opts
	 */
	constructor(opts) {
		if (!opts.now || typeof opts.now !== "function") throw new TypeError("AudioAnalysisService: now is required");
		if (!opts.log || typeof opts.log !== "function") throw new TypeError("AudioAnalysisService: log is required");
		if (!opts.provider || typeof opts.provider.classify !== "function") {
			throw new TypeError("AudioAnalysisService: provider must implement AudioProvider");
		}
		if (!opts.sink || typeof opts.sink.publish !== "function") {
			throw new TypeError("AudioAnalysisService: sink must implement AudioSink");
		}
		// Privacy posture (TS 8/PRD 8): audio analysis is OFF by default per
		// camera — absent enablement resolution means nothing analyzes. A
		// deployment turns it on deliberately through the knob of record.
		this.enabledFor = opts.enabledFor ?? (() => false);
		this.provider = opts.provider;
		this.sink = opts.sink;
		this.now = opts.now;
		this.log = opts.log;
		this.windower = new AudioWindower({ windowMs: opts.windowMs ?? 1000, maxMs: opts.maxMs });
		this.chunks = 0;
		this.refused = 0;
		this.published = 0;
		this.generation = 0;
		/** @type {{ reason: string|null }} consumer-loss state (never silent) */
		this.stopped = { reason: null };
	}

	/**
	 * Normalize a knob reader answer to { value, source }. Boolean answers
	 * carry source "injected" (the composition root's own seam).
	 * @param {string} camera
	 * @returns {Promise<{ value: boolean, source: string }>}
	 */
	async enabled(camera) {
		const answer = await this.enabledFor(camera);
		if (typeof answer === "boolean") return { value: answer, source: "injected" };
		if (answer && typeof answer.value === "boolean" && typeof answer.source === "string") {
			return { value: answer.value, source: answer.source };
		}
		throw new TypeError(`audio enablement for camera "${camera}" must be boolean or { value: boolean, source: string }`);
	}

	/**
	 * Re-point the live provider (compute re-pointing, PORCH-152 seam):
	 * validates the AudioProvider protocol, closes the old provider (close
	 * errors are logged, never fatal), swaps it in live. Generation bumps
	 * with every re-point (visible in status()).
	 * @param {AudioProvider} provider
	 * @returns {Promise<{ name: string, generation: number }>}
	 */
	async repoint(provider) {
		if (
			!provider ||
			typeof provider.name !== "string" ||
			provider.name.length === 0 ||
			typeof provider.classify !== "function"
		) {
			throw new TypeError("AudioAnalysisService.repoint: provider must implement AudioProvider (a name string plus a classify(frame) function)");
		}
		const previous = this.provider;
		this.provider = provider;
		this.generation += 1;
		try {
			await previous.close?.();
		} catch (err) {
			this.log(`[audio] provider close during repoint failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
		}
		return { name: provider.name, generation: this.generation };
	}

	/**
	 * Run one decoded chunk through the plane: gate → window → classify →
	 * publish. For a DISABLED camera the chunk is refused immediately — the
	 * provider is never called and the windower keeps nothing (ac-3: zero
	 * analysis, zero retention, proven by counters and the provider spy).
	 * Returns the published events plus the wall latency of the classify→
	 * publish pass (ms). The LATENCY TARGET of record gates on the benchmark
	 * run (PORCH-153 ac-1) — no number commits before it; this measurement
	 * is the observable the benchmark reads.
	 *
	 * @param {AudioChunk} chunk
	 * @returns {Promise<{ events: AudioEvent[], latencyMs: number, refused: string|null }>}
	 */
	async submit(chunk) {
		assertAudioChunk(chunk);
		this.chunks += 1;
		if (this.stopped.reason) {
			this.refused += 1;
			return { events: [], latencyMs: 0, refused: this.stopped.reason };
		}
		const enabled = await this.enabled(chunk.camera);
		if (!enabled.value) {
			this.refused += 1;
			const reason = `audio detection is off for camera "${chunk.camera}" (enabledFor answered false via "${enabled.source}")`;
			return { events: [], latencyMs: 0, refused: reason };
		}
		const windows = this.windower.push(chunk);
		if (windows.length === 0) return { events: [], latencyMs: 0, refused: null };
		const started = performance.now();
		/** @type {AudioEvent[]} */
		const published = [];
		for (const window of windows) {
			assertAudioFrame(window);
			const hits = await this.provider.classify(window);
			const at = this.now();
			for (const hit of hits) {
				if (!hit || typeof hit.cls !== "string" || hit.cls.length === 0) {
					throw new TypeError("AudioProvider.classify returned a hit without a class string");
				}
				if (typeof hit.conf !== "number" || hit.conf < 0 || hit.conf > 1) {
					throw new TypeError(`AudioProvider.classify hit "${hit.cls}" has confidence outside [0,1]`);
				}
				/** @type {AudioEvent} */
				const event = {
					camera: window.camera,
					timestamp: at,
					class: hit.cls,
					confidence: hit.conf,
					clipStart: window.clipStart,
					clipEnd: window.clipEnd,
					provider: this.provider.name,
				};
				assertAudioEvent(event);
				await this.sink.publish(event);
				this.published += 1;
				published.push(event);
			}
		}
		return { events: published, latencyMs: performance.now() - started, refused: null };
	}

	/**
	 * Mark the consumer stopped (consumer-loss, ac-4): the audio plane
	 * reports its degradation as an explained state — the reason states that
	 * audio events stop while recording and visual detection continue — and
	 * every submitted chunk is refused until the consumer restarts. Never
	 * silent, never fatal to anything else.
	 * @param {string} reason
	 */
	stop(reason) {
		const detail = typeof reason === "string" && reason.trim() !== ""
			? reason
			: "the audio analysis consumer stopped";
		this.stopped = {
			reason: `audio event analysis stopped (${detail}) — sounds no longer raise camera events; recording and visual detection continue.`,
		};
		this.log(`[audio] ${this.stopped.reason}`);
	}

	/** Clear a consumer-loss: the plane accepts chunks again. */
	restart() {
		this.stopped = { reason: null };
	}

	/**
	 * Full never-silent posture of the stage: provider + sink status, chunk
	 * and publish counters, refusals (disabled cameras + consumer-stopped),
	 * windower retention and cap drops, and the re-point generation. The
	 * reporter the compute plane registers for "audio-classification" is
	 * {@link computeStatus}.
	 */
	status() {
		return {
			stage: "audio-classification",
			provider: this.provider.status?.() ?? { engine: "unknown", state: "unknown", reason: "the audio provider reports no status" },
			sink: this.sink.status?.() ?? {},
			chunks: this.chunks,
			published: this.published,
			refused: this.refused,
			windower: { ...this.windower.retained(), droppedSamples: this.windower.dropped, windowMs: this.windower.windowMs },
			generation: this.generation,
			stopped: this.stopped.reason !== null,
			stoppedReason: this.stopped.reason,
		};
	}

	/**
	 * The compute-posture reporter shape (registerStatus("audio-classification")):
	 * stage state with the never-silent states of record — "failed" while the
	 * consumer is stopped (reason names what degraded and what continues),
	 * otherwise the provider's own posture. A provider that cannot say its
	 * state reports "unknown" with the reason, never a blank.
	 * @returns {{ state: "native"|"cpu"|"degraded"|"failed"|"unknown", providerClass: string|null, model: string|null, executionTarget: string|null, reason: string|null }}
	 */
	computeStatus() {
		if (this.stopped.reason) {
			return { state: "failed", providerClass: null, model: null, executionTarget: null, reason: this.stopped.reason };
		}
		const raw = this.provider.status?.();
		const state = raw?.state ?? "unknown";
		return {
			state: state === "native" || state === "cpu" || state === "degraded" || state === "failed" ? state : "unknown",
			providerClass: raw?.providerClass ?? null,
			model: raw?.model ?? null,
			executionTarget: raw?.executionTarget ?? null,
			reason: raw?.reason ?? (state === "unknown" ? "the audio provider reports no status" : null),
		};
	}

	async close() {
		for (const fn of [this.provider.close?.(), this.sink.close?.()]) {
			if (fn) await fn;
		}
	}
}
