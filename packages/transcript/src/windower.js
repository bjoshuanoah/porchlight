// windower.js — the rolling transcription windower (PORCH-155; TS 13
// "Rolling windows": aligned ~1-minute windows over each camera's decoded
// PCM). Windows are ALIGNED to wall-clock minute boundaries so the window
// id `window-<camera>-<startMs>` is stable for retention and vector refs.
// A window is emitted COMPLETE when its span is fully covered — the next
// window's first sample — so transcription cadence ("transcribes in well
// under its wall-clock length") is measured window-close → text-landed,
// never source-arrival → text: the transcriber is real-time with headroom
// rather than chasing the feed.

import { ValidationError } from "./types.js";

/**
 * A completed rolling window: contiguous samples covering
 * [clipStart, clipEnd].
 *
 * @typedef {object} RollingWindow
 * @property {string} camera
 * @property {string} ref        window-<camera>-<startMs>
 * @property {number} clipStart  epoch seconds
 * @property {number} clipEnd    epoch seconds
 * @property {number} sampleRate Hz
 * @property {Float32Array} data
 */

export class RollingWindower {
	/**
	 * @param {{ windowMs?: number, log?: (...args: unknown[]) => void }} [opts]
	 */
	constructor(opts = {}) {
		this.windowMs = opts.windowMs ?? 60_000;
		if (!Number.isFinite(this.windowMs) || this.windowMs <= 0) throw new ValidationError("windowMs: must be a positive number of milliseconds");
		/** @type {Map<string, { camera: string, chunks: Array<{t: number, data: Float32Array}>, startSec: number, sampleRate: number }>} */
		this.buckets = new Map();
	}

	/**
	 * Push one decoded chunk; returns the COMPLETED windows for that camera.
	 * Chunks before the first boundary accumulate; buckets are per-camera so
	 * each camera's cadence is its own.
	 *
	 * @param {{ camera: string, t: number, sampleRate: number, data: Float32Array }} chunk
	 * @returns {RollingWindow[]}
	 */
	push(chunk) {
		if (!chunk || typeof chunk.camera !== "string" || chunk.camera.trim() === "") {
			throw new ValidationError("chunk.camera: required");
		}
		if (!Number.isFinite(chunk.t) || !Number.isFinite(chunk.sampleRate) || chunk.sampleRate <= 0) {
			throw new ValidationError("chunk.t/sampleRate: epoch seconds and a positive sample rate are required");
		}
		if (!(chunk.data instanceof Float32Array)) {
			throw new ValidationError("chunk.data: must be a Float32Array of mono PCM samples");
		}
		const spanSec = this.windowMs / 1000;
		const bucket = this.buckets.get(chunk.camera) ?? { camera: chunk.camera, chunks: [], startSec: chunk.t, sampleRate: chunk.sampleRate };
		bucket.chunks.push(chunk);
		/** @type {RollingWindow[]} */
		const completed = [];
		// Emit every full window the chunk's span has passed (a catch-up chunk
		// after a stall drains sequentially, in time order).
		const endSec = chunk.t + chunk.data.length / chunk.sampleRate;
		while (bucket.chunks.length > 0 && bucket.startSec + spanSec <= endSec + 1e-9) {
			const w = coalesceSpan(bucket, bucket.startSec, spanSec, `window-${bucket.camera}-${Math.round(bucket.startSec * 1000)}`);
			if (!w) break;
			completed.push({ camera: bucket.camera, ref: w.ref, clipStart: w.clipStart, clipEnd: w.clipEnd, sampleRate: w.sampleRate, data: w.data });
			bucket.startSec += spanSec; // next aligned window opens here
		}
		if (bucket.chunks.length > 0) this.buckets.set(chunk.camera, bucket);
		else this.buckets.delete(chunk.camera);
		return completed;
	}

	/**
	 * Close out one camera — flush its pending remainder as a final window
	 * (`window-<camera>-<startMs>`), used at consumer stop so analyzed audio
	 * never loses its tail.
	 * @param {string} camera
	 * @returns {RollingWindow|null}
	 */
	flush(camera) {
		const bucket = this.buckets.get(camera);
		if (!bucket || bucket.chunks.length === 0) return null;
		const spanSec = chunkEnd(bucket.chunks[bucket.chunks.length - 1], bucket.sampleRate) - bucket.startSec;
		if (spanSec <= 0) {
			this.buckets.delete(camera);
			return null;
		}
		const w = coalesceSpan(bucket, bucket.startSec, spanSec, `window-${camera}-${Math.round(bucket.startSec * 1000)}`);
		this.buckets.delete(camera);
		return w
			? { camera, ref: w.ref, clipStart: w.clipStart, clipEnd: w.clipEnd, sampleRate: w.sampleRate, data: w.data }
			: null;
	}

	/**
	 * Observable retention state — per-camera pending spans.
	 */
	retained() {
		/** @type {Record<string, { startSec: number, pendingSec: number, chunks: number, sampleRate: number }>} */
		const out = {};
		for (const [camera, bucket] of this.buckets) {
			const last = bucket.chunks[bucket.chunks.length - 1];
			out[camera] = {
				startSec: bucket.startSec,
				pendingSec: Math.max(0, chunkEnd(last, bucket.sampleRate) - bucket.startSec),
				chunks: bucket.chunks.length,
				sampleRate: bucket.sampleRate,
			};
		}
		return out;
	}
}

function chunkEnd(c, sampleRate) {
	return c.t + c.data.length / sampleRate;
}

/**
 * Concatenate exactly the chunk-queue head covering [startSec, startSec +
 * spanSec); a partially consumed head chunk keeps its remaining samples
 * truthfully (its time advances by the consumed samples) and stays on the
 * queue with its samples in time order.
 */
function coalesceSpan(bucket, startSec, spanSec, ref) {
	const want = Math.round(spanSec * bucket.sampleRate);
	if (want <= 0) return null;
	const data = new Float32Array(want);
	let filled = 0;
	let i = 0;
	while (i < bucket.chunks.length && filled < want) {
		const c = bucket.chunks[i];
		const offsetSamples = Math.max(0, Math.round((startSec - c.t) * bucket.sampleRate));
		const available = c.data.length - offsetSamples;
		const take = Math.min(available, want - filled);
		if (take <= 0) {
			i += 1;
			continue;
		}
		data.set(c.data.subarray(offsetSamples, offsetSamples + take), filled);
		filled += take;
		if (offsetSamples + take >= c.data.length) i += 1;
		else bucket.chunks[i] = { t: c.t + (offsetSamples + take) / bucket.sampleRate, data: c.data.subarray(offsetSamples + take) };
	}
	// Drop fully consumed head chunks; keep the queue's remaining samples.
	if (i > 0) bucket.chunks.splice(0, i);
	if (filled === 0) return null;
	return {
		ref,
		clipStart: Math.round(startSec * 1000) / 1000,
		clipEnd: Math.round((startSec + spanSec) * 1000) / 1000,
		sampleRate: bucket.sampleRate,
		data,
	};
}
