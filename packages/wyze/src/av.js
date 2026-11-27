// av.js — the AV channel layer of the Wyze DTLS session (PORCH-131): the
// post-handshake message set that rides the DTLS records, ported from the
// reverse-engineered reference (go2rtc pkg/wyze/client.go + the conn's AV
// framing): AV login, the HL/IOTC control channel (K-commands), resolution
// selection, and the ACK cadence. Wire-exact: builders are tested against
// vectors generated from the reference (packages/wyze/test/av.test.js).

import { xxteaDecryptVar } from "./crypto.js";

/** HL/IOTC control commands (cmd IDs in the HL messages). */
export const K_CMD = Object.freeze({
	AUTH: 10000,
	CHALLENGE: 10001,
	CHALLENGE_RESP: 10002,
	AUTH_RESULT: 10003,
	CONTROL_CHANNEL: 10010,
	CONTROL_CHANNEL_RESP: 10011,
	SET_RESOLUTION_DB: 10052,
	SET_RESOLUTION_DB_RES: 10053,
	SET_RESOLUTION: 10056,
	SET_RESOLUTION_RESP: 10057,
});

/** AV-layer magic codes (little-endian message prefixes). */
export const AV_MAGIC = Object.freeze({
	AV_LOGIN_RESP: 0x2100,
	IO_CTRL: 0x7000,
	CHANNEL_MSG: 0x1000,
	ACK: 0x0009,
	AV_LOGIN_1: 0x0000,
	AV_LOGIN_2: 0x2000,
	PROTO_VERSION: 0x000c,
});

/** Camera "HL" message media types for the control-channel open. */
export const MEDIA_TYPE = Object.freeze({
	VIDEO: 1,
	AUDIO: 2,
	RETURN_AUDIO: 3,
	RDT: 4,
});

export const DEFAULT_CAPS = 0x001f07fb;

/**
 * HL envelope: magic "HL" + version 5 + cmdID (LE) + payload len (LE).
 * @param {number} cmdId
 * @param {Buffer|Uint8Array|string} payload
 * @returns {Buffer}
 */
export function buildHL(cmdId, payload) {
	const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload?.toString() ?? "", "utf8");
	const b = Buffer.alloc(16 + p.length);
	b[0] = 0x48; // "H"
	b[1] = 0x4c; // "L"
	b[2] = 5; // version
	b.writeUInt16LE(cmdId, 4);
	b.writeUInt16LE(p.length, 6);
	p.copy(b, 16);
	return b;
}

/** Parse an HL message; null when the data does not open with magic HL. */
export function parseHL(data) {
	if (!data || data.length < 16 || data[0] !== 0x48 || data[1] !== 0x4c) return null;
	return {
		cmdId: data.readUInt16LE(4),
		payload: data.subarray(16, 16 + Math.min(data.readUInt16LE(6), data.length - 16)),
	};
}

/** Find an embedded HL message starting at or after `offset`. */
export function findHL(data, offset) {
	data = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
	for (let i = offset; i + 16 <= data.length; i++) {
		if (data[i] === 0x48 && data[i + 1] === 0x4c) return data.subarray(i);
	}
	return null;
}

/**
 * Generate the K10002 challenge response under the status class (go2rtc
 * pkg/wyze/client.go generateChallengeResponse).
 */
export const CHALLENGE_STATUS = Object.freeze({ DEFAULT: 1, ENR16: 3, ENR32: 6 });

/**
 * generateChallengeResponse — K10002's 16-byte answer keyed by the status
 * byte the camera chose (see crypto.js xxteaDecryptVar for the engine).
 * @param {Buffer} challenge 16 bytes from K10001
 * @param {string} enr
 * @param {number} status 1 | 3 | 6
 * @returns {Buffer} 16-byte response
 */
export function generateChallengeResponse(challengeBytes, enr, status) {
	const enrBuf = Buffer.from(enr, "utf8");
	let secretKey;
	let work = Buffer.from(challengeBytes);
	switch (status) {
		case CHALLENGE_STATUS.DEFAULT:
			secretKey = Buffer.from("FFFFFFFFFFFFFFFF", "ascii");
			break;
		case CHALLENGE_STATUS.ENR16:
			secretKey = enrBuf.length >= 16 ? enrBuf.subarray(0, 16) : Buffer.alloc(16, 0).fill(enrBuf);
			break;
		case CHALLENGE_STATUS.ENR32:
			if (enrBuf.length >= 16) {
				const dec = xxteaDecryptVar(work, enrBuf.subarray(0, 16));
				if (dec) work = dec;
			}
			secretKey =
				enrBuf.length >= 32
					? enrBuf.subarray(16, 32)
					: enrBuf.length > 16
						? Buffer.alloc(16).fill(enrBuf.subarray(16))
						: Buffer.from("FFFFFFFFFFFFFFFF", "ascii");
			break;
		default:
			secretKey = Buffer.from("FFFFFFFFFFFFFFFF", "ascii");
	}
	return xxteaDecryptVar(work, secretKey) ?? Buffer.alloc(16);
}

