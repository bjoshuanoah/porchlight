// session.js — the Wyze DTLS P2P camera session (PORCH-131).
//
// One session = the camera's single upstream connection of record: IOTC
// discovery over UDP 32761 (iotc.js), the DTLS-PSK handshake (dtls/), then
// the AV channel — AV login, the HL K-auth (challenge/response over the
// encrypted channel), the video/audio control-channel opens (K10010), the
// ACK cadence, the clear-text session keep-alive, and the frame
// reassembly pump (frame.js).
//
// Native-host-only law: the DTLS handshake breaks through containerized
// UDP paths (field-validated), so this session runs on the deployment host.
//
// AV phase map (go2rtc pkg/wyze + pkg/tutk/dtls):
//   discovering → handshaking → login → kauth → streaming → down
// Every transition emits "state" ({ state, reason }) — never silent.

import { EventEmitter } from "node:events";
import dgram from "node:dgram";
import { randomBytes } from "node:crypto";

import { calculateAuthKey, derivePsk } from "./dtls/keys.js";
import { DtlsPskClient } from "./dtls/client.js";
import {
	IOTC_CMD, DISCOVERY_STAGE, DISCOVERY_PORT, DISCOVERY_INTERVAL_MS,
	isCc51Datagram, buildDisco, buildSession, buildKeepaliveReq,
	decodeIotcDatagram, encodeIotcDatagram, buildSessionDataTx,
} from "./iotc.js";
import {
	buildAVLogin, buildIOCtrl, buildACK, buildK10000, buildK10002,
	buildK10010, buildK10056, buildK10052, parseK10001, parseK10003,
	parseAVLoginResp, generateChallengeResponse, extractHLFromAv,
	is2KModel, isDoorbellResolutionModel, isFloodlightModel,
	FRAME_SIZE, BITRATE, AV_MAGIC, buildHL, K_CMD,
} from "./av.js";
import { FrameHandler } from "./frame.js";

const HANDSHAKE_BUDGET_MS = 10_000;
const LOGIN_BUDGET_MS = 10_000;
const SESSION_RETRANSMIT_MS = 1000;
const DISCOVER_BUDGET_MS = 10_000;
/** Socket rx buffer: frames arrive in bursts (go2rtc sets 2 MiB). */
const RX_BUFFER_BYTES = 2 * 1024 * 1024;

/**
 * parseWyzeUrl — the of-record URL scheme:
 *   wyze://<ip>[:port]?uid=<P2PID>&enr=<ENR>&mac=<MAC>&model=<MODEL>&dtls=true[&subtype=hd|sd]
 */
export function parseWyzeUrl(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`the Wyze camera source is not a valid URL: ${JSON.stringify(url)}`);
	}
	if (parsed.protocol !== "wyze:") {
		throw new Error(`the Wyze adapter serves wyze:// URLs only (got ${JSON.stringify(parsed.protocol)})`);
	}
	const q = parsed.searchParams;
	if (q.get("dtls") !== "true") {
		throw new Error(`the Wyze camera at ${parsed.hostname} runs non-DTLS firmware — the adapter serves DTLS cameras only`);
	}
	const uid = q.get("uid") ?? "";
	const enr = q.get("enr") ?? "";
	const mac = q.get("mac") ?? "";
	const model = q.get("model") ?? "";
	if (!uid || !enr || !mac || !model) {
		throw new Error(`the Wyze URL for ${parsed.hostname} is missing uid, enr, mac or model — the camera config of record carries all four`);
	}
	return {
		host: parsed.hostname,
		port: parsed.port ? Number(parsed.port) : DISCOVERY_PORT,
		uid, enr, mac, model,
		subtype: q.get("subtype") ?? "hd",
	};
}

/** Session states of record. */
export const SESSION_STATES = Object.freeze([
	"down", "discovering", "handshaking", "login", "kauth", "streaming",
]);

/**
 * WyzeCameraSession — one upstream camera connection. Emits:
 *   "frame"    ({ channel, codec, isKeyframe, frameNo, sampleRate?, channels?, timestamp, data })
 *   "state"    ({ state, reason, at })
 *   "ready"    ({ hasAudio, hasTwoWay }) — the stream contract is negotiated
 *   "error"    (Error) — every failure names its state (never-silent law)
 *   "close"
 */
