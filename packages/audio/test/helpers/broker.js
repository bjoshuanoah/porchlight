// helpers/broker.js — embedded MQTT broker for audio sink/service tests. Test-only
// dependency (aedes); production bus wiring is the PORCH-129 transport
// vetting decision, provisioned by the product's own setup.
// (Mirrors packages/detection/test/helpers/broker.js — the same embedded
// broker fixture shape.)

import net from "node:net";
import { once } from "node:events";

/**
 * Start an embedded aedes broker on an ephemeral loopback port.
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export async function startBroker() {
	const mod = await import("aedes");
	const Aedes = mod.Aedes ?? mod.default;
	const aedes = await /** @type {any} */ (Aedes).createBroker();
	const server = net.createServer(aedes.handle);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
	return {
		url: `mqtt://127.0.0.1:${port}`,
		port,
		close: async () => {
			// Force-close any connected clients so server.close cannot hang on
			// sockets a failed test left open.
			for (const id of Object.keys(aedes.clients ?? {})) {
				try {
					/** @type {any} */ (aedes.clients[id]).close();
				} catch {
					// already gone
				}
			}
			await new Promise((resolve) => server.close(resolve));
			aedes.close();
		},
	};
}
