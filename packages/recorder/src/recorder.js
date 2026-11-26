// recorder.js — the per-camera Recorder daemon (PORCH-127; storage plane PORCH-136).
//
// One daemon per camera. It is a Node child-process manager over native
// ffmpeg: ffmpeg holds ONE long-lived ingest per camera and writes fMP4
// segments (frag_keyframe + empty_moov) at <root>/<date>/<hour>/<camera>/
// <HHMMSS>.part with strftime names in UTC (TZ=UTC env); the daemon atomically
// renames settled segments to their final .mp4 name, recovers orphaned .part
// files after crashes (finalize-if-playable, else discard — never a corrupt
// file), restarts ffmpeg with capped backoff, and kills a stalled writer.
//
// Writer-layer recording modes (TS 10, ac-3): "continuous" keeps the classic
// rolling buffer layout; "event" keeps a bounded STAGING ingest at
// <root>/.staging and writes store segments only while an event window is
// open — settled staging segments covering [trigger - pre-roll, window close]
// are promoted into <root>/events (the event retention class), everything
// else is garbage-collected on schedule. A manual trigger from live view
// moves this daemon's ffmpeg to <root>/manual/<camera> — the protected tier
// no retention rule or sweep may prune.

import nodeChildProcess from "node:child_process";
import fsDefault from "node:fs";
import path from "node:path";
import { buildFfmpegArgs } from "./args.js";
import { finalizePlan, finalizeSegment, recoverSegment } from "./finalize.js";
import { listSegments, segmentDir } from "./paths.js";

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000, 60000];
const STABLE_RESET_MS = 5 * 60 * 1000;

/**
 * @typedef {Object} RecorderDaemonOptions
 * @property {import("./types.js").CameraConfig} camera
 * @property {import("./types.js").RecorderConfig} config
 * @property {() => string | null} [activeRoot] the storage location new
 *   writes target (the supervisor's StorageBackend decides: primary |
 *   failover | null-paused). Default: config.storageRoot.
 * @property {(fault: {where: string, err?: unknown}) => void} [onWriteError]
 *   write-failure reports feed the failover state machine (ac-2).
 * @property {number} [nowMs] injectable clock (tests)
 * @property {number} [pollMs]
 * @property {number} [settleMs] orphan age before probe-recovery runs
 * @property {number} [stallMs] no-new-mtime bound before a stalled writer is killed
 * @property {typeof fsDefault} [fs]
 * @property {typeof nodeChildProcess.spawn} [spawn]
 * @property {string} [logPrefix]
 * @property {(line: string) => void} [log]
 */

export class RecorderDaemon {
	/** @param {RecorderDaemonOptions} opts */
	constructor(opts) {
		const { camera, config } = opts;
		this.camera = camera;
		this.config = config;
		this.mode = /** @type {"continuous"|"event"} */ (camera.recordingMode ?? "continuous");
		this.preRollMs = (camera.preRollSeconds ?? 10) * 1000;
		this.postRollMs = (camera.postRollSeconds ?? 30) * 1000;
		this.activeRootFn = opts.activeRoot ?? (() => config.storageRoot);
		this.onWriteError = opts.onWriteError ?? null;
		this.segmentSeconds = config.segmentSeconds ?? 600;
		this.ffmpegPath = config.ffmpegPath ?? "ffmpeg";
		this.ffprobePath = config.ffprobePath ?? "ffprobe";
		this.pollMs = opts.pollMs ?? 2000;
		this.settleMs = opts.settleMs ?? 5000;
		this.stallMs = opts.stallMs ?? 60000;
		this.fs = opts.fs ?? fsDefault;
		this.spawnImpl = opts.spawn ?? nodeChildProcess.spawn.bind(nodeChildProcess);
		this.log = opts.log ?? (() => {});
		this.nowMs = opts.nowMs ?? (() => Date.now());
		this.prefix = opts.logPrefix ?? `[recorder:${camera.name}]`;

		/** @type {import("node:child_process").ChildProcess|null} */
		this.proc = null;
		this.state = "stopped";
		this.restarts = 0;
		this.startedAt = null;
		/** @type {null|{code: number|string|null, signal: string|null, at: number, stderrTail: string}} */
		this.lastExit = null;
		this.currentSegment = null;
		this.stderrTail = "";
		this.stopping = false;
		this.handle = null; // timer handle for the polling loop
		this.dirHandle = null;
		this.stableSince = null;

		// Writing-mode state (PORCH-136).
		/** @type {boolean} manual live-view trigger (protected tier). */
		this.manualActive = false;
		/** @type {null|{startedAt: number, endsAt: number}} */
		this.eventWindow = null;
		this.lastTriggerAt = null;
		/** Immediate re-spawn after a target switch (no backoff, no restart count). */
		this.respawnRequested = false;
		/** @type {string|null} tree to recover orphans from after a target switch. */
		this.respawnFrom = null;
	}

