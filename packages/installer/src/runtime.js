// runtime.js — the platform daemon: the composition root launchd keeps
// alive (PORCH-134 ac-1). Starts the engine services of record (the
// recorder supervisor, idle until cameras arrive in the config of
// record) and serves the health status page. SIGTERM/SIGINT stop it
// gracefully so launchd KeepAlive relaunches on crash, not on deploy.

import { RecorderSupervisor } from "@porchlight/recorder";
import { resolveHal } from "@porchlight/hal";
import { aggregateHealth, createStatusServer } from "./status-page.js";
import { loadPlatformConfig } from "./config.js";

/**
 * Never-silent platform posture: if the HAL cannot resolve on this host,
 * the status page states the error, never advertises a capability.
 */
export function platformPosture() {
	try {
		return resolveHal().status();
	} catch (err) {
		return { platform: process.platform, error: /** @type {Error} */ (err).message };
	}
}

/**
 * Start the platform runtime against a validated config.
 * @param {{
 *   config: Record<string, unknown>,
 *   version?: string,
 *   log?: (line: string) => void,
 *   halStatus?: Record<string, unknown>,
 * }} opts
 */
export async function startPlatformRuntime({ config, version = "unknown", log = console.log, halStatus } = {}) {
	const supervisor = new RecorderSupervisor({ config: /** @type {any} */ (config), log });
	supervisor.start();
	log(`[runtime] recorder supervisor up (${/** @type {any[]} */ (config.cameras ?? []).length} camera(s) configured)`);
	const aggregate = () => aggregateHealth({
		supervisor,
		version,
		halStatus: halStatus ?? platformPosture(),
	});
	const status = createStatusServer({
		aggregate,
		port: /** @type {number} */ (config.statusPort ?? 8970),
		host: /** @type {string} */ (config.statusHost ?? "0.0.0.0"),
	});
	await status.listening();
	log(`[runtime] status page on http://${config.statusHost ?? "0.0.0.0"}:${config.statusPort ?? 8970}/`);
	return {
		supervisor,
		status,
		aggregate,
		/** @returns {Promise<void>} */
		stop: async () => {
			await status.close();
			await supervisor.stop();
		},
	};
}

/**
 * Daemon entrypoint: `porchlight-home daemon --config <file>`.
 * @param {{configPath: string, version?: string, signals?: boolean, log?: (line: string) => void}} opts
 */
export async function runDaemon({ configPath, version = "unknown", signals = true, log = console.log } = {}) {
	const config = loadPlatformConfig(configPath);
	const rt = await startPlatformRuntime({ config, version, log });
	if (signals) {
		let stopping = false;
		const onSignal = () => {
			if (stopping) return;
			stopping = true;
			log("[runtime] stopping (signal)");
			rt.stop().then(() => process.exit(0), (/** @type {unknown} */ err) => {
				log(`[runtime] stop failed: ${/** @type {Error} */ (err).message}`);
				process.exit(1);
			});
		};
		process.on("SIGTERM", onSignal);
		process.on("SIGINT", onSignal);
	}
	// Runs until signalled; launchd KeepAlive owns the lifecycle.
	return new Promise(() => undefined);
}
