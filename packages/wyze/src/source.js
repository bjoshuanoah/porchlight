// source.js — the stream-manager factory of the Wyze adapter (PORCH-131).
//
// The adapter rides @porchlight/stream's one-factory seam: StreamManager
// opts.factory is asked per camera for its upstream demuxer. For a
// wyze:// camera the answer is a WyzePumpHandle: ONE upstream connection
// (the session), decoded into the manager's four lanes of record by ONE
// ffmpeg child fed over pipes (the camera's H.264 and PCM ride pipes 6/7
// as inputs; the manager's expected stdio layout 1/3/4/5 carries the
// mpegts copy lane, rgb, jpeg, and pcm out — the same byte destinations
// buildStreamArgs uses for url cameras). Camera drops re-open through
// CameraSource's backoff ladder: the handle closes on session failure and
// the manager re-asks the factory (bounded reconnect storm per AC-1).
//
// ffmpeg is spawned only after the negotiated stream proves it can deliver
// frames (and once the audio rate is known) — lane wiring never represents
// a stream the camera has not actually confirmed (never-silent law).

import nodeChildProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { spawnFactory as defaultSpawnFactory, PCM_SAMPLE_RATE } from "@porchlight/stream";
import { createHal } from "@porchlight/hal";
import { WyzeCameraSession, parseWyzeUrl } from "./session.js";
import { CHANNEL } from "./frame.js";

/** The pump ffmpeg's stdio by FD: manager lanes on 0..5 (the manager reads
 *  fd 3/4/5 as the rgb/jpeg/pcm lanes exactly like STREAM_STDIO) plus the
 *  camera lanes as inputs on fd 6 (video) and 7 (audio). */
export const PUMP_STDIO = Object.freeze([
	"ignore", // 0
	"pipe", // 1  mpegts copy lane → relay / recorder
	"pipe", // 2  stderr
	"pipe", // 3  rgb24 → in-process consumers
	"pipe", // 4  mjpeg → live grid
	"pipe", // 5  f32le 16 kHz PCM → audio consumers
	"pipe", // 6  H.264/H.265 AnnexB input (camera video)
	"pipe", // 7  s16le PCM input (camera audio)
]);

/**
 * The pump's ffmpeg argv: HAL decode choices before the pipe inputs, the
 * four-lane block after them (audio transcoded to AAC/16 kHz once at the
 * single upstream — the manager lane contract).
 * @param {{ audio: boolean, audioRate: number }} known negotiated stream facts
 * @param {{ rgbFps: number, jpegFps: number }} cfg
 * @param {ReturnType<typeof import("@porchlight/hal").createHal>} [hal]
 * @returns {string[]}
 */
export function buildPumpArgs({ audio, audioRate }, cfg, hal = createHal()) {
	const argv = [
		"-hide_banner", "-loglevel", "warning", "-nostdin",
		"-f", "h264",
		...hal.videoDecodeArgs(),
		"-fflags", "+genpts",
		"-i", "pipe:6",
	];
	if (audio) {
		argv.push("-f", "s16le", "-ar", String(audioRate), "-ac", "1", "-i", "pipe:7");
	}
	argv.push(
		"-map", "0:v:0", "-c:v", "copy", "-bsf:v", "dump_extra",
		"-map", "0:a:0?", "-c:a", "aac", "-ar", String(PCM_SAMPLE_RATE), "-b:a", "96k",
		"-f", "mpegts", "pipe:1",
		"-map", "0:v:0", "-r", String(cfg.rgbFps), "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:3",
		"-map", "0:v:0", "-r", String(cfg.jpegFps), "-q:v", "5", "-f", "mjpeg", "pipe:4",
	);
	if (audio) {
		argv.push("-map", "0:a:0?", "-f", "f32le", "-ac", "1", "-ar", String(PCM_SAMPLE_RATE), "pipe:5");
	}
	return argv;
}

/** Type predicate for the factory seam. */
export function isWyzeCamera(camera) {
	return typeof camera?.source?.url === "string" && camera.source.url.startsWith("wyze://");
}

