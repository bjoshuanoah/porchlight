// runtime.js — the platform daemon: the composition root launchd keeps
// alive (PORCH-134 ac-1). Starts the engine services of record — the
// stream manager (the one upstream connection per camera and its relay
// lanes, PORCH-154) first, then the recorder supervisor, idle until
// cameras arrive in the config of record — and serves the health status
// page. SIGTERM/SIGINT stop it gracefully so launchd KeepAlive relaunches
// on crash, not on deploy.

import { RecorderSupervisor } from "@porchlight/recorder";
import { EventBusBroker } from "@porchlight/bus";
import { StreamManager } from "@porchlight/stream";
import {
	TranscriptionService,
	TranscriptStore,
	LocalVectorStore,
	createProviderResolver,
	createTranscriptCascade,
} from "@porchlight/transcript";
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
 *   transcription?: import("@porchlight/transcript").TranscriptionService,
 *   transcriptionResolver?: (method: string) => import("@porchlight/transcript").TranscriptionProvider,
 *   transcriptionEnabledFor?: (cameraId: string) => Promise<boolean|{value: boolean, source: string}>|boolean|{value: boolean, source: string},
 *   transcriptionEventReader?: (span: {cameraId: string, from: number, to: number}) => Promise<{data: Float32Array, sampleRate: number}|null>,
 *   transcriptionWindowMs?: number,
 * }} opts
 */
