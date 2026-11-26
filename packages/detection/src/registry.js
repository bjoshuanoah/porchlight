// registry.js — the InferenceProvider registry (PORCH-128 ac-3 seam).
//
// Pluggability law (PORCH-I-009 TS 5): a new provider registers itself and
// the detection core never changes. Registration is metadata-only here —
// factory(opts) is invoked by whoever wires the service, so a provider
// module can register itself on import with zero coupling to the core.

/**
 * @typedef {(opts?: Record<string, unknown>) => import("./types.js").InferenceProvider} ProviderFactory
 */

export class ProviderRegistry {
	constructor() {
		/** @type {Map<string, ProviderFactory>} */
		this.#factories = new Map();
	}

	/** @type {Map<string, ProviderFactory>} */
	#factories;

	/**
	 * Register a provider factory under `name`. Re-registering the same name
	 * replaces the factory (compute re-pointing, never silent: `replaced`
	 * reports true so callers can log the swap).
	 *
	 * @param {string} name
	 * @param {ProviderFactory} factory
	 * @returns {{ replaced: boolean }}
	 */
	register(name, factory) {
		if (typeof name !== "string" || name.length === 0) {
			throw new TypeError("registry.register: name must be a non-empty string");
		}
		if (typeof factory !== "function") {
			throw new TypeError(`registry.register(${JSON.stringify(name)}): factory must be a function`);
		}
		const replaced = this.#factories.has(name);
		this.#factories.set(name, factory);
		return { replaced };
	}

	/** @param {string} name */
	has(name) {
		return this.#factories.has(name);
	}

	/** @returns {string[]} registered provider names, insertion order */
	names() {
		return [...this.#factories.keys()];
	}

	/**
	 * Instantiate a provider by name.
	 * @param {string} name
	 * @param {Record<string, unknown>} [opts]
	 * @returns {import("./types.js").InferenceProvider}
	 */
	create(name, opts = {}) {
		const factory = this.#factories.get(name);
		if (!factory) {
			throw new Error(`registry.create: provider ${JSON.stringify(name)} is not registered (registered: ${this.names().join(", ") || "none"})`);
		}
		const provider = factory(opts);
		if (typeof provider?.detect !== "function" || typeof provider?.name !== "string") {
			throw new TypeError(`registry.create(${JSON.stringify(name)}): factory returned an object without name/detect (InferenceProvider protocol)`);
		}
		return provider;
	}
}
