// keyset.js — the per-member keyset (PORCH-147).
//
// The member's agent-credential store: opaque names → opaque secrets, sealed
// inside the member's own namespace. Nothing here ever leaves the member's
// keyset scope; the runtime's identity views never include keyset contents.

export class KeysetStore {
	/** @param {{ store: import("./store.js").MemberStore }} opts */
	constructor({ store }) {
		this.#store = store;
	}

	#store;

	/**
	 * Store one member-held secret under an opaque name.
	 * @returns {Promise<void>}
	 */
	async set(name, secret) {
		if (typeof name !== "string" || !name.trim()) {
			throw new TypeError("KeysetStore.set: key name required");
		}
		if (typeof secret !== "string") {
			throw new TypeError("KeysetStore.set: secret must be a string");
		}
		await this.#store.set(`key:${name}`, String(secret));
	}

	/** @returns {Promise<string | null>} */
	async get(name) {
		return (await this.#store.get(`key:${name}`)) ?? null;
	}

	/** @returns {Promise<boolean>} */
	async has(name) {
		return (await this.get(name)) !== null;
	}

	/** @returns {Promise<void>} */
	async delete(name) {
		await this.#store.delete(`key:${name}`);
	}

	/** @returns {Promise<string[]>} the held key names (never the secrets) */
	async names() {
		const rows = await this.#store.list("key:");
		return rows.map((r) => r.key.slice("key:".length)).sort();
	}
}
