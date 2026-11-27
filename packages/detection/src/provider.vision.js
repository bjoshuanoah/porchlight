// provider.vision.js — Apple Vision framework provider via a Swift subprocess
// (PORCH-128; helper owned by the platform HAL since PORCH-132).
//
// The helper (packages/hal/swift/VisionHelper.swift — the HAL owns all
// OS-framework code, source resolved via @porchlight/hal's `visionHelper()`)
// runs Apple Vision primitives (person/animal detection, pose availability)
// natively on macOS and talks the framed stdin/stdout protocol documented in
// packages/hal/swift/README.md. Frames are written one at a time; a helper
// crash respawns with capped backoff.

import { spawn } from "node:child_process";
import { assertFrame } from "./types.js";

/** @typedef {import("./types.js").Frame} Frame */
/** @typedef {import("./types.js").RawDetection} RawDetection */

const MAX_BACKOFF_MS = 15000;

export class VisionProvider {
	/**
	 * @param {{
	 *   bin: string,             // path to the compiled helper (or a script stand-in for tests)
	 *   args?: string[],
	 *   timeoutMs?: number,      // per-frame response deadline
	 *   spawnImpl?: typeof spawn,
	 *   log?: (...args: unknown[]) => void,
	 *   name?: string,
	 * }} opts
	 */
	constructor(opts) {
		if (!opts.bin || typeof opts.bin !== "string") {
			throw new TypeError("VisionProvider: bin is required (compiled @porchlight/hal swift/VisionHelper.swift)");
		}
		this.name = opts.name ?? "vision";
		this.bin = opts.bin;
		this.args = opts.args ?? [];
		this.timeoutMs = opts.timeoutMs ?? 10000;
		this.spawnImpl = opts.spawnImpl ?? spawn;
		this.log = opts.log ?? (() => {});
		/** @type {import("node:child_process").ChildProcess | null} */
		this.child = null;
		/** @type {Buffer[]} */
		this.unread = []; // stdout bytes not yet consumed by a frame response
		this.inflight = false;
		this.respawns = 0;
		this.nextBackoffMs = 250;
	}

	/** Spawn the helper; idempotent. @returns {Promise<this>} */
	async start() {
		if (this.child) return this;
		this.child = this.#spawnChild();
		return this;
	}

	/** @returns {import("node:child_process").ChildProcess} */
	#spawnChild() {
		const child = this.spawnImpl(this.bin, this.args, { stdio: ["pipe", "pipe", "pipe"] });
		child.stderr?.on("data", (/** @type {Buffer} */ chunk) => {
			this.log(`[${this.name}] helper stderr: ${String(chunk).trimEnd()}`);
		});
		child.on("exit", (code, signal) => {
			this.child = null;
			this.inflight = false;
			this.unread = [];
			if (signal === "SIGTERM" || signal === "SIGKILL" || this.stopping) return;
			this.log(`[${this.name}] helper exited (code=${code ?? "null"} signal=${signal ?? "null"}); respawn in ${this.nextBackoffMs}ms`);
			setTimeout(() => {
				this.respawns += 1;
				void this.start();
			}, this.nextBackoffMs).unref?.();
			this.nextBackoffMs = Math.min(MAX_BACKOFF_MS, this.nextBackoffMs * 2);
		});
		this.nextBackoffMs = 250;
		return child;
	}

	/**
	 * @param {Frame} frame
	 * @returns {Promise<RawDetection[]>}
	 */
	async detect(frame) {
		assertFrame(frame);
		await this.start();
		// A helper serves frames serially — one in flight at a time.
		const resp = await this.#writeFrame(frame);
		const parsed = JSON.parse(resp);
		if (parsed.error) throw new Error(`VisionProvider: helper error: ${parsed.error}`);
		if (parsed.engine !== "vision") {
			throw new Error(`VisionProvider: unexpected helper engine ${JSON.stringify(parsed.engine)}`);
		}
		/** @type {RawDetection[]} */
		const detections = [];
		for (const d of parsed.detections ?? []) {
			detections.push({
				cls: String(d.cls),
				conf: Number(d.conf),
				bbox: /** @type {[number, number, number, number]} */ (d.bbox),
				t: d.t === undefined ? frame.t : Number(d.t),
			});
		}
		return detections;
	}

	/**
	 * Frame one payload: header line, then payload bytes; await the helper's
	 * single response line.
	 * @param {Frame} frame
	 * @returns {Promise<string>} response JSON line
	 */
	async #writeFrame(frame) {
		/** @type {any} */
		const child = this.child;
		const payloadBytes = frame.format === "rgb" ? frame.w * frame.h * 3 : frame.format === "rgba" ? frame.w * frame.h * 4 : frame.data.length;
		if (frame.data.length < payloadBytes) {
			throw new Error(`VisionProvider: ${frame.format} payload too short: ${frame.data.length} < ${payloadBytes}`);
		}
		if (this.inflight) throw new Error("VisionProvider: a frame is already awaiting a response");
		this.inflight = true;
		const header = `FRAME ${payloadBytes} ${frame.w} ${frame.h} ${frame.t} ${frame.format}\n`;
		try {
			await new Promise((resolve, reject) => {
				child.stdin.write(header, (/** @type {unknown} */ err) => (err ? reject(err) : resolve(true)));
			});
			await new Promise((resolve, reject) => {
				child.stdin.write(frame.data.subarray(0, payloadBytes), (/** @type {unknown} */ err) => (err ? reject(err) : resolve(true)));
			});
			const line = await this.#readResponseLine();
			return line;
		} finally {
			this.inflight = false;
		}
	}

	/**
	 * Await one newline-terminated stdout line within the deadline.
	 * @returns {Promise<string>}
	 */
	#readResponseLine() {
		/** @type {any} */
		const child = this.child;
		return new Promise((resolve, reject) => {
			let acc = Buffer.concat(this.unread.splice(0));
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`VisionProvider: no helper response within ${this.timeoutMs}ms`));
			}, this.timeoutMs);
			timer.unref?.();
			const cleanup = () => {
				child.stdout.off("data", onData);
				clearTimeout(timer);
			};
			const onData = (/** @type {Buffer} */ chunk) => {
				acc = Buffer.concat([acc, chunk]);
				const nl = acc.indexOf(0x0a);
				if (nl === -1) return;
				const line = acc.subarray(0, nl).toString("utf8");
				if (acc.length > nl + 1) this.unread.push(acc.subarray(nl + 1));
				cleanup();
				resolve(line);
			};
			child.stdout.on("data", onData);
		});
	}

	/** Never-silent compute posture (PORCH-152): all five fields, always. */
	status() {
		return {
			engine: "vision",
			providerClass: "native-mlx",
			model: "apple-vision",
			executionTarget: "ane",
			state: "native",
			respawns: this.respawns,
			reason: this.respawns > 0 ? `helper respawned ${this.respawns} times` : null,
		};
	}

	/** Stop the helper (SIGTERM). */
	async close() {
		/** @type {any} */
		const child = this.child;
		if (!child) return;
		this.stopping = true;
		this.child = null;
		await new Promise((resolve) => {
			child.once("exit", resolve);
			child.kill("SIGTERM");
			setTimeout(resolve, 1000).unref?.();
		});
	}
}
