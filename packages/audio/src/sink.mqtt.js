// sink.mqtt.js — MQTT audio-event publishing (PORCH-153).
//
// The engine's event-bus transport decision (PORCH-129 vetting — docs/event-bus-transport.md) is owned by
// this seam; the audio core depends only on AudioSink (types.js). The topic
// family of record is the SAME two-segment detections family every consumer
// keys on — <topicPrefix>/<camera>/<class> — so audio events ride the same
// bus family as DetectedObject (TS 8) with the AudioEvent field set in the
// payload. Consumers keyed on this family: the recorder's DETECTIONS
// subscription (event-mode triggers; cameraFromTopic = parts[3]), the home
// hub consumer (ENGINE_DETECTIONS_PREFIX "/+/+" → the event/timeline ingest,
// the same evidence path as visual events), and the recognition plane
// (which drops non-recognition-bearing events before anything runs).
//
// Reconnect: mqtt.js reconnects automatically; publications issued while
// offline buffer (bounded — oldest drops first, drops are counted and
// reported in status) and flush in order on reconnect.

import mqtt from "mqtt";

/** @typedef {import("./types.js").AudioEvent} AudioEvent */

export class MqttAudioSink {
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
		if (!opts.url) throw new TypeError("MqttAudioSink: url is required");
		this.url = opts.url;
		// The detections family of record (same as MqttDetectionSink's default):
		// the two-segment <camera>/<class> shape every bus consumer keys on.
		this.topicPrefix = opts.topicPrefix ?? "porchlight/engine/detections";
		this.qos = opts.qos ?? 0;
		this.bufferLimit = opts.bufferLimit ?? 1000;
		this.connectTimeoutMs = opts.connectTimeoutMs ?? 10000;
		this.reconnectPeriodMs = opts.reconnectPeriodMs ?? 1000;
		this.log = opts.log ?? (() => {});
		/** @type {unknown} */ this.client = opts.client ?? null;
		/** @type {AudioEvent[]} */ this.buffer = [];
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
				this.log(`mqtt audio sink error (will reconnect): ${err instanceof Error ? err.message : String(err)}`);
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
					reject(new Error(`mqtt audio sink: connect timeout after ${this.connectTimeoutMs}ms (${this.url})`));
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
	 * Publish one AudioEvent to `<topicPrefix>/<camera>/<class>` (the
	 * two-segment topic family of record).
	 * @param {AudioEvent} event
	 */
	async publish(event) {
		/** @type {any} */
		const c = this.client;
		if (!c) throw new Error("mqtt audio sink: start() must run before publish()");
		if (!c.connected) {
			this.#buffer(event);
			return;
		}
		if (this.buffer.length > 0) this.#flushBuffered(c);
		c.publish(`${this.topicPrefix}/${event.camera}/${event.class}`, JSON.stringify(event), { qos: this.qos, retain: false });
	}

	/**
	 * @param {AudioEvent} event
	 */
	#buffer(event) {
		if (this.buffer.length >= this.bufferLimit) {
			this.buffer.shift();
			this.dropped += 1;
		}
		this.buffer.push(event);
	}

	/** @param {any} c */
	#flushBuffered(c) {
		for (const buffered of this.buffer.splice(0)) {
			c.publish(`${this.topicPrefix}/${buffered.camera}/${buffered.class}`, JSON.stringify(buffered), { qos: this.qos, retain: false });
		}
	}

	status() {
		const connected = /** @type {any} */ (this.client)?.connected ?? false;
		// Never-silent law: an offline bus holds buffered audio events, and
		// that count is the stated reason.
		const noun = this.buffer.length === 1 ? "event" : "events";
		return {
			transport: "mqtt",
			url: this.url,
			topicPrefix: this.topicPrefix,
			connected,
			state: connected ? "native" : "degraded",
			reason: connected ? null : `bus offline — ${this.buffer.length} audio ${noun} buffered`,
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

/** Sink used when no bus is attached (harness/dry runs): serializes and keeps. */
export class NullAudioSink {
	/** @type {unknown[]} */
	published = [];

	/**
	 * @param {AudioEvent} event
	 */
	async publish(event) {
		this.published.push(JSON.parse(JSON.stringify(event)));
	}

	status() {
		return { transport: "null", published: this.published.length };
	}

	async close() {}
}
