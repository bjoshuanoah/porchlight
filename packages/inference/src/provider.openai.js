// provider.openai.js — the tier-2 provider (PORCH-133; PRD 5: "Tier 2
// (paid, OpenAI-compatible): user-supplied keys, off by default; only
// high-value moments per policy").
//
// The paid tier speaks the OpenAI-compatible chat-completions contract (any
// OpenAI-spec endpoint: hosted or a user-provided one). Routing reaches it
// ONLY after the tier-2 opt-in — the router owns that law; this provider
// assumes nothing about it.
//
// Data boundary: tier 2 is the ONLY tier whose requests may leave the hub.
// What may be sent: the event's facts and at most one base64 snapshot
// still, under the user's explicit opt-in and per-provider documentation.
// Video never rides any provider (privacy law: nothing ever uploads video).

import { promptOf } from "./provider.ollama.js";

export class OpenAiSpecProvider {
	/** @param {{ model: string, endpoint: { url: string, key?: string }, fetch?: typeof globalThis.fetch, log?: (...args: unknown[]) => void }} opts */
	constructor(opts) {
		if (!opts?.model || typeof opts.model !== "string") {
			throw new TypeError("OpenAiSpecProvider: model is required");
		}
		if (!opts?.endpoint?.url || typeof opts.endpoint.url !== "string") {
			throw new TypeError("OpenAiSpecProvider: endpoint.url is required (resolved at the composition root)");
		}
		this.model = opts.model;
		this.endpoint = opts.endpoint;
		this.fetchImpl = opts.fetch ?? globalThis.fetch;
		this.log = opts.log ?? (() => {});
		this.name = "openai";
		this.providerClass = "openai-spec";
		this.tier = "tier2";
	}

	/**
	 * @param {import("./types.js").DescriptionRequest} request
	 * @returns {Promise<import("./types.js").DescriptionResult>}
	 */
	async describe(request) {
		const content = [/** @type {Record<string, unknown>} */ ({ type: "text", text: promptOf(request) })];
		if (request.image) {
			// OpenAI-spec vision contract: data-URL image part.
			content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${request.image}` } });
		}
		const res = await this.fetchImpl(`${this.endpoint.url.replace(/\/$/, "")}/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(this.endpoint.key ? { authorization: `Bearer ${this.endpoint.key}` } : {}),
			},
			body: JSON.stringify({
				model: this.model,
				messages: [{ role: "user", content: /** @type {unknown} */ (content) }],
			}),
		});
		if (!res.ok) {
			let safeText = "";
			try {
				safeText = (await res.text()).slice(0, 200);
			} catch {
				// body unreadable — the status line alone carries the failure
			}
			throw new Error(`openai: description failed (${res.status} ${res.statusText}): ${safeText}`);
		}
		let doc;
		try {
			doc = await res.json();
		} catch (error) {
			throw new Error(`openai: description response was not JSON — ${error instanceof Error ? error.message : String(error)}`);
		}
		const message = /** @type {{choices?: Array<{message?: {content?: unknown}}>}} */ (doc)?.choices?.[0]?.message?.content;
		const text = typeof message === "string" && message.trim() !== "" ? message.trim() : null;
		return { text, model: this.model };
	}

	/** The never-silent compute posture for the event-description stage. */
	status() {
		return {
			engine: "openai-chat",
			providerClass: this.providerClass,
			model: this.model,
			state: "configured",
			endpointResolved: true,
		};
	}
}
