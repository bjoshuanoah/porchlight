// audit.js — the People & Things audit log of record (PORCH-141).
//
// One JSON line per record; same shape as the Overwatch audit (F3 style for
// the whole Overwatch & Recognition plane). File-backed when a path is
// provided (sync append, in-memory mirror loaded at construction); the
// mirror keeps reads allocation-free while the file stays the durable
// artifact. In-memory only when path is omitted — the tests' default.
//
// Record types of record: "recognition-toggle", "recognition-threshold",
// "registry-enroll", "registry-entry-purge".

import fsDefault from "node:fs";
import pathDefault from "node:path";

/**
 * @typedef {{
 *   at: string,
 *   type: string,
 *   actorIdentityRef: string | null,
 *   detail: object,
 *   outcome: string,
 *   homeId: string | null,
 *   seq: number,
 * }} AuditRecord
 */

/**
 * @typedef {{
 *   record(input: {
 *     type: string,
 *     actorIdentityRef?: string | null,
 *     detail?: object,
 *     outcome?: string,
 *     homeId?: string | null,
 *   }): AuditRecord,
 *   list(filters?: { type?: string, homeId?: string, limit?: number }): AuditRecord[],
 *   path: string | null,
 * }} AuditLog
 */

/**
 * @param {{
 *   path?: string | null,
 *   now?: () => string,
 * }} [options]
 * @returns {AuditLog}
 */
export function createAuditLog({ path = null, now = () => new Date().toISOString() } = {}) {
	/** @type {AuditRecord[]} oldest-first */
	const records = [];
	let seq = 0;

	if (path !== null) {
		fsDefault.mkdirSync(pathDefault.dirname(path), { recursive: true });
		if (fsDefault.existsSync(path)) {
			for (const line of fsDefault.readFileSync(path, "utf8").split("\n")) {
				if (line.trim() === "") continue;
				const record = /** @type {AuditRecord} */ (JSON.parse(line));
				seq += 1;
				records.push(record);
			}
		}
	}

	/**
	 * Sync append of exactly one JSON line (file-backed) or one in-memory
	 * append. The record is the durable companion of every explicit registry
	 * state change — toggles, calibration, enrollment, and purges.
	 * @param {{ type: string, actorIdentityRef?: string | null, detail?: object, outcome?: string, homeId?: string | null }} input
	 * @returns {AuditRecord}
	 */
	function record({ type, actorIdentityRef = null, detail = {}, outcome = "confirmed", homeId = null }) {
		seq += 1;
		const entry = { at: now(), type, actorIdentityRef, detail, outcome, homeId, seq };
		records.push(entry);
		if (path !== null) {
			fsDefault.appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
		}
		return entry;
	}

	/**
	 * Newest-first filtered view.
	 * @param {{ type?: string, homeId?: string, limit?: number }} [filters]
	 */
	function list({ type, homeId, limit } = {}) {
		const filtered = records.filter((entry) => (type ? entry.type === type : true) && (homeId ? entry.homeId === homeId : true));
		const page = [...filtered].reverse();
		return limit !== undefined && Number.isInteger(limit) && limit > 0 ? page.slice(0, limit) : page;
	}

	return { record, list, path: path ?? null };
}