export class WyzeCameraSession extends EventEmitter {
	/**
	 * @param {{ url: string, log?: (line: string) => void, nowMs?: () => number,
	 *           random?: (n: number) => Buffer }} opts
	 */
	constructor({ url, log = () => {}, nowMs = () => Date.now(), random = (n) => randomBytes(n) }) {
		super();
		const info = parseWyzeUrl(url);
		this.host = info.host;
		this.port = info.port;
		this.uid = info.uid;
		this.enr = info.enr;
		this.mac = info.mac;
		this.model = info.model;
		this.subtype = info.subtype;
		this.authKey = calculateAuthKey(info.enr, info.mac);
		this.psk = derivePsk(info.enr);
		const prefix = `[wyze:${info.model}]`;
		this.log = (l) => log(`${prefix} ${l}`);
		this.nowMs = nowMs;
		this.random = random;
		this.state = "down";
		this.reason = null;
		this.frames = new FrameHandler();
		this.frames.on("frame", (f) => this.emit("frame", f));
		/** @type {import("node:dgram").Socket|null} */
		this.socket = null;
		this.cameraAddr = null;
		/** @type {DtlsPskClient|null} */
		this.dtls = null;
		this.sid = random(8);
		this.avSeq = 0;
		this.seqCmd = 0;
		this.dataSeq = 0;
		this.rxSeqStart = 0xffff;
		this.rxSeqEnd = 0xffff;
		this.rxAckInit = false;
		this.ackFlags = 0;
		/** @type {{ hasAudio?: boolean, hasTwoWay?: boolean }} */
		this.capabilities = {};
		this.timers = {};
		/** @type {{ cmdId: number, handler: (hl: Buffer) => void } | null} */
		this.pendingWait = null;
		this.closed = false;
		this.lastWait = null;
	}

