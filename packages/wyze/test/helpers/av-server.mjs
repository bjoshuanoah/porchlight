// test/helpers/av-server.mjs — the fake camera's AV control-plane builders
// (PORCH-131 contract harness): the camera-side HL wires the adapter must
// parse, in the reference byte shapes (go2rtc pkg/wyze client.go parsers).

import { buildHL, K_CMD } from "../../src/av.js";

/**
 * K10001 challenge wire (camera → client): HL(cmd 10001) with payload:
 * [0] status byte, [1..17) the 16-byte challenge.
 * @param {1|3|6} status
 * @returns {Buffer} full IOCtrl-wrapped AV record
 */
export function buildK10001Wire(status, challenge = null) {
	const ch = challenge ?? Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c]);
	const payload = Buffer.alloc(17);
	payload[0] = status;
	ch.copy(payload, 1);
	return buildHL(K_CMD.CHALLENGE, payload);
}

/**
 * K10003 auth result wire (camera → client): HL(cmd 10003) with the
 * cameraInfo JSON of record (audio enabled, per the reference).
 */
export function buildK10003Wire({ audio = true } = {}) {
	const json = JSON.stringify({
		cameraInfo: {
			channelRequestResult: { audio: audio ? "1" : "0" },
		},
	});
	return buildHL(K_CMD.AUTH_RESULT, Buffer.from(json, "utf8"));
}

/**
 * The IOCtrl wrapper the camera's control messages ride inside the AV
 * channel (go2rtc msgIOCtrl wire shape, camera → client direction).
 * @param {Buffer} hlWire
 * @returns {Buffer}
 */
export function buildIOCtrl(hlWire, { avSeq = 0, seqCmd = 0 } = {}) {
	const b = Buffer.alloc(40 + hlWire.length);
	b.writeUInt16LE(0x000c, 0);
	b.writeUInt16LE(0x000c, 2);
	b.writeUInt32LE(avSeq, 4);
	b.writeUInt16LE(0x7000, 16);
	b.writeUInt16LE(seqCmd & 0xffff, 18);
	b.writeUInt32LE(1, 20);
	b.writeUInt32LE(hlWire.length + 4, 24);
	b.writeUInt32LE(seqCmd, 28);
	b[37] = 0x01;
	hlWire.copy(b, 40);
	return b;
}

/** The resolution-response control message the camera acknowledges with. */
export function buildResolutionResp(cmdId) {
	return buildHL(cmdId, Buffer.from('{"cameraInfo":{"resolution":"ok"}}', "utf8"));
}
