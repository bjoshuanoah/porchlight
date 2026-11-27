// health-bus.js — MQTT stream health publishing (PORCH-154).
//
// Mirrors packages/detection/src/sink.mqtt.js style: the stream core depends
// only on the StreamHealthBus seam, never on MQTT directly; this module is
// the MQTT implementation. Topic family of record:
//
//     porchlight/engine/streams/<camera>/up
//     porchlight/engine/streams/<camera>/down
//
// payload JSON { camera, state: "up"|"down", reason, at } — emitted on every
// source connect/disconnect. Green-field law: with no busUrl configured the
// manager runs a NullStreamHealthBus (nothing is assumed pre-deployed).
//
// Reconnect: mqtt.js reconnects automatically; publications issued while
// offline buffer (bounded — oldest drops first, drops counted and reported
// in status) and flush in order on reconnect.

import mqtt from "mqtt";

/** The topic-prefix segment of record for stream health. */
export const STREAM_HEALTH_PREFIX = "porchlight/engine/streams";

/** @param {string} camera @param {"up"|"down"} direction */
export function streamHealthTopic(camera, direction) {
	return `${STREAM_HEALTH_PREFIX}/${camera}/${direction}`;
}

export class MqttStreamHealthPublisher {
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
		if (!opts.url) throw new TypeError("MqttStreamHealthPublisher: url is required");
		this.url = opts.url;
		this.topicPrefix = opts.topicPrefix ?? STREAM_HEALTH_PREFIX;
		this.qos = opts.qos ?? 0;
		this.bufferLimit = opts.bufferLimit ?? 1000;
		this.connectTimeoutMs = opts.connectTimeoutMs ?? 10000;
		this.reconnectPeriodMs = opts.reconnectPeriodMs ?? 1000;
		this.log = opts.log ?? (() => {});
		/** @type {unknown} */ this.client = opts.client ?? null;
		/** @type {{ topic: string, payload: string }[]} */ this.buffer = [];
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
			/** @type {any} */ (this.client).on("error", () => {
				this.log("[stream-bus] mqtt error (will reconnect)");
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
					reject(new Error(`mqtt stream health bus: connect timeout after ${this.connectTimeoutMs}ms (${this.url})`));
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
	 * Publish one stream health event. Offline publications buffer (bounded)
	 * and flush in order on reconnect — never silent, drops are counted.
	 * @param {string} topic
	 * @param {unknown} payload
	 */
	async publish(topic, payload) {
		/** @type {any} */
		const c = this.client;
		if (!c) throw new Error("mqtt stream health bus: start() must run before publish()");
		if (!c.connected) {
			this.#buffer(topic, payload);
			return;
		}
		if (this.buffer.length > 0) this.#flushBuffered(c);
		c.publish(topic, JSON.stringify(payload), { qos: this.qos, retain: false });
	}

	/**
	 * @param {string} topic
	 * @param {unknown} payload
	 */
	#buffer(topic, payload) {
		if (this.buffer.length >= this.bufferLimit) {
			this.buffer.shift();
			this.dropped += 1;
		}
		this.buffer.push({ topic, payload: JSON.stringify(payload) });
	}

	/** @param {any} c */
	#flushBuffered(c) {
		for (const buffered of this.buffer.splice(0)) {
			c.publish(buffered.topic, buffered.payload, { qos: this.qos, retain: false });
		}
	}

	status() {
		const connected = /** @type {any} */ (this.client)?.connected ?? false;
		const noun = this.buffer.length === 1 ? "event" : "events";
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

/** Bus used when no busUrl is configured (green-field law): records and drops. */
export class NullStreamHealthBus {
	/** @type {{ topic: string, payload: unknown }[]} */
	published = [];

	constructor(opts = {}) {
		this.topicPrefix = opts.topicPrefix ?? STREAM_HEALTH_PREFIX;
	}

	/**
	 * @param {string} topic
	 * @param {unknown} payload
	 */
	async publish(topic, payload) {
		this.published.push({ topic, payload: JSON.parse(JSON.stringify(payload)) });
	}

	status() {
		return { transport: "null", published: this.published.length };
	}

	async close() {}
}