/**
 * buildK10000 — the auth start (HL cmd 10000) declaring the audio codecs
 * the client speaks (PCMU 137, PCMA 138, PCM 140).
 * @returns {Buffer} HL wire
 */
export function buildK10000() {
	return buildHL(K_CMD.AUTH, `{"cameraInfo":{"audioEncoderList":[137,138,140]}}`);
}

/**
 * buildK10002 — the challenge answer (HL cmd 10002): 16-byte response +
 * random 4-byte session id + video/audio enable flags.
 * @param {{ response: Buffer, sessionId: Buffer }} p
 * @returns {Buffer} 38-byte wire
 */
export function buildK10002({ response, sessionId }) {
	const b = Buffer.alloc(38);
	b[0] = 0x48; b[1] = 0x4c;
	b[2] = 5;
	b.writeUInt16LE(K_CMD.CHALLENGE_RESP, 4);
	b[6] = 22;
	response.subarray(0, 16).copy(b, 16);
	sessionId.subarray(0, 4).copy(b, 32);
	b[36] = 1; // video enabled
	b[37] = 1; // audio enabled
	return b;
}

/** parseK10001 — challenge (16 bytes) + status byte. */
export function parseK10001(hlData) {
	if (!hlData || hlData.length < 33 || hlData[0] !== 0x48 || hlData[1] !== 0x4c) return null;
	const cmdId = hlData.readUInt16LE(4);
	if (cmdId !== K_CMD.CHALLENGE) return null;
	return { status: hlData[16], challenge: Buffer.from(hlData.subarray(17, 33)) };
}

/** parseK10003 — the auth result JSON (cameraInfo). */
export function parseK10003(hlData) {
	if (!hlData || hlData.length < 16 || hlData[0] !== 0x48 || hlData[1] !== 0x4c) return {};
	const cmdId = hlData.readUInt16LE(4);
	const textLen = hlData.readUInt16LE(6);
	if (cmdId !== K_CMD.AUTH_RESULT) return {};
	if (hlData.length > 16 && textLen > 0) {
		const json = hlData.subarray(16);
		const brace = json.indexOf(0x7b); // {
		if (brace !== -1) {
			try {
				return JSON.parse(json.subarray(brace).toString("utf8"));
			} catch {
				return {};
			}
		}
	}
	return {};
}

/**
 * buildK10010 — the control-channel open/close (HL cmd 10010).
 * @param {{ mediaType: number|string, enabled: boolean }} p
 * @returns {Buffer} 18-byte wire
 */
export function buildK10010({ mediaType, enabled }) {
	const b = Buffer.alloc(18);
	b[0] = 0x48; b[1] = 0x4c;
	b[2] = 5;
	b.writeUInt16LE(K_CMD.CONTROL_CHANNEL, 4);
	b.writeUInt16LE(2, 6);
	b[16] = typeof mediaType === "string" ? MEDIA_TYPE[mediaType] : mediaType;
	b[17] = enabled ? 1 : 2;
	return b;
}

/**
 * buildK10056 — the resolution request (HL cmd 10056, non-doorbell path).
 * @param {{ frameSize: number, bitrate: number }} p
 * @returns {Buffer} 21-byte wire
 */
export function buildK10056({ frameSize, bitrate }) {
	const b = Buffer.alloc(21);
	b[0] = 0x48; b[1] = 0x4c;
	b[2] = 5;
	b.writeUInt16LE(K_CMD.SET_RESOLUTION, 4);
	b.writeUInt16LE(5, 6);
	b[16] = frameSize + 1;
	b.writeUInt16LE(bitrate, 17);
	return b;
}

/**
 * buildK10052 — the doorbell-family resolution request (HL cmd 10052).
 * @param {{ frameSize: number, bitrate: number }} p
 * @returns {Buffer} 22-byte wire
 */
export function buildK10052({ frameSize, bitrate }) {
	const b = Buffer.alloc(22);
	b[0] = 0x48; b[1] = 0x4c;
	b[2] = 5;
	b.writeUInt16LE(K_CMD.SET_RESOLUTION_DB, 4);
	b.writeUInt16LE(6, 6);
	b.writeUInt16LE(bitrate, 16);
	b[18] = frameSize + 1;
	return b;
}

/**
 * Frame-size constants of record (go2rtc FrameSize*).
 */
export const FRAME_SIZE = Object.freeze({
	F_1080P: 0,
	F_360P: 1,
	F_720P: 2,
	F_2K: 3,
	F_FLOODLIGHT: 4,
});
export const BITRATE = Object.freeze({ MAX: 0xf0, SD: 0x3c });

/** Camera model helpers of record (go2rtc client.go).
 *  The 2K set includes the confirmed models HL_DB2 and WYZE_CAKP2JFUS. */
export function is2KModel(model) {
	return ["HL_CAM3P", "HL_PANP", "HL_CAM4", "HL_DB2", "WYZE_CAKP2JFUS", "HL_CFL2"].includes(model);
}
export function isDoorbellResolutionModel(model) {
	return ["WYZEDB3", "WVOD1", "HL_WCO2", "WYZEC1"].includes(model);
}
export function isFloodlightModel(model) {
	return model === "HL_CFL2";
}

