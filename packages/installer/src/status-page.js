// status-page.js — the health status surface (PORCH-134 ac-1).
//
// One deterministic page: what services exist, whether each is healthy,
// and what the host platform provides — stated, never advertised
// (never-silent law). Zero analytics, zero scripts, nothing loaded from
// the network; earned states render in plain language ("no cameras
// configured yet" is a stated state, not a silent empty dashboard).

/** @typedef {{name: string, healthy: boolean, state: string, detail: string}} ServiceHealth */

/** Closed Local Network postures (the TCC probe of record: src/tcc.js runNetworkProbe). */
const LOCAL_NETWORK_STATES = Object.freeze(["allowed", "denied", "unknown", "unprobed"]);

/** Plain-language explanation per posture (PORCH-152 never-silent law): the macOS Local Network permission silently drops UDP when ungranted, so the page says so instead of letting discovery and camera traffic vanish. */
const LOCAL_NETWORK_NOTES = Object.freeze({
	allowed: "Local Network access is granted — LAN discovery and camera local-P2P traffic (UDP) can leave the process.",
	denied: "Local Network permission denied — LAN discovery and camera local-P2P paths (UDP) are being silently dropped; grant Porchlight the Local Network permission in System Settings.",
	unknown: "The Local Network posture could not be determined — the stated reason carries the probe's own account.",
	unprobed: "No Local Network probe has run yet — the posture is stated as soon as the runtime probes the host.",
});

/**
 * @param {{
 *   supervisor?: import("@porchlight/recorder").RecorderSupervisor | null,
 *   manager?: import("@porchlight/stream").StreamManager | null,
 *   version?: string,
 *   halStatus?: Record<string, unknown>,
 *   localNetwork?: {state?: string, reason?: string | null} | null,
 *   transcription?: import("@porchlight/transcript").TranscriptionService | null,
 *   bus?: Record<string, unknown> | null,
 *   generatedAt?: string,
 * }} opts
 */
