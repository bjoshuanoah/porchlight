// source.js — the per-camera upstream source (PORCH-154).
//
// One demux handle per camera — camera law: EXACTLY ONE upstream connection,
// consumers never open camera connections directly. In production the handle
// is one long-lived ffmpeg child (stdio layout of record in args.js): the
// mpegts copy lane on fd 1 gets fanned to the relay by the manager, the
// decoded lanes (rgb24 fd 3, mjpeg fd 4, f32le PCM fd 5) are parsed here and
// routed to in-process subscribers. The source owns the reconnect ladder:
// capped backoff with the 5-stable-minute reset — recorder.js semantics —
// so a camera drop comes back WITHOUT manual action, and every transition
// surfaces as a health state with a plain-language reason (never silent).
//
// source.url visibility law: this is packages/stream — the only plane allowed
// to read source.url. A URL camera without registered dimensions refuses to
// open (state "down" naming the missing dims; no upstream open, no retry
// churn — applyFleet's mutation path is the reopen).

import nodeChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { createHal } from "@porchlight/hal";
import { buildStreamArgs, resolveStreamDimensions, STREAM_STDIO } from "./args.js";

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000, 60000];
const STABLE_RESET_MS = 5 * 60 * 1000;

/** JPEG markers: SOI starts a frame, EI closes it. In entropy-coded JPEG
 *  data a 0xFF byte is only ever followed by 0x00 stuffing or RST markers,
 *  so 0xFFD9 cannot occur inside a scan — byte-scanning EOI is exact. */
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
/** Safety bound for a jpeg accumulator that carries no SOI at all. */
const JPEG_ACC_MAX = 32 * 1024 * 1024;
const STDERR_TAIL_BYTES = 8192;

/**
 * @typedef {import("./types.js").StreamHandle} StreamHandle
 */

/**
 * Production factory: spawn the upstream ffmpeg child with the stdio layout
 * of record. The manager (and tests) may inject any StreamHandle factory —
 * the source never spawns on its own.
 * @param {import("./types.js").StreamCamera} camera
 * @param {{ rgbFps: number, jpegFps: number }} cfg
 * @param {ReturnType<typeof import("@porchlight/hal").createHal>} hal
 * @param {typeof nodeChildProcess.spawn} spawn
 * @returns {StreamHandle}
 */
export function spawnFactory(camera, cfg, hal, spawn) {
	return /** @type {any} */ (spawn("ffmpeg", buildStreamArgs(camera, cfg, hal), {
		stdio: STREAM_STDIO,
		env: { ...process.env },
	}));
}

export class CameraSource extends EventEmitter {
	/**
	 * @param {{
	 *   camera: import("./types.js").StreamCamera,
	 *   config: { rgbFps?: number, jpegFps?: number },
	 *   spawn?: typeof nodeChildProcess.spawn,
	 *   factory?: (camera: import("./types.js").StreamCamera, cfg: { rgbFps: number, jpegFps: number }) => StreamHandle,
	 *   hal?: ReturnType<typeof import("@porchlight/hal").createHal>,
	 *   backoffMs?: number[],
	 *   nowMs?: () => number,
	 *   log?: (line: string) => void,
	 * }} opts
	 */
	constructor(opts) {
		super();
		this.camera = opts.camera;
		this.config = { rgbFps: opts.config?.rgbFps ?? 10, jpegFps: opts.config?.jpegFps ?? 5 };
		this.spawnImpl = opts.spawn ?? nodeChildProcess.spawn.bind(nodeChildProcess);
		this.hal = opts.hal ?? createHal();
		this.backoffLadder = opts.backoffMs ?? BACKOFF_MS;
		this.nowMs = opts.nowMs ?? (() => Date.now());
		this.log = opts.log ?? (() => {});
		this.prefix = `[stream:${this.camera.name}]`;
		// The upstream factory seam. The default uses the injected spawn —
		// every handle (real or test) arrives through here, never elsewhere.
		this.factory = opts.factory ?? ((camera, cfg) => spawnFactory(camera, cfg, this.hal, this.spawnImpl));

		/** @type {"opening"|"live"|"down"} */
		this.state = "down";
		this.reason = "the camera has not been opened yet";
		this.at = this.nowSec();
		this.notified = false;
		this.restarts = 0;
		/** @type {null|StreamHandle} */
		this.proc = null;
		/** @type {{ w: number, h: number }|null} */
		this.dims = null;
		this.stopping = false;
		/** @type {null|ReturnType<typeof setTimeout>} */
		this.timer = null;
		/** @type {Buffer|null} */
		this.rgbAcc = null;
		/** @type {Buffer|null} */
		this.jpegAcc = null;
		/** @type {Buffer|null} */
		this.pcmAcc = null;
		/** next pcm sample's epoch seconds (chunk START clock) */
		this.pcmT = null;
		this.stderrTail = "";
		this.stableSince = null;
	}

