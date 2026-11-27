// iotc.js — the IOTC session0 wire layer of the Wyze DTLS P2P session
// (PORCH-131): discovery, session bind, and keep-alive framing that rides
// UDP 32761 in the clear but under the "Charlie" obfuscation (crypto.js).
//
// Port of the reverse-engineered knowledge mirrored by go2rtc
// (pkg/tutk/dtls/conn_dtls.go, the non-CC51 IOTC-Basis path). Every builder
// here is pure and contract-tested byte-for-byte against vectors generated
// from the reference (packages/wyze/test/iotc.test.js). The CC51 datagram
// variant is intentionally not ported: no camera model of record
// (HL_DB2 / WYZE_CAKP2JFUS) speaks it — a CC51 reply on discovery is
// detected and refused with a plain-language error instead.

import { reverseTransCodeBlob, transCodeBlob } from "./crypto.js";

/** IOTC command codes (little-endian at wire offset 8). */
export const IOTC_CMD = Object.freeze({
	DISCO_REQ: 0x0601,
	DISCO_RES: 0x0602,
	SESSION_REQ: 0x0402,
	SESSION_RES: 0x0404,
	DATA_TX: 0x0407,
	DATA_RX: 0x0408,
	KEEPALIVE_REQ: 0x0427,
	KEEPALIVE_RES: 0x0428,
});

/** DTLS-path discovery/session header: "\x04\x02\x1a\x02". */
export const IOTC_MAGIC = Buffer.from([0x04, 0x02, 0x1a, 0x02]);
/** Data-mode header variant: "\x04\x02\x1a\x0b" (data TX frames). */
export const IOTC_MAGIC_DATA = Buffer.from([0x04, 0x02, 0x1a, 0x0b]);
/** Keepalive-mode header variant: "\x04\x02\x1a\x0a". */
export const IOTC_MAGIC_KEEPALIVE = Buffer.from([0x04, 0x02, 0x1a, 0x0a]);

/** Emulated SDK version string of record (go2rtc: SDK 4.2.1.1). */
export const SDK_VERSION = Buffer.from([0x01, 0x01, 0x02, 0x04]);

export const IOTC_HEADER_SIZE = 16;
export const DISCOVERY_STAGE = Object.freeze({ DISCOVER: 1, DIRECT: 2 });
export const DISCOVERY_PORT = 32761;
export const DISCOVERY_INTERVAL_MS = 100;
export const DISCOVERY_TIMEOUT_MS = 5000;

/**
 * genSessionID — the 8-byte session id (go2rtc: unix-nano, little-endian).
 * @param {() => number} [nowMs] injectable wall clock
 * @returns {Buffer} 8 bytes
 */
export function genSessionID(nowMs = Date.now) {
	const v = (BigInt(nowMs()) * 1_000_000n) & 0xffffffffffffffffn;
	const b = Buffer.alloc(8);
	b.writeUInt32LE(Number(v & 0xffffffffn), 0);
	b.writeUInt32LE(Number(v >> 32n), 4);
	return b;
}

/**
 * buildDisco — the discovery request (stage 1 carries the auth key, so the
 * camera can validate the ENR-derived credential before anything else).
 * @param {{ stage: number, uid: string, authKey: string, sid: Buffer }} p
 * @returns {Buffer} 88-byte plaintext (transCodeBlob() it before the wire)
 */
export function buildDisco({ stage, uid, authKey, sid }) {
	if (!uid || !sid || sid.length !== 8) {
		throw new Error(`buildDisco needs a uid and an 8-byte sid (got sid ${sid?.length ?? "none"})`);
	}
	const b = Buffer.alloc(16 + 72);
	IOTC_MAGIC.copy(b, 0);
	b.writeUInt16LE(72, 4); // body size
	b.writeUInt16LE(IOTC_CMD.DISCO_REQ, 8);
	b.writeUInt16LE(0x0021, 10); // flags
	Buffer.from(uid, "utf8").copy(b, 16, 0, 20); // body[0:20]
	SDK_VERSION.copy(b, 52); // body[36:40]
	sid.copy(b, 56); // body[40:48]
	b[64] = stage; // body[48]
	if (stage === DISCOVERY_STAGE.DISCOVER && authKey) {
		Buffer.from(authKey, "utf8").copy(b, 74, 0, 8); // body[58:66]
	}
	return b;
}

/**
 * buildSession — the session-bind request right after discovery answers.
 * @param {{ uid: string, sid: Buffer, nowSec: number }} p
 * @returns {Buffer} 52-byte plaintext
 */
