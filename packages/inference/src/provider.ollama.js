// provider.ollama.js — the tier-1 provider (PORCH-133; PRD 5: "Tier 1
// (local LLM/VLM): Ollama on the deployment host ... event descriptions,
// behavior triage, gated by event FSM transitions").
//
// The deployment host's own Ollama (provisioned by the product's own setup,
// green-field law — never assumed pre-installed). Model is the
// setup-selected vision-capable candidate of record (shaping-verified
// candidates: ornith-1.5:9b, ornith-1.5:35b, gemma4:e2b-mlx); the provider
// is the boundary, never a hardcoded runtime.
//
// Data boundary (per-provider, README carries the law): tier 1 is LOCAL —
// the request stays on the deployment host. What may be sent here is the
// event's facts and at most one base64 snapshot still; video never rides
// any provider.
//
// Endpoint posture (the transcript providers' convention): the endpoint is
// pre-RESOLVED by the composition root — no addresses or keys are stored in
// the config of record, and fetch is injectable for tests.

/**
 * The gated-event description prompt. Facts first (what detection saw),
 * then what the FSM said happened, then the ask. The ask never invents:
 * the provider returns its answer verbatim and the caller records it as a
 * "likely reading", never a fact (the event surfaces' attribution law).
 * @param {import("./types.js").DescriptionRequest} request
 */
export function promptOf(request) {
	const facts = /** @type {string[]} */ ([
		`Camera: ${request.camera}`,
		`Moment: ${new Date(request.t * 1000).toISOString()}`,
		request.cls ? `Class: ${request.cls}` : "",
		request.trackId ? `Track: ${request.trackId}` : "",
		request.detections?.length ? `Detections: ${request.detections.map((d) => `${d.cls} ${d.conf}`).join(", ")}` : "",
		`What happened: the tracked thing's state changed to "${request.transition}"`,
		`Snapshot still: ${request.image ? "attached (one frame, low detail)" : "not attached"}`,
	].filter((line) => line !== ""));
	return [
		...facts,
		"",
		"Describe who or what was seen and what they were doing at this moment. " +
			"One or two short sentences. If the still is not enough to be sure, say " +
			"so plainly instead of guessing.",
	].join("\n");
}

export class OllamaProvider {
	/** @param {{ model: string, endpoint: { url: string, key?: string }, fetch?: typeof globalThis.fetch, log?: (...args: unknown[]) => void }} opts */
	constructor(opts) {
		if (!opts?.model || typeof opts.model !== "string") {
			throw new TypeError("OllamaProvider: model is required (the setup-provisioned vision-capable model)");
		}
		if (!opts?.endpoint?.url || typeof opts.endpoint.url !== "string") {
			throw new TypeError("OllamaProvider: endpoint.url is required (resolved at the composition root)");
		}
		this.model = opts.model;
		this.endpoint = opts.endpoint;
		this.fetchImpl = opts.fetch ?? globalThis.fetch;
		this.log = opts.log ?? (() => {});
		this.name = "ollama";
		this.providerClass = "local-server";
		this.tier = "tier1";
	}

	/**
	 * @param {import("./types.js").DescriptionRequest} request
	 * @returns {Promise<import("./types.js").DescriptionResult>}
	 */
	async describe(request) {
		const message = /** @type {Record<string, unknown>} */ ({
			role: "user",
			content: promptOf(request),
		});
		// Vision-capable models take base64 image per message (Ollama chat contract).
		if (request.image) message.images = [request.image];
		const res = await this.fetchImpl(`${this.endpoint.url.replace(/\/$/, "")}/api/chat`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(this.endpoint.key ? { authorization: `Bearer ${this.endpoint.key}` } : {}),
			},
			body: JSON.stringify({ model: this.model, stream: false, messages: [message] }),
		});
		if (!res.ok) {
			let safeText = "";
			try {
				safeText = (await res.text()).slice(0, 200);
			} catch {
				// body unreadable — the status line alone carries the failure
			}
			throw new Error(`ollama: description failed (${res.status} ${res.statusText}): ${safeText}`);
		}
		let doc;
		try {
			doc = await res.json();
		} catch (error) {
			throw new Error(`ollama: description response was not JSON — ${error instanceof Error ? error.message : String(error)}`);
		}
		const content = /** @type {{message?: {content?: unknown}}} */ (doc)?.message?.content;
		const text = typeof content === "string" && content.trim() !== "" ? content.trim() : null;
		// An empty local answer is an explicit no-answer: null escalates routing
		// to the next tier, it never invents a description.
		return { text, model: this.model };
	}

	/** The never-silent compute posture for the event-description stage. */
	status() {
		return {
			engine: "ollama-chat",
			providerClass: this.providerClass,
			model: this.model,
			state: "configured",
			endpointResolved: true,
		};
	}
}
