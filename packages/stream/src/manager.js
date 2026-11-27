// manager.js — the StreamManager: stream serving for every camera (PORCH-154).
//
// Composition law of the engine's live-image path (PORCH-127 supervisor
// comment, now realized): the manager holds EXACTLY ONE upstream connection
// per camera (the CameraSource child), demuxes it into the four lanes of
// record, and feeds every consumer from there:
//   - the mpegts copy lane (fd 1) is fanned byte-for-byte to the per-camera
//     relay TCP listener (127.0.0.1:<base + 1 + sortedIndex(name)>, codepoint
//     order — both sides derive ports with the same formula); the recorder
//     records from the relay URL, never from the camera,
//   - rgb frames and audio chunks reach in-process subscribers directly,
//   - jpeg frames reach the live-grid feed and the MJPEG live view.
//
// Consumer-count changes add ZERO camera load: a slow relay consumer is
// disconnected by itself (bounded per-socket buffer, explained in the log)
// and never back-pressures the upstream or its peers.
//
// Health is never silent: every camera carries the closed state set
// opening|live|down with reason/at, every connect/disconnect publishes
// { camera, state, reason, at } on the engine bus (Null bus with no busUrl —
// green-field law), and the control HTTP renders it on /health.

import fsDefault from "node:fs";
import http from "node:http";
import net from "node:net";
import { resolveStreamSettings, validateCameras } from "./config.js";
import { streamHealthTopic, MqttStreamHealthPublisher, NullStreamHealthBus } from "./health-bus.js";
import { CameraSource } from "./source.js";

const BODY_CHUNK_LIMIT = 1024;
/** Max bytes a relay socket may fall behind before it is disconnected. */
const RELAY_BUFFER_MAX_DEFAULT = 4 * 1024 * 1024;
/** How long a relay socket may stay blocked without a drain before it is dropped. */
const RELAY_STALL_MS_DEFAULT = 500;
const MJPEG_BOUNDARY = "porchlight-live";

/** Read and parse a JSON request body; null on malformed JSON or oversize. */
async function readJsonBody(req) {
	const chunks = [];
	for await (const chunk of req) {
		chunks.push(/** @type {Buffer} */ (chunk));
		if (chunks.length > BODY_CHUNK_LIMIT) return null;
	}
	try {
		return /** @type {unknown} */ (JSON.parse(Buffer.concat(chunks).toString("utf8")));
	} catch {
		return null;
	}
}

/** @param {import("node:http").ServerResponse} res @param {number} code @param {object} body @param {Record<string, string>} [extra] */
function sendJson(res, code, body, extra) {
	const payload = JSON.stringify(body);
	res.writeHead(code, { "content-type": "application/json; charset=utf-8", ...extra });
	res.end(payload);
}