export async function startPlatformRuntime(opts = {}) {
	const {
		config,
		version = "unknown",
		log = console.log,
		halStatus,
		localNetworkProbe,
		localNetworkProbeMs = 60_000,
	} = opts;
	// The bus FIRST (PORCH-129 ac-1, the vetting decision in
	// docs/event-bus-transport.md): the engine's event bus is provisioned by
	// the product's own setup — an embedded MQTT broker bound to loopback,
	// started in-process before any engine service composes, so every
	// service's mqtt.js client connects at boot and a restarted service
	// reconnects with no manual step. A deployment that points busUrl at its
	// own broker runs on that broker instead; the config of record wins.
	/** @type {import("@porchlight/bus").EventBusBroker|null} */
	let broker = null;
	/** @type {Record<string, unknown>} */
	let runtimeConfig = config;
	if (config.busUrl) {
		log(`[runtime] event bus: ${String(config.busUrl)} (from the config of record)`);
	} else {
		broker = await new EventBusBroker({ log }).start();
		runtimeConfig = { ...config, busUrl: broker.url };
		log("[runtime] event bus provisioned green-field by the runtime (see /health for the broker row)");
	}
	// The stream manager composes FIRST (PORCH-154): it owns the ONE upstream
	// connection per camera and serves the relay ports the supervisor's
	// recorder fleet consumes — it must be answering before the recorder
	// opens its inputs. The started promise is recorded (the initial fleet
	// application resolves on it); a failed application is stated on the
	// manager's own health plane, never silently swallowed.
	const manager = new StreamManager({ config: /** @type {any} */ (runtimeConfig), log });
	const managerStarted = manager.start().applyPromise;
	managerStarted?.catch((err) => {
		log(`[runtime] stream manager initial fleet application failed: ${err instanceof Error ? err.message : String(err)}`);
	});
	log(`[runtime] stream manager up (${/** @type {any[]} */ (config.cameras ?? []).length} camera(s) configured)`);
	// The transcription consumer (PORCH-155; TS 13): a consumer of the stream
	// manager — it subscribes to each camera's decoded PCM the manager
	// already produces, so NOTHING here opens a second camera connection
	// (stream-manager law). Composed when the runtime receives the seams; a
	// not-wired plane states itself on the status page (never silent). The
	// retention index cascade rides the supervisor's sweep in the same pass.
	/** @type {import("@porchlight/transcript").TranscriptionService|null} */
	let transcription = opts.transcription ?? null;
	if (!transcription && (opts.transcriptionResolver || opts.transcriptionEnabledFor || opts.transcriptionEventReader)) {
		const storageRoot = /** @type {string} */ (runtimeConfig.storageRoot);
		const transcriptsRoot = `${storageRoot.replace(/\/$/, "")}/transcripts`;
		transcription = new TranscriptionService({
			store: new TranscriptStore({ root: transcriptsRoot }),
			vectorStore: new LocalVectorStore({ file: `${transcriptsRoot}/vectors.json` }),
			resolveProvider: opts.transcriptionResolver ?? createProviderResolver({}),
			enabledFor: opts.transcriptionEnabledFor ?? (() => false),
			eventReader: opts.transcriptionEventReader ?? null,
			windowMs: opts.transcriptionWindowMs,
			now: Date.now,
			log,
		});
	}
	/** @type {Map<string, () => void>} */
	const transcriptionSubs = new Map();
	const attachTranscription = (name) => {
		if (!transcription || transcriptionSubs.has(name)) return;
		const unsub = manager.subscribeAudio(name, (ch) => {
			void transcription.submitRollingAudio(ch);
		});
		transcriptionSubs.set(name, unsub);
	};
	if (transcription) {
		for (const camera of /** @type {any[]} */ (config.cameras ?? [])) {
			attachTranscription(/** @type {string} */ (camera.name ?? camera.id));
		}
		log(`[runtime] transcription consumer attached to ${transcriptionSubs.size} camera pcm lane(s)`);
		// Fleet changes ride the SAME manager instance the config mirror
		// applies to (POST /api/cameras/apply): an added camera gets its
		// subscription here — still ZERO extra camera connections; a removed
		// camera's subscription detaches with its source.
		const applyFleet = manager.applyFleet.bind(manager);
		/** @param {any[]} cameras */
		manager.applyFleet = async (cameras) => {
			const applied = await applyFleet(cameras);
			for (const name of applied.added ?? []) attachTranscription(/** @type {string} */ (name));
			for (const name of applied.removed ?? []) {
				transcriptionSubs.get(/** @type {string} */ (name))?.();
				transcriptionSubs.delete(/** @type {string} */ (name));
			}
			return applied;
		};
	}
	const supervisor = new RecorderSupervisor({
		config: /** @type {any} */ (runtimeConfig),
		log,
		...(transcription
			? {
					retentionCascade: createTranscriptCascade({
						store: transcription.store,
						vectorStore: transcription.vectorStore,
						log,
					}),
				}
			: {}),
	});
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
		transcription,
		bus: broker ? broker.status() : { transport: "mqtt", mode: "external", state: "external", url: /** @type {string} */ (config.busUrl), clients: null },
	});
	const status = createStatusServer({
		aggregate,
		port: /** @type {number} */ (runtimeConfig.statusPort ?? 8970),
		host: /** @type {string} */ (runtimeConfig.statusHost ?? "0.0.0.0"),
	});
	await status.listening();
	log(`[runtime] status page on http://${runtimeConfig.statusHost ?? "0.0.0.0"}:${runtimeConfig.statusPort ?? 8970}/`);
	await runProbe(); // the first probe rides boot — the page is already up and stating "unprobed"
	const interval = setInterval(() => { void runProbe(); }, localNetworkProbeMs);
	interval.unref();
	return {
		supervisor,
		manager,
		managerStarted,
		status,
		aggregate,
		transcription,
		broker,
		/** @type {string} */
		busUrl: /** @type {string} */ (runtimeConfig.busUrl),
		/** @returns {Promise<void>} */
		stop: async () => {
			clearInterval(interval);
			await status.close();
			// The recorder stops before the manager: its recordings drain from
			// the manager's relay lanes, so the manager closes last — and the
			// bus closes after every client has drained from it (PORCH-129).
			await supervisor.stop();
			for (const unsub of transcriptionSubs.values()) unsub?.();
			await transcription?.close();
			await manager.stop();
			await broker?.stop();
			broker = null;
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
