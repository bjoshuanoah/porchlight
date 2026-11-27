// runtime.js — the platform daemon: the composition root launchd keeps
// alive (PORCH-134 ac-1). Starts the engine services of record — the
// stream manager (the one upstream connection per camera and its relay
// lanes, PORCH-154) first, then the recorder supervisor, idle until
// cameras arrive in the config of record — and serves the health status
// page. SIGTERM/SIGINT stop it gracefully so launchd KeepAlive relaunches
// on crash, not on deploy.

import { RecorderSupervisor } from "@porchlight/recorder";
import { StreamManager } from "@porchlight/stream";
import { resolveHal } from "@porchlight/hal";
import { aggregateHealth, createStatusServer } from "./status-page.js";
import { loadPlatformConfig } from "./config.js";
import { runNetworkProbe } from "./tcc.js";

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
 * The default Local Network probe seam (PORCH-152): the TCC UDP posture
 * probe (tcc.js runNetworkProbe). A completed probe — the regulated UDP
 * send per TN3179 — states "allowed"; a thrown probe (socket refused,
 * sandboxed host) states "denied" with the error, never silent. The
 * injection point exists for tests and networkless runs.
 * @param {(line: string) => void} log
 * @returns {() => Promise<{state: "allowed"|"denied", reason?: string}>}
 */
function defaultLocalNetworkProbe(log) {
	return async () => {
		try {
			await runNetworkProbe({ dgram: await import("node:dgram"), log, timeoutMs: 4000, interfaceAddress: undefined });
			return { state: "allowed" };
		} catch (err) {
			return { state: "denied", reason: /** @type {Error} */ (err).message };
		}
	};
}

/**
 * Start the platform runtime against a validated config.
 * @param {{
 *   config: Record<string, unknown>,
 *   version?: string,
 *   log?: (line: string) => void,
 *   halStatus?: Record<string, unknown>,
 *   localNetworkProbe?: () => Promise<{state: "allowed"|"denied"|"unknown"|"unprobed", reason?: string} | null>,
 *   localNetworkProbeMs?: number,
 * }} opts
 */
export async function startPlatformRuntime({ config, version = "unknown", log = console.log, halStatus, localNetworkProbe, localNetworkProbeMs = 60_000 } = {}) {
	// The stream manager composes FIRST (PORCH-154): it owns the ONE upstream
	// connection per camera and serves the relay ports the supervisor's
	// recorder fleet consumes — it must be answering before the recorder
	// opens its inputs. The started promise is recorded (the initial fleet
	// application resolves on it); a failed application is stated on the
	// manager's own health plane, never silently swallowed.
	const manager = new StreamManager({ config: /** @type {any} */ (config), log });
	const managerStarted = manager.start().applyPromise;
	managerStarted?.catch((err) => {
		log(`[runtime] stream manager initial fleet application failed: ${err instanceof Error ? err.message : String(err)}`);
	});
	log(`[runtime] stream manager up (${/** @type {any[]} */ (config.cameras ?? []).length} camera(s) configured)`);
	const supervisor = new RecorderSupervisor({ config: /** @type {any} */ (config), log });
	supervisor.start();
	log(`[runtime] recorder supervisor up (${/** @type {any[]} */ (config.cameras ?? []).length} camera(s) configured)`);
	// The Local Network posture (PORCH-152): probed at boot and re-probed on
	// an interval, stated on the status surface — macOS silently drops UDP
	// from an unpermitted process (TN3179), so the loss must surface, never
	// disappear. A failing probe is a stated state; it never crashes the daemon.
	/** @type {{state?: string, reason?: string | null}} */
	let localNetwork = { state: "unprobed", reason: "the first probe is still running" };
	const runProbe = async () => {
		/** @type {{state?: string, reason?: string | null}} */
		let result;
		try {
			result = await (localNetworkProbe ?? defaultLocalNetworkProbe(log))();
		} catch (err) {
			result = { state: "unknown", reason: `the Local Network probe failed: ${/** @type {Error} */ (err).message}` };
		}
		if (result.state !== localNetwork.state) {
			log(`[runtime] local-network posture: ${result.state ?? "unknown"}${result.reason ? ` (${result.reason})` : ""}`);
		}
		localNetwork = result;
	};
	const aggregate = () => aggregateHealth({
		supervisor,
		manager,
		version,
		halStatus: halStatus ?? platformPosture(),
		localNetwork,
	});
	const status = createStatusServer({
		aggregate,
		port: /** @type {number} */ (config.statusPort ?? 8970),
		host: /** @type {string} */ (config.statusHost ?? "0.0.0.0"),
	});
	await status.listening();
	log(`[runtime] status page on http://${config.statusHost ?? "0.0.0.0"}:${config.statusPort ?? 8970}/`);
	await runProbe(); // the first probe rides boot — the page is already up and stating "unprobed"
	const interval = setInterval(() => { void runProbe(); }, localNetworkProbeMs);
	interval.unref();
	return {
		supervisor,
		manager,
		managerStarted,
		status,
		aggregate,
		/** @returns {Promise<void>} */
		stop: async () => {
			clearInterval(interval);
			await status.close();
			// The recorder stops before the manager: its recordings drain from
			// the manager's relay lanes, so the manager closes last.
			await supervisor.stop();
			await manager.stop();
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