	/** @returns {number} epoch seconds of the injected clock. */
	nowSec() {
		return Math.floor(this.nowMs() / 1000);
	}

	/** Open the upstream handle (first open and every reconnect land here). */
	open() {
		if (this.stopping || this.proc || this.timer) return;
		const dims = resolveStreamDimensions(this.camera);
		if (!dims) {
			this.#emitDown(`camera "${this.camera.name}" is missing source.width/source.height — the stream manager cannot demux this camera without its frame dimensions; register the camera through the engine (the probe writes them) or add them to the config`);
			return;
		}
		this.dims = dims;
		this.state = "opening";
		this.reason = null;
		this.at = this.nowSec();
		this.rgbAcc = null;
		this.jpegAcc = null;
		this.pcmAcc = null;
		this.pcmT = null;
		const proc = this.factory(this.camera, { rgbFps: this.config.rgbFps, jpegFps: this.config.jpegFps });
		this.proc = proc;
		this.stableSince = this.nowMs();
		this.log(`${this.prefix} opening upstream (${typeof this.camera.source?.url === "string" ? "url" : "synthetic"} camera, ${dims.w}x${dims.h})`);
		proc.stderr?.on("data", (/** @type {Buffer} */ c) => {
			this.stderrTail = Buffer.concat([Buffer.from(this.stderrTail), c]).toString("utf8").slice(-STDERR_TAIL_BYTES);
		});
		proc.stdout?.on("data", (/** @type {Buffer} */ c) => this.#mpegtsData(c));
		proc.stdio?.[3]?.on("data", (/** @type {Buffer} */ c) => this.#rgbData(c));
		proc.stdio?.[4]?.on("data", (/** @type {Buffer} */ c) => this.#jpegData(c));
		proc.stdio?.[5]?.on("data", (/** @type {Buffer} */ c) => this.#pcmData(c));
		proc.on("error", (/** @type {Error} */ err) => this.#onHandleError(err));
		proc.on("close", (/** @type {number|string|null} */ code, /** @type {string|null} */ signal) => this.#onHandleClose(code, signal));
	}

	/**
	 * Stop the source: kill the handle, cancel the reopen timer. Resolves
	 * when the handle is gone (SIGTERM, escalating to SIGKILL after 2s).
	 * @returns {Promise<void>}
	 */
	async stop() {
		this.stopping = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		const proc = this.proc;
		if (!proc) return;
		await new Promise((resolve) => {
			let settled = false;
			const done = () => {
				if (settled) return;
				settled = true;
				clearTimeout(killer);
				resolve(true);
			};
			const killer = setTimeout(() => {
				try {
					proc.kill?.("SIGKILL");
				} catch { /* already gone */ }
			}, 2000);
			proc.on("close", () => done());
			try {
				proc.kill?.("SIGTERM");
			} catch { /* already gone */ }
		});
		this.proc = null;
		this.state = "down";
		this.reason = null;
		this.at = this.nowSec();
	}

	/**
	 * A stable run resets the backoff ladder (recorder.js semantics): after
	 * five stable minutes one full crash costs only the first step again.
	 */
	#onHandleClose(code, signal) {
		const wasProc = this.proc;
		this.proc = null;
		if (!wasProc || this.stopping) return;
		if (this.stableSince && this.nowMs() - this.stableSince > STABLE_RESET_MS) {
			this.restarts = Math.max(0, this.restarts - 1);
		}
		this.stableSince = null;
		const tail = this.stderrTail.split("\n").filter(Boolean).slice(-1)[0] ?? "";
		this.stderrTail = "";
		this.#emitDown(`the camera stream dropped — the stream process exited (code ${code} signal ${signal})${tail ? `: ${tail}` : ""}`);
		this.#scheduleReconnect();
	}

	#onHandleError(err) {
		if (this.stopping) return;
		this.proc = null;
		this.#emitDown(`the stream process failed to start: ${err instanceof Error ? err.message : String(err)}`);
		this.#scheduleReconnect();
	}

	#scheduleReconnect() {
		if (this.stopping || this.timer) return;
		const delay = this.backoffLadder[Math.min(this.restarts, this.backoffLadder.length - 1)];
		this.restarts += 1;
		this.log(`${this.prefix} reopening the upstream in ${delay}ms (restarts=${this.restarts})`);
		this.timer = setTimeout(() => {
			this.timer = null;
			this.open();
		}, delay);
		this.timer.unref?.();
	}

	#emitDown(reason) {
		// First-ever transition notifies even from the initial state (a
		// refusal to open is a real, nameable event); later ones notify on
		// change so an identity "down → down" stay isn't bus noise.
		const changed = !this.notified || this.state !== "down";
		this.state = "down";
		this.reason = reason;
		this.at = this.nowSec();
		this.log(`${this.prefix} down: ${reason}`);
		if (changed) this.emit("down", { camera: this.camera.name, state: "down", reason, at: this.at });
		this.notified = true;
	}

	/** Any lane byte arriving is the proof of life. */
	#becomeLive() {
		if (this.state === "live") return;
		const changed = this.state !== "live";
		this.state = "live";
		this.reason = null;
		this.at = this.nowSec();
		if (changed) this.emit("up", { camera: this.camera.name, state: "up", reason: null, at: this.at });
	}

	/** The mpegts copy lane (fd 1) — raw; the manager fans it to the relay. */
	#mpegtsData(buf) {
		this.#becomeLive();
		this.emit("mpegts", buf);
	}

