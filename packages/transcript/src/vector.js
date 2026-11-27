// vector.js — the local vector store of record for transcript text
// (PORCH-155; TS 13 "The vector store of record"). A local store, provisioned
// by the product's own setup (green-field law): one persisted JSON
// collection beside the transcripts it indexes, no pre-deployed service
// assumed. Transcript chunks embed at WRITE TIME (never lazy) with exactly
// the payload refs of TS 13 {cameraId, sourceType, sourceRef, startOffset,
// endOffset, text}; semantic audio search is a vector query over this
// collection ranked by cosine similarity. Deletions are payload-ref
// filtered (the retention cascade's same-pass vector half).
//
// The entry count of record is observable (list/count/audit) so the
// cascade e2e can assert ZERO orphan payloads — count verified, never
// assumed.

import fsDefault from "node:fs";
import path from "node:path";
import { assertVectorPayload, ValidationError } from "./types.js";

/** Entry id of record: one vector per (camera, family, ref, chunk start). */
export function vectorIdOf(payload) {
	return `${payload.cameraId}:${payload.sourceType}:${payload.sourceRef}:${roundSec(payload.startOffset)}`;
}

function roundSec(v) {
	return Math.round(v * 1000) / 1000;
}

export class LocalVectorStore {
	/**
	 * @param {{
	 *   file: string,          // persisted collection of record
	 *   fs?: typeof fsDefault,
	 *   log?: (...args: unknown[]) => void,
	 * }} opts
	 */
	constructor(opts) {
		if (!opts.file || typeof opts.file !== "string") throw new ValidationError("file: required (the collection file of record)");
		this.file = opts.file;
		this.fs = opts.fs ?? fsDefault;
		this.log = opts.log ?? (() => {});
		/** @type {Map<string, { vector: Float32Array, payload: import("./types.js").VectorPayload }>} */
		this.entries = new Map();
		this.#load();
	}

	/** Write-time embedding: one put per chunk, replacing the same chunk id. */
	put(vector, payload) {
		if (!vector || !(vector.data instanceof Float32Array) || vector.data.length === 0) {
			throw new ValidationError("vector: required (a non-empty Float32Array)");
		}
		assertVectorPayload(payload);
		const id = vectorIdOf(payload);
		this.entries.set(id, { vector: Float32Array.from(vector.data), payload: { ...payload } });
		this.#persist();
		return id;
	}

	/**
	 * Cosine search over the collection. Optional payload filters; k bounds
	 * the answer. Results rank with their payload refs resolved by the
	 * CALLER to timeline paths — the store ranks and returns payloads.
	 *
	 * @param {{ data: Float32Array }} vector
	 * @param {{ k?: number, sourceType?: "rolling"|"event", cameraId?: string }} [opts]
	 * @returns {Array<{ score: number, payload: import("./types.js").VectorPayload }>}
	 */
	search(vector, opts = {}) {
		if (!vector || !(vector.data instanceof Float32Array)) throw new ValidationError("vector: required (Float32Array)");
		const k = opts.k ?? 10;
		/** @type {Array<{ score: number, payload: import("./types.js").VectorPayload }>} */
		const out = [];
		for (const entry of this.entries.values()) {
			if (opts.sourceType && entry.payload.sourceType !== opts.sourceType) continue;
			if (opts.cameraId && entry.payload.cameraId !== opts.cameraId) continue;
			out.push({ score: cosine(vector.data, entry.vector), payload: entry.payload });
		}
		out.sort((a, b) => b.score - a.score || a.payload.startOffset - b.payload.startOffset);
		return out.slice(0, k);
	}

	/**
	 * Drop payloads matching EXACT source refs (the cascade's per-sourceRef
	 * filter of record — part of the sweep's same pass, never a periodic
	 * cleanup hope).
	 * @param {{"rolling"|"event": string[]|undefined} & { sourceType: "rolling"|"event", refs: string[] }} opts
	 * @returns {number} payloads removed (counted)
	 */
	deleteByRefs(opts) {
		const refs = new Set(opts.refs.filter(Boolean));
		let removed = 0;
		for (const [id, entry] of this.entries) {
			if (entry.payload.sourceType === opts.sourceType && refs.has(entry.payload.sourceRef)) {
				this.entries.delete(id);
				removed += 1;
			}
		}
		if (removed > 0) this.#persist();
		return removed;
	}

	/**
	 * Drop everything in one family whose chunk starts inside one of the
	 * given UTC dateKeys — the cascade's day-level vector half (rolling
	 * sweeps delete whole days).
	 * @param {{ sourceType: "rolling"|"event", dateKeys: string[] }} opts
	 * @returns {number}
	 */
	deleteByDateKeys(opts) {
		const keys = new Set(opts.dateKeys.filter(Boolean));
		let removed = 0;
		for (const [id, entry] of this.entries) {
			if (entry.payload.sourceType !== opts.sourceType) continue;
			if (keys.has(new Date(entry.payload.startOffset * 1000).toISOString().slice(0, 10))) {
				this.entries.delete(id);
				removed += 1;
			}
		}
		if (removed > 0) this.#persist();
		return removed;
	}

	/** Every payload of record — the cascade audit's countable truth. */
	list() {
		return [...this.entries.values()].map((e) => e.payload);
	}

	count() {
		return this.entries.size;
	}

	#load() {
		if (!this.fs.existsSync(this.file)) return;
		try {
			const doc = JSON.parse(this.fs.readFileSync(this.file, "utf8"));
			for (const e of doc.entries ?? []) {
				assertVectorPayload(e.payload);
				this.entries.set(vectorIdOf(e.payload), { vector: Float32Array.from(e.vector), payload: e.payload });
			}
		} catch (err) {
			throw new ValidationError(`vector store collection unreadable at ${this.file}: ${/** @type {Error} */ (err).message} — refusing to guess over a torn index`);
		}
	}

	#persist() {
		this.fs.mkdirSync(path.dirname(this.file), { recursive: true });
		this.fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({
			entries: [...this.entries.entries()].map(([id, e]) => ({ id, vector: [...e.vector], payload: e.payload })),
		}, null, "\t"));
		this.fs.renameSync(`${this.file}.tmp`, this.file);
	}
}

/** Cosine similarity between two Float32Arrays. */
function cosine(a, b) {
	if (a.length !== b.length) {
		throw new ValidationError(`vector dims mismatch: query ${a.length} vs stored ${b.length} — the embedder of record changed under the index; re-embed before searching`);
	}
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom === 0 ? 0 : dot / denom;
}