/**
 * WyzePumpHandle — the StreamHandle the manager consumes for one wyze://
 * camera. The manager treats it like a child process (stdout + stdio lanes
 * by fd number + close/error events + kill); internally it owns the Wyze
 * session and the ffmpeg pump child.
 */
export class WyzePumpHandle {
	/** @type {Set<(...a: any[]) => void>} */
	#errorListeners = new Set();
	/** @type {Set<(...a: any[]) => void>} */
	#closeListeners = new Set();
	#child = null;
	#session = null;
	#closed = false;
	#frameBudget = null;
	#ready = null;
	/** @type {{ rate: number, buffered: Buffer[] } | null} */
	#audioPending = null;
	#firstVideo = false;

	constructor({ camera, cfg, hal = createHal(), spawn = nodeChildProcess.spawn.bind(nodeChildProcess), log = () => {}, nowMs = () => Date.now(), random = undefined }) {
		const info = parseWyzeUrl(camera.source.url);
		const prefix = `[wyze:${info.model}]`;
		this.log = (l) => log(`${prefix} ${l}`);
		/** The manager's lane contract: stdout = mpegts copy; stdio[3]/[4]/[5]
		 *  = rgb24/jpeg/f32le PCM, exactly a ChildProcess's fd numbering. */
		this.stdout = new PassThrough({ highWaterMark: 512 * 1024 });
		this.stderr = new PassThrough();
		this.stdio = [
			null, // fd 0 unused
			this.stdout, // fd 1
			this.stderr, // fd 2
			new PassThrough({ highWaterMark: 1024 * 1024 }), // fd 3 rgb24
			new PassThrough({ highWaterMark: 512 * 1024 }), // fd 4 mjpeg
			new PassThrough({ highWaterMark: 512 * 1024 }), // fd 5 pcm
			new PassThrough(), // fd 6 video into ffmpeg
			new PassThrough(), // fd 7 audio into ffmpeg
		];
		this.cameraArgs = { rgbFps: cfg.rgbFps, jpegFps: cfg.jpegFps };
		this.hal = hal;
		this.spawnImpl = spawn;
		this.session = new WyzeCameraSession({ url: camera.source.url, log: this.log, nowMs, random });
		this.#session = this.session;
		this.session.on("state", (e) => this.log(`${e.state}${e.reason ? `: ${e.reason}` : ""}`));
		this.session.on("ready", (caps) => {
			this.#ready = { ...caps };
			this.#frameBudget = setTimeout(() => {
				if (!this.#firstVideo && !this.#closed) {
					this.#teardown("the camera negotiated its stream but produced no video within ten seconds");
				}
			}, 10_000);
			this.#frameBudget.unref?.();
		});
		this.session.on("frame", (frame) => this.#onFrame(frame));
		this.session.on("error", (err) => {
			if (!this.#closed) this.#teardown(err.message);
		});
		this.session.on("close", () => {
			if (!this.#closed) this.#teardown("the camera session closed");
		});
		this.session.connect().catch((err) => {
			this.#teardown(err instanceof Error ? err.message : String(err));
		});
	}

	/** Manager-facing event surface (ChildProcess-compatible). */
	on(event, fn) {
		if (event === "error") this.#errorListeners.add(fn);
		else if (event === "close") this.#closeListeners.add(fn);
		return this;
	}

	kill(signal) {
		this.#teardown("the manager closed the source", signal ?? "SIGTERM");
		return true;
	}

	#emit(kind, ...args) {
		const listeners = kind === "error" ? this.#errorListeners : this.#closeListeners;
		for (const fn of [...listeners]) {
			try {
				fn(...args);
			} catch (err) {
				this.log(`event handler failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	#onFrame(frame) {
		if (this.#closed) return;
		if (frame.channel === CHANNEL.AUDIO) {
			if (!this.#child) {
				const pending = (this.#audioPending ??= { rate: frame.sampleRate ?? PCM_SAMPLE_RATE, buffered: [] });
				if (frame.sampleRate) pending.rate = frame.sampleRate;
				pending.buffered.push(frame.data);
				return;
			}
			this.#flushPendingAudio();
			this.stdio[7].write(frame.data);
			return;
		}
		if (this.#firstVideo) {
			this.stdio[6].write(frame.data);
			return;
		}
		// First video frame: the stream is proven; open the lanes now.
		this.#firstVideo = true;
		if (this.#frameBudget) {
			clearTimeout(this.#frameBudget);
			this.#frameBudget = null;
		}
		const audioKnown = this.#audioPending?.rate ?? (this.#ready?.hasAudio ? 16000 : null);
		this.#spawnPump({ audio: !!audioKnown, audioRate: audioKnown ?? PCM_SAMPLE_RATE });
		this.stdio[6].write(frame.data);
		this.#flushPendingAudio();
	}

	#flushPendingAudio() {
		if (!this.#audioPending) return;
		for (const buf of this.#audioPending.buffered) this.stdio[7].write(buf);
		this.#audioPending = null;
	}

	#spawnPump(known) {
		const child = this.spawnImpl("ffmpeg", buildPumpArgs(known, this.cameraArgs, this.hal), {
			stdio: PUMP_STDIO.slice(),
			env: { ...process.env },
		});
		this.#child = child;
		child.stdout?.on("data", (c) => this.stdout.write(c));
		child.stderr?.on("data", (c) => this.stderr.write(c));
		child.stdio?.[3]?.on("data", (c) => this.stdio[3].write(c));
		child.stdio?.[4]?.on("data", (c) => this.stdio[4].write(c));
		child.stdio?.[5]?.on("data", (c) => this.stdio[5].write(c));
		if (child.stdio?.[6]) this.stdio[6].pipe(child.stdio[6]);
		if (child.stdio?.[7]) this.stdio[7].pipe(child.stdio[7]);
		child.on("close", (code, sig) => {
			this.#child = null;
			if (this.#closed) return;
			this.#teardown(`the lane decoder exited (code ${code} signal ${sig})`);
		});
		child.on("error", (err) => {
			if (this.#closed) return;
			this.#teardown(`the lane decoder failed to start: ${err.message}`);
		});
	}

	#teardown(reason, signal = "SIGTERM") {
		if (this.#closed) return;
		this.#closed = true;
		const child = this.#child;
		if (child) {
			this.#child = null;
			try {
				child.kill(signal);
			} catch { /* already gone */ }
		}
		this.stdio[6]?.destroy();
		this.stdio[7]?.destroy();
		this.stdout.end();
		this.stderr.end();
		this.stdio[3]?.end();
		this.stdio[4]?.end();
		this.stdio[5]?.end();
		if (this.#frameBudget) {
			clearTimeout(this.#frameBudget);
			this.#frameBudget = null;
		}
		const session = this.#session;
		this.#session = null;
		try {
			session?.close();
		} catch { /* already closed */ }
		this.log(`source stopped: ${reason}`);
		this.#emit("close", reason);
	}
}

/**
 * createWyzeStreamFactory — inject into StreamManager opts.factory. wyze://
 * cameras ride the adapter; every other camera falls through to the
 * stream package's default spawnFactory (rtsp/synthetic unchanged).
 * @param {{ log?: (line: string) => void, spawn?: typeof nodeChildProcess.spawn, hal?: ReturnType<typeof import("@porchlight/hal").createHal>, nowMs?: () => number, random?: (n: number) => Buffer }} [opts]
 * @returns {(camera: any, cfg: { rgbFps: number, jpegFps: number }) => any}
 */
export function createWyzeStreamFactory({ log = () => {}, spawn, hal, nowMs, random } = {}) {
	const spawnImpl = nodeChildProcess.spawn.bind(nodeChildProcess);
	const spawnFn = spawn ?? spawnImpl;
	return (camera, cfg) => {
		if (isWyzeCamera(camera)) {
			return new WyzePumpHandle({ camera, cfg, hal, spawn: spawnFn, log, nowMs, random });
		}
		return defaultSpawnFactory(camera, cfg, hal ?? createHal(), spawnFn);
	};
}
