// supervisor.js — runs every per-camera Recorder daemon (PORCH-127).
//
// The supervisor is the headless entrypoint launchd keeps alive: one child
// ffmpeg per camera (single upstream connection per camera — consumers like
// detection ride the stream manager, never an extra camera connection), a
// 127.0.0.1 health endpoint, and a state file that renders recording state
// for the status surfaces (never a silent stall).

import fsDefault from "node:fs";
import http from "node:http";
import { RecorderDaemon } from "./recorder.js";
import { resolveDefaults } from "./config.js";
import { pruneRolling, retentionWatchdog } from "./retention.js";
import { DAY_MS, dateDirName } from "./paths.js";

const STATE_WRITE_MS = 2000;
const RETENTION_SWEEP_MS = 10 * 60 * 1000;

export class RecorderSupervisor {
	/** @param {{config: import("./types.js").RecorderConfig, log?: (line: string) => void, spawn?: typeof import("node:child_process").spawn, fs?: typeof fsDefault, pollMs?: number}} opts */
	constructor(opts) {
		const d = resolveDefaults(opts.config);
		this.config = opts.config;
		this.d = d;
		this.storageRoot = opts.config.storageRoot;
		this.log = opts.log ?? console.log;
		this.spawn = opts.spawn;
		this.fs = opts.fs ?? fsDefault;
		this.pollMs = opts.pollMs;
		/** @type {RecorderDaemon[]} */
		this.daemons = [];
		this.startedAt = null;
		/** @type {import("node:http").Server|null} */
		this.httpServer = null;
		/** @type {{type: string, at: number, detail?: string}[]} */
		this.events = [];
		this.retentionHandle = null;
		this.stateHandle = null;
		this.stopping = false;
	}

	start() {
		this.fs.mkdirSync(this.storageRoot, { recursive: true });
		this.startedAt = Date.now();
		for (const camera of this.config.cameras) {
			const daemon = new RecorderDaemon({
				camera,
				config: this.config,
				spawn: this.spawn,
				fs: this.fs,
				pollMs: this.pollMs,
				log: (l) => this.log(l),
			});
			this.daemons.push(daemon);
			daemon.start();
		}
		this.startHealth();
		this.writeState();
		this.stateHandle = setInterval(() => this.writeState(), STATE_WRITE_MS);
		this.stateHandle.unref?.();
		this.retentionHandle = setInterval(() => this.sweepRetention(), RETENTION_SWEEP_MS);
		this.retentionHandle.unref?.();
		this.log(`[supervisor] recording ${this.daemons.length} camera(s) → ${this.storageRoot}`);
		return this;
	}

	startHealth() {
		const server = http.createServer((req, res) => {
			if (req.url === "/health" || req.url === "/health/") {
				const body = JSON.stringify(this.state());
				res.writeHead(200, { "content-type": "application/json" });
				res.end(body);
				return;
			}
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "not-found" }));
		});
		server.listen(this.d.port, "127.0.0.1", () => {
			this.log(`[supervisor] health endpoint on http://127.0.0.1:${this.d.port}/health`);
		});
		server.on("error", (err) => this.log(`[supervisor] health endpoint error: ${err.message}`));
		this.httpServer = server;
	}

	recordEvent(e) {
		this.events.push({ type: e.type, at: Date.now(), detail: e.detail });
		this.events = this.events.slice(-200);
	}

	sweepRetention() {
		try {
			pruneRolling({
				root: this.storageRoot,
				retentionDays: this.d.retentionDays,
				nowMs: Date.now(),
				coldRoot: this.config.coldRoot ?? null,
				fs: this.fs,
				onEvent: (e) => {
					this.recordEvent(e);
					this.log(`[supervisor] retention: pruned ${e.dates.join(", ")}`);
				},
			});
			const wd = retentionWatchdog({
				root: this.storageRoot,
				retentionDays: this.d.retentionDays,
				nowMs: Date.now(),
				highWaterFraction: this.d.highWaterFraction,
				fs: this.fs,
				onEvent: (e) => {
					this.recordEvent(e);
					this.log(`[supervisor] ${e.type}: ${e.detail ?? ""}`);
				},
			});
			if (wd?.alerted) this.writeState();
		} catch (err) {
			this.recordEvent({ type: "retention.error", detail: String(err) });
			this.log(`[supervisor] retention sweep failed: ${/** @type {Error} */ (err).message}`);
		}
	}

	state() {
		return {
			service: "porchlight-recorder",
			pid: process.pid,
			startedAt: this.startedAt,
			uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
			storageRoot: this.storageRoot,
			segmentSeconds: this.d.segmentSeconds,
			retentionDays: this.d.retentionDays,
			health: this.daemons.every((dmn) => dmn.state === "recording") ? "ok" : "degraded",
			stopping: this.stopping,
			cameras: this.daemons.map((dmn) => dmn.snapshot()),
			events: this.events.slice(-20),
		};
	}

	writeState() {
		try {
			this.fs.writeFileSync(this.d.statePath, JSON.stringify(this.state(), null, 2));
		} catch (err) {
			this.log(`[supervisor] state write failed: ${/** @type {Error} */ (err).message}`);
		}
	}

	dayDirForCleanup() {
		return dateDirName(Date.now() - this.d.retentionDays * DAY_MS);
	}

	async stop() {
		this.stopping = true;
		clearInterval(this.stateHandle);
		clearInterval(this.retentionHandle);
		await Promise.all(this.daemons.map((dmn) => dmn.stop()));
		await new Promise((resolve) => this.httpServer?.close(() => resolve()));
		this.httpServer = null;
		this.writeState();
	}
}
