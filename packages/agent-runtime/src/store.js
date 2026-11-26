// store.js — the per-member storage seam (PORCH-147 isolation contract).
//
// Every member-scoped store is namespaced `member:<memberId>:<scope>:<key>`
// before it reaches the backend, so one query touches one member's records
// and a backend never sees an un-namespaced runtime key. Key arguments that
// attempt to escape the member namespace — a forged cross-member key
// (`member:other:...`), path traversal (`..`), separators (`/`) — refuse
// fail closed with AgentIsolationError and every refusal lands on the
// runtime's refusal trail via the injected `refuse` callback.

import { AgentIsolationError } from "./errors.js";

export const STORE_SCOPES = ["memory", "topics", "keyset", "soul"];

/**
 * Reject a key that attempts to escape (or forge) a member namespace.
 * Fail closed, with the refusal logged through the injected callback.
 *
 * @param {{ memberId: string, scope: string, refuse: (attempt: object) => void }} ctx
 * @param {string} op    get|set|delete|list
 * @param {string} key
 * @returns {void}
 */
function assertMemberKey(ctx, op, key) {
	const attempt = { memberId: ctx.memberId, scope: ctx.scope, op, key };
	// Refusal of record: non-string/empty keys, path separators, traversal
	// fragments, a key leading with a separator, and the forged cross-member
	// namespace pattern (`member:<id>:...`) anywhere inside the key.
	const bad =
		typeof key !== "string" ||
		key.length === 0 ||
		key.includes("/") ||
		key.includes("..") ||
		key.startsWith(":") ||
		key.includes("member:");
	if (!bad) return;
	ctx.refuse(attempt);
	throw new AgentIsolationError(
		`refused ${op} on ${ctx.scope} for member ${ctx.memberId}: key does not stay inside the member's own namespace (cross-member state access fails closed)`,
		attempt,
	);
}

/** One persistent view inside exactly one member's namespace. */
export class MemberStore {
	/**
	 * @param {{
	 *   memberId: string,
	 *   scope: string,
	 *   backend: import("./types.js").KeyValueBackend,
	 *   refuse: (attempt: object) => void,
	 * }} opts
	 */
	constructor({ memberId, scope, backend, refuse }) {
		this.#memberId = memberId;
		this.#scope = scope;
		this.#backend = backend;
		this.#refuse = refuse;
	}

	#memberId;
	#scope;
	#backend;
	#refuse;

	get #ns() {
		return `member:${this.#memberId}:${this.#scope}`;
	}

	#key(key, op) {
		assertMemberKey(this.#ctx(), op, key);
		return `${this.#ns}:${key}`;
	}

	#ctx() {
		return { memberId: this.#memberId, scope: this.#scope, refuse: this.#refuse };
	}

	/** @returns {Promise<unknown>} */
	async get(key) {
		return this.#backend.get(this.#key(key, "get"));
	}

	/** @returns {Promise<unknown>} */
	async set(key, value) {
		return this.#backend.set(this.#key(key, "set"), value);
	}

	/** @returns {Promise<unknown>} */
	async delete(key) {
		return this.#backend.delete(this.#key(key, "delete"));
	}

	/**
	 * List entries under an (optional) prefix, always inside the member's
	 * namespace — the prefix cannot widen past it. Keys return
	 * scope-relative (the member prefix is stripped), matching get/set.
	 * @returns {Promise<{ key: string, value: unknown }[]>}
	 */
	async list(prefix = "") {
		assertMemberKey(this.#ctx(), "list", prefix === "" ? "self" : prefix);
		const rows = await this.#backend.list(prefix === "" ? `${this.#ns}:` : `${this.#ns}:${prefix}`);
		return rows.map((r) => ({ key: r.key.slice(this.#ns.length + 1), value: r.value }));
	}
}

/** The default in-memory backend — standalone/test posture; the hub injects its own. */
export class MapBackend {
	#map = new Map();

	/** @returns {Promise<unknown>} */
	async get(key) {
		return this.#map.get(key);
	}

	/** @returns {Promise<unknown>} */
	async set(key, value) {
		this.#map.set(key, value);
	}

	/** @returns {Promise<unknown>} */
	async delete(key) {
		this.#map.delete(key);
	}

	/** @returns {Promise<{ key: string, value: unknown }[]>} */
	async list(prefix) {
		return [...this.#map]
			.filter(([key]) => key.startsWith(prefix))
			.map(([key, value]) => ({ key, value }));
	}
}

/**
 * Open the four member-scoped stores (memory, topics, keyset, soul) for one
 * member over one shared backend — the per-member seam the agent entity
 * consumes.
 *
 * @param {{
 *   memberId: string,
 *   backend: import("./types.js").KeyValueBackend,
 *   refuse: (attempt: object) => void,
 * }} opts
 */
export function createMemberStores({ memberId, backend, refuse }) {
	const built = {};
	for (const scope of STORE_SCOPES) {
		built[scope] = new MemberStore({ memberId, scope, backend, refuse });
	}
	return built;
}
