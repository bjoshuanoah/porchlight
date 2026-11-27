// broker.js — the engine's event bus of record (PORCH-129).
//
// Transport decision: docs/event-bus-transport.md (the PORCH-129 vetting).
// MQTT won; the broker ships INSIDE the product's own setup — aedes, an
// in-process broker bound to loopback — so a fresh deployment provisions
// and starts its bus on first boot with nothing pre-deployed (green-field
// law, PRD 3). A deployment that wants its own broker sets busUrl in the
// config of record; the runtime then skips provisioning and the engine
// services connect to the configured broker instead.
//
// Lifecycle contract (PORCH-129 ac-1): the runtime starts the bus before
// any engine service composes, every service connects (mqtt.js clients),
// and a restarted service reconnects without manual intervention — mqtt.js
// clients auto-reconnect (reconnectPeriod) and the broker holds no state
// that a reconnect would need.

import net from "node:net";
import { once } from "node:events";

/** @returns {Promise<any>} the aedes broker factory */
async function aedesFactory() {
	const mod = await import("aedes");
	// same resolution shape as the engine's test broker fixtures
	return /** @type {any} */ (mod).Aedes ?? /** @type {any} */ (mod).default;
}

export class EventBusBroker {
	/**
	 * @param {{
	 *   host?: string,
	 *   port?: number,
	 *   log?: (...args: unknown[]) => void,
	 *   aedesFactory?: () => Promise<any>,
	 * }} opts
	 */
	constructor(opts = {}) {
		this.host = opts.host ?? "127.0.0.1";
		this.port = opts.port ?? 0; // 0 = ephemeral loopback port
		this.log = opts.log ?? (() => {});
		this.#factory = opts.aedesFactory ?? aedesFactory;
		/** @type {any|null} */ this.aedes = null;
		/** @type {import("node:net").Server|null} */ this.server = null;
		this.#boundPort = 0;
		this.#stopping = false;
	}

	/** @type {() => Promise<any>} */
	#factory;

	/** @type {number} */ #boundPort;
	/** @type {boolean} */ #stopping;

	/**
	 * Provision and start the broker. Idempotent: a started broker returns
	 * itself without a second bind.
	 * @returns {Promise<this>}
	 */
	async start() {
		if (this.server) return this;
		const Aedes = await this.#factory();
		const aedes = await /** @type {any} */ (Aedes).createBroker();
		aedes.on("clientError", (/** @type {any} */ client, /** @type {Error} */ err) => {
			this.log(`[bus] client ${client?.id ?? "unknown"} error: ${err.message}`);
		});
		const server = net.createServer(aedes.handle);
		server.listen(this.port, this.host);
		await once(server, "listening");
		this.#boundPort = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
		this.aedes = aedes;
		this.server = server;
		this.log(`[bus] provisioned at mqtt://${this.host}:${this.#boundPort} (embedded MQTT broker)`);
		return this;
	}

	/** @returns {string} the mqtt:// URL engine services connect to */
	get url() {
		if (!this.server) throw new Error("bus broker: start() must run before url");
		return `mqtt://${this.host}:${this.#boundPort}`;
	}

	/** @returns {number} clients currently connected */
	get clientCount() {
		return this.aedes ? Object.keys(this.aedes.clients ?? {}).length : 0;
	}

	/**
	 * Never-silent posture (PORCH-152): the runtime status page states the
	 * bus row from this, including the deployment-owned external broker URL.
	 */
	status() {
		if (!this.server) {
			return { transport: "mqtt", mode: "embedded", state: "stopped", url: null, clients: 0 };
		}
		return {
			transport: "mqtt",
			mode: "embedded",
			state: "running",
			url: this.url,
			clients: this.clientCount,
		};
	}

	/**
	 * Stop the broker: connected clients are force-closed first so
	 * server.close cannot hang on a live socket, then the server and the
	 * aedes instance drain. Safe to call twice.
	 * @returns {Promise<void>}
	 */
	async stop() {
		if (!this.server || this.#stopping) return;
		this.#stopping = true;
		try {
			for (const id of Object.keys(this.aedes?.clients ?? {})) {
				try {
					/** @type {any} */ (this.aedes.clients[id]).close();
				} catch {
					// already gone
				}
			}
			await new Promise((resolve) => this.server?.close(resolve));
			await new Promise((resolve) => /** @type {any} */ (this.aedes)?.close(resolve));
		} finally {
			this.aedes = null;
			this.server = null;
			this.#stopping = false;
		}
		this.log("[bus] stopped");
	}
}
