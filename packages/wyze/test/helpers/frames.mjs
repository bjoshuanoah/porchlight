// test/helpers/frames.mjs — the fake camera's AV frame builders (PORCH-131
// contract harness): constructs the wire AV packets the adapter's
// FrameHandler must reassemble, byte-for-byte in the reference shapes.

import { FRAME_INFO_SIZE, CODEC } from "../../src/frame.js";

/** AV packet header sizes per frame type. */
const HEADER_28 = 28;
const HEADER_36 = 36;

/**
 * buildVideoPacket — one video packet (channel 5).
 * @param {{
 *   type: "start"|"cont"|"end",
 *   frameNo: number,
 *   pktIdx: number,
 *   pktTotal: number,
 *   payload: Buffer,
 *   frameInfo?: { codec: number, keyframe: boolean, fps: number, timestamp: number, sessionId: number, payloadSize: number, resTier?: number, bitrate?: number },
 * }} p
 * @returns {Buffer} the wire packet
 */
export function buildVideoPacket(p) {
	const fi = p.frameInfo;
	const useExt = p.type === "start"; // the start carries the 36-byte header
	const hasFI = fi && (p.type === "end" || p.pktTotal === 1);
	const hdrSize = useExt && !hasFI ? HEADER_36 : HEADER_28;
	const body = Buffer.alloc(hdrSize + p.payload.length + (hasFI ? FRAME_INFO_SIZE : 0));
	body[0] = 0x05; // video channel
	body[1] = useExt ? 0x08 : p.type === "end" ? (p.pktTotal > 1 ? 0x05 : 0x01) : 0x00;
	if (hdrSize === 28) {
		body.writeUInt16LE(p.pktTotal, 12);
		body.writeUInt16LE(hasFI ? 0x28 : p.pktIdx, 14);
		body.writeUInt16LE(p.payload.length, 16);
		body.writeUInt32LE(p.frameNo, 24);
	} else {
		body.writeUInt16LE(p.pktTotal, 20);
		body.writeUInt16LE(p.pktIdx, 22);
		body.writeUInt16LE(p.payload.length, 24);
		body.writeUInt32LE(p.frameNo, 32);
	}
	const info = hasFI ? buildFrameInfo(fi) : null;
	if (info) info.copy(body, hdrSize + p.payload.length);
	p.payload.copy(body, hdrSize);
	return body;
}

/**
 * buildFrameInfo — the 40-byte extended FRAMEINFO trailer.
 * @param {{ codec: number, keyframe?: boolean, fps?: number, timestamp: number,
 *   sessionId?: number, payloadSize: number, frameNo?: number, resTier?: number,
 *   bitrate?: number, sampleRate?: number, stereo?: boolean }} fi
 * @returns {Buffer}
 */
export function buildFrameInfo(fi) {
	const b = Buffer.alloc(FRAME_INFO_SIZE);
	b[0] = fi.codec ?? CODEC.H264;
	b[1] = 0;
	b[2] = fi.keyframe ? 1 : 0;
	if (fi.codec && fi.codec >= 0x86 && fi.codec <= 0x92) {
		// Audio: flags [3:2] = sample rate index, [1] = 16-bit, [0] = stereo.
		const rates = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
		const idx = rates.indexOf(fi.sampleRate ?? 8000);
		b[2] = ((idx < 0 ? 0 : idx) << 2) | 0x02 | (fi.stereo ? 1 : 0);
	}
	b[3] = 0;
	b[4] = 1;
	b[5] = fi.fps ?? 15;
	b[6] = fi.resTier ?? 4;
	b[7] = fi.bitrate ?? 100;
	b.writeUInt32LE(fi.timestamp, 8);
	b.writeUInt32LE(fi.sessionId ?? 0x11223344, 12);
	b.writeUInt32LE(fi.payloadSize, 16);
	b.writeUInt32LE(fi.frameNo ?? 0, 20);
	return b;
}

/**
 * A scripted H.264 access unit: one multi-packet frame in the multi-packet
 * video packet shapes the camera of record emits.
 * @param {{ frameNo: number, chunks: Buffer[], timestamp: number, keyframe?: boolean }} u
 * @returns {Buffer[]}
 */
export function buildVideoAccessUnit(u) {
	const total = u.chunks.length;
	const packets = [];
	const fi = { codec: CODEC.H264, keyframe: u.keyframe ?? true, timestamp: u.timestamp, sessionId: 0x11223344, payloadSize: u.chunks.reduce((n, c) => n + c.length, 0), frameNo: u.frameNo };
	u.chunks.forEach((chunk, i) => {
		packets.push(buildVideoPacket({
			type: i === 0 ? "start" : i === total - 1 ? "end" : "cont",
			frameNo: u.frameNo,
			pktIdx: i,
			pktTotal: total,
			payload: chunk,
			frameInfo: i === total - 1 ? fi : undefined,
		}));
	});
	return packets;
}

/** A scripted audio packet (channel 3, PCM in the audio flags of record). */
export function buildAudioPacket({ frameNo, timestamp, samples = 320, rate = 8000, codec }) {
	const payload = samples % 8 === 0 ? samples : Math.ceil(samples / 8) * 8;
	const data = Buffer.alloc(payload);
	for (let i = 0; i < payload; i++) data[i] = (i * 29) % 256;
	const fi = { codec: codec ?? CODEC.PCML, timestamp, sessionId: 0x11223344, payloadSize: payload, frameNo, sampleRate: rate };
	const b = Buffer.alloc(HEADER_28 + payload + FRAME_INFO_SIZE);
	b[0] = 0x03; // audio channel
	b[1] = 0x01; // single-packet end
	b.writeUInt16LE(1, 12);
	b.writeUInt16LE(0x28, 14);
	b.writeUInt16LE(payload, 16);
	b.writeUInt32LE(frameNo, 24);
	const info = buildFrameInfo(fi);
	info.copy(b, HEADER_28 + payload);
	data.copy(b, HEADER_28);
	return b;
}