export function buildSession({ uid, sid, nowSec }) {
	if (!uid || !sid || sid.length !== 8) {
		throw new Error(`buildSession needs a uid and an 8-byte sid (got sid ${sid?.length ?? "none"})`);
	}
	const b = Buffer.alloc(16 + 36);
	IOTC_MAGIC.copy(b, 0);
	b.writeUInt16LE(36, 4);
	b.writeUInt16LE(IOTC_CMD.SESSION_REQ, 8);
	b.writeUInt16LE(0x0033, 10);
	Buffer.from(uid, "utf8").copy(b, 16, 0, 20);
	sid.copy(b, 36); // body[20:28]
	b.writeUInt32LE(nowSec >>> 0, 48); // body[32:36]
	return b;
}

/**
 * buildKeepaliveReq — answers cmdKeepaliveRes by echoing the camera's
 * payload bytes; missing echo = a zero-payload request.
 * @param {Buffer} [incoming] the camera response payload (data[16:])
 * @returns {Buffer} 24-byte plaintext
 */
export function buildKeepaliveReq(incoming) {
	const b = Buffer.alloc(24);
	IOTC_MAGIC_KEEPALIVE.copy(b, 0);
	b.writeUInt16LE(8, 4);
	b.writeUInt16LE(IOTC_CMD.KEEPALIVE_REQ, 8);
	b.writeUInt16LE(0x0021, 10);
	if (incoming && incoming.length >= 8) incoming.subarray(0, 8).copy(b, 16);
	return b;
}

/**
 * buildSessionDataRx — the channel-data frame the CAMERA → adapter
 * direction uses (cmdDataRX 0x0408): same 12-byte routing block as the TX
 * frame (parseable identically after the blob-decode).
 * @param {{ payload: Buffer, channel: number, seq: number, sid: Buffer }} p
 * @returns {Buffer} plaintext frame
 */
export function buildSessionDataRx({ payload, channel, seq, sid }) {
	const b = buildSessionDataTx({ payload, channel, seq, sid });
	b.writeUInt16LE(IOTC_CMD.DATA_RX, 8);
	return b;
}

/**
 * buildSessionDataTx — the channel-data upstream frame (DTLS payloads ride
 * inside body[28:]): 16-byte header + 12-byte routing + payload.
 * @param {{ payload: Buffer, channel: number, seq: number, sid: Buffer }} p
 * @returns {Buffer} plaintext frame (44 + payload bytes)
 */
export function buildSessionDataTx({ payload, channel, seq, sid }) {
	const bodySize = 12 + payload.length;
	const b = Buffer.alloc(16 + bodySize);
	IOTC_MAGIC_DATA.copy(b, 0);
	b.writeUInt16LE(bodySize, 4);
	b.writeUInt16LE(seq & 0xffff, 6);
	b.writeUInt16LE(IOTC_CMD.DATA_TX, 8);
	b.writeUInt16LE(0x0021, 10);
	b[12] = sid[0]; // rid[0:2]
	b[13] = sid[1];
	b[14] = channel;
	b[15] = 0x01; // marker
	b.writeUInt32LE(0x0000000c, 16); // const
	sid.subarray(0, 8).copy(b, 20); // rid
	payload.copy(b, 28);
	return b;
}

/**
 * parseIotc — decode a reverse-blob'd datagram into its command shape.
 * @param {Buffer} data plaintext (already through reverseTransCodeBlob)
 * @returns {{ cmd: number, flags: number, bodySize: number, body: Buffer } | null}
 */
export function parseIotc(data) {
	if (!data || data.length < 16) return null;
	const cmd = data.readUInt16LE(8);
	const flags = data.readUInt16LE(10);
	const bodySize = data.readUInt16LE(4);
	const body = data.length > 16 ? data.subarray(16, Math.min(16 + bodySize, data.length)) : Buffer.alloc(0);
	return { cmd, flags, bodySize, body, raw: Buffer.from(data) };
}

/**
 * decodeIotcDatagram — the production read path: reverse-obfuscate an
 * incoming datagram and parse it.
 * @param {Buffer} wire
 * @returns {{ cmd: number, flags: number, bodySize: number, body: Buffer } | null}
 */
export function decodeIotcDatagram(wire) {
	if (!wire) return null;
	const plain = reverseTransCodeBlob(Buffer.from(wire));
	return parseIotc(plain);
}

/**
 * encodeIotcDatagram — the production write path: obfuscate a plaintext
 * packet for the wire.
 * @param {Buffer} plain
 * @returns {Buffer}
 */
export function encodeIotcDatagram(plain) {
	return transCodeBlob(plain);
}

/** True when the datagram carries the CC51 magic ("\x51\xcc") — the
 *  Gwell-family protocol variant this adapter explicitly refuses (no
 *  camera model of record speaks it; the owner gets a plain-language
 *  state instead of a dead hang). */
export function isCc51Datagram(wire) {
	return !!wire && wire.length >= 2 && wire[0] === 0x51 && wire[1] === 0xcc;
}