export function aggregateHealth({ supervisor = null, manager = null, version = "unknown", halStatus = null, generatedAt, localNetwork, transcription = null, bus = null } = {}) {
	/** @type {ServiceHealth[]} */
	const services = [];
	let recorderState = null;
	if (supervisor) {
		recorderState = supervisor.state();
		const healthy = recorderState.health === "ok" && !recorderState.stopping;
		const cameras = recorderState.cameras ?? [];
		services.push({
			name: "recorder",
			healthy,
			state: healthy ? "ok" : "degraded",
			detail: cameras.length === 0
				? "running — no cameras configured yet; add cameras to start recording"
				: `recording ${cameras.length} camera(s) → ${recorderState.storageRoot}`,
		});
	} else {
		services.push({ name: "recorder", healthy: false, state: "stopped", detail: "not started" });
	}
	// The stream serving row (PORCH-154): the stream manager holds the ONE
	// upstream connection per camera and feeds the live grid, the relay
	// consumers and the recorder from it — its health maps like the recorder
	// plane's (idle/opening/live ⇒ ok, degraded ⇒ degraded), and a stopped
	// or failing manager states itself instead of a healthy blank. The row
	// is stated whenever the runtime composes a manager.
	let streamView = null;
	if (manager) {
		if (/** @type {any} */ (manager).stopping === true) {
			services.push({ name: "stream", healthy: false, state: "stopped", detail: "the stream manager is stopping" });
		} else {
			try {
				const mh = manager.health();
				const mcams = Array.isArray(mh.cameras) ? mh.cameras : [];
				const mlive = mcams.filter((/** @type {{state?: string}} */ c) => c?.state === "live").length;
				const state = mh.state === "degraded" ? "degraded" : "ok";
				const detail = `${mcams.length} camera(s), ${mlive} live source(s)`;
				services.push({ name: "stream", healthy: state === "ok", state, detail });
				streamView = {
					state: /** @type {string} */ (mh.state),
					detail,
					cameraCount: mcams.length,
					cameraNames: mcams.map((/** @type {{name?: string}} */ c) => c.name ?? "unnamed"),
					liveSources: mlive,
				};
			} catch (err) {
				const reason = /** @type {Error} */ (err).message;
				services.push({ name: "stream", healthy: false, state: "unavailable", detail: `the stream manager isn't reachable (${reason})` });
			}
		}
	}
	// The storage plane (PORCH-136) rides the supervisor state; a supervisor
	// state without it (or no supervisor) is a stated unknown, not a lie.
	const storage = recorderState?.storage ?? null;
	const storageHealthy = supervisor
		? storage?.state !== "unavailable" && storage?.driveHealthy !== false
		: false;
	if (supervisor) {
		let storageDetail;
		if (storage?.reason) {
			storageDetail = storage.reason;
		} else if (storage?.driveHealthy === false) {
			storageDetail = storage.driveReason ?? "the storage drive is reporting a problem";
		} else if (storage?.activeLocation) {
			storageDetail = `recording to ${storage.activeLocation}`;
		} else {
			storageDetail = "the recorder has not reported storage status yet";
		}
		services.push({
			name: "storage",
			healthy: storageHealthy,
			state: storage?.state ?? "unknown",
			detail: storageDetail,
		});
	} else {
		services.push({
			name: "storage",
			healthy: false,
			state: "not started",
			detail: "the recorder is not running — storage state unknown",
		});
	}
	// The transcription row (PORCH-155): the consumer of the stream manager's
	// pcm lane. Composed → its own never-silent posture (enablement is off
	// by default per camera, so "off" is normal); not composed → a stated
	// unavailable row, never a silent blank.
	if (transcription && typeof transcription.status === "function") {
		const ts = transcription.status();
		const detail = ts.state === "failed"
			? (ts.reason ?? "the transcription consumer stopped")
			: `transcribing ${ts.methods.effective.rolling} — ${ts.counters.recordsWritten} record(s), cadence last window ${ts.cadence.lastWindowMs == null ? "pending" : `${Math.round(ts.cadence.lastWindowMs)}ms / ${ts.cadence.budgetMs}ms budget`}${ts.cadence.budgetOverruns > 0 ? `, ${ts.cadence.budgetOverruns} overrun(s)` : ""}`;
		services.push({ name: "transcript", healthy: ts.state !== "failed", state: ts.state === "failed" ? "failed" : "ok", detail });
	} else {
		services.push({ name: "transcript", healthy: false, state: "unavailable", detail: "the transcription consumer is not wired into this runtime — speech is not being transcribed" });
	}
	// The event-bus row (PORCH-129): the engine's transport of record. An
	// embedded broker provisioned green-field by the runtime states its URL
	// and client count; a deployment-owned broker (busUrl in the config of
	// record) states the configured endpoint — healthy, because the runtime
	// does not own that broker's lifecycle. A stopped embedded broker is a
	// real degradation: every engine service loses its event delivery.
	let busView = null;
	if (bus) {
		const state = /** @type {string} */ (bus.state ?? "unknown");
		const url = /** @type {string|null} */ (bus.url ?? null);
		const mode = /** @type {string} */ (bus.mode ?? "embedded");
		const healthy = state === "running" || (mode === "external" && Boolean(url));
		const detail = state === "running"
			? `provisioned at ${url} — ${/** @type {number} */ (bus.clients ?? 0)} engine client(s) connected`
			: mode === "external"
				? `riding the deployment's broker at ${url ?? "an unspecified busUrl"}`
				: state === "stopped"
					? "the embedded bus broker is not running — engine services cannot deliver events"
					: `the bus is in an unstated state: ${state}`;
		services.push({ name: "bus", healthy, state: healthy ? "ok" : state, detail });
		busView = { transport: bus.transport ?? "mqtt", mode, state, url, clients: bus.clients ?? 0 };
	} else {
		// No `bus` argument: this aggregate is not composed from the platform
		// runtime (tests, other callers) — no bus plane exists to state, so
		// the row is simply not rendered. The runtime ALWAYS passes this
		// plane (embedded state, or the config-of-record broker), which is
		// where the never-silent row lives.
	}
	// The Local Network posture (PORCH-152): TCP on the LAN is unaffected by
	// macOS local-network privacy, but a process without the permission
	// silently LOSES UDP — LAN discovery and camera local-P2P paths just
	// miss. The row states the truth in plain language instead of letting
	// the traffic vanish; only a stated denial degrades the page.
	const lnState = localNetwork == null
		? "unprobed"
		: (LOCAL_NETWORK_STATES.includes(localNetwork.state) ? /** @type {"allowed"|"denied"|"unknown"|"unprobed"} */ (localNetwork.state) : "unknown");
	const lnReason = localNetwork?.reason ?? null;
	const lnDetail = lnState === "denied"
		? `Local Network permission denied — LAN discovery and camera local-P2P paths (UDP) are being silently dropped; grant Porchlight the Local Network permission in System Settings.${lnReason ? ` (probe: ${lnReason})` : ""}`
		: lnState === "allowed"
			? "UDP discovery traffic leaves the process — Local Network access is granted."
			: lnReason ?? "the Local Network posture has not been stated yet";
	services.push({
		name: "local-network",
		healthy: lnState !== "denied",
		state: lnState,
		detail: lnDetail,
	});
	services.push({ name: "status-page", healthy: true, state: "ok", detail: "served" });
	const cameras = recorderState?.cameras ?? [];
	// Degradation law (TS 13): losing the transcription consumer degrades
	// TRANSCRIPTS ONLY — recording, visual detection, and every other row
	// keep the page healthy. A not-wired plane states its row plainly but
	// never drags the whole page to degraded.
	const degraded = services.some((s) => !s.healthy && s.name !== "transcript");
	return {
		status: degraded ? "degraded" : "healthy",
		version,
		generatedAt: generatedAt ?? new Date().toISOString(),
		services,
		platform: halStatus ?? { platform: process.platform, note: "platform posture unavailable" },
		recorder: recorderState ? {
			health: recorderState.health,
			cameraCount: cameras.length,
			cameraNames: cameras.map((/** @type {{name?: string}} */ c) => c.name ?? "unnamed"),
			storageRoot: recorderState.storageRoot,
			uptimeMs: recorderState.uptimeMs,
		} : null,
		storage: storage ? {
			state: storage.state ?? "unknown",
			activeLocation: storage.activeLocation ?? null,
			reason: storage.reason ?? null,
			driveHealthy: storage.driveHealthy ?? null,
			driveReason: storage.driveReason ?? null,
			paused: storage.paused ?? null,
		} : null,
		stream: streamView,
		bus: busView,
		localNetwork: {
			state: lnState,
			reason: lnReason,
			note: LOCAL_NETWORK_NOTES[lnState] ?? `the Local Network posture is stated as ${JSON.stringify(lnState)} — outside the known postures; treat as unknown`,
		},
		awaitingConfiguration: supervisor ? cameras.length === 0 : false,
	};
}

