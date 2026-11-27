// sink.mqtt.js — MQTT detection publishing (PORCH-128).
//
// The engine's event-bus transport is owned by the PORCH-129 vetting
// decision (docs/event-bus-transport.md); the detection core depends only on the DetectionSink
// interface (types.js), never on MQTT directly. This module is the MQTT implementation
// of that seam: normalized DetectedObject JSON.
//
// Topic family of record (PORCH-152): `<topicPrefix>/<camera>/<cls>` — two
// segments after the prefix. Consumers keyed on this exact shape: the
// recorder's DETECTIONS_PATTERN "porchlight/engine/detections/+/+"
// (packages/recorder/src/bus.mqtt.js, cameraFromTopic = parts[3]), the home
// hub consumer (ENGINE_DETECTIONS_PREFIX "/+/+"), and apps/server's
// re-emitter (`<prefix>/<camera>/<cls>`).
//
// Reconnect: mqtt.js reconnects automatically; publications issued while
// offline buffer (bounded — oldest drops first, drops are counted and
// reported in status) and flush in order on reconnect.

import mqtt from "mqtt";

/** @typedef {import("./types.js").DetectedObject} DetectedObject */

export class MqttDetectionSink {
	/**
	 * @param {{
	 *   url: string,
	 *   topicPrefix?: string,
	 *   qos?: 0|1,
	 *   bufferLimit?: number,
	 *   client?: unknown,
	 *   connectTimeoutMs?: number,
	 *   reconnectPeriodMs?: number,
	 *   log?: (...args: unknown[]) => void,
	 * }} opts
	 */
	constructor(opts) {
		if (!opts.url) throw new TypeError("MqttDetectionSink: url is required");
		this.url = opts.url;
		this.topicPrefix = opts.topicPrefix ?? "porchlight/engine/detections";
		this.qos = opts.qos ?? 0;
		this.bufferLimit = opts.bufferLimit ?? 1000;
		this.connectTimeoutMs = opts.connectTimeoutMs ?? 10000;
		this.reconnectPeriodMs = opts.reconnectPeriodMs ?? 1000;
		this.log = opts.log ?? (() => {});
		/** @type {unknown} */ this.client = opts.client ?? null;
		/** @type {DetectedObject[]} */ this.buffer = [];
		this.dropped = 0;
	}

	/**
	 * Connect (or adopt an injected client) and wait for the connection.
	 * @returns {Promise<this>}
	 */
	async start() {
		if (!this.client) {
			this.client = mqtt.connect(this.url, {
				connectTimeout: this.connectTimeoutMs,
				reconnectPeriod: this.reconnectPeriodMs,
			});
			/** @type {any} */ (this.client).on("error", (/** @type {unknown} */ err) => {
				this.log(`mqtt sink error (will reconnect): ${err instanceof Error ? err.message : String(err)}`);
			});
		}
		/** @type {any} */
		const c = this.client;
		// An injected client is caller-managed; only a real mqtt client waits
		// here for the initial connection.
		if (typeof c.on === "function" && !c.connected) {
			await new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					c.off("connect", onConnect);
					reject(new Error(`mqtt sink: connect timeout after ${this.connectTimeoutMs}ms (${this.url})`));
				}, this.connectTimeoutMs);
				const onConnect = () => {
					clearTimeout(timer);
					c.off("connect", onConnect);
					resolve(true);
				};
				c.on("connect", onConnect);
			});
		}
		return this;
	}

	/**
	 * Publish one normalized detection to `<topicPrefix>/<camera>/<cls>`
	 * (the two-segment topic family of record, PORCH-152).
	 * @param {DetectedObject} object
	 */
	async publish(object) {
		/** @type {any} */
		const c = this.client;
		if (!c) throw new Error("mqtt sink: start() must run before publish()");
		if (!c.connected) {
			this.#buffer(object);
			return;
		}
		if (this.buffer.length > 0) this.#flushBuffered(c);
		c.publish(`${this.topicPrefix}/${object.camera}/${object.cls}`, JSON.stringify(object), { qos: this.qos, retain: false });
	}

	/**
	 * @param {DetectedObject} object
	 */
	#buffer(object) {
		if (this.buffer.length >= this.bufferLimit) {
			this.buffer.shift();
			this.dropped += 1;
		}
		this.buffer.push(object);
	}

	/** @param {any} c */
	#flushBuffered(c) {
		for (const buffered of this.buffer.splice(0)) {
			c.publish(`${this.topicPrefix}/${buffered.camera}/${buffered.cls}`, JSON.stringify(buffered), { qos: this.qos, retain: false });
		}
	}

	status() {
		const connected = /** @type {any} */ (this.client)?.connected ?? false;
		// Never-silent (PORCH-152): the sink names its degradation — an
		// offline bus holds buffered detections, and that count is the reason.
		const noun = this.buffer.length === 1 ? "detection" : "detections";
		return {
			transport: "mqtt",
			url: this.url,
			topicPrefix: this.topicPrefix,
			connected,
			state: connected ? "native" : "degraded",
			reason: connected ? null : `bus offline — ${this.buffer.length} ${noun} buffered`,
			buffered: this.buffer.length,
			dropped: this.dropped,
		};
	}

	async close() {
		/** @type {any} */
		const c = this.client;
		if (!c || typeof c.end !== "function") return;
		await new Promise((resolve) => c.end(true, {}, resolve));
		this.client = null;
	}
}

/** Sink used when no bus is attached (harness/dry runs): serializes and drops. */
export class NullDetectionSink {
	/** @type {unknown[]} */
	published = [];

	/**
	 * @param {DetectedObject} object
	 */
	async publish(object) {
		this.published.push(JSON.parse(JSON.stringify(object)));
	}

	status() {
		return { transport: "null", published: this.published.length };
	}

	async close() {}
}