export class StreamManager {
	/**
	 * config is the whole platform doc (cameras[], streams, busUrl). spawn/fs/
	 * factory are injectable exactly like RecorderDaemon's options — the test
	 * matrix runs without ffmpeg on the injected factory alone.
	 * @param {{
	 *   config: Record<string, unknown>,
	 *   log?: (line: string) => void,
	 *   bus?: import("./health-bus.js").MqttStreamHealthPublisher|import("./health-bus.js").NullStreamHealthBus,
	 *   spawn?: typeof import("node:child_process").spawn,
	 *   factory?: (camera: import("./types.js").StreamCamera, cfg: { rgbFps: number, jpegFps: number }) => import("./types.js").StreamHandle,
	 *   fs?: typeof fsDefault,
	 *   nowMs?: () => number,
 *   backoffMs?: number[],
 *   relayBufferMax?: number,
 *   relayStallMs?: number,
 * }} opts
 */
	constructor(opts) {
		this.config = opts.config;
		this.settings = resolveStreamSettings(opts.config);
		this.log = opts.log ?? console.log;
		this.nowMs = opts.nowMs ?? (() => Date.now());
		this.spawn = opts.spawn;
		this.fs = opts.fs ?? fsDefault;
		this.factory = opts.factory ?? null;
		this.backoffMs = opts.backoffMs ?? null;
		this.relayBufferMax = opts.relayBufferMax ?? RELAY_BUFFER_MAX_DEFAULT;
		this.relayStallMs = opts.relayStallMs ?? RELAY_STALL_MS_DEFAULT;
		// Bus seam of record: injected bus wins; else MQTT when busUrl is set;
		// else the Null bus (nothing is assumed pre-deployed).
		this.bus = opts.bus ?? (typeof this.config.busUrl === "string" && this.config.busUrl
			? new MqttStreamHealthPublisher({ url: this.config.busUrl, log: (l) => this.log(l) })
			: new NullStreamHealthBus());
		/** @type {Map<string, CameraSource>} */
		this.sources = new Map();
		/** @type {Map<string, { port: number, server: import("node:net").Server, sockets: Set<import("node:net").Socket>, meta: WeakMap<import("node:net").Socket, { pending: Buffer[], bytes: number, stall?: NodeJS.Timeout }>, drop: (sock: import("node:net").Socket, m: { pending: Buffer[], bytes: number, stall?: NodeJS.Timeout }, why: string) => void }>} */
		this.relays = new Map();
		/** @type {Map<string, import("./types.js").StreamCamera>} */
		this.cameras = new Map();
		/** @type {Map<string, Set<(f: any) => void>>} */
		this.rgbSubs = new Map();
		/** @type {Map<string, Set<(f: any) => void>>} */
		this.jpegSubs = new Map();
		/** @type {Map<string, Set<(f: any) => void>>} */
		this.audioSubs = new Map();
		/** @type {Map<string, Buffer>} last jpeg frame per camera (live view) */
		this.latestJpeg = new Map();
		/** @type {import("node:http").Server|null} */
		this.httpServer = null;
		this.stopping = false;
		/** @type {Promise<{added: string[], mutated: string[], removed: string[], kept: string[], ports: Record<string, number>}>|null} */
		this.applyPromise = null;
	}

	/**
	 * Start control HTTP + the configured fleet. Returns this; the fleet
	 * application resolves on manager.applyPromise.
	 * @returns {this}
	 */
	start() {
		if (this.httpServer) throw new Error("[stream] manager already started");
		this.stopping = false;
		if (typeof (/** @type {any} */ (this.bus).start) === "function") {
			Promise.resolve(/** @type {any} */ (this.bus).start()).catch((err) => {
				this.log(`[stream] health bus failed to start (will retry per transport): ${err instanceof Error ? err.message : String(err)}`);
			});
		}
		this.startControlHttp();
		this.applyPromise = this.applyFleet(/** @type {any} */ (this.config.cameras) ?? []);
		return this;
	}

