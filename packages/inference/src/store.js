// store.js — descriptions stored with their event (PORCH-133 ac-2: "a
// description is generated locally and stored with the event").
//
// Append-only JSONL, one file per UTC date of the event's own t (the
// config event feed's storage pattern), addressable by the event's own
// identity: `{t, camera, cls, trackId}` — the same identity the event feed
// of record (config's events.js) persists. A description never floats free:
// it always rides the event it describes. Deletion rides the record's event
// (the retention/index-cascade law lands when the feed itself prunes; this
// store carries the same date-partition seam).

import fsDefault from "node:fs";
import pathDefault from "node:path";
import { ValidationError, assertObject } from "./types.js";
import { TIERS } from "./types.js";

const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const MILLIS_THRESHOLD = 1e11;

/** @param {string} tMs */
function dateDirNameFrom(t) {
	return new Date(t * 1000).toISOString().slice(0, 10);
}

/** Normalize an event time to epoch seconds (the feed's own law). @param {unknown} value */
function secondsOf(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
	return value >= MILLIS_THRESHOLD ? Math.floor(value / 1000) : Math.floor(value);
}

/**
 * Create the description store.
 * @param {{
 *   dir: string,
 *   fs?: typeof import("node:fs"),
 *   now?: () => Date,
 * }} opts
 */
export function createDescriptionStore({ dir, fs = fsDefault, now = () => new Date() }) {
	if (typeof dir !== "string" || dir.trim() === "") throw new ValidationError("description store: dir is required");

	/** @param {string} file */
	function pathFor(file) {
		return pathDefault.join(dir, file);
	}

	return {
		/** Root dir of record. */
		get dir() {
			return dir;
		},
		/**
		 * Store one description against its event. Returns the normalized record.
		 * @param {{
		 *   event: { t: number, camera: string, cls?: string|null, trackId?: string|null },
		 *   transition: string,
		 *   tier: string,
		 *   provider: string,
		 *   providerClass: string,
		 *   model?: string|null,
		 *   text: string|null,
		 * }} entry
		 */
		record(entry) {
			assertObject(entry, "description entry");
			const t = secondsOf(entry.event?.t);
			if (t === null) throw new ValidationError("description entry: event.t must be a positive epoch time");
			if (typeof entry.event.camera !== "string" || entry.event.camera.trim() === "") {
				throw new ValidationError("description entry: event.camera must be a non-empty string");
			}
			if (typeof entry.transition !== "string" || entry.transition.trim() === "") {
				throw new ValidationError("description entry: transition must be a non-empty string");
			}
			if (!TIERS.includes(entry.tier)) throw new ValidationError(`description entry: tier must be one of ${TIERS.join(", ")}`);
			for (const field of ["provider", "providerClass"]) {
				if (typeof /** @type {Record<string, unknown>} */ (entry)[field] !== "string" || /** @type {Record<string, unknown>} */ (entry)[field].trim() === "") {
					throw new ValidationError(`description entry: ${field} must be a non-empty string`);
				}
			}
			if (entry.text !== null && (typeof entry.text !== "string" || /** @type {string} */ (entry.text).trim() === "")) {
				throw new ValidationError("description entry: text must be a non-empty string or null (explicit no-answer)");
			}
			const record = {
				t,
				camera: entry.event.camera,
				cls: entry.event.cls ?? null,
				trackId: entry.event.trackId ?? null,
				transition: entry.transition,
				tier: entry.tier,
				provider: entry.provider,
				providerClass: entry.providerClass,
				model: entry.model ?? null,
				text: entry.text,
				at: now().toISOString(),
			};
			fs.mkdirSync(dir, { recursive: true });
			fs.appendFileSync(pathFor(`${dateDirNameFrom(t)}.jsonl`), JSON.stringify(record) + "\n", "utf8");
			return record;
		},
		/**
		 * The description(s) stored for one event identity. The UTC-date
		 * partition keys files on the event's own t, so the primary read is the
		 * event's own day file; a description recorded after midnight carries a
		 * next-day `at` but the SAME t, so the following day is checked too.
		 * @param {{ t: number, camera: string, cls?: string|null, trackId?: string|null }} event
		 * @returns {Record<string, unknown>[]}
		 */
		forEvent(event) {
			const t = secondsOf(event.t);
			if (t === null) throw new ValidationError("forEvent: event.t must be a positive epoch time");
			// Identity join: an ABSENT field (undefined) filters nothing — the
			// caller just didn't carry it; an explicit null filters for events
			// without that field (audio events carry no trackId).
			const matchesIdentity = /** @param {Record<string, unknown>} r */
				(r) => r.t === t
					&& r.camera === event.camera
					&& (event.trackId === undefined ? true : event.trackId === null ? r.trackId == null : r.trackId === event.trackId)
					&& (event.cls === undefined ? true : event.cls === null ? r.cls == null : r.cls === event.cls);
			const day = dateDirNameFrom(t);
			const next = new Date(t * 1000 + 86_400_000).toISOString().slice(0, 10);
			const out = [];
			for (const candidate of [day, next]) {
				const file = pathFor(`${candidate}.jsonl`);
				if (!fs.existsSync(file)) continue;
				for (const line of fs.readFileSync(file, "utf8").split("\n")) {
					if (line.trim() === "") continue;
					try {
						const row = JSON.parse(line);
						if (matchesIdentity(row)) out.push(row);
					} catch {
						// A malformed line is skipped with no crash and no silent loss of
						// the rest of the day (the feed's own parse law).
					}
				}
			}
			return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
		},
		/**
		 * Date files of record (names only) — the retention seam.
		 * @returns {string[]}
		 */
		files() {
			if (!fs.existsSync(dir)) return [];
			return fs.readdirSync(dir, "utf8").filter((name) => DATE_FILE_RE.test(name)).sort();
		},
	};
}