	/** The rgb24 lane (fd 3): fixed frames of exactly w*h*3 bytes. */
	#rgbData(chunk) {
		if (!this.dims) return;
		this.#becomeLive();
		const frameLen = this.dims.w * this.dims.h * 3;
		/** @type {Buffer} */
		let acc = this.rgbAcc ? Buffer.concat([this.rgbAcc, chunk]) : chunk;
		let off = 0;
		while (acc.length - off >= frameLen) {
			// Views stay safe: a full remainder buffer is never mutated, and the
			// next concat produces a fresh buffer — subscribers may hold frames
			// past later reads without aliasing.
			this.emit("frame", {
				camera: this.camera.name,
				w: this.dims.w,
				h: this.dims.h,
				t: this.nowSec(),
				data: acc.subarray(off, off + frameLen),
			});
			off += frameLen;
		}
		this.rgbAcc = acc.length - off > 0 ? acc.subarray(off) : null;
	}

	/** The mjpeg lane (fd 4): EOI-scanned complete frames (SOI..EOI). */
	#jpegData(chunk) {
		this.#becomeLive();
		let acc = this.jpegAcc ? Buffer.concat([this.jpegAcc, chunk]) : chunk;
		let searchFrom = 0;
		for (;;) {
			const soi = acc.indexOf(JPEG_SOI, searchFrom);
			if (soi === -1) break;
			const eoi = acc.indexOf(JPEG_EOI, soi + 2);
			if (eoi === -1) break;
			this.emit("jpeg", acc.subarray(soi, eoi + 2));
			searchFrom = eoi + 2;
		}
		if (acc.length > JPEG_ACC_MAX && searchFrom === 0) {
			// No SOI anywhere in a bounded-gone accumulator: log the loss, reset.
			this.log(`${this.prefix} jpeg lane reset — ${acc.length} bytes carried no frame start`);
			acc = Buffer.alloc(0);
		}
		this.jpegAcc = acc.subarray(searchFrom);
	}

	/** The PCM lane (fd 5): f32le mono 16 kHz — AudioChunk-shaped chunks. */
	#pcmData(chunk) {
		this.#becomeLive();
		if (this.pcmT === null) this.pcmT = this.nowSec();
		/** @type {Buffer} */
		let acc = this.pcmAcc ? Buffer.concat([this.pcmAcc, chunk]) : chunk;
		const whole = Math.floor(acc.length / 4);
		if (whole === 0) {
			this.pcmAcc = acc;
			return;
		}
		const data = new Float32Array(whole);
		new Uint8Array(data.buffer).set(acc.subarray(0, whole * 4));
		this.emit("audio", { camera: this.camera.name, t: this.pcmT, sampleRate: 16000, data });
		this.pcmT += whole / 16000;
		this.pcmAcc = acc.length > whole * 4 ? acc.subarray(whole * 4) : null;
	}
}


