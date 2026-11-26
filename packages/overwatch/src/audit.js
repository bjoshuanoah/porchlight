// audit.js — the overwatch audit log of record (PORCH-140 F3/F12).
//
// One JSON line per record. File-backed when a path is provided (sync append,
// in-memory mirror loaded at construction for list(); the mirror keeps reads
// allocation-free while the file stays the durable artifact). In-memory only
// when path is omitted — the tests' default.
//
// Record types of record: "dial-change", "follow-bump-engage",
// "follow-bump-release", "association-flag", "zone-config-change".
// (The compositor additionally emits "layout-version-bump" — see compositor.js.)

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
			const raw = fsDefault.readFileSync(path, "utf8");
			for (const line of raw.split("\n")) {
				if (line.trim() === "") continue;
				const parsed = JSON.parse(line);
				records.push(parsed);
				seq = Math.max(seq, parsed.seq ?? 0);
			}
		}
	}

	/**
	 * Sync append of exactly one JSON line (file-backed) or one in-memory
	 * record. Ordering is append order; `seq` breaks ties for readers.
	 * @param {{
	 *   type: string,
	 *   actorIdentityRef?: string | null,
	 *   detail?: object,
	 *   outcome?: string,
	 *   homeId?: string | null,
	 * }} input
	 * @returns {AuditRecord}
	 */
	function record({ type, actorIdentityRef = null, detail = {}, outcome = "confirmed", homeId = null }) {
		if (typeof type !== "string" || type === "") {
			throw new TypeError("audit record needs a type string");
		}
		const entry = {
			type,
			actorIdentityRef,
			detail,
			outcome,
			homeId,
			at: now(),
			seq: ++seq,
		};
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
		const filtered = [];
		for (let i = records.length - 1; i >= 0; i--) {
			const r = records[i];
			if (type !== undefined && r.type !== type) continue;
			if (homeId !== undefined && r.homeId !== homeId) continue;
			filtered.push(r);
			if (limit !== undefined && filtered.length >= limit) break;
		}
		return filtered;
	}

	return { record, list, path };
}
