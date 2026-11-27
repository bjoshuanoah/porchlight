// test/helpers/camera.mjs — the contract-test fake Wyze camera (PORCH-131).
//
// A UDP peer that speaks the session of record end to end so the adapter's
// contract tests run offline (the live-camera e2e stays env-gated):
// discovery + session bind (clear-text IOTC), the DTLS-PSK handshake
// (channel 0), the AV login/K-auth dance, and a scripted frame feed
// (H.264-style video access units + PCM audio) inside DATA_TX datagrams.
// It also records every wire packet the adapter sent for behavior
// assertions (connect/disconnect/audio/video per the contract).

import { createSocket } from "node:dgram";
import {
	buildKeepaliveReq, buildSessionDataRx,
	decodeIotcDatagram, encodeIotcDatagram, IOTC_CMD,
	isCc51Datagram,
} from "../../src/iotc.js";
import { transCodeBlob } from "../../src/crypto.js";
import { DtlsPskServer } from "../../src/dtls/server.js";
import { derivePsk } from "../../src/dtls/keys.js";
import { buildK10001Wire, buildIOCtrl, buildK10003Wire } from "./av-server.mjs";
import { extractHLFromAv, parseHL as parseHlWire } from "../../src/av.js";
import { buildVideoAccessUnit, buildAudioPacket } from "./frames.mjs";

const HL_HELPERS = { extractHLFromAv, parseHL: parseHlWire };

/** The fake camera's fixed credential of record (test-only ENR/MAC). */
export const FAKE_ENR = "TESTENR0123456789";
export const FAKE_MAC = "AABBCCDDEEFF";

export class FakeWyzeCamera {
	/**
	 * @param {{
	 *   enr?: string, mac?: string, uid?: string,
	 *   cc51?: boolean,              // answer discovery as a CC51 camera
	 *   refuseDtls?: boolean,        // accept the session but never handshake
	 *   dropAfter?: number,          // stop answering after N frames (camera drop)
	 *   authStatus?: 1|3|6,          // K-auth challenge status class
	 *   frames?: { width?: number, height?: number, fps?: number, audio?: boolean },
	 *   log?: (l: string) => void,
	 * }} opts
	 */
	constructor({ enr = FAKE_ENR, mac = FAKE_MAC, uid = "FAKEUID1234567890A", cc51 = false, refuseDtls = false, authStatus = 3, frames = { width: 160, height: 90, fps: 10, audio: true }, log = () => {} } = {}) {
		this.enr = enr;
		this.mac = mac;
		this.uid = uid;
		this.cc51 = cc51;
		this.refuseDtls = refuseDtls;
		this.authStatus = authStatus;
		this.framesCfg = frames;
		this.log = log;
		this.hlmod = HL_HELPERS;
		this.sent = [];
		this.session = null;
		this.dtls = null;
		this.socket = null;
		this.addr = null;
		this.port = 0;
		this.stopped = false;
	}

	async listen() {
		this.socket = createSocket("udp4");
		await new Promise((resolve) => this.socket.bind(0, "127.0.0.1", resolve));
		this.port = this.socket.address().port;
		this.socket.on("message", (msg, rinfo) => this.#onDatagram(msg, rinfo));
		return { port: this.port, url: `wyze://127.0.0.1:${this.port}?uid=${this.uid}&enr=${this.enr}&mac=${this.mac}&model=WYZE_CAKP2JFUS&dtls=true` };
	}

	close() {
		this.stopped = true;
		try {
			this.socket?.close();
		} catch { /* already */ }
		try {
			this.dtls?.clearTimer();
		} catch { /* no timers */ }
	}

	#send(wire) {
		if (this.stopped || (this.dropAfter !== undefined && this.sent.length >= this.dropAfter)) return;
		this.sent.push(wire);
		this.socket.send(wire, this.addr.port, this.addr.address);
	}

