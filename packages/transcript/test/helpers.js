// helpers.js — shared test fakes for the transcript plane (PORCH-155).
// Follows the engine test convention: fakes inject, nothing networked.

import fsDefault from "node:fs";
import os from "node:os";
import path from "node:path";
import { rollingRefOf } from "../src/types.js";

/** A fake PCM chunk: one camera, `seconds` of 16 kHz mono noise-free tone. */
export function chunk(camera, t, seconds = 1, rate = 16_000, value = 0.5) {
	return { camera, t, sampleRate: rate, data: new Float32Array(Math.round(seconds * rate)).fill(value) };
}

/** A fake transcription provider with scripted answers keyed by window ref/camera. */
export function spyProvider({ name = "spy:whisper", answers = [], delayMs = 0, now = () => Date.now(), failOn = null } = {}) {
	/** @type {Array<{input: any, at: number, tookMs: number}>} */
	const calls = [];
	return {
		name,
		calls,
		/** @param {{camera: string, clipStart: number, clipEnd: number, sampleRate: number, data: Float32Array}} frame */
		async transcribe(frame) {
			const started = now();
			if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
			const answer = answers[calls.length];
			calls.push({ input: frame, at: started, tookMs: now() - started });
			if (failOn !== null && calls.length === failOn.call) throw new Error(failOn.message);
			return typeof answer === "function" ? answer({ ...frame, call: calls.length }) : (answer ?? { text: null });
		},
		status() {
			return { engine: "fake", providerClass: "native-mlx", state: "configured", model: "fake" };
		},
		async close() {},
	};
}

/** Deterministic test embedder: 8-dim normalized hashing vector. Same text
 * always embeds identically; cosine ranks lexical overlap predictably. */
export class DeterministicEmbedder {
	constructor({ name = "test:embed", dims = 8 } = {}) {
		this.name = name;
		this.dims = dims;
		/** @type {string[]} */
		this.embedded = [];
	}

	async embed(text) {
		this.embedded.push(text);
		const data = new Float32Array(this.dims);
		try {
			const words = text.toLowerCase().split(/\s+/).filter(Boolean);
			for (const word of words) {
				// 4-char stem bucket: inflections of one word embed near each
				// other (bark/barked), which is what search ranking needs.
				const stem = word.replace(/[^a-z0-9]/g, "").slice(0, 4);
				if (!stem) continue;
				let h = 2166136261;
				for (let i = 0; i < stem.length; i++) {
					h ^= stem.charCodeAt(i);
					h = Math.imul(h, 16777619) >>> 0;
				}
				data[h % this.dims] += 1;
			}
		} catch { /* empty text never reaches here — the service refuses */ }
		let norm = 0;
		for (const v of data) norm += v * v;
		norm = Math.sqrt(norm) || 1;
		for (let i = 0; i < data.length; i++) data[i] /= norm;
		return { data };
	}

	status() {
		return { engine: "fake", providerClass: "native-mlx", model: "test", state: "configured" };
	}
}

/** Fresh transcripts tree of record under a temp root. */
export function tempTree(tag = "transcript") {
	const dir = fsDefault.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
	return {
		root: path.join(dir, "transcripts"),
		cleanup() {
			fsDefault.rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** Window ref of record for a camera at aligned start seconds. */
export function refFor(camera, startSec) {
	return rollingRefOf(camera, Math.round(startSec * 1000));
}

/** Push `seconds` of PCM through a service at 60 s chunk granularity. */
export async function feed(service, camera, fromSec, seconds, { rate = 16_000, secPerChunk = 60, value = 0.5 } = {}) {
	let t = fromSec;
	const end = fromSec + seconds;
	while (t < end) {
		const take = Math.min(secPerChunk, end - t);
		await service.submitRollingAudio(chunk(camera, t, take, rate, value));
		t += take;
	}
}

/** Log sink that captures lines (never-silent assertions read it). */
export function logSink() {
	/** @type {string[]} */
	const lines = [];
	/** @type {(...args: unknown[]) => void} */
	const fn = (...args) => lines.push(args.map(String).join(" "));
	return { fn, lines };
}
