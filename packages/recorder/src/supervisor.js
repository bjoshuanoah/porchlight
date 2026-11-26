// supervisor.js — runs every per-camera Recorder daemon (PORCH-127; storage
// plane PORCH-136).
//
// The supervisor is the headless entrypoint launchd keeps alive: one child
// ffmpeg per camera (single upstream connection per camera — consumers like
// detection ride the stream manager, never an extra camera connection), a
// 127.0.0.1 health endpoint, and a state file that renders recording state
// for the status surfaces (never a silent stall).
//
// Storage plane (PRD 10 / TS 10, ac-2/4/5): every writer routes through the
// StorageBackend — the explicit primary | degraded-write | unavailable state
// machine. A write failure on the active location switches new writes to the
// configured failover (the admin alert fires on switchover); with no
// writable location recording PAUSES with the state named. Failback to the
// primary is manual only (POST /api/storage/failback). The drive-health
// monitor feeds alerts from OS-exposed signals plus write probes, and every
// storage state lands on the engine's event bus when busUrl is configured.

import fsDefault from "node:fs";
import http from "node:http";
import { RecorderDaemon } from "./recorder.js";
import { resolveDefaults } from "./config.js";
import { pruneRolling, retentionWatchdog, pruneEventTier } from "./retention.js";
import { StorageBackend, tierUsage } from "./storage.js";
import { DETECTIONS_PATTERN, STORAGE_EVENTS_TOPIC, STORAGE_STATE_TOPIC, createMqttBus } from "./bus.mqtt.js";
import { DAY_MS, dateDirName } from "./paths.js";

const STATE_WRITE_MS = 2000;
const RETENTION_SWEEP_MS = 10 * 60 * 1000;

export class RecorderSupervisor {
	/** @param {{config: import("./types.js").RecorderConfig, log?: (line: string) => void, spawn?: typeof import("node:child_process").spawn, fs?: typeof fsDefault, pollMs?: number, bus?: import("./bus.mqtt.js").MqttBus | null}} opts */
	constructor(opts) {
		const d = resolveDefaults(opts.config);
		this.config = opts.config;
		this.d = d;
		this.storageRoot = opts.config.storageRoot;
		this.log = opts.log ?? console.log;
		this.spawn = opts.spawn;
		this.fs = opts.fs ?? fsDefault;
		this.pollMs = opts.pollMs;
		this.paused = false;
		/** @type {import("./bus.mqtt.js").MqttBus | null | undefined} */
		this.bus = opts.bus;
		this.backend = new StorageBackend({
			primary: this.storageRoot,
			failover: opts.config.failoverRoot ?? null,
			fs: this.fs,
			onEvent: (e) => {
				this.recordEvent(e);
				this.publishBusEvent(e);
			},
		});
		/** @type {RecorderDaemon[]} */
		this.daemons = [];
		this.startedAt = null;
		/** @type {import("node:http").Server|null} */
		this.httpServer = null;
		/** @type {{type: string, at: number, detail?: string}[]} */
		this.events = [];
		this.retentionHandle = null;
		this.stateHandle = null;
		this.healthHandle = null;
		this.stopping = false;
	}

	start() {
		this.fs.mkdirSync(this.storageRoot, { recursive: true });
		this.startedAt = Date.now();
		this.startDaemons();
		this.startHealth();
		this.startBus();
		this.writeState();
		this.stateHandle = setInterval(() => this.writeState(), STATE_WRITE_MS);
		this.stateHandle.unref?.();
		this.retentionHandle = setInterval(() => this.sweepRetention(), RETENTION_SWEEP_MS);
		this.retentionHandle.unref?.();
		this.healthHandle = setInterval(() => this.probeDriveHealth(), this.d.healthProbeMs);
		this.healthHandle.unref?.();
		this.log(`[supervisor] recording ${this.daemons.length} camera(s) → ${this.storageRoot}`);
		return this;
	}

	startDaemons() {
		if (this.stopping) return;
		if (!this.backend.activeLocation()) {
			// No writable location (ac-2): recording pauses with the state named.
			this.paused = true;
			this.log("[supervisor] recording paused — no writable storage location");
			return;
		}
		// A fresh start (initial boot or resume from the paused state) owns a
		// new daemon set; migrations reuse the live ones via applyTarget().
		this.daemons = [];
		this.paused = false;
		for (const camera of this.config.cameras) {
			const daemon = new RecorderDaemon({
				camera,
				config: this.config,
				activeRoot: () => this.backend.activeLocation(),
				onWriteError: (fault) => this.handleWriteFault(fault),
				spawn: this.spawn,
				fs: this.fs,
				pollMs: this.pollMs,
				log: (l) => this.log(l),
			});
			this.daemons.push(daemon);
			daemon.start();
		}
	}

