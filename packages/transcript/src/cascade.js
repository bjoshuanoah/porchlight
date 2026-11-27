// cascade.js — the retention index cascade (PORCH-155; TS 13 "Index
// cascade"). Deletions ride the retention sweeper: ANY sweep deleting a
// rolling window, event, or clip removes the matching transcript text AND
// vector payloads IN THE SAME PASS (per-sourceRef / per-dateKey filtering).
// The cascade is part of the sweep's write path — the supervisor's sweep
// call runs these drops inside its own pruning pass — never a periodic
// cleanup hope.
//
// Sweeper wiring of record (packages/recorder):
//   pruneRolling(...) → removed dateKeys → dropRollingDates(removed)
//   pruneEventTier(...) → removed dateKeys → dropEventDates(removed)
// Cold-archived dates are NOT dropped: the footage still exists (the
// cascade follows DELETION, not relocation).

import { ValidationError } from "./types.js";

/**
 * @param {{
 *   store: import("./store.js").TranscriptStore,
 *   vectorStore: import("./vector.js").LocalVectorStore,
 *   log?: (...args: unknown[]) => void,
 * }} opts
 */
export function createTranscriptCascade({ store, vectorStore, log = () => {} }) {
	if (!store || !vectorStore) throw new ValidationError("cascade: store and vectorStore are required");
	return {
		/**
		 * Rolling half of the pass: the sweep deleted (or moved-to-cold →
		 * excluded) these UTC dateKeys; drop every rolling transcript doc in
		 * them and the matching vector payloads — both counted in the return.
		 * @param {string[]} dateKeys
		 * @returns {Promise<{records: number, vectors: number, dateKeys: string[]}>}
		 */
		async dropRollingDates(dateKeys) {
			const records = store.dropDates("rolling", dateKeys);
			const vectors = vectorStore.deleteByDateKeys({ sourceType: "rolling", dateKeys });
			log(`[cascade] rolling sweep: dropped ${records} transcript record(s) and ${vectors} vector payload(s) for ${dateKeys.join(", ") || "no dates"}`);
			return { records, vectors, dateKeys };
		},

		/**
		 * Event half of the pass: same law, the events family.
		 * @param {string[]} dateKeys
		 * @returns {Promise<{records: number, vectors: number, dateKeys: string[]}>}
		 */
		async dropEventDates(dateKeys) {
			const records = store.dropDates("event", dateKeys);
			const vectors = vectorStore.deleteByDateKeys({ sourceType: "event", dateKeys });
			log(`[cascade] event sweep: dropped ${records} transcript record(s) and ${vectors} vector payload(s) for ${dateKeys.join(", ") || "no dates"}`);
			return { records, vectors, dateKeys };
		},

		/**
		 * The orphan check of record (cascade e2e asserts ZERO orphans,
		 * count verified): a text record whose vectors are missing is
		 * vectorless; a vector whose record is gone is orphaned. Both are
		 * explicit counts — never a silent assumption.
		 */
		audit() {
			const records = store.list();
			const payloads = vectorStore.list();
			/** Key set of record: one key per text chunk (the vector granularity). */
			const recordKeys = new Set();
			for (const r of records) {
				const chunks = r.chunks?.length
					? r.chunks.filter((c) => c.state === "text")
					: r.state === "text"
						? [{ startOffset: r.startOffset }]
						: [];
				for (const c of chunks) recordKeys.add(`${r.cameraId}:${r.sourceType}:${r.sourceRef}:${Math.round(c.startOffset * 1000)}`);
			}
			let orphanVectors = 0;
			let vectorlessRecords = 0;
			const vectorKeys = new Set();
			for (const p of payloads) {
				const key = `${p.cameraId}:${p.sourceType}:${p.sourceRef}:${Math.round(p.startOffset * 1000)}`;
				vectorKeys.add(key);
				if (!recordKeys.has(key)) orphanVectors += 1;
			}
			for (const key of recordKeys) {
				if (!vectorKeys.has(key)) vectorlessRecords += 1;
			}
			return {
				transcriptRecords: records.length,
				vectorPayloads: payloads.length,
				textChunks: recordKeys.size,
				orphanVectors,
				vectorlessRecords,
			};
		},
	};
}
