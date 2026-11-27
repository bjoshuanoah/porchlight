// supervisor.js — runs every per-camera Recorder daemon (PORCH-127; storage
// plane PORCH-136).
//
// The supervisor is the headless entrypoint launchd keeps alive: one child
// ffmpeg per camera consuming the stream manager's localhost relay (PORCH-154
// single-upstream law — the recorder never opens a camera connection either),
// a 127.0.0.1 health endpoint, and a state file that renders recording state
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
import { validateConfig, resolveDefaults } from "./config.js";
import { relayInputFor } from "./args.js";
import { pruneRolling, retentionWatchdog, pruneEventTier } from "./retention.js";
import { StorageBackend, tierUsage } from "./storage.js";
import { DETECTIONS_PATTERN, STORAGE_EVENTS_TOPIC, STORAGE_STATE_TOPIC, createMqttBus } from "./bus.mqtt.js";
import { DAY_MS, dateDirName } from "./paths.js";

const STATE_WRITE_MS = 2000;
const RETENTION_SWEEP_MS = 10 * 60 * 1000;
/** Camera-set bodies are tiny; anything beyond this bound is refused upfront. */
const BODY_CHUNK_LIMIT = 128;

/** Read and parse a JSON request body; null on malformed JSON or oversize. */
async function readJsonBody(req) {
	const chunks = [];
	for await (const chunk of req) {
		chunks.push(/** @type {Buffer} */ (chunk));
		if (chunks.length > BODY_CHUNK_LIMIT) return null;
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return null;
	}
}

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
		// The retention index cascade (PORCH-155; TS 13): an injected sink the
		// retention sweep drops transcript text + vector payloads into IN THE
		// SAME PASS as the segment deletion. Absent = no cascade (the plane is
		// not wired); the composition root owns that wiring.
		this.retentionCascade = opts.retentionCascade ?? null;
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

	/** One daemon per camera — shared factory for boot and the live apply path (PORCH-152). */
	#makeDaemon(camera) {
		return new RecorderDaemon({
			camera,
			config: this.config,
			activeRoot: () => this.backend.activeLocation(),
			onWriteError: (fault) => this.handleWriteFault(fault),
			spawn: this.spawn,
			fs: this.fs,
			pollMs: this.pollMs,
			log: (l) => this.log(l),
		});
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
			const daemon = this.#makeDaemon(camera);
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

	/** The camera fields that define a writer — any change forces a rebuild. */
	#defineDiffers(a, b) {
		return (
			JSON.stringify(a.source ?? null) !== JSON.stringify(b.source ?? null) ||
			(a.recordingMode ?? "continuous") !== (b.recordingMode ?? "continuous") ||
			(a.audioMode ?? "transcode") !== (b.audioMode ?? "transcode") ||
			(a.preRollSeconds ?? 10) !== (b.preRollSeconds ?? 10) ||
			(a.postRollSeconds ?? 30) !== (b.postRollSeconds ?? 30)
		);
	}

	/** Drop a daemon from the fleet after a stop (the diff path's bookkeeping). */
	#dropDaemon(daemon) {
		this.daemons = this.daemons.filter((d) => d !== daemon);
	}

	/**
	 * Live camera-set application (PORCH-152, ac-4): the health plane's
	 * POST /api/cameras/apply path. Validation of the FULL next config runs
	 * first — a bad camera never half-applies — then the camera set diffs
	 * by name against the running fleet: added daemons start (same factory
	 * as boot), removed ones stop and drop, mutated ones (source or the
	 * recording-mode/window fields) stop and rebuild. Only the camera set
	 * plus busUrl rewire live; the other config fields ride along in this
	 * config of record but their boot-time wiring (e.g. the storage plane)
	 * stays as-is until the next restart — never a silent claim otherwise.
	 * @param {import("./types.js").RecorderConfig} nextConfig
	 * @returns {Promise<{ok: true, started: string[], stopped: string[], kept: string[], paused?: boolean}>}
	 */
	async applyConfig(nextConfig) {
		validateConfig(nextConfig);
		const nextByName = new Map(nextConfig.cameras.map((c) => [c.name, c]));
		const curByName = new Map(this.config.cameras.map((c) => [c.name, c]));
		const started = [];
		const stopped = [];
		// Removed cameras: stop the writer before the fleet drops it.
		for (const [name, camera] of curByName) {
			if (nextByName.has(name)) continue;
			stopped.push(name);
			const daemon = this.daemonFor(camera);
			if (daemon) {
				await daemon.stop();
				this.#dropDaemon(daemon);
			}
		}
		// Mutated cameras: the writer's arguments changed under a live name.
		for (const [name, nextCamera] of nextByName) {
			const current = curByName.get(name);
			if (!current) continue;
			// The writer's ffmpeg input is the stream manager's relay URL
			// (single-upstream law, PORCH-154): a live fleet shift that moves a
			// kept camera's relay port (sorted-fleet position) is a writer
			// change too, or the kept writer would read a listener the manager
			// moved.
			if (
				!this.#defineDiffers(current, nextCamera) &&
				relayInputFor(this.config, name) === relayInputFor(nextConfig, name)
			) {
				continue;
			}
			stopped.push(name);
			const daemon = this.daemonFor(current);
			if (daemon) {
				await daemon.stop();
				this.#dropDaemon(daemon);
			}
		}
		const busChanged = (nextConfig.busUrl ?? null) !== (this.config.busUrl ?? null);
		this.config = nextConfig;
		if (busChanged) {
			// The old endpoint dies with its subscriptions; startBus() rebuilds
			// from the new busUrl (or leaves the bus detached when unset).
			const old = this.bus;
			this.bus = undefined;
			await old?.close?.();
			this.startBus();
		}
		const paused = this.paused;
		if (!paused && !this.stopping) {
			for (const [name, camera] of nextByName) {
				if (this.daemonFor(camera)) continue;
				const daemon = this.#makeDaemon(camera);
				this.daemons.push(daemon);
				daemon.start();
				started.push(name);
			}
		}
		this.writeState();
		// While paused (no writable storage location, ac-2) the config of
		// record still swaps; daemons start only when storage resumes
		// (probeDriveHealth → startDaemons) — never a silent half-apply.
		return paused
			? { ok: true, started: [], stopped, kept: [], paused: true }
			: {
					ok: true,
					started,
					stopped,
					kept: [...nextByName.keys()].filter((name) => !started.includes(name) && !stopped.includes(name)),
				};
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
			if (parts[1] === "cameras" && parts[2] === "apply" && method === "POST") {
				// Live camera-set application (PORCH-152 ac-4): the engine's
				// config plane and the setup wizard push new camera sets here —
				// loopback bind, same plane as record/trigger. Validation
				// failures refuse plain-language with 422, never silence.
				const body = await readJsonBody(req);
				if (!body || !Array.isArray(body.cameras)) {
					return json(422, { error: "expected a JSON body with a cameras array of camera objects" });
				}
				try {
					const result = await this.applyConfig({ ...this.config, cameras: body.cameras });
					return json(200, result);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					this.log(`[supervisor] camera apply refused: ${message}`);
					return json(422, { error: message });
				}
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
		return (async () => {
			try {
				const root = this.backend.activeLocation() ?? this.storageRoot;
				const rolling = pruneRolling({
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
				// The index cascade (PORCH-155): DELETED rolling dates drop their
				// transcript text + vector payloads in the SAME pass — never a
				// later cleanup hope. Cold-moved dates keep theirs (the footage
				// still exists; the cascade follows deletion).
				let cascadeRolling = null;
				if (this.retentionCascade && rolling.removed.length > 0) {
					cascadeRolling = await this.retentionCascade.dropRollingDates(rolling.removed);
				}
				const events = pruneEventTier({
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
				let cascadeEvents = null;
				if (this.retentionCascade && events.removed.length > 0) {
					cascadeEvents = await this.retentionCascade.dropEventDates(events.removed);
				}
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
				return { rolling, events, cascadeRolling, cascadeEvents };
			} catch (err) {
				this.recordEvent({ type: "retention.error", detail: String(err) });
				this.log(`[supervisor] retention sweep failed: ${/** @type {Error} */ (err).message}`);
				return null;
			}
		})();
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
		if (this.httpServer) {
			// A null server means stop() already ran — resolve immediately so a
			// retry path never stalls (the promise only resolves on the close
			// callback, which never fires for an already-closed server).
			await new Promise((resolve) => this.httpServer.close(() => resolve()));
		}
		this.httpServer = null;
		await this.bus?.close?.();
		this.bus = null;
		this.writeState();
	}
}