/**
 * Render the HTML status page. Deterministic given the aggregate: no
 * timestamps inside the markup (the JSON /health plane carries the check
 * time), no scripts, no external fetches, no analytics.
 * @param {ReturnType<typeof aggregateHealth>} agg
 * @returns {string}
 */
export function renderStatusHtml(agg) {
	const rows = agg.services.map((s) => {
		const marker = s.healthy ? `<span class="ok">●</span>` : `<span class="bad">●</span>`;
		return `		<tr><td>${marker} ${s.name}</td><td>${s.state}</td><td>${s.detail}</td></tr>`;
	}).join("\n");
	const recorder = agg.recorder
		? `		<p class="note">Recorder: ${agg.recorder.cameraCount} camera(s) recorded${
			agg.recorder.storageRoot ? ` to ${agg.recorder.storageRoot}` : ""}. Uptime ${Math.round(agg.recorder.uptimeMs / 1000)}s.</p>\n`
		: "";
	const storage = agg.storage
		? `		<p class="note">Storage: ${agg.storage.state}${
			agg.storage.reason ? ` — ${agg.storage.reason}`
				: agg.storage.activeLocation ? ` — recording to ${agg.storage.activeLocation}` : ""}.</p>\n`
		: "";
	const awaiting = agg.awaitingConfiguration
		? `		<p class="note">No cameras configured yet — add cameras to the config of record to start recording. The platform is running and healthy.</p>\n`
		: "";
	const posture = Object.entries(agg.platform ?? {})
		.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
		.join(" · ");
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Porchlight Home — status</title>
<style>
:root { color-scheme: light dark; }
body { font: 16px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 46rem; padding: 0 1rem; }
h1 { font-weight: 600; letter-spacing: .2px; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
td { padding: .5rem .75rem; border-top: 1px solid oklch(.7 .01 250); vertical-align: top; }
.ok { color: oklch(.7 .14 150); }
.bad { color: oklch(.6 .19 25); }
.note { color: inherit; opacity: .85; }
footer { margin-top: 2rem; font-size: .875rem; opacity: .7; }
</style>
</head>
<body>
	<h1>Porchlight Home</h1>
		<p><b>${agg.status}</b> — engine v${agg.version}</p>
${recorder}${storage}${awaiting}		<table>
		<tr><th>Service</th><th>State</th><th>Detail</th></tr>
${rows}
	</table>
	<p class="note">Platform posture: ${posture}</p>
	<footer>Local status page — served by the hub itself. No analytics, no telemetry calls.</footer>
</body>
</html>
`;
}

/**
 * @param {{ aggregate: () => ReturnType<typeof aggregateHealth>, port: number,
 *           host?: string }} opts
 */
export function createStatusServer({ aggregate, port, host = "0.0.0.0" }) {
	const server = http.createServer((req, res) => {
		const url = req.url ?? "/";
		if (url === "/health" || url === "/health/") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(aggregate()));
			return;
		}
		if (url === "/" || url.startsWith("/?") || url === "/index.html" || url === "/status") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(renderStatusHtml(aggregate()));
			return;
		}
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "not-found" }));
	});
	server.listen(port, host);
	return {
		server,
		/** @returns {Promise<void>} */
		listening: () => new Promise((resolve, reject) => {
			server.once("listening", resolve);
			server.once("error", reject);
		}),
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

import http from "node:http";
