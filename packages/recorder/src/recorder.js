// recorder.js — the per-camera Recorder daemon (PORCH-127).
//
// One daemon per camera. It is a Node child-process manager over native
// ffmpeg: ffmpeg holds ONE long-lived ingest per camera and writes fMP4
// segments (frag_keyframe + empty_moov) at <root>/<date>/<hour>/<camera>/
// <HHMMSS>.part with strftime names in UTC (TZ=UTC env); the daemon atomically
// renames settled segments to their final .mp4 name, recovers orphaned .part
// files after crashes (finalize-if-playable, else discard — never a corrupt
// file), restarts ffmpeg with capped backoff, and kills a stalled writer.

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
		this.storageRoot = config.storageRoot;
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
		for (let h = 0; h < 6; h++) {
			const ts = now + h * 3600 * 1000;
			const dir = segmentDir(this.storageRoot, this.camera.name, ts);
			try {
				this.fs.mkdirSync(dir, { recursive: true });
			} catch {
				// best-effort pre-create; the stall/error path recovers.
			}
		}
	}

	async spawnFfmpeg() {
		if (this.stopping || this.proc) return;
		const args = buildFfmpegArgs(this.camera, { segmentSeconds: this.segmentSeconds });
		this.log(`${this.prefix} spawning ffmpeg`);
		const proc = this.spawnImpl(this.ffmpegPath, args, {
			cwd: this.storageRoot,
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
			const crashed = !this.stopping && Boolean(code || signal);
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
			this.log(`${this.prefix} ffmpeg exited code=${code} signal=${signal} crashed=${crashed}`);
			void this.recoverOrphans().then(() => {
				if (this.stopping) return;
				const delay = BACKOFF_MS[Math.min(this.restarts, BACKOFF_MS.length - 1)];
				this.restarts += 1;
				this.log(`${this.prefix} restarting ffmpeg in ${delay}ms (restarts=${this.restarts})`);
				setTimeout(() => this.spawnFfmpeg(), delay).unref?.();
			});
		});
	}

	/** Poll the camera's store: finalize settled segments, watch for stalls. */
	poll() {
		if (this.stopping) return;
		const entries = listSegments(this.storageRoot, { fs: this.fs })
			.filter((e) => e.camera === this.camera.name);
		if (entries.length) {
			for (const rel of finalizePlan(entries)) {
				finalizeSegment(this.fs, path.join(this.storageRoot, rel));
				this.log(`${this.prefix} finalized ${rel}`);
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
	}

	/**
	 * Recover orphaned .part files (crash leftovers): probe each; finalize
	 * playable, discard unrecoverable. While ffmpeg is running, only the
	 * newest part (the live writer) is spared; after exit every part is
	 * recovered.
	 */
	async recoverOrphans() {
		const parts = listSegments(this.storageRoot, { fs: this.fs })
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
		};
	}
}