	/** The storage location this daemon currently writes into, or null when paused. */
	root() {
		return this.activeRootFn() ?? this.config.storageRoot;
	}

	/** Where ffmpeg writes relative to its cwd: the cwd + the tree kind. */
	target() {
		const root = this.root();
		if (this.manualActive) return { cwd: path.join(root, "manual"), kind: /** @type {const} */ ("manual") };
		if (this.mode === "event") return { cwd: path.join(root, ".staging"), kind: /** @type {const} */ ("staging") };
		return { cwd: root, kind: /** @type {const} */ ("continuous") };
	}

	/** The store tree the event tier promotes settled staging segments into. */
	eventsRoot() {
		return path.join(this.root(), "events");
	}

	/** @param {{where: string, err?: unknown}} fault */
	reportWriteError(fault) {
		this.log(`${this.prefix} write failure at ${fault.where}: ${fault.err instanceof Error ? fault.err.message : String(fault.err ?? "unknown")}`);
		this.onWriteError?.(fault);
	}

	start() {
		if (this.handle) throw new Error(`${this.prefix} already started`);
		this.stopping = false;
		this.ensureHourDirs();
		this.dirHandle = setInterval(() => this.ensureHourDirs(), 30000);
		this.dirHandle.unref?.();
		void this.recoverOrphans().then(() => this.spawnFfmpeg());
		this.handle = setInterval(() => this.poll(), this.pollMs);
		this.handle.unref?.();
		this.state = "starting";
		this.startedAt = this.startedAt ?? Date.now();
		return this;
	}

	/**
	 * ffmpeg's strftime resolves UTC names only under TZ=UTC; pre-create the
	 * date/hour dirs for a three-hour lookahead because ffmpeg cannot mkdir.
	 */
	ensureHourDirs() {
		const now = this.nowMs();
		const cwd = this.target().cwd;
		for (let h = 0; h < 6; h++) {
			const ts = now + h * 3600 * 1000;
			const dir = segmentDir(cwd, this.camera.name, ts);
			try {
				this.fs.mkdirSync(dir, { recursive: true });
			} catch (err) {
				// best-effort pre-create; the stall/error path recovers — but the
				// failure still reports to the failover state machine (ac-2).
				this.reportWriteError({ where: "segment dir pre-create", err });
				break;
			}
		}
	}

	async spawnFfmpeg() {
		if (this.stopping || this.proc) return;
		const target = this.target();
		try {
			this.fs.mkdirSync(target.cwd, { recursive: true });
		} catch (err) {
			this.reportWriteError({ where: "target directory create", err });
		}
		const args = buildFfmpegArgs(this.camera, { segmentSeconds: this.segmentSeconds });
		this.log(`${this.prefix} spawning ffmpeg → ${target.kind} (${target.cwd})`);
		const proc = this.spawnImpl(this.ffmpegPath, args, {
			cwd: target.cwd,
			env: { ...process.env, TZ: "UTC" },
			stdio: ["ignore", "ignore", "pipe"],
		});
		this.proc = proc;
		this.state = "recording";
		this.stableSince = Date.now();
		proc.stderr?.on("data", (chunk) => {
			this.stderrTail = (this.stderrTail + String(chunk)).slice(-8192);
		});
		proc.on("error", (err) => {
			this.log(`${this.prefix} ffmpeg spawn error: ${err.message}`);
		});
		proc.on("close", (code, signal) => {
			this.proc = null;
			const immediateTargetSwitch = this.respawnRequested;
			this.respawnRequested = false;
			const fromTree = this.respawnFrom;
			this.respawnFrom = null;
			this.currentSegment = null;
			if (!this.stopping && this.stableSince && Date.now() - this.stableSince > STABLE_RESET_MS) {
				// stable run → reset the backoff ladder
				this.restarts = Math.max(0, this.restarts - 1);
			}
			this.lastExit = {
				code,
				signal,
				at: Date.now(),
				stderrTail: this.stderrTail.slice(-1024),
			};
			this.stderrTail = "";
			this.state = this.stopping ? "stopped" : "backoff";
			this.log(`${this.prefix} ffmpeg exited code=${code} signal=${signal} crashed=${!this.stopping && Boolean(code || signal)}`);
			void this.recoverOrphans(fromTree ?? undefined).then(() => {
				if (this.stopping) return;
				// A target switch (manual trigger, failover move) re-spawns
				// without touching the backoff ladder: the exit was planned.
				if (immediateTargetSwitch) {
					void this.spawnFfmpeg();
					return;
				}
				const delay = BACKOFF_MS[Math.min(this.restarts, BACKOFF_MS.length - 1)];
				this.restarts += 1;
				this.log(`${this.prefix} restarting ffmpeg in ${delay}ms (restarts=${this.restarts})`);
				setTimeout(() => this.spawnFfmpeg(), delay).unref?.();
			});
		});
	}

