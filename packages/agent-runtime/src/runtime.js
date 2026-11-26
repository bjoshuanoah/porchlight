// runtime.js — the agent runtime session (PORCH-147).
//
// One runtime session per hub-session: exactly one agent entity per member
// is instantiated here (memoized), each with its own namespaced memory,
// topics, and keyset. Entity resolution never leaks another member's
// identity — an entity carries only its own member.
//
// The runtime consumes two injected seams and only these:
//   - the inference seam: an InferenceProvider implementation (the engine's
//     three provider classes) — profile-selected models ride exactly this
//     seam (composition seam 1; PORCH-148 plugs profile resolution here)
//   - the tool-execution seam: a ToolRegistry holding registry-registered
//     tools, plus the injected authority resolver that derives the acting
//     member's authority per call (hub-side delegation enforcement)

import { randomUUID } from "node:crypto";
import { MapBackend, createMemberStores } from "./store.js";
import { AgentEntity } from "./agent.js";
import { PROVIDER_CLASSES } from "./constants.js";

/** @typedef {import("./types.js").InferenceProvider} InferenceProvider */
/** @typedef {import("./types.js").KeyValueBackend} KeyValueBackend */
/** @typedef {import("./types.js").MemberAuthority} MemberAuthority */

export class AgentRuntime {
	#entities = new Map();
	#refusals = [];
	#logs = [];

	/**
	 * @param {{
	 *   inference: InferenceProvider,
	 *   backend?: KeyValueBackend,
	 *   tools?: import("./tools.js").ToolRegistry,
	 *   authority?: (memberId: string) => Promise<MemberAuthority>,
	 *   onRefusal?: (entry: object) => void,
	 *   sessionId?: string,
	 * }} opts
	 */
	constructor(opts) {
		this.#validateInference(opts?.inference);
		this.inference = opts.inference;
		this.backend = opts.backend ?? new MapBackend();
		if (opts.tools && (typeof opts.tools.execute !== "function" || typeof opts.tools.list !== "function")) {
			throw new TypeError(
				"AgentRuntime: tools must implement the tool-execution seam the loop consumes (list descriptors, execute under authority)",
			);
		}
		this.tools = opts.tools ?? null;
		if (opts.authority !== null && opts.authority !== undefined && typeof opts.authority !== "function") {
			throw new TypeError("AgentRuntime: authority must be a (memberId) => Promise<{memberId, scopes}> resolver");
		}
		this.authority = typeof opts.authority === "function" ? opts.authority : null;
		this.onRefusal = typeof opts.onRefusal === "function" ? opts.onRefusal : null;
		this.sessionId = opts.sessionId ?? randomUUID();
	}

	#validateInference(inference) {
		if (!inference || typeof inference.name !== "string" || !inference.name) {
			throw new TypeError("AgentRuntime: inference must be an InferenceProvider with a name (composition seam 1)");
		}
		// PORCH-148: the profiles machinery presents itself as THE
		// InferenceProvider this seam consumes — a profile router rides one of
		// the engine's three compute classes per resolved profile, so a router
		// declares the classes it routes across. Every response carries the
		// class that actually answered (the provenance line of record).
		if (Array.isArray(inference.providerClasses)) {
			if (inference.providerClasses.length === 0) {
				throw new TypeError("AgentRuntime: a profile router must declare the compute classes it routes across");
			}
			for (const entry of inference.providerClasses) {
				if (!PROVIDER_CLASSES.includes(entry)) {
					throw new TypeError(
						`AgentRuntime: every providerClasses entry must be one of ${PROVIDER_CLASSES.join(", ")} (the engine's compute classes)`,
					);
				}
			}
			if (typeof inference.complete !== "function") {
				throw new TypeError("AgentRuntime: inference must implement complete(request) — the inference-call seam has no parallel path");
			}
			return;
		}
		if (!PROVIDER_CLASSES.includes(inference.providerClass)) {
			throw new TypeError(
				`AgentRuntime: inference.providerClass must be one of ${PROVIDER_CLASSES.join(", ")} (the engine's three compute classes)`,
			);
		}
		if (typeof inference.complete !== "function") {
			throw new TypeError("AgentRuntime: inference must implement complete(request) — the inference-call seam has no parallel path");
		}
	}

	/**
	 * Resolve the acting member's agent entity — exactly one per member per
	 * runtime session.
	 * @returns {AgentEntity}
	 */
	agentFor(memberId) {
		if (typeof memberId !== "string" || memberId.length === 0) {
			throw new TypeError("AgentRuntime.agentFor: memberId required");
		}
		let entity = this.#entities.get(memberId);
		if (!entity) {
			entity = new AgentEntity({ runtime: this, memberId });
			this.#entities.set(memberId, entity);
		}
		return entity;
	}

	/** @returns {string[]} members with an agent entity in this session */
	members() {
		return [...this.#entities.keys()].sort();
	}

	/**
	 * Log an isolation/atmosphere refusal (fail-closed trail of record).
	 * @returns {void}
	 */
	logRefusal(attempt) {
		const entry = { at: new Date().toISOString(), ...attempt };
		this.#refusals.push(entry);
		this.onRefusal?.(entry);
	}

	/** @returns {object[]} every refusal this session logged, chronological */
	refusals() {
		return [...this.#refusals];
	}

	refusalsForMember(memberId) {
		return this.#refusals.filter((r) => r.memberId === memberId);
	}

	/**
	 * A per-member log line (member identity carries on every line).
	 * @returns {void}
	 */
	logLine(memberId, line) {
		this.#logs.push({ at: new Date().toISOString(), memberId, line });
	}

	/** @returns {object[]} the session's per-member log lines, chronological */
	logsForMember(memberId) {
		return this.#logs.filter((l) => l.memberId === memberId);
	}
}

export { createMemberStores };