	#setState(state, reason = null) {
		this.state = state;
		this.reason = reason;
		this.emit("state", { state, reason, at: Math.floor(this.nowMs() / 1000) });
	}

	#setTimer(key, fn, ms, repeat = false) {
		this.#clearTimer(key);
		this.timers[key] = (repeat ? setInterval : setTimeout)(fn, ms);
		this.timers[key].unref?.();
	}

	#clearTimer(key) {
		const t = this.timers[key];
		if (t) {
			clearTimeout(t);
			clearInterval(t);
			delete this.timers[key];
		}
	}

	#clearAllTimers() {
		for (const key of Object.keys(this.timers)) this.#clearTimer(key);
		this.pendingWait = null;
		this.lastWait = null;
	}

	/** Open the session. Resolves once discovery begins; "ready" marks the
	 *  fully negotiated stream. */
	async connect() {
		if (this.state !== "down" && !this.closed && this.socket) {
			throw new Error("the Wyze session is already open");
		}
		this.closed = false;
		if (!this.socket) {
			this.socket = dgram.createSocket("udp4");
			this.socket.on("message", (msg, rinfo) => this.#onDatagram(msg, rinfo));
			this.socket.on("error", (err) => {
				if (!this.closed) this.#fail(`the session socket failed: ${err.message}`);
			});
			this.socket.bind(0, () => {
				try {
					this.socket.setRecvBufferSize(RX_BUFFER_BYTES);
				} catch { /* best effort */ }
			});
		}
		this.#setState("discovering");
		this.#setTimer("discoverBudget", () => {
			if (this.state === "discovering") {
				this.#fail("the camera did not answer discovery within ten seconds — check that the services network reaches it on UDP 32761 in both directions");
			}
		}, DISCOVER_BUDGET_MS);
		this.#discoverLoop();
	}

	#discoverLoop() {
		if (this.closed || this.state !== "discovering") return;
		this.#send(encodeIotcDatagram(buildDisco({ stage: DISCOVERY_STAGE.DISCOVER, uid: this.uid, authKey: this.authKey, sid: this.sid })));
		this.#setTimer("discoverLoop", () => this.#discoverLoop(), DISCOVERY_INTERVAL_MS, true);
	}

	#send(wire) {
		if (!this.socket || this.closed) return;
		const { address, port } = this.cameraAddr ?? { address: this.host, port: this.port };
		this.socket.send(wire, port, address);
	}

	#onDatagram(wire, rinfo) {
		if (isCc51Datagram(wire)) {
			this.#fail("the camera answered discovery with the CC51 protocol family — no camera model of record (HL_DB2 / WYZE_CAKP2JFUS) speaks it; the adapter refuses instead of hanging");
			return;
		}
		const iotc = decodeIotcDatagram(wire);
		if (!iotc) return;
		switch (iotc.cmd) {
			case IOTC_CMD.DISCO_RES: {
				if (this.state !== "discovering") return;
				// Bind the answering address (the camera may redirect the port).
				this.cameraAddr = { address: rinfo.address, port: rinfo.port };
				this.#clearTimer("discoverLoop");
				this.#clearTimer("discoverBudget");
				this.#setState("handshaking");
				this.#send(encodeIotcDatagram(buildDisco({ stage: DISCOVERY_STAGE.DIRECT, uid: this.uid, authKey: this.authKey, sid: this.sid })));
				setTimeout(() => this.#sendSessionReq(), 100);
				return;
			}
			case IOTC_CMD.SESSION_RES: {
				if (this.state !== "handshaking") return;
				this.#clearTimer("sessionRetransmit");
				this.#clearTimer("sessionBudget");
				this.#startDtls();
				return;
			}
			case IOTC_CMD.KEEPALIVE_RES: {
				if (iotc.body.length > 8) this.#send(encodeIotcDatagram(buildKeepaliveReq(iotc.body)));
				return;
			}
			case IOTC_CMD.DATA_RX: {
				// The decoder already un-obfuscated the full datagram; the
				// 12-byte routing block rides the 16-byte header: rid(2) at
				// 12, channel at 14, marker 15, const(4) + rid(8) to 28, and
				// the DTLS payload from 28.
				if (iotc.raw.length > 28) {
					const channel = iotc.raw[14];
					const dtlsWire = iotc.raw.subarray(28);
					// Channel 1 = the (inter)com backchannel — the source role
					// never speaks on it, but record frames ride channel 0.
					if ((channel === 0 || channel === 1) && this.dtls) {
						const reply = this.dtls.push(dtlsWire);
						for (const out of reply.out) this.#sendDtls(channel, out);
					}
				}
				return;
			}
			default:
				return;
		}
	}

	#sendSessionReq() {
		this.#send(encodeIotcDatagram(buildSession({ uid: this.uid, sid: this.sid, nowSec: Math.floor(this.nowMs() / 1000) })));
		this.lastWait = IOTC_CMD.SESSION_RES;
		this.#setTimer("sessionRetransmit", () => {
			if (this.lastWait == null || this.state !== "handshaking") return;
			this.#sendSessionReq();
		}, SESSION_RETRANSMIT_MS, true);
		this.#setTimer("sessionBudget", () => {
			if (this.state === "handshaking") {
				this.#fail("the camera answered discovery but not the session bind within ten seconds");
			}
		}, DISCOVER_BUDGET_MS);
	}

	#startDtls() {
		this.#setState(this.state); // keep "handshaking" label until DTLS is up
		this.dtls = new DtlsPskClient({ psk: this.psk, identity: "AUTHPWD_admin", log: this.log });
		this.dtls.on("connect", () => this.#onDtlsUp());
		this.dtls.on("error", (err) => this.#fail(`the camera's DTLS handshake failed: ${err.message}`));
		this.dtls.on("applicationData", (plain) => this.#routeAv(plain));
		this.#setTimer("dlsBudget", () => {
			if (!this.dtls?.keys) {
				this.#fail("the camera answered the session bind but not the DTLS handshake within ten seconds");
			}
		}, HANDSHAKE_BUDGET_MS);
		for (const out of this.dtls.start()) this.#sendDtls(0, out);
	}

	#sendDtls(channel, datagram) {
		this.#send(encodeIotcDatagram(buildSessionDataTx({ payload: datagram, channel, seq: this.dataSeq++, sid: this.sid })));
	}

	#sendAv(wire) {
		if (!this.dtls?.keys) return;
		this.#sendDtls(0, this.dtls.sendApplicationData(wire));
	}

	#onDtlsUp() {
		if (this.timers.dlsBudget) this.#clearTimer("dlsBudget");
		this.capabilities = {};
		this.#setState("login");
		// Replay any camera AV datagrams that raced the flight-6 processing.
		const queued = this.avQueue ?? [];
		this.avQueue = [];
		for (const plain of queued) this.#routeAv(plain);
		// AV handshake budget (go2rtc: 5s); ours 10s.
		this.#setTimer("loginBudget", () => {
			if (this.state === "login") this.#fail("the camera answered the DTLS handshake but not the AV login within ten seconds");
		}, LOGIN_BUDGET_MS);
		this.randomId = this.random(4);
		this.#sendAv(buildAVLogin({ enr: this.enr, variant: 1, randomId: this.randomId }));
		setTimeout(() => {
			if (this.state === "login") this.#sendAv(buildAVLogin({ enr: this.enr, variant: 2, randomId: this.randomId }));
		}, 10).unref?.();
	}

	/** Track the camera's protocol-version records for the ACK window. */
	#trackRx(plain) {
		if (plain.length >= 8 && plain.length >= 2 && plain.readUInt16LE(0) === AV_MAGIC.PROTO_VERSION) {
			const seq = plain.readUInt16LE(4);
			if (!this.rxAckInit) this.rxAckInit = true;
			else if (seq > this.rxSeqEnd || this.rxSeqEnd === 0xffff) this.rxSeqEnd = seq;
		}
	}

	/** The camera-side AV dispatcher: one decrypted datagram. */
	#routeAv(plain) {
		if (plain.length < 2) return;
		this.#trackRx(plain);
		// The camera's AV phase may send its login before this side has
		// finished processing the DTLS flight 6 (arrival races are normal);
		// buffer until the session's own connect handling completes, then
		// replay IN ORDER. Nothing is dropped, ever.
		if (this.state === "handshaking" || this.state === "down") {
			if (!this.closed) (this.avQueue ??= []).push(Buffer.from(plain));
			return;
		}
		const magic = plain.readUInt16LE(0);
		switch (magic) {
			case AV_MAGIC.AV_LOGIN_RESP: {
				if (this.state === "login") this.#onAvLogin(plain);
				return;
			}
			case AV_MAGIC.ACK:
				return;
			case AV_MAGIC.IO_CTRL:
			case AV_MAGIC.CHANNEL_MSG:
			case AV_MAGIC.PROTO_VERSION: {
				if (this.state === "kauth" && this.pendingWait) {
					const hl = extractHLFromAv(plain);
					if (hl?.readUInt16LE(4) === this.pendingWait.cmdId) {
						const wait = this.pendingWait;
						this.pendingWait = null;
						wait.handler(hl);
					} else {
						this.#sendAv(buildACK({ avSeq: this.avSeq++, rxSeqStart: this.rxSeqStart, rxSeqEnd: this.rxSeqEnd, ackFlags: this.ackFlags++ }));
					}
					return;
				}
				// Streaming-phase control responses and frames both land here:
				// HL-prefixed records are control responses; anything else is
				// camera AV data for the frame handler.
				if (plain[0] === 0x48 && plain[1] === 0x4c) {
					this.#sendAv(buildACK({ avSeq: this.avSeq++, rxSeqStart: this.rxSeqStart, rxSeqEnd: this.rxSeqEnd, ackFlags: this.ackFlags++ }));
					return;
				}
				dtlsFrameRoute(this, plain);
				return;
			}
			default:
				// The camera's AV data: [channel 3/5/7][frameType ...].
				dtlsFrameRoute(this, plain);
				return;
		}
	}

	#onAvLogin(plain) {
		const resp = parseAVLoginResp(plain);
		if (!resp) return;
		this.capabilities.hasTwoWay = resp.hasTwoWayStreaming;
		this.#clearTimer("loginBudget");
		// Acknowledge and start the 100 ms ACK cadence (go2rtc ackTicker).
		this.#sendAv(buildACK({ avSeq: this.avSeq++, rxSeqStart: this.rxSeqStart, rxSeqEnd: this.rxSeqEnd, ackFlags: this.ackFlags++ }));
		this.#setTimer("ackTicker", () => {
			if (this.dtls?.keys && this.state !== "down" && !this.closed) {
				this.#sendAv(buildACK({ avSeq: this.avSeq++, rxSeqStart: this.rxSeqStart, rxSeqEnd: this.rxSeqEnd, ackFlags: this.ackFlags++ }));
			}
		}, 100, true);
		// K-auth: challenge → response → auth result.
		this.#setState("kauth");
		this.pendingWait = { cmdId: K_CMD.CHALLENGE, handler: (hl) => this.#onKChallenge(hl) };
		this.#sendCtrl(buildK10000());
		this.#setTimer("kauthBudget", () => {
			if (this.state === "kauth") this.#fail("the camera answered the AV login but not the K-auth within ten seconds");
		}, LOGIN_BUDGET_MS);
	}

	#onKChallenge(hl) {
		const challenge = parseK10001(hl);
		if (!challenge) {
			this.#fail("the camera's K-auth challenge could not be parsed");
			return;
		}
		const response = generateChallengeResponse(challenge.challenge, this.enr, challenge.status);
		this.#sendCtrl(buildK10002({ response, sessionId: this.random(4) }));
		this.pendingWait = { cmdId: K_CMD.AUTH_RESULT, handler: (hl2) => this.#onKResult(hl2) };
	}

	#onKResult(hl) {
		const auth = parseK10003(hl);
		const hasAudio = String(auth?.cameraInfo?.channelRequestResult?.audio ?? "1") === "1";
		this.capabilities.hasAudio = hasAudio;
		// Open the video + audio channels (K10010) and set the resolution.
		this.#sendCtrl(buildK10010({ mediaType: 1, enabled: true }));
		if (hasAudio) this.#sendCtrl(buildK10010({ mediaType: 2, enabled: true }));
		this.#sendCtrl(this.#buildResolution());
		this.#clearTimer("kauthBudget");
		this.#setState("streaming");
		this.emit("ready", { hasAudio, hasTwoWay: this.capabilities.hasTwoWay === true });
	}

	#sendCtrl(hlWire) {
		this.#sendAv(buildIOCtrl({ payload: hlWire, avSeq: this.avSeq++, seqCmd: this.seqCmd++ }));
	}

	#buildResolution() {
		const sd = this.subtype === "sd";
		const frameSize = sd ? FRAME_SIZE.F_360P : this.isFloodlight() ? FRAME_SIZE.F_FLOODLIGHT : this.is2K() ? FRAME_SIZE.F_2K : FRAME_SIZE.F_1080P;
		const bitrate = sd ? BITRATE.SD : BITRATE.MAX;
		if (isDoorbellResolutionModel(this.model)) {
			return buildK10052({ frameSize, bitrate });
		}
		return buildK10056({ frameSize, bitrate });
	}

	is2K() {
		return this.subtype !== "sd" && is2KModel(this.model);
	}
	isFloodlight() {
		return this.subtype !== "sd" && isFloodlightModel(this.model);
	}

	#fail(reason) {
		if (this.closed) return;
		this.#clearAllTimers();
		// The socket stays open for a retrying owner; the DTLS client dies so
		// no half-keyed record is processed after a failure.
		this.dtls = null;
		this.#setState("down", reason);
		this.emit("error", new Error(reason));
	}

	/** Close the session; idempotent. */
	close() {
		if (this.closed) return;
		this.closed = true;
		this.#clearAllTimers();
		this.#setState("down", "the session was closed");
		if (this.socket) {
			try {
				this.socket.close();
			} catch { /* already closed */ }
			this.socket = null;
		}
		this.dtls = null;
		this.emit("close");
	}
}

/** Route a camera AV datagram into the frame handler (channel 3/5/7). */
function dtlsFrameRoute(session, plain) {
	const channel = plain[0];
	if (session.frames && (channel === 0x03 || channel === 0x05 || channel === 0x07)) {
		session.frames.handle(plain);
	}
}

export { buildHL };
