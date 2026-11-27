// embedder.js — the embedder clients of record (PORCH-155; TS 13 "the same
// store the semantic-search feature uses", candidate qwen3-embedding-class
// [Assumed: model choice confirmed at build]). The embedder rides the
// engine compute posture (PRD 5 / TS 5 InferenceProvider): the "embedding"
// stage's plan carries { providerClass, model, endpointRef } and endpooint
// references are RESOLVED at the composition root — never literal
// addresses in the config of record.
//
// Never-silent: an unwired stage presents the UnwiredEmbedder — a stateful
// "not provisioned" presenter that refuses embed() with plain language
// instead of silently embedding nothing.

import { ValidationError } from "./types.js";

/** @typedef {{ data: Float32Array }} Embedding */

/**
 * OpenAI-spec embeddings client (POST <endpoint>/embeddings {model, input}).
 * The endpoint resolver is injected (endpointRef → resolved URL + key); the
 * provider never reads secrets itself. fetch is injectable for tests.
 */
export class OpenAiSpecEmbedder {
	/**
	 * @param {{
	 *   model: string,
	 *   endpoint: { url: string, key?: string },
	 *   fetch?: typeof globalThis.fetch,
	 *   log?: (...args: unknown[]) => void,
	 * }} opts
	 */
	constructor(opts) {
		if (!opts.model) throw new ValidationError("model: required (the embedder model of record, e.g. qwen3-embedding-class)");
		if (!opts.endpoint?.url) throw new ValidationError("endpoint.url: required — the resolved endpoint, never a secret reference here");
		this.name = `openai-spec:${opts.model}`;
		this.model = opts.model;
		this.endpoint = opts.endpoint;
		this.fetchImpl = opts.fetch ?? globalThis.fetch;
		this.log = opts.log ?? (() => {});
	}

	/** @param {string} text */
	async embed(text) {
		if (typeof text !== "string" || text.trim() === "") {
			throw new ValidationError("embed: text is required — no-speech chunks are never embedded (nothing to embed)");
		}
		let res;
		try {
			res = await this.fetchImpl(`${this.endpoint.url.replace(/\/$/, "")}/embeddings`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(this.endpoint.key ? { authorization: `Bearer ${this.endpoint.key}` } : {}),
				},
				body: JSON.stringify({ model: this.model, input: text }),
			});
		} catch (err) {
			throw new ValidationError(`embedding endpoint unreachable (${this.name}): ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!res.ok) {
			throw new ValidationError(`embedding request failed (${res.status} ${res.statusText || "status"}): ${await safeText(res)}`);
		}
		const body = await res.json();
		const data = body?.data?.[0]?.embedding;
		if (!Array.isArray(data) || data.length === 0) {
			throw new ValidationError("embedding response: no embedding array — the endpoint is not OpenAI-spec-compatible");
		}
		return { data: Float32Array.from(data) };
	}

	status() {
		return { engine: "http", providerClass: "openai-spec", model: this.model, state: "configured", endpointResolved: true };
	}
}

/**
 * Local-server embeddings client (POST <endpoint>/embeddings {input}) — the
 * same class of endpoint as a provisioned local embedding service (e.g. an
 * Ollama-class server carrying the qwen3-embedding model of record).
 */
export class LocalServerEmbedder {
	/**
	 * @param {{
	 *   model: string,
	 *   endpoint: { url: string, key?: string },
	 *   fetch?: typeof globalThis.fetch,
	 *   log?: (...args: unknown[]) => void,
	 * }} opts
	 */
	constructor(opts) {
		if (!opts.model) throw new ValidationError("model: required");
		if (!opts.endpoint?.url) throw new ValidationError("endpoint.url: required — the resolved endpoint, never a secret reference here");
		this.name = `local-server:${opts.model}`;
		this.model = opts.model;
		this.endpoint = opts.endpoint;
		this.fetchImpl = opts.fetch ?? globalThis.fetch;
		this.log = opts.log ?? (() => {});
	}

	/** @param {string} text */
	async embed(text) {
		if (typeof text !== "string" || text.trim() === "") {
			throw new ValidationError("embed: text is required — no-speech chunks are never embedded (nothing to embed)");
		}
		let res;
		try {
			res = await this.fetchImpl(`${this.endpoint.url.replace(/\/$/, "")}/embeddings`, {
				method: "POST",
				headers: this.endpoint.key ? { authorization: `Bearer ${this.endpoint.key}` } : {},
				body: JSON.stringify({ input: text, model: this.model }),
			});
		} catch (err) {
			throw new ValidationError(`embedding endpoint unreachable (${this.name}): ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!res.ok) {
			throw new ValidationError(`embedding request failed (${res.status} ${res.statusText || "status"}): ${await safeText(res)}`);
		}
		const body = await res.json();
		const data = body?.embedding ?? body?.data?.[0]?.embedding;
		if (!Array.isArray(data) || data.length === 0) {
			throw new ValidationError("embedding response: no embedding array — the local server returned nothing");
		}
		return { data: Float32Array.from(data) };
	}

	status() {
		return { engine: "http", providerClass: "local-server", model: this.model, state: "configured", endpointResolved: true };
	}
}

/** The never-silent posture when nothing is provisioned: refuses work with
 * plain language, reports its unwired truth, never fakes a vector. */
export class UnwiredEmbedder {
	constructor(reason = "the embedding stage has no provider yet — re-point it on the Models/Compute surface") {
		this.name = "unwired";
		this.reason = reason;
	}

	async embed(_text) {
		throw new ValidationError(this.reason);
	}

	status() {
		return { engine: "none", providerClass: null, model: null, state: "not-provisioned", reason: this.reason };
	}
}

async function safeText(res) {
	return res.text().catch(() => "<unreadable body>");
}