	startBus() {
		if (this.bus === undefined && this.config.busUrl) {
			this.bus = createMqttBus({ url: this.config.busUrl, log: this.log });
		}
		if (this.bus) {
			this.bus.subscribe(DETECTIONS_PATTERN, (topic) => {
				const parts = topic.split("/");
				const name = parts[3];
				const daemon = name ? this.daemons.find((d) => d.camera.name === name) : null;
				if (daemon?.trigger()) {
					this.log(`[supervisor] event trigger → ${name}`);
					this.publishBusEvent({ type: "recording.event-trigger", at: Date.now(), detail: name });
				}
			});
		}
		this.publishState();
	}

	/** The machine surface of the storage plane (ac-4): active state + tier usage. */
	storageStatus() {
		const location = this.backend.activeLocation();
		return {
			...this.backend.status(),
			paused: this.paused,
			usage: location ? tierUsage(location, { fs: this.fs }) : null,
			bus: this.bus?.status?.() ?? null,
		};
	}

	handleWriteFault(fault) {
		if (this.stopping) return;
		const result = this.backend.reportWriteFailure(fault);
		this.log(`[supervisor] storage write fault (${fault.where}): ${fault.err instanceof Error ? fault.err.message : String(fault.err ?? "unknown")} → ${result.state}`);
		if (result.switched) {
			// New writes go to the failover location in a degraded-write state
			// (ac-2) — every live writer migrates without losing a beat.
			for (const daemon of this.daemons) daemon.applyTarget();
		}
		if (result.state === "unavailable") {
			this.paused = true;
			for (const daemon of this.daemons) void daemon.stop();
		}
		this.writeState();
	}

	probeDriveHealth() {
		if (this.stopping) return;
		const before = this.backend.state;
		this.backend.checkDriveHealth();
		if (before === "unavailable" && this.backend.state !== "unavailable") {
			// The paused state recovered (location writable again): recording
			// resumes on the same location — no failover flip happened.
			this.startDaemons();
			this.log("[supervisor] recording resumed — storage writable again");
		}
		this.writeState();
	}

	/** Manual failback to the primary (the only failback path, ac-2). */
	failback() {
		const result = this.backend.failback();
		if (result.ok) {
			for (const daemon of this.daemons) daemon.applyTarget();
			this.writeState();
		}
		return result;
	}

	/** @param {{name: string}} camera @returns {RecorderDaemon | null} */
	daemonFor(camera) {
		return this.daemons.find((d) => d.camera.name === camera.name) ?? null;
	}

	/** Test/fault-injection seam: swap the filesystem view behind every writer. */
	injectFs(fs) {
		this.fs = fs;
		this.backend.fs = fs;
		for (const d of this.daemons) d.fs = fs;
	}

