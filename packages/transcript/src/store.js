// store.js — the transcript store of record (PORCH-155; TS 13). Transcript
// TEXT lives close to the video it annotates: one JSON doc per
// (sourceType, UTC dateKey, camera) under the recording root's transcripts
// tree, so the retention cascade (retention.js) drops text with the
// segments in the same sweep pass — the two-class law holds: rolling and
// event transcripts are separate classes with separate windows and are
// never mixed.
//
// Event records obey the desc-and-transcript law HERE (assertTranscriptRecord
// enforces it): description and transcript land together or neither.

import fsDefault from "node:fs";
import path from "node:path";
import { assertCameraId, assertTranscriptRecord, SOURCE_TYPES, ValidationError } from "./types.js";

/** UTC dateKey of record (matches the recorder's segment layout). */
export function dateKeyOf(epochMs) {
	return new Date(epochMs).toISOString().slice(0, 10);
}

export class TranscriptStore {
	/**
	 * @param {{
	 *   root: string,                       // <storageRoot>/transcripts
	 *   fs?: typeof fsDefault,
	 *   now?: () => Date,
	 *   log?: (...args: unknown[]) => void,
	 * }} opts
	 */
	constructor(opts) {
		if (!opts.root || typeof opts.root !== "string") throw new ValidationError("root: required (the transcripts tree of record)");
		this.root = opts.root;
		this.fs = opts.fs ?? fsDefault;
		this.now = opts.now ?? (() => new Date());
		this.log = opts.log ?? (() => {});
	}

	/**
	 * Write one record (idempotent per sourceRef — a re-transcription
	 * replaces the prior state, keeping the record count stable).
	 * @param {import("./types.js").TranscriptRecord} record
	 * @returns {import("./types.js").TranscriptRecord}
	 */
	put(record) {
		assertTranscriptRecord(record);
		writeDoc(this.fs, this.docPath(record.sourceType, record.cameraId, dateKeyOf(record.startOffset * 1000)), (doc) => {
			doc.records ||= [];
			const at = doc.records.findIndex((r) => r.sourceRef === record.sourceRef);
			if (at >= 0) doc.records[at] = record;
			else doc.records.push(record);
			return { records: [...doc.records].sort((a, b) => a.startOffset - b.startOffset) };
		});
		return record;
	}

	/**
	 * One record by sourceRef, or null.
	 * @param {string} cameraId
	 * @param {"rolling"|"event"} sourceType
	 * @param {string} sourceRef
	 */
	get(cameraId, sourceType, sourceRef) {
		return listDocs(this.fs, this.familyDir(sourceType), "cameras", cameraId)
			.map((doc) => doc.records.find((r) => r.sourceRef === sourceRef))
			.find(Boolean) ?? null;
	}

	/**
	 * List records, newest first.
	 * @param {{ cameraId?: string, sourceType?: "rolling"|"event", limit?: number }} [opts]
	 * @returns {import("./types.js").TranscriptRecord[]}
	 */
	list(opts = {}) {
		const families = opts.sourceType ? [opts.sourceType] : [...SOURCE_TYPES];
		/** @type {import("./types.js").TranscriptRecord[]} */
		const out = [];
		for (const sourceType of families) {
			for (const doc of opts.cameraId
				? listDocs(this.fs, this.familyDir(sourceType), "cameras", opts.cameraId)
				: listAllDocs(this.fs, this.familyDir(sourceType))) {
				out.push(...doc.records);
			}
		}
		out.sort((a, b) => b.startOffset - a.startOffset);
		return opts.limit ? out.slice(0, opts.limit) : out;
	}

	/**
	 * Drop every family in one sourceType for the given UTC dateKeys — the
	 * retention cascade's text half, called from the sweep pass itself.
	 * @param {"rolling"|"event"} sourceType
	 * @param {string[]} dateKeys
	 * @returns {number} records removed (counted for the sweep's report)
	 */
	dropDates(sourceType, dateKeys) {
		if (!SOURCE_TYPES.includes(sourceType)) throw new ValidationError(`sourceType: must be one of ${SOURCE_TYPES.join(", ")}`);
		const keys = new Set(dateKeys.filter(Boolean));
		const familyDir = this.familyDir(sourceType);
		let removed = 0;
		for (const day of this.fs.existsSync(familyDir) ? this.fs.readdirSync(familyDir) : []) {
			if (!keys.has(day)) continue;
			const dayDir = path.join(familyDir, day);
			for (const file of this.fs.existsSync(dayDir) ? this.fs.readdirSync(dayDir) : []) {
				if (file.endsWith(".json")) removed += 1;
			}
			this.fs.rmSync(dayDir, { recursive: true, force: true });
			this.log(`[transcript] dropped ${removed} ${sourceType} record(s) for ${day}`);
		}
		return removed;
	}

	/** @returns {string} <root>/rolling | <root>/events */
	familyDir(sourceType) {
		return path.join(this.root, sourceType);
	}

	/**
	 * Per-camera doc path for one sourceType/dateKey/camera.
	 */
	docPath(sourceType, cameraId, dateKey) {
		assertCameraId(cameraId);
		return path.join(this.familyDir(sourceType), dateKey, `${cameraId}.json`);
	}
}

/** Read-modify-write one JSON doc atomically. */
function writeDoc(fs, file, mutate) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	/** @type {any} */
	let doc = {};
	if (fs.existsSync(file)) {
		try {
			doc = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {
			// A torn doc reads empty — the next write heals it; content is
			// derivable from the recording, never silently lost state.
		}
	}
	fs.writeFileSync(`${file}.tmp`, JSON.stringify(mutate(doc), null, "\t"));
	fs.renameSync(`${file}.tmp`, file);
}

/** List every per-camera doc under one day dir. */
function listAllDocs(fs, dir) {
	if (!fs.existsSync(dir)) return [];
	/** @type {any[]} */
	const out = [];
	for (const day of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
		const dayDir = path.join(dir, day);
		let isDir = false;
		try { isDir = fs.statSync(dayDir).isDirectory(); } catch { continue; }
		if (!isDir) continue;
		for (const camera of fs.readdirSync(dayDir)) {
			const file = path.join(dayDir, camera);
			try {
				out.push(JSON.parse(fs.readFileSync(file, "utf8")));
			} catch (err) {
				// Torn doc surfaced in the return shape, never silently: read
				// failures stay on disk for the next put to heal and state here.
				out.push({ records: [{ cameraId: camera.replace(/\.json$/, ""), sourceType: "rolling", sourceRef: "unreadable", text: null, state: "partial", partial: { completedChunks: 0, totalChunks: 1, reason: `transcript doc unreadable: ${/** @type {Error} */ (err).message}` }, startOffset: 0, endOffset: 0, transcribedAt: 0, provider: "unreadable" }] });
			}
		}
	}
	return out;
}

/** List every day doc for one camera across a family. */
function listDocs(fs, familyDir, _seg, cameraId) {
	if (!fs.existsSync(familyDir)) return [];
	/** @type {any[]} */
	const out = [];
	for (const day of fs.readdirSync(familyDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) {
		const file = path.join(familyDir, day, `${cameraId}.json`);
		if (fs.existsSync(file)) {
			try {
				out.push(JSON.parse(fs.readFileSync(file, "utf8")));
			} catch { /* torn doc: healed on next put; never silent here */ }
		}
	}
	return out;
}
