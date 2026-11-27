// sink.webhook.js — HTTP webhook detection output (PORCH-129, ac-3).
//
// The sink family rides the DetectionSink seam (types.js) next to the MQTT
// bus sink: when the effective alertRouting config ("bus" | "webhook" knobs,
// packages/config) selects webhook output, detections emit as HTTP POSTs
// carrying the SAME normalized DetectedObject JSON the bus publishes —
// field-for-field, one wire contract, two deliveries.
//
// Delivery posture: webhooking is best-effort like the bus's QoS-0 publish.
// A failing target is counted, logged, and never blocks the detection loop
// or the other output; targets are attempted in parallel. No payload is
// reshaped, filtered, or enriched: the webhook emits exactly what the bus
// subscriber receives.

/** @typedef {import("./types.js").DetectedObject} DetectedObject */

export class WebhookDetectionSink {
	/**
	 * @param {{
	 *   urls: string[],
	 *   timeoutMs?: number,
	 *   fetchImpl?: typeof fetch,
	 *   log?: (...args: unknown[]) => void,
	 * }} opts
	 */
	constructor(opts) {
		const urls = opts.urls ?? [];
		if (!Array.isArray(urls) || urls.length === 0 || urls.some((u) => typeof u !== "string" || u.length === 0)) {
			throw new TypeError("WebhookDetectionSink: urls must be a non-empty list of http(s) URLs");
		}
		if (urls.some((u) => !/^https?:\/\//.test(u))) {
			throw new TypeError("WebhookDetectionSink: every webhook target must be an http(s) URL");
		}
		this.urls = [...urls];
		this.timeoutMs = opts.timeoutMs ?? 3000;
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.log = opts.log ?? (() => {});
		this.delivered = 0;
		this.failed = 0;
	}

	/**
	 * Emit one detection to every configured target as the same
	 * DetectedObject JSON the bus carries. Never throws: a webhook is an
	 * output, not a dependency (graceful-degradation principle).
	 * @param {DetectedObject} object
	 */
	async publish(object) {
		const body = JSON.stringify(object);
		await Promise.all(this.urls.map(async (url) => {
			try {
				const res = await this.fetchImpl(url, {
					method: "POST",
					headers: { "content-type": "application/json", "user-agent": "porchlight-engine" },
					body,
					signal: AbortSignal.timeout(this.timeoutMs),
				});
				if (!res.ok) throw new Error(`webhook ${url}: HTTP ${res.status}`);
				this.delivered += 1;
			} catch (err) {
				this.failed += 1;
				this.log(`webhook sink: ${err instanceof Error ? err.message : String(err)}`);
			}
		}));
	}

	/** Never-silent posture (PORCH-152): the output's own delivery counts. */
	status() {
		return {
			transport: "webhook",
			urls: this.urls.length,
			delivered: this.delivered,
			failed: this.failed,
			state: this.failed > this.delivered ? "degraded" : "native",
			reason: this.failed > this.delivered ? `${this.failed} delivery failure(s) outweigh ${this.delivered} delivered` : null,
		};
	}
}

/**
 * Fan a detection to every selected output sink (the alertRouting wiring
 * point: ["bus"] rides the MQTT family alone, ["webhook"] the HTTP seam,
 * and both selected fan to both — one wire contract per ac-3, no reshaping).
 * Sinks are independent: one sink's failure never blocks the others, and
 * per-sink status stays readable for the status surface.
 *
 * @param {{ name: string, sink: import("./types.js").DetectionSink }[]} sinks
 * @returns {import("./types.js").DetectionSink}
 */
export function fanoutDetectionSink(sinks) {
	const named = sinks.map((s) => ({
		name: s.name,
		sink: /** @type {import("./types.js").DetectionSink} */ (s.sink),
	}));

	return {
		async publish(object) {
			await Promise.all(named.map(async ({ name, sink }) => {
				try {
					await sink.publish(object);
				} catch (err) {
					// A sink failure is logged with its name, never swallowed
					// silently and never fatal to the detection loop.
					console.error(`[detection-fanout] sink "${name}" failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}));
		},
		status() {
			return {
				transport: "fanout",
				sinks: named.map(({ name, sink }) => ({ name, status: sink.status?.() ?? null })),
			};
		},
		async close() {
			for (const { sink } of named) await sink.close?.();
		},
	};
}