	startHealth() {
		const server = http.createServer((req, res) => {
			void this.handleHttp(req, res).catch((err) => {
				this.log(`[supervisor] http error: ${/** @type {Error} */ (err).message}`);
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "internal error" }));
			});
		});
		server.listen(this.d.port, "127.0.0.1", () => {
			this.log(`[supervisor] health endpoint on http://127.0.0.1:${this.d.port}/health`);
		});
		server.on("error", (err) => this.log(`[supervisor] health endpoint error: ${err.message}`));
		this.httpServer = server;
	}

	/** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
	async handleHttp(req, res) {
		const url = new URL(req.url ?? "/", "http://localhost");
		const parts = url.pathname.split("/").filter(Boolean);
		const method = req.method ?? "GET";
		const json = (status, body) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		if (url.pathname === "/health" || url.pathname === "/health/") {
			if (method !== "GET") return json(405, { error: "method not allowed" });
			return json(200, this.state());
		}
		if (parts[0] === "api") {
			// Storage-plane control surface (ac-2/3/4): machine surface for the
			// admin console and the wire tests.
			if (parts[1] === "storage" && parts.length === 2) {
				if (method === "GET") return json(200, this.storageStatus());
			}
			if (parts[1] === "storage" && parts[2] === "failback" && method === "POST") {
				const result = this.failback();
				if (!result.ok) return json(409, { error: result.reason ?? "failback refused" });
				return json(200, { ok: true, storage: this.storageStatus() });
			}
			if (parts[1] === "cameras" && parts.length >= 3) {
				const camera = { name: parts[2] };
				const daemon = this.daemonFor(camera);
				if (!daemon) return json(404, { error: `unknown camera "${camera.name}"` });
				if (this.paused || !this.backend.activeLocation()) {
					return json(409, { error: "recording is paused — no writable storage location" });
				}
				if (parts[3] === "record" && method === "POST") {
					if (parts[4] === "start") {
						return daemon.manualStart()
							? json(200, { ok: true, camera: daemon.camera.name, manualActive: true })
							: json(409, { error: "manual recording is already active on this camera" });
					}
					if (parts[4] === "stop") {
						return daemon.manualStop()
							? json(200, { ok: true, camera: daemon.camera.name, manualActive: false })
							: json(409, { error: "no manual recording is active on this camera" });
					}
				}
				if (parts[3] === "trigger" && method === "POST") {
					return daemon.trigger()
						? json(200, { ok: true, camera: daemon.camera.name, eventWindow: daemon.eventWindow })
						: json(409, { error: "this camera records continuously — events do not gate segment writes" });
				}
			}
		}
		return json(404, { error: "not-found" });
	}

	recordEvent(e) {
		this.events.push({ type: e.type, at: e.at ?? Date.now(), detail: e.detail });
		this.events = this.events.slice(-200);
	}

	publishBusEvent(e) {
		if (!this.bus?.publish) return;
		this.bus.publish(STORAGE_EVENTS_TOPIC, { ...e, storageState: this.backend.state });
	}

	publishState() {
		if (!this.bus?.publish) return;
		this.bus.publish(STORAGE_STATE_TOPIC, { storage: this.backend.status(), paused: this.paused }, { retain: true });
	}

	sweepRetention() {
		try {
			const root = this.backend.activeLocation() ?? this.storageRoot;
			pruneRolling({
				root,
				retentionDays: this.d.retentionDays,
				nowMs: Date.now(),
				coldRoot: this.config.coldRoot ?? null,
				fs: this.fs,
				onEvent: (e) => {
					this.recordEvent(e);
					this.log(`[supervisor] retention: pruned ${e.dates.join(", ")}`);
				},
			});
			pruneEventTier({
				root,
				eventRetentionDays: this.d.eventRetentionDays,
				retentionRules: this.config.retentionRules ?? [],
				nowMs: Date.now(),
				fs: this.fs,
				onEvent: (e) => {
					this.recordEvent(e);
					this.log(`[supervisor] event tier: pruned ${e.dates.join(", ")}`);
				},
			});
			const wd = retentionWatchdog({
				root,
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
			health: this.paused || this.backend.state === "degraded-write" || !this.backend.driveHealthy || this.daemons.some((dmn) => dmn.state !== "recording") ? "degraded" : "ok",
			stopping: this.stopping,
			storage: {
				state: this.backend.state,
				activeLocation: this.backend.activeLocation(),
				primary: this.backend.primary,
				failover: this.backend.failover,
				reason: this.backend.reason,
				driveHealthy: this.backend.driveHealthy,
				driveReason: this.backend.driveReason,
				paused: this.paused,
			},
			cameras: this.daemons.map((dmn) => dmn.snapshot()),
			events: this.events.slice(-20),
		};
	}

	writeState() {
		// While degraded-write the store's own location is unwritable — the
		// state file follows the active location so the status plane survives
		// the switchover (default layout only; an explicit statePath is kept).
		let statePath = this.d.statePath;
		if (this.backend.state !== "primary" && this.d.statePath === `${this.storageRoot}/recorder-state.json` && this.backend.activeLocation()) {
			statePath = `${this.backend.activeLocation()}/recorder-state.json`;
		}
		try {
			this.fs.writeFileSync(statePath, JSON.stringify(this.state(), null, 2));
			this.publishState();
		} catch (err) {
			this.log(`[supervisor] state write failed: ${/** @type {Error} */ (err).message}`);
			if (this.startedAt && !this.stopping) {
				// The state file lives beside the store: its failure IS a
				// storage write fault (ac-2) — never a silent stall.
				this.backend.reportWriteFailure({ where: "supervisor state file", err });
			}
		}
	}

	dayDirForCleanup() {
		return dateDirName(Date.now() - this.d.retentionDays * DAY_MS);
	}

	async stop() {
		this.stopping = true;
		clearInterval(this.stateHandle);
		clearInterval(this.retentionHandle);
		clearInterval(this.healthHandle);
		await Promise.all(this.daemons.map((dmn) => dmn.stop()));
		await new Promise((resolve) => this.httpServer?.close(() => resolve()));
		this.httpServer = null;
		await this.bus?.close?.();
		this.bus = null;
		this.writeState();
	}
}