/**
 * buildAVLogin — the two AV-login datagrams sent on the DTLS channel
 * (magic 0x0000/0x2000). Body: username "admin" at 24 and the ENR at 280.
 * @param {{ enr: string, variant: 1|2, randomId: Buffer }} p
 * @returns {Buffer} 570/572 bytes
 */
export function buildAVLogin({ enr, variant, randomId }) {
	const size = variant === 1 ? 570 : 572;
	const magic = variant === 1 ? AV_MAGIC.AV_LOGIN_1 : AV_MAGIC.AV_LOGIN_2;
	const b = Buffer.alloc(size);
	b.writeUInt16LE(magic, 0);
	b.writeUInt16LE(AV_MAGIC.PROTO_VERSION, 2);
	b.writeUInt16LE(size - 24, 16);
	b.writeUInt16LE(variant === 1 ? 0x0001 : 0x0000, 18);
	const id = variant === 2 ? inc4(randomId) : randomId;
	id.subarray(0, 4).copy(b, 20);
	b.write("admin", 24, "ascii");
	b.write(enr, 280, "ascii");
	b.writeUInt32LE(4, 540);
	b.writeUInt32LE(DEFAULT_CAPS, 552);
	return b;
}

function inc4(id) {
	const c = Buffer.from(id);
	let carry = 1;
	for (let i = 0; i < 4 && carry; i++) {
		const v = (c[i] + carry) & 0xff;
		carry = v === 0 ? 1 : 0;
		c[i] = v;
	}
	return c;
}

/** parseAVLoginResp — two-way streaming flag at offset 31. */
export function parseAVLoginResp(data) {
	if (!data || data.length < 32 || data.readUInt16LE(0) !== AV_MAGIC.AV_LOGIN_RESP) return null;
	return { hasTwoWayStreaming: data[31] === 1 };
}

/**
 * buildIOCtrl — the AV-layer IOTC control message wrapping an HL payload.
 * Wire: protoVersion(2)|protoVersion(2)|avSeq(4)|[4]|magic 0x7000(2)|
 * subChannel(2)|ioctlSeq 1(4)|payloadLen(4)|flag seqCmd(4)|0x01|payload.
 * @param {{ payload: Buffer, avSeq: number, seqCmd: number }} p
 * @returns {Buffer} 40 + payload bytes
 */
export function buildIOCtrl({ payload, avSeq, seqCmd }) {
	const b = Buffer.alloc(40 + payload.length);
	b.writeUInt16LE(AV_MAGIC.PROTO_VERSION, 0);
	b.writeUInt16LE(AV_MAGIC.PROTO_VERSION, 2);
	b.writeUInt32LE(avSeq, 4);
	b.writeUInt16LE(AV_MAGIC.IO_CTRL, 16);
	b.writeUInt16LE(seqCmd & 0xffff, 18);
	b.writeUInt32LE(1, 20);
	b.writeUInt32LE(payload.length + 4, 24);
	b.writeUInt32LE(seqCmd, 28);
	b[37] = 0x01;
	payload.copy(b, 40);
	return b;
}

/**
 * buildACK — the 24-byte streaming ACK the session sends at 100 ms cadence
 * and on every control response (go2rtc msgACK).
 * @param {{ avSeq: number, rxSeqStart: number, rxSeqEnd: number, ackFlags: number }} p
 * @returns {Buffer}
 */
export function buildACK({ avSeq, rxSeqStart, rxSeqEnd, ackFlags }) {
	const b = Buffer.alloc(24);
	b.writeUInt16LE(AV_MAGIC.ACK, 0);
	b.writeUInt16LE(AV_MAGIC.PROTO_VERSION, 2);
	b.writeUInt32LE(avSeq, 4);
	b.writeUInt16LE(rxSeqStart, 8);
	b.writeUInt16LE(rxSeqEnd, 10);
	b.writeUInt16LE(ackFlags, 12);
	b.writeUInt32LE(ackFlags << 16 >>> 0, 16);
	return b;
}

/**
 * buildAVLoginResponse — the backchannel's answer to the camera's AV login
 * when WE act as the speaker server (intercom ready path).
 * @param {number} checksum echoed from the camera's login
 * @returns {Buffer} 60 bytes
 */
export function buildAVLoginResponse(checksum) {
	const b = Buffer.alloc(60);
	b.writeUInt16LE(AV_MAGIC.AV_LOGIN_RESP, 0);
	b.writeUInt16LE(AV_MAGIC.PROTO_VERSION, 2);
	b[4] = 0x10;
	b.writeUInt32LE(0x24, 16);
	b.writeUInt32LE(checksum, 20);
	b[29] = 0x01;
	b[31] = 0x01;
	b.writeUInt32LE(4, 36);
	b.writeUInt32LE(DEFAULT_CAPS, 40);
	b.writeUInt16LE(3, 54);
	b.writeUInt16LE(2, 56);
	return b;
}

/** parseIOCtrlBody — the IOTC payload starts at offset 40 of an AV rec. */
export function extractHLFromAv(data) {
	return findHL(data, 32) ?? findHL(data, 36);
}
