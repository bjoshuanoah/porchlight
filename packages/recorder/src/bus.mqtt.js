// bus.mqtt.js — the recorder's event-bus seam (PORCH-136).
//
// Storage state (ac-4) and drive-health alerts (ac-5) publish on the
// engine's event bus; detection events drive event-mode recording (ac-3).
// Transport: MQTT via mqtt.js — the same seam family the detection sink
// uses. Green-field law: the supervisor only creates this when the config
// of record carries busUrl; nothing is assumed pre-deployed.

import mqtt from "mqtt";

export const STORAGE_STATE_TOPIC = "porchlight/engine/storage/state";
export const STORAGE_EVENTS_TOPIC = "porchlight/engine/storage/events";
export const DETECTIONS_PATTERN = "porchlight/engine/detections/+/+";

/**
 * Open the recorder's bus connection.
 * @param {{url: string, clientId?: string, log?: (line: string) => void}} opts
 */
export function createMqttBus(opts) {
	const log = opts.log ?? (() => {});
	const client = mqtt.connect(opts.url, {
		clientId: opts.clientId ?? "porchlight-recorder",
		reconnectPeriod: 5000,
		clean: true,
	});
	client.on("error", (err) => log(`[bus] connection error: ${err.message}`));
	client.on("connect", () => log(`[bus] connected to ${opts.url}`));

	return {
		client,
		/**
		 * @param {string} topic
		 * @param {unknown} payload
		 */
		publish(topic, payload, { retain = false } = {}) {
			if (!client.connected) return false;
			client.publish(topic, JSON.stringify(payload), { qos: 0, retain });
			return true;
		},
		/**
		 * @param {string} pattern
		 * @param {(topic: string, payload: string) => void} handler
		 */
		subscribe(pattern, handler) {
			client.subscribe(pattern);
			client.on("message", (topic, buf) => handler(topic, buf.toString("utf8")));
		},
		/** Camera name out of the detection topic contract. */
		cameraFromTopic(topic) {
			const parts = topic.split("/");
			return parts[3] ?? null;
		},
		status() {
			return { connected: client.connected, url: opts.url };
		},
		/** @returns {Promise<void>} */
		close() {
			return new Promise((resolve) => {
				if (!client.connected) {
					client.end(true);
					resolve();
					return;
				}
				client.end(false, {}, () => resolve());
			});
		},
	};
}
