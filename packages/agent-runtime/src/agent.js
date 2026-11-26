// agent.js — the agent entity of record (PORCH-147).
//
// One entity per member per runtime session. The entity binds the member's
// own stores (memory stream, topics, keyset, soul), runs the agent loop
// over the injected inference seam, records the provenance line of every
// inference (which model answered, under which provider/class, at which
// time — member-tagged), and routes every tool call through the registry
// with member-derived authority. Nothing on this object references or can
// reach another member's state: cross-member key attempts refuse at the
// storage seam, cross-member authority mismatch refuses at the delegation
// seam — both fail closed and both land on the refusal trail.

import { MemoryStream } from "./memory.js";
import { TopicsStore } from "./topics.js";
import { KeysetStore } from "./keyset.js";
import { createMemberStores } from "./store.js";
import { renderSoulInjection, DEFAULT_SOUL, normalizeSoul } from "./soul.js";

/** @typedef {import("./runtime.js").AgentRuntime} AgentRuntime */

export class AgentEntity {
	#runtime;
	#stores;

	/**
	 * Instantiate directly only via AgentRuntime.agentFor — entity uniqueness
	 * per member is the runtime session's guarantee.
	 * @param {{ runtime: AgentRuntime, memberId: string }} opts
	 */
	constructor({ runtime, memberId }) {
		this.#runtime = runtime;
		/** @type {{ id: string }} the member this entity answers for — and nothing else */
		this.member = Object.freeze({ id: memberId });
		/** @type {import("./types.js").InferenceResponse | null} provenance line of the latest inference */
		this.lastProvenance = null;
		this.#stores = createMemberStores({
			memberId,
			backend: runtime.backend,
			refuse: (attempt) => runtime.logRefusal({ kind: "isolation", ...attempt }),
		});
		this.topics = new TopicsStore({ store: this.#stores.topics });
		this.memory = new MemoryStream({ store: this.#stores.memory, topics: this.topics });
		this.keyset = new KeysetStore({ store: this.#stores.keyset });
		runtime.logLine(memberId, "agent entity created");
	}

	get memberId() {
		return this.member.id;
	}

	/** @param {import("./types.js").Soul} doc the member's authored SOUL */
	async setSoul(doc) {
		await this.#stores.soul.set("doc", normalizeSoul(doc));
		this.#runtime.logLine(this.member.id, "SOUL document updated");
	}

	/** @returns {Promise<string>} the rendered SOUL injection of record */
	async soulInjection() {
		const doc = (await this.#stores.soul.get("doc")) ?? DEFAULT_SOUL;
		return renderSoulInjection(doc);
	}

	#toolDescriptors() {
		return this.#runtime.tools ? this.#runtime.tools.list() : [];
	}

	async #resolveAuthority() {
		const resolver = this.#runtime.authority;
		if (!resolver) {
			throw new Error(
				"no authority resolver configured — member-derived authority is required before any tool executes (delegation law seam)",
			);
		}
		const authority = await resolver(this.member.id);
		if (authority?.memberId !== this.member.id) {
			throw new Error(
				`resolved authority does not match the acting member: entity is ${this.member.id}, authority names ${String(authority?.memberId ?? "nothing")} — refusing`,
			);
		}
		return authority;
	}

	#toChatMessage(entry) {
		const role = entry.role === "agent" ? "assistant" : entry.role;
		return { role, content: entry.text };
	}

	/**
	 * One agent turn: append the member's input, render the SOUL injection,
	 * resolve the running history, call the inference seam, execute any tool
	 * calls under member-derived authority, and settle the final answer —
	 * with the provenance line of record on every inference.
	 *
	 * @param {{ text: string, topic?: string, maxToolTurns?: number }} input
	 * @returns {Promise<{ text: string, provenance: object, toolsUsed: string[] }>}
	 */
	async runTurn({ text, topic = "general", maxToolTurns = 6 }) {
		if (typeof text !== "string" || text.length === 0) {
			throw new TypeError("AgentEntity.runTurn: text required");
		}
		await this.topics.ensure(topic);
		await this.memory.append({ role: "user", text, topic });
		const toolsUsed = [];

		for (let turn = 0; ; turn++) {
			const messages = [
				{ role: "system", content: await this.soulInjection() },
				...(await this.memory.all()).map((e) => this.#toChatMessage(e)),
			];
			if (turn >= maxToolTurns) {
				throw new Error(`agent loop exceeded maxToolTurns (${maxToolTurns}) without a settled answer — never silent`);
			}

			const response = await this.#runtime.inference.complete({
				memberId: this.member.id,
				sessionId: this.#runtime.sessionId,
				messages,
				tools: this.#toolDescriptors(),
			});
			const routed = Array.isArray(this.#runtime.inference.providerClasses);
			this.lastProvenance = {
				provider: this.#runtime.inference.name,
				providerClass: routed ? (response?.providerClass ?? null) : this.#runtime.inference.providerClass,
				modelId: response?.modelId ?? null,
				at: new Date().toISOString(),
			};
			this.#runtime.logLine(
				this.member.id,
				`inference: ${this.lastProvenance.provider} (${this.lastProvenance.providerClass}) model ${this.lastProvenance.modelId ?? "unspecified"} answered`,
			);

			const calls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
			if (calls.length === 0) {
				await this.memory.append({ role: "agent", text: String(response?.text ?? ""), topic });
				return { text: String(response?.text ?? ""), provenance: this.lastProvenance, toolsUsed };
			}

			await this.memory.append({ role: "agent", text: String(response?.text ?? ""), topic });
			for (const call of calls) {
				if (!call || typeof call.name !== "string" || !call.name) {
					throw new Error("inference returned a tool call without a name — refusing the turn");
				}
				let outcome;
				try {
					const authority = await this.#resolveAuthority();
					const result = await this.#runtime.tools.execute(call.name, call.args ?? {}, authority);
					outcome = { ok: true, result: result ?? null };
					toolsUsed.push(call.name);
				} catch (err) {
					this.#runtime.logRefusal({ kind: "tool", memberId: this.member.id, tool: call.name, reason: err.message });
					outcome = { ok: false, error: err.message };
				}
				await this.memory.append({ role: "tool", text: JSON.stringify(outcome), topic, tool: call.name });
			}
		}
	}
}