	startControlHttp() {
		const server = http.createServer((req, res) => {
			this.#route(req, res).catch((err) => {
				this.log(`[stream] control HTTP handler failed: ${err instanceof Error ? err.message : String(err)}`);
				sendJson(res, 500, { ok: false, reason: "the stream control endpoint failed to answer this request" });
			});
		});
		server.on("error", (err) => {
			this.log(`[stream] control HTTP listener failed on 127.0.0.1:${this.settings.base}: ${err.message}`);
		});
		this.httpServer = server;
		server.listen(this.settings.base, "127.0.0.1");
		return server;
	}

	#port(index) {
		return this.settings.base + 1 + index;
	}

	/** Relay URL of record for one camera — recorder-side inputs derive from this. */
	relayUrl(name) {
		return `tcp://127.0.0.1:${this.relays.get(name)?.port ?? "?"}`;
	}

	/**
	 * Diff the running fleet against the next camera set: added cameras open,
	 * removed ones close, mutated ones (source fields differ) close+reopen;
	 * unchanged names keep their warm upstream. Relay listeners sit at
	 * <base> + 1 + sortedIndex(name) over the codepoint-sorted fleet.
	 * @param {import("./types.js").StreamCamera[]} cameras
	 * @returns {Promise<{added: string[], mutated: string[], removed: string[], kept: string[], ports: Record<string, number>}>}
	 */
	async applyFleet(cameras) {
		if (this.stopping) return { added: [], mutated: [], removed: [], kept: [], ports: {} };
		validateCameras(cameras);
		const nextByName = new Map(cameras.map((c) => [c.name, c]));
		const sortedNames = cameras.map((c) => c.name).sort();
		const portOf = new Map(sortedNames.map((n, i) => [n, this.#port(i)]));
		/** @type {{ added: string[], mutated: string[], removed: string[], kept: string[] }} */
		const diff = { added: [], mutated: [], removed: [], kept: [] };

		for (const name of this.sources.keys()) {
			if (nextByName.has(name)) continue;
			diff.removed.push(name);
			await this.#closeSource(name);
		}
		for (const [name, next] of nextByName) {
			const current = this.cameras.get(name);
			this.cameras.set(name, next);
			if (!current) {
				diff.added.push(name);
			} else if (JSON.stringify(current?.source ?? null) !== JSON.stringify(next.source ?? null)) {
				// Mutated: the upstream arguments changed under a live name —
				// close+reopen through the same path as an add.
				diff.mutated.push(name);
				await this.#closeSource(name);
			} else {
				diff.kept.push(name);
			}
		}
		for (const name of sortedNames) {
			if (this.sources.has(name)) continue;
			this.#openSource(/** @type {import("./types.js").StreamCamera} */ (nextByName.get(name)));
		}
		this.#syncRelayListeners(portOf, sortedNames);
		this.log(`[stream] fleet applied — ${diff.added.length} added, ${diff.mutated.length} mutated, ${diff.removed.length} removed, ${diff.kept.length} kept`);
		return {
			...diff,
			ports: Object.fromEntries(sortedNames.map((n) => [n, /** @type {number} */ (portOf.get(n))])),
		};
	}

	#openSource(camera) {
		const name = camera.name;
		const src = new CameraSource({
			camera,
			config: this.settings,
			spawn: this.spawn ?? undefined,
			factory: this.factory ?? undefined,
			backoffMs: this.backoffMs ?? undefined,
			nowMs: this.nowMs,
			log: (l) => this.log(l),
		});
		src.on("up", (e) => this.#publishHealth("up", e.camera, e.reason, e.at));
		src.on("down", (e) => this.#publishHealth("down", e.camera, e.reason, e.at));
		src.on("mpegts", (buf) => this.#fan(name, buf));
		src.on("frame", (f) => this.#deliver(this.rgbSubs, name, f));
		src.on("jpeg", (buf) => {
			this.latestJpeg.set(name, buf);
			this.#deliver(this.jpegSubs, name, buf);
		});
		src.on("audio", (chunk) => this.#deliver(this.audioSubs, name, chunk));
		this.sources.set(name, src);
		src.open();
		return src;
	}

	/**
	 * Close one camera's plane: stop the source (downstream of the relay),
	 * drop its subscriptions and latest frame, close its relay listener and
	 * every socket on it.
	 * @returns {Promise<void>}
	 */
	async #closeSource(name) {
		const src = this.sources.get(name);
		if (src) {
			this.sources.delete(name);
			await src.stop();
		}
		this.rgbSubs.delete(name);
		this.jpegSubs.delete(name);
		this.audioSubs.delete(name);
		this.latestJpeg.delete(name);
		const relay = this.relays.get(name);
		if (relay) {
			this.relays.delete(name);
			for (const sock of relay.sockets) sock.destroy();
			await new Promise((resolve) => relay.server.close(() => resolve()));
		}
	}

	#syncRelayListeners(portOf, sortedNames) {
		for (const name of sortedNames) {
			const wanted = /** @type {number} */ (portOf.get(name));
			const existing = this.relays.get(name);
			if (existing && existing.port === wanted) continue;
			if (existing) {
				// The fleet's shape moved this camera's lane port. Existing
				// consumers re-derive their URL with the same formula — named,
				// never silent.
				this.log(`[stream:${name}] relay listener moved to port ${wanted} (fleet composition changed) — consumers re-derive the port with the same formula`);
				for (const sock of existing.sockets) sock.destroy();
				existing.server.close();
				this.relays.delete(name);
			}
			/** @type {Set<import("node:net").Socket>} */
			const sockets = new Set();
			/** @type {WeakMap<import("node:net").Socket, { pending: Buffer[], bytes: number, stall?: NodeJS.Timeout }>} */
			const meta = new WeakMap();
			/** One consumer's disconnect: the socket alone, with the reason. */
			const drop = (sock, m, why) => {
				clearTimeout(m.stall);
				m.stall = undefined;
				this.log(`[stream:${name}] relay consumer dropped — ${why}; this consumer alone is disconnected, the camera lane and other consumers are unaffected`);
				sock.destroy();
				sockets.delete(sock);
			};
			const server = net.createServer((sock) => {
				sockets.add(sock);
				sock.setNoDelay(true);
				meta.set(sock, /** @type {{ pending: Buffer[], bytes: number, stall?: NodeJS.Timeout }} */ ({ pending: [], bytes: 0 }));
				sock.on("drain", () => {
					const m = meta.get(sock);
					if (!m || m.pending.length === 0) return;
					const parts = m.pending;
					m.pending = [];
					m.bytes = 0;
					clearTimeout(m.stall);
					m.stall = undefined;
					let ok = true;
					for (const part of parts) ok = sock.write(part) && ok;
					if (!ok) {
						m.pending = [Buffer.concat(parts)];
						m.bytes = m.pending[0].length;
						// Still blocked after the flush — the stall clock restarts.
						m.stall = setTimeout(() => drop(sock, m, `its socket stayed blocked past ${this.relayStallMs}ms (` + `${m.bytes} bytes queued)`), this.relayStallMs);
					}
				});
				sock.on("close", () => {
					const m = meta.get(sock);
					clearTimeout(m?.stall);
					sockets.delete(sock);
				});
				sock.on("error", (err) => {
					this.log(`[stream:${name}] relay socket error: ${err.message}`);
					sock.destroy();
				});
			});
			server.on("error", (err) => {
				this.log(`[stream:${name}] relay listener failed on 127.0.0.1:${wanted}: ${err.message}`);
			});
			server.listen(wanted, "127.0.0.1");
			this.relays.set(name, /** @type {any} */ ({ port: wanted, server, sockets, meta, drop }));
		}
	}

	/**
	 * Fan one mpegts chunk to every relay socket. Backpressure is normal
	 * traffic, not failure — a consumer is disconnected alone only when it
	 * does not DRAIN: its queued bytes persist past the stall window with no
	 * drain event, or its queue exceeds the absolute memory cap. A healthy
	 * consumer with momentary backpressure survives (the drain event clears
	 * the stall clock); only a genuinely stalled socket is disconnected, and
	 * the upstream lane and every other consumer continue untouched.
	 * @param {string} name
	 * @param {Buffer} buf
	 */
	#fan(name, buf) {
		const relay = /** @type {any} */ (this.relays.get(name));
		if (!relay) return;
		for (const sock of [...relay.sockets]) {
			const m = /** @type {{ pending: Buffer[], bytes: number, stall?: NodeJS.Timeout }|undefined} */ (relay.meta.get(sock));
			if (!m) continue;
			if (m.pending.length > 0) {
				m.pending.push(buf);
			} else if (!sock.write(buf)) {
				m.pending.push(buf);
				// First backpressure: the stall clock starts — a drain clears it.
				m.stall = setTimeout(() => {
					relay.drop(sock, m, `its socket queued ${m.bytes} bytes and stayed blocked past ${this.relayStallMs}ms with no drain`);
				}, this.relayStallMs);
			}
			m.bytes = m.pending.reduce((sum, b) => sum + b.length, 0);
			if (m.bytes > this.relayBufferMax) {
				relay.drop(sock, m, `its socket fell ${m.bytes} bytes behind (bounded buffer ${this.relayBufferMax} exceeded)`);
			}
		}
	}

	/**
	 * Deliver one in-process event to a camera's subscribers. A throwing
	 * subscriber is logged and skipped — never fatal to the pipeline.
	 * @param {Map<string, Set<(f: any) => void>>} subs
	 * @param {string} name
	 * @param {any} arg
	 */
	#deliver(subs, name, arg) {
		const set = subs.get(name);
		if (!set) return;
		for (const fn of set) {
			try {
				fn(arg);
			} catch (err) {
				this.log(`[stream:${name}] subscriber failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	/**
	 * @param {"up"|"down"} direction
	 * @param {string} camera
	 * @param {string|null} reason
	 * @param {number} at
	 */
	#publishHealth(direction, camera, reason, at) {
		const payload = { camera, state: direction, reason: reason ?? null, at };
		Promise.resolve(this.bus.publish(streamHealthTopic(camera, direction), payload)).catch((err) => {
			this.log(`[stream] health event "${camera}/${direction}" failed to publish: ${err instanceof Error ? err.message : String(err)}`);
		});
	}

	/**
	 * subscribeFrames(name, fn({camera, w, h, t, data})) → unsub. data is the
	 * rgb24 buffer; t is the epoch seconds at read.
	 * @param {string} name
	 * @param {(f: import("./types.js").StreamFrame) => void} fn
	 * @returns {() => void}
	 */
	subscribeFrames(name, fn) {
		return this.#subscribe(this.rgbSubs, name, fn);
	}

	/**
	 * subscribeAudio(name, fn({camera, t, sampleRate: 16000, data})) → unsub.
	 * Shape-identical to @porchlight/audio's AudioChunk.
	 * @param {string} name
	 * @param {(f: import("./types.js").StreamAudioChunk) => void} fn
	 * @returns {() => void}
	 */
	subscribeAudio(name, fn) {
		return this.#subscribe(this.audioSubs, name, fn);
	}

	/** subscribeImages(name, fn(jpegBuffer)) → unsub. */
	subscribeImages(name, fn) {
		return this.#subscribe(this.jpegSubs, name, fn);
	}

	/**
	 * @template {(...args: any[]) => void} F
	 * @param {Map<string, Set<F>>} subs
	 * @param {string} name
	 * @param {F} fn
	 * @returns {() => void}
	 */
	#subscribe(subs, name, fn) {
		let set = subs.get(name);
		if (!set) {
			set = new Set();
			subs.set(name, set);
		}
		set.add(fn);
		return () => set.delete(fn);
	}

	/** The full health posture: aggregate state + the per-camera rows. */
	health() {
		const cameras = [...this.sources.keys()].sort().map((name) => {
			const s = /** @type {CameraSource} */ (this.sources.get(name));
			const relay = this.relays.get(name);
			return {
				name,
				state: /** @type {"opening"|"live"|"down"} */ (s.state),
				reason: s.reason ?? null,
				at: s.at,
				relayPort: relay?.port ?? null,
				consumers: relay?.sockets.size ?? 0,
			};
		});
		const state = cameras.length === 0
			? "idle"
			: cameras.every((c) => c.state === "live")
				? "live"
				: cameras.some((c) => c.state === "down")
					? "degraded"
					: "opening";
		return { state, cameras };
	}

	/** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
	async #route(req, res) {
		const url = new URL(/** @type {string} */ (req.url), `http://127.0.0.1:${this.settings.base}`);
		const path = url.pathname;
		if (req.method === "GET" && path === "/health") {
			sendJson(res, 200, this.health());
			return;
		}
		if (req.method === "POST" && path === "/api/cameras/apply") {
			const body = await readJsonBody(req);
			if (!body || typeof body !== "object" || !Array.isArray(/** @type {any} */ (body).cameras)) {
				sendJson(res, 422, { ok: false, reason: "the apply request needs a JSON body shaped { cameras: [ ... ] }" });
				return;
			}
			/** @type {any[]} */
			const cameras = /** @type {any} */ (body).cameras;
			if (cameras.length > 4096) {
				sendJson(res, 422, { ok: false, reason: `the camera set carries ${cameras.length} entries — far beyond any fleet a deployment runs; refusing to apply` });
				return;
			}
			try {
				validateCameras(cameras);
			} catch (err) {
				sendJson(res, 422, { ok: false, reason: `the camera set is not valid: ${err instanceof Error ? err.message : String(err)}` });
				return;
			}
			const result = await this.applyFleet(/** @type {any} */ (cameras));
			sendJson(res, 200, { ok: true, ...result, cameras: this.health().cameras });
			return;
		}
		const cameraMatch = /^\/cameras\/([^/]+)$/.exec(path);
		if (req.method === "GET" && cameraMatch) {
			const name = decodeURIComponent(cameraMatch[1]);
			const row = this.health().cameras.find((c) => c.name === name);
			if (!row) {
				sendJson(res, 404, { ok: false, reason: `no camera named "${name}" is served by the stream manager` });
				return;
			}
			sendJson(res, 200, row);
			return;
		}
		const liveMatch = /^\/live\/([^/]+)$/.exec(path);
		if (req.method === "GET" && liveMatch) {
			this.#serveMjpeg(decodeURIComponent(liveMatch[1]), req, res);
			return;
		}
		sendJson(res, 404, { ok: false, reason: `no stream endpoint answers ${req.method} ${path} — see GET /health, GET /cameras/:id, GET /live/:name or POST /api/cameras/apply` });
	}

	/**
	 * MJPEG live view: multipart/x-mixed-replace at latest-frame semantics —
	 * while the response is busy writing, newer frames REPLACE the pending
	 * one, so a slow viewer sees the newest picture instead of a growing
	 * backlog. Unknown cameras 404; non-live cameras 503 with the reason.
	 * @param {string} name
	 * @param {import("node:http").IncomingMessage} req
	 * @param {import("node:http").ServerResponse} res
	 */
	#serveMjpeg(name, req, res) {
		const src = this.sources.get(name);
		if (!src) {
			sendJson(res, 404, { ok: false, reason: `no camera named "${name}" is served by the stream manager — there is no live view to show` });
			return;
		}
		if (src.state !== "live") {
			sendJson(res, 503, { ok: false, reason: `camera "${name}" is not live right now (state: ${src.state})${src.reason ? ` — ${src.reason}` : ""}` });
			return;
		}
		res.writeHead(200, {
			"content-type": `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
			"cache-control": "no-store",
			connection: "close",
		});
		let closed = false;
		let writing = false;
		let buffered = null;
		const unsubscribe = this.subscribeImages(name, (jpg) => {
			if (closed) return;
			buffered = jpg;
			flush();
		});
		const flush = () => {
			if (closed || writing || !buffered) return;
			const jpg = buffered;
			buffered = null;
			writing = true;
			const head = Buffer.from(
				`--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpg.length}\r\n\r\n`,
			);
			res.write(head);
			res.write(jpg, () => {
				res.write("\r\n", () => {
					writing = false;
					flush();
				});
			});
		};
		const finish = () => {
			if (closed) return;
			closed = true;
			unsubscribe();
			try {
				res.end();
			} catch { /* response already gone */ }
		};
		res.on("close", finish);
		res.on("error", finish);
		req.on("close", finish);
	}

	/**
	 * Stop everything: HTTP, relays, every source, the bus.
	 * @returns {Promise<void>}
	 */
	async stop() {
		this.stopping = true;
		const server = this.httpServer;
		this.httpServer = null;
		if (server) await new Promise((resolve) => server.close(() => resolve()));
		await Promise.all([...this.sources.keys()].map((name) => this.#closeSource(name)));
		await Promise.resolve(this.bus.close?.());
	}
}
