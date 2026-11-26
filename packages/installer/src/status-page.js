// status-page.js — the health status surface (PORCH-134 ac-1).
//
// One deterministic page: what services exist, whether each is healthy,
// and what the host platform provides — stated, never advertised
// (never-silent law). Zero analytics, zero scripts, nothing loaded from
// the network; earned states render in plain language ("no cameras
// configured yet" is a stated state, not a silent empty dashboard).

/** @typedef {{name: string, healthy: boolean, state: string, detail: string}} ServiceHealth */

/**
 * @param {{
 *   supervisor?: import("@porchlight/recorder").RecorderSupervisor | null,
 *   version?: string,
 *   halStatus?: Record<string, unknown>,
 *   generatedAt?: string,
 * }} opts
 */
export function aggregateHealth({ supervisor = null, version = "unknown", halStatus = null, generatedAt } = {}) {
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
	services.push({ name: "status-page", healthy: true, state: "ok", detail: "served" });
	const cameras = recorderState?.cameras ?? [];
	const degraded = services.some((s) => !s.healthy);
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
${recorder}${awaiting}		<table>
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
