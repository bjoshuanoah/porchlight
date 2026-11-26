// memory.js — the per-member memory stream (PORCH-147).
//
// One append-only interaction stream per member: every entry carries the
// member identity by construction (the underlying store is bound to the
// member's namespace), plus role, text, topic, and timestamp. Roles of
// record: "user", "agent", "tool".

/**
 * @typedef {object} MemoryEntry
 * @property {string} id
 * @property {string} role   "user" | "agent" | "tool"
 * @property {string} text
 * @property {string} topic
 * @property {string} at     ISO 8601
 * @property {string} [tool] tool name for role "tool"
 */

const ALLOWED_ROLES = new Set(["user", "agent", "tool"]);

export class MemoryStream {
	/**
	 * @param {{ store: import("./store.js").MemberStore, topics: import("./topics.js").TopicsStore }} opts
	 */
	constructor({ store, topics }) {
		this.#store = store;
		this.#topics = topics;
	}

	#store;
	#topics;

	async #nextSeq() {
		const current = await this.#store.get("seq");
		const seq = (typeof current === "number" ? current : 0) + 1;
		await this.#store.set("seq", seq);
		return seq;
	}

	/**
	 * Append one interaction to the member's stream; counts it on its topic.
	 * @returns {Promise<MemoryEntry>}
	 */
	async append({ role, text, topic = "general", at, tool }) {
		if (!ALLOWED_ROLES.has(role)) {
			throw new TypeError(`MemoryStream.append: role ${JSON.stringify(role)} not in ${[...ALLOWED_ROLES].join(", ")}`);
		}
		if (typeof text !== "string") {
			throw new TypeError("MemoryStream.append: text must be a string");
		}
		const seq = await this.#nextSeq();
		const entry = {
			id: `e${String(seq).padStart(9, "0")}`,
			role,
			text,
			topic,
			at: (at ? new Date(at) : new Date()).toISOString(),
			...(role === "tool" ? { tool: String(tool ?? "unknown") } : {}),
		};
		await this.#store.set(`entry:${entry.id}`, entry);
		const t = await this.#topics.ensure(topic);
		await this.#topics.touch(t.id);
		return entry;
	}

	/**
	 * The most recent n entries, chronological.
	 * @returns {Promise<MemoryEntry[]>}
	 */
	async recent(n = 20) {
		const all = await this.all();
		return all.slice(-n);
	}

	/** @returns {Promise<MemoryEntry[]>} the whole member stream, chronological */
	async all() {
		const rows = await this.#store.list("entry:");
		return rows
			.map((r) => r.value)
			.sort((a, b) => String(a.id).localeCompare(String(b.id)));
	}

	/**
	 * Entries of one topic.
	 * @returns {Promise<MemoryEntry[]>}
	 */
	async byTopic(topic) {
		if (typeof topic !== "string" || !topic) {
			throw new TypeError("MemoryStream.byTopic: topic string required");
		}
		return (await this.all()).filter((e) => e.topic === topic);
	}
}