	#onDatagram(wire, rinfo) {
		if (isCc51Datagram(wire) && this.cc51) {
			// Nothing to negotiate: the adapter refuses on seeing the magic.
			return;
		}
		const iotc = decodeIotcDatagram(wire);
		if (!iotc) return;
		this.addr ??= { address: rinfo.address, port: rinfo.port };
		if (iotc.cmd === IOTC_CMD.DISCO_REQ) {
			if (this.cc51) {
				// Send the CC51 discovery magic (adapter must refuse it).
				const cc = Buffer.alloc(52);
				cc[0] = 0x51; cc[1] = 0xcc;
				this.socket.send(cc, rinfo.port, rinfo.address);
				return;
			}
			// disco res: 16-byte IOTC header + body; the adapter only checks
			// cmd at offset 8, so a minimal res with the flags of record.
			const res = Buffer.alloc(16 + 36);
			res.writeUInt16LE(36, 4);
			res.writeUInt16LE(IOTC_CMD.DISCO_RES, 8);
			res.writeUInt16LE(0x0012, 10);
			this.#send(transCodeBlob(res));
			return;
		}
		if (iotc.cmd === IOTC_CMD.SESSION_REQ) {
			this.session = { sid: iotc.body.subarray(20, 28) };
			const res = Buffer.alloc(16 + 36);
			res.writeUInt16LE(36, 4);
			res.writeUInt16LE(IOTC_CMD.SESSION_RES, 8);
			res.writeUInt16LE(0x0033, 10);
			this.#send(transCodeBlob(res));
			if (!this.refuseDtls) {
				this.dtls = new DtlsPskServer({
					psk: derivePsk(this.enr),
					// The camera of record speaks the CCAC suite against the
					// pion-style client of record.
					suites: [0xccac, 0x00a9],
					requireHelloVerify: false,
				}).start();
				this.dtls.on("connect", () => {
					this.log("camera: DTLS up — AV phase");
					this.#avPhase();
				});
				// Established: the adapter's decrypted records feed the AV
				// phase machine (login → K-auth → channel opens).
				this.dtls.on("applicationData", (p) => this.#onAv(p));
			}
			return;
		}
		if (iotc.cmd === IOTC_CMD.KEEPALIVE_RES) {
			if (iotc.body.length > 8) this.#send(encodeIotcDatagram(buildKeepaliveReq(iotc.body)));
			return;
		}
		if (iotc.cmd === IOTC_CMD.DATA_TX && this.dtls && iotc.raw.length > 28) {
			const payload = iotc.raw.subarray(28);
			const channel = iotc.raw[14];
			// Every server-side output burst is client-bound: forward it.
			const reply = this.dtls.push(payload);
			for (const out of reply.out) {
				if (!out.length) continue;
				this.#send(encodeIotcDatagram(buildSessionDataRx({ payload: out, channel, seq: 0, sid: this.session.sid })));
			}
			return;
		}
	}

	#avPhase() {
		this.avStage = "login";
		// AV login response (magic 0x2100): two-way streaming enabled.
		const resp = Buffer.alloc(60);
		resp.writeUInt16LE(0x2100, 0);
		resp.writeUInt16LE(0x000c, 2);
		resp[4] = 0x10;
		resp.writeUInt32LE(0x24, 16);
		resp[31] = 1;
		this.#sendDtls(resp);
		// K10001 challenge (IOCtrl-wrapped HL).
		this.#sendDtls(buildIOCtrl(buildK10001Wire(this.authStatus)));
		this.avStage = "k10001";
	}

	#sendDtls(payload) {
		// Camera → adapter AV records ride the DTLS channel (encrypted) and
		// the DATA_RX (0x0408) IOTC frame — mirror of the reference conn.
		if (!this.dtls?.state || this.dtls.state === "wait-ch" || this.dtls.state === "wait-cke" || this.dtls.state === "wait-finished") {
			// The handshake channel is not keyed yet (should not happen).
			this.log("camera refuses to send an AV record without DTLS keys");
			return;
		}
		const record = this.dtls.sendApplicationData(payload);
		this.#send(encodeIotcDatagram(buildSessionDataRx({ payload: record, channel: 0, seq: 0, sid: this.session.sid })));
	}

	/** The AV control-plane machine: parse the adapter's wrapped HL records
	 *  (K10002 → reply K10003; K10010 → streaming). The AV datagrams may
	 *  arrive before this camera finishes sending its flight 6, so the
	 *  machine keys on the WIRE COMMANDS — not a phase flag. */
	#onAv(rec) {
		if (rec.length < 2) return;
		const avMod = (this.avMod ??= null);
		void avMod;
		let hl = null;
		if (rec[0] === 0x48 && rec[1] === 0x4c) hl = rec;
		else if ([0x7000, 0x1000, 0x000c].includes(rec.readUInt16LE(0))) {
			// The adapter wraps HL payloads in the AV IOCtrl record at 40.
			if (rec.length > 40 && rec[40] === 0x48) hl = rec.subarray(40);
			else {
				const { extractHLFromAv } = this.hlmod;
				hl = extractHLFromAv(rec);
			}
		}
		if (!hl) return;
		const parsed = this.hlmod.parseHL(hl);
		if (!parsed) return;
		if (parsed.cmdId === 10002) {
			this.k10002Seen = true;
			this.#sendDtls(buildIOCtrl(buildK10003Wire({ audio: this.framesCfg.audio })));
			return;
		}
		if (parsed.cmdId === 10010) {
			this.videoOpened = true;
			this.log("camera: streaming phase");
		}
	}

	/** Stream one scripted frame batch (video access unit + audio). */
	stream(nowMs = 0) {
		if (!this.dtls || this.dtls.state !== "established" || !this.videoOpened) return false;
		const seq = (this.frameNo = (this.frameNo ?? 0) + 1);
		const ts = nowMs || seq * 66667;
		const chunks = 2;
		const size = this.framesCfg.width * 3;
		const au = Array.from({ length: chunks }, (_, i) => Buffer.from(Array.from({ length: size }, (_, j) => (i * 7 + j * 13) % 256)));
		for (const pkt of buildVideoAccessUnit({ frameNo: seq, chunks: au, timestamp: Math.floor(ts / 1000), keyframe: seq % 5 === 1 })) {
			this.#sendDtls(pkt);
		}
		if (this.framesCfg.audio) {
			this.#sendDtls(buildAudioPacket({ frameNo: seq, timestamp: Math.floor(ts / 1000), samples: 160, rate: 8000 }));
		}
		return true;
	}

	/** The K-auth answer observed (contract evidence helper). */
	kAuthConfirmed() {
		return this.k10002Seen === true && this.videoOpened === true;
	}
}