	/** Poll the camera's tree: finalize settled segments, watch for stalls. */
	poll() {
		if (this.stopping) return;
		const target = this.target();
		// A vanished/failed volume must surface as a write-fault report, never
		// an uncaught interval exception — the failover machine acts on it.
		try {
			this.pollTree(target);
		} catch (err) {
			this.reportWriteError({ where: "segment store poll", err });
		}
	}

	/** @param {{cwd: string, kind: string}} target */
	pollTree(target) {
		const entries = listSegments(target.cwd, { fs: this.fs })
			.filter((e) => e.camera === this.camera.name);
		if (entries.length) {
			for (const rel of finalizePlan(entries)) {
				try {
					finalizeSegment(this.fs, path.join(target.cwd, rel));
					this.log(`${this.prefix} finalized ${target.kind} ${rel}`);
				} catch (err) {
					this.reportWriteError({ where: "segment finalize", err });
				}
			}
			const newest = entries[entries.length - 1];
			this.currentSegment = newest.relPath;
			if (newest.part && Date.now() - newest.mtimeMs > this.stallMs) {
				// stalled writer (input hung without exiting) — kill and respawn
				this.log(`${this.prefix} stalled: latest .part untouched for ${Date.now() - newest.mtimeMs}ms, killing ffmpeg`);
				this.state = "stalled";
				try {
					this.proc?.kill("SIGKILL");
				} catch { /* process already gone */ }
			}
		}
		if (this.mode === "event" && !this.manualActive) {
			// Event mode (ac-3): promote the settled staging segments the open
			// window covers, garbage-collect ones it will never need. Runs on
			// every poll; a target switch back from manual reopens nothing —
			// promotion only ever moves what the window law covers.
			this.promoteEventSegments(target.cwd);
			this.gcStaging(target.cwd);
		}
	}

	/**
	 * Event-mode trigger: (re)open the event window. Each trigger extends the
	 * post-roll; the first opens the window and starts pre-roll coverage.
	 * @returns {boolean} false when this daemon is not in event mode.
	 */
	trigger() {
		const now = this.nowMs();
		this.lastTriggerAt = now;
		if (this.mode !== "event") return false;
		if (this.eventWindow) {
			this.eventWindow.endsAt = now + this.postRollMs;
		} else {
			this.eventWindow = { startedAt: now, endsAt: now + this.postRollMs };
		}
		return true;
	}

	/**
	 * Promote settled staging segments the event window covers into
	 * <root>/events (the event retention class, stored separately from the
	 * rolling ring — two-class law). Coverage is segment-granular: the
	 * segment containing the pre-roll boundary is the earliest promoted
	 * (configured pre/post-roll honored per TS 10). The window closes once
	 * ffmpeg has moved past "endsAt" (a newer segment exists) — the final
	 * covering segment then promotes with the window.
	 * @param {string} stagingRoot
	 */
	promoteEventSegments(stagingRoot) {
		const stagingEntries = listSegments(stagingRoot, { fs: this.fs })
			.filter((e) => e.camera === this.camera.name);
		const win = this.eventWindow;
		if (!win) return;
		const now = this.nowMs();
		const lower = win.startedAt - this.preRollMs;
		const segMs = this.segmentSeconds * 1000;
		// The window closes once the segment covering "endsAt" has settled:
		// proven by any entry starting after endsAt, or — when the writer died
		// before crossing endsAt — by a two-segment grace so a window can
		// never wedge open forever.
		const hasPastEntry = stagingEntries.some((e) => e.tsMs > win.endsAt);
		const graceOver = now > win.endsAt + segMs * 2;
		const windowPast = hasPastEntry || graceOver;
		const upper = Math.min(now, win.endsAt);
		let promoted = 0;
		for (const e of stagingEntries.filter((e) => !e.part).sort((a, b) => a.tsMs - b.tsMs)) {
			if (e.tsMs > upper) break;
			// Segment fully before the pre-roll boundary never promotes.
			if (e.tsMs + segMs <= lower) continue;
			this.moveIntoEvents(e);
			promoted += 1;
		}
		if (promoted) this.log(`${this.prefix} promoted ${promoted} segment(s) to the event tier`);
		if (windowPast) {
			this.eventWindow = null;
			this.log(`${this.prefix} event window closed`);
		}
	}

