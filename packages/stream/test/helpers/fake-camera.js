// fake-camera.js — deterministic test doubles for the stream plane (PORCH-154).
//
// The e2e matrix runs WITHOUT ffmpeg (default-deterministic law): a real
// node:net "camera" TCP server streams a trivial framed wire protocol, and
// the injected factory (fakeFactory) plays the demux role ffmpeg plays for a
// real camera: it opens the ONE upstream connection (net.connect), parses
// the framing, and writes each lane into the source's stdio layout
// (fd 1 mpegts, fd 3 rgb, fd 4 jpeg, fd 5 pcm — args.js STREAM_STDIO).

import net from "node:net";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/** Lane tags of the FAKE wire protocol (deliberately equal to the fd lanes). */
export const FAKE_LANE = Object.freeze({ mpegts: 1, rgb: 3, jpeg: 4, pcm: 5 });

/** @param {number} tag @param {Buffer} payload */
export function encodeLane(tag, payload) {
	const head = Buffer.alloc(5);
	head.writeUInt8(tag, 0);
	head.writeUInt32BE(payload.length, 1);
	return Buffer.concat([head, payload]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A tiny "camera" that accepts TCP connections and sends framed lanes.
 * Tracks how many connections were accepted and how many bytes left the
 * server — the connection-count law (exactly one) and the load-parity
 * law (consumer count changes add zero camera load) read those counters.
 */
export class FakeCameraServer {
	/** @param {{ framesPerRound?: number, interFrameMs?: number }} [opts] */
	constructor(opts = {}) {
		this.framesPerRound = opts.framesPerRound ?? 10;
		this.interFrameMs = opts.interFrameMs ?? 20;
		/** number of accepted TCP connections (the upstream-connection count) */
		this.connections = 0;
		/** bytes the camera wrote onto the wire (the camera-load counter) */
		this.bytesSent = 0;
		/** @type {import("node:net").Socket[]} */
		this.sockets = [];
		this.server = net.createServer((sock) => {
			this.connections += 1;
			this.sockets.push(sock);
			sock.on("error", () => {});
		});
		this.port = 0;
		this.sending = false;
	}

	/** @returns {Promise<number>} the bound port */
	start() {
		return new Promise((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(0, "127.0.0.1", () => {
				this.port = /** @type {import("node:net").AddressInfo} */ (this.server.address()).port;
				resolve(this.port);
			});
		});
	}

	/**
	 * One round of framed lanes to every connected socket. Resolves when the
	 * whole round has been written by this server (socket-level backpressure
	 * is the OS's business — the manager never throttles its reads).
	 */
	async sendRound(frameIndex) {
		// rgb24 16x12 = 576 bytes; deterministic pixel pattern per frame.
		const rgb = Buffer.alloc(576);
		for (let i = 0; i < 576; i++) rgb[i] = (i + frameIndex) % 256;
		const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0x18, frameIndex % 256, 0x4a]), Buffer.from([0xff, 0xd9])]);
		const pcm = Buffer.alloc(1600); // 400 samples of silence for 16 kHz mono
		const mpegts = Buffer.alloc(120, 0x47); // 0x47 = an mpegts sync byte lookalike
		const records = Buffer.concat([
			encodeLane(FAKE_LANE.mpegts, mpegts),
			encodeLane(FAKE_LANE.rgb, rgb),
			encodeLane(FAKE_LANE.jpeg, jpeg),
			encodeLane(FAKE_LANE.pcm, pcm),
		]);
		this.send(records);
	}

	/** @param {Buffer} buf */
	send(buf) {
		this.bytesSent += buf.length;
		for (const sock of this.sockets) {
			if (!sock.destroyed) sock.write(buf);
		}
	}

	/** Cut every live connection the way a camera power-cycle does. */
	destroyConnections() {
		for (const sock of this.sockets) sock.destroy();
		this.sockets = [];
	}

	/** keep sending rounds until stopped() — for the "live feed" test shape. */
	async streamForever() {
		this.sending = true;
		let i = 0;
		while (this.sending) {
			await this.sendRound(i++);
			await sleep(this.interFrameMs);
		}
	}

	stopSending() {
		this.sending = false;
	}

	/** total bytes a full round adds: 4 record headers (5 bytes each) plus
	 *  mpegts 120 + rgb 576 + jpeg 7 (SOI+3+EOI) + pcm 1600. */
	roundBytes() {
		return (120 + 576 + 7 + 1600) + 5 * 4;
	}

	/** @returns {Promise<void>} */
	async stop() {
		this.stopSending();
		this.destroyConnections();
		await new Promise((resolve) => this.server.close(() => resolve()));
	}
}

/**
 * The injected upstream factory: connects via net.connect (exactly one
 * connection per handle), demuxes the fake protocol into the stdio layout
 * of record, and emits close when the camera connection dies — the same
 * lifecycle the recorder daemon sees from a real ffmpeg child.
 * @param {import("../../src/types.js").StreamCamera} camera
 * @param {{ rgbFps: number, jpegFps: number }} _cfg
 * @returns {import("node:events").EventEmitter & {
 *   stdout: PassThrough, stdio: (Duplex|null)[], kill: (sig?: string) => void,
 * }}
 */
export function fakeFactory(camera, _cfg) {
	const url = /** @type {string} */ (camera.source?.url);
	if (typeof url !== "string" || !url.startsWith("tcp://")) {
		throw new Error(`fakeFactory: camera ${camera.name} has no tcp:// source url to connect to`);
	}
	const m = /^tcp:\/\/127\.0\.0\.1:(\d+)$/.exec(url);
	if (!m) throw new Error(`fakeFactory: unparseable camera url ${url}`);
	const port = Number(m[1]);

	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const rgbLane = new PassThrough();
	const jpegLane = new PassThrough();
	const pcmLane = new PassThrough();

	/** @type {any} */
	const handle = new EventEmitter();
	handle.stdout = stdout;
	handle.stderr = stderr;
	handle.stdio = [null, stdout, stderr, rgbLane, jpegLane, pcmLane];
	handle.killCalls = [];
	handle.killed = false;
	handle.kill = (sig) => {
		handle.killed = true;
		handle.killCalls.push(sig ?? "SIGTERM");
		socket.destroy();
	};

	const socket = net.connect(port, "127.0.0.1");
	/** @type {Buffer|null} */
	let acc = null;
	socket.on("data", (chunk) => {
		let buf = acc ? Buffer.concat([acc, chunk]) : chunk;
		for (;;) {
			if (buf.length < 5) break;
			const tag = buf.readUInt8(0);
			const len = buf.readUInt32BE(1);
			if (buf.length < 5 + len) break;
			const payload = buf.subarray(5, 5 + len);
			if (tag === FAKE_LANE.mpegts) stdout.write(payload);
			else if (tag === FAKE_LANE.rgb) rgbLane.write(payload);
			else if (tag === FAKE_LANE.jpeg) jpegLane.write(payload);
			else if (tag === FAKE_LANE.pcm) pcmLane.write(payload);
			else stderr.write(payload);
			buf = buf.subarray(5 + len);
		}
		acc = buf.length > 0 ? Buffer.from(buf) : null;
	});
	socket.on("close", () => handle.emit("close"));
	socket.on("error", (err) => handle.emit("error", err));
	return handle;
}
