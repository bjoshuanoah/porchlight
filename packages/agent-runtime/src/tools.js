// tools.js — the tool-execution seam (PORCH-147 ac-4).
//
// Registry-registered tools; the registry passes exactly member-derived
// authority to the tool — a frozen { memberId, scopes } the hub resolves
// per call through the runtime's injected authority resolver (PORCH-149's
// delegation enforcement). The library never fabricates, widens, or
// re-slices authority: a missing or shape-invalid authority refuses fail
// closed before the tool runs.

/**
 * Validate member-derived authority. Returns a frozen copy.
 *
 * @param {{ memberId: string, scopes: string[] }} [authority]
 * @returns {{ memberId: string, scopes: string[] }}
 */
export function assertMemberAuthority(authority) {
	if (
		!authority ||
		typeof authority.memberId !== "string" ||
		authority.memberId.length === 0 ||
		!Array.isArray(authority.scopes) ||
		authority.scopes.some((s) => typeof s !== "string")
	) {
		throw new TypeError(
			"member-derived authority required: { memberId: string, scopes: string[] } — the tool-execution seam never runs a tool without it",
		);
	}
	return Object.freeze({ memberId: authority.memberId, scopes: Object.freeze([...authority.scopes]) });
}

export class ToolRegistry {
	#tools = new Map();

	/**
	 * Register one tool (duplicate names refuse — the registry never
	 * silently replaces a registered authority surface).
	 * @param {import("./types.js").AgentTool} tool
	 */
	register(tool) {
		if (!tool || typeof tool.name !== "string" || !tool.name || typeof tool.run !== "function") {
			throw new TypeError("ToolRegistry.register: tool must carry a name and a run(args, authority) function");
		}
		if (this.#tools.has(tool.name)) {
			throw new Error(`ToolRegistry.register: tool ${tool.name} is already registered`);
		}
		this.#tools.set(tool.name, tool);
		return this;
	}

	/** @returns {boolean} */
	has(name) {
		return this.#tools.has(name);
	}

	/** @returns {{ name: string, description?: string }[]} descriptors for the inference seam */
	list() {
		return [...this.#tools.values()]
			.map(({ name, description }) => ({ name, ...(description ? { description } : {}) }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * Execute one tool under member-derived authority.
	 * @returns {Promise<unknown>} the tool's own result
	 */
	async execute(name, args = {}, authority) {
		if (typeof name !== "string" || !name) {
			throw new TypeError("ToolRegistry.execute: tool name required");
		}
		const tool = this.#tools.get(name);
		if (!tool) {
			throw new Error(`ToolRegistry.execute: no tool registered under ${JSON.stringify(name)}`);
		}
		const sealed = assertMemberAuthority(authority);
		return tool.run(args ?? {}, sealed);
	}
}