	/** Move one settled staging segment into the event tier (EXDEV-safe). */
	moveIntoEvents(entry) {
		// relPath already ends in .mp4 for settled segments — join directly.
		const destPath = path.join(this.eventsRoot(), entry.relPath);
		this.fs.mkdirSync(path.dirname(destPath), { recursive: true });
		try {
			this.fs.renameSync(entry.absPath, destPath);
		} catch (err) {
			if (/** @type {any} */ (err).code !== "EXDEV") throw err;
			// Cross-device failover target: copy-then-delete keeps the move atomic-enough.
			this.fs.cpSync(entry.absPath, destPath);
			this.fs.rmSync(entry.absPath, { force: true });
		}
	}

	/** Remove settled staging segments no open window can ever cover. */
	gcStaging(stagingRoot) {
		const horizonMs = this.nowMs() - this.preRollMs - this.segmentSeconds * 1000 * 2;
		const entries = listSegments(stagingRoot, { fs: this.fs })
			.filter((e) => e.camera === this.camera.name && !e.part);
		for (const e of entries) {
			if (e.tsMs < horizonMs) {
				try {
					this.fs.unlinkSync(e.absPath);
				} catch { /* already gone */ }
			}
		}
	}

	/** Manual trigger from live view (ac-3): start a protected recording. */
	manualStart() {
		if (this.manualActive) return false;
		this.manualActive = true;
		this.applyTarget("manual trigger start");
		return true;
	}

	/** End the protected manual recording; the writer returns to its mode. */
	manualStop() {
		if (!this.manualActive) return false;
		this.manualActive = false;
		this.applyTarget("manual trigger stop");
		return true;
	}

	/**
	 * Move ffmpeg to the current target immediately (manual switch, failover
	 * migration): plan a no-backoff re-spawn, then stop the live writer.
	 */
	applyTarget() {
		if (this.stopping) return;
		this.respawnFrom = this.target().cwd;
		this.respawnRequested = true;
		if (this.proc) {
			try {
				this.proc.kill("SIGTERM");
			} catch { /* gone already */ }
		} else {
			void this.spawnFfmpeg();
		}
	}

	/**
	 * Recover orphaned .part files (crash leftovers): probe each; finalize
	 * playable, discard unrecoverable. While ffmpeg is running, only the
	 * newest part (the live writer) is spared; after exit every part is
	 * recovered.
	 * @param {string} [rootOverride] tree to recover from (target switch).
	 */
	async recoverOrphans(rootOverride) {
		const cwd = rootOverride ?? this.target().cwd;
		/** @type {{relPath: string, absPath: string, camera: string, tsMs: number, part: boolean, mtimeMs: number, size: number}[]} */
		let all;
		try {
			all = listSegments(cwd, { fs: this.fs });
		} catch (err) {
			// The tree is unreadable (failed volume) — recovery waits for the
			// storage plane to pick a writable location; never an unhandled crash.
			this.reportWriteError({ where: "orphan recovery scan", err });
			return;
		}
		const parts = all
			.filter((e) => e.camera === this.camera.name && e.part)
			.sort((a, b) => a.mtimeMs - b.mtimeMs);
		const orphans = this.proc && parts.length > 1 ? parts.slice(0, -1) : parts;
		for (const e of orphans) {
			const res = await recoverSegment(this.ffprobePath, e, {
				fs: this.fs,
				execFile: nodeChildProcess.execFile,
			});
			if (res.action === "finalized") {
				this.log(`${this.prefix} crash-recovery finalized ${e.relPath}`);
			} else {
				this.log(`${this.prefix} crash-recovery discarded unrecoverable ${e.relPath}`);
			}
		}
	}

	/** @param {number} [graceMs] */
	stop(graceMs = 10000) {
		this.stopping = true;
		clearInterval(this.handle);
		clearInterval(this.dirHandle);
		this.handle = null;
		this.dirHandle = null;
		const proc = this.proc;
		if (!proc) {
			this.state = "stopped";
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				try { proc.kill("SIGKILL"); } catch { /* gone */ }
			}, graceMs);
			timer.unref?.();
			proc.once("close", () => {
				clearTimeout(timer);
				this.state = "stopped";
				resolve();
			});
			proc.kill("SIGTERM");
		});
	}

	/** Snapshot for supervisor state file / health endpoint. */
	snapshot() {
		return {
			camera: this.camera.name,
			state: this.state,
			pid: this.proc?.pid ?? null,
			restarts: this.restarts,
			startedAt: this.startedAt,
			currentSegment: this.currentSegment,
			lastExit: this.lastExit,
			audioMode: this.camera.audioMode ?? "transcode",
			recordingMode: this.mode,
			recordingTarget: this.target().kind,
			manualActive: this.manualActive,
			eventWindow: this.eventWindow
				? { startedAt: this.eventWindow.startedAt, endsAt: this.eventWindow.endsAt }
				: null,
			lastTriggerAt: this.lastTriggerAt,
		};
	}
}
