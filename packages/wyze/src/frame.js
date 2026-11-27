// frame.js — the AV frame handler of the Wyze DTLS session (PORCH-131).
//
// Port of the reference framing knowledge (go2rtc pkg/tutk/frame.go): the
// per-channel reassembly of the camera's AV stream into video frames
// (H.264/H.265 access units) and audio packets, per the extended
// FRAMEINFO trailer the cameras append. Frame reassembly is exact: a lost
// packet resets the frame instead of emitting a corrupt one (vendor
// firmware is an adversary — corruption is never passed downstream).

import { EventEmitter } from "node:events";

/** Channel ids of the camera's AV stream. */
export const CHANNEL = Object.freeze({
	AUDIO: 0x03,
	IVIDEO: 0x05,
	PVIDEO: 0x07,
});

/** Frame types (first byte after the channel byte). */
export const FRAME_TYPE = Object.freeze({
	START: 0x08, // extended start (36-byte header)
	START_ALT: 0x09, // start alt (36-byte header)
	CONT: 0x00, // continuation (28-byte header)
	CONT_ALT: 0x04,
	END_SINGLE: 0x01, // single-packet frame (28-byte header)
	END_MULTI: 0x05, // multi-packet end
	END_EXT: 0x0d, // extended end (36-byte header)
});

export const FRAME_INFO_SIZE = 40;

/** Codec ids carried in the frame info trailer. */
export const CODEC = Object.freeze({
	MPEG4: 0x4c,
	H263: 0x4d,
	H264: 0x4e,
	MJPEG: 0x4f,
	H265: 0x50,
	AAC_RAW: 0x86,
	AAC_ADTS: 0x87,
	AAC_LATM: 0x88,
	PCMU: 0x89,
	PCMA: 0x8a,
	ADPCM: 0x8b,
	PCML: 0x8c,
	SPEEX: 0x8d,
	MP3: 0x8e,
	G726: 0x8f,
	AAC_ALT: 0x90,
	OPUS: 0x92,
});

const SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

export function isVideoCodec(id) {
	return id >= CODEC.MPEG4 && id <= CODEC.H265;
}

export function isAudioCodec(id) {
	return id >= CODEC.AAC_RAW && id <= CODEC.OPUS;
}

/** A parsed extended FRAMEINFO trailer (go2rtc frame.go struct). */
export function parseFrameInfo(data) {
	if (data.length < FRAME_INFO_SIZE) return null;
	const fi = data.subarray(data.length - FRAME_INFO_SIZE);
	return {
		codecId: fi[0],
		flags: fi[2],
		camIndex: fi[3],
		onlineNum: fi[4],
		fps: fi[5],
		resTier: fi[6],
		bitrate: fi[7],
		timestamp: fi.readUInt32LE(8),
		sessionId: fi.readUInt32LE(12),
		payloadSize: fi.readUInt32LE(16),
		frameNo: fi.readUInt32LE(20),
		isKeyframe: () => fi[2] === 0x01,
		sampleRate: () => {
			const idx = (fi[2] >> 2) & 0x0f;
			return idx < SAMPLE_RATES.length ? SAMPLE_RATES[idx] : 16000;
		},
		channels: () => ((fi[2] & 0x01) === 1 ? 2 : 1),
	};
}

/** Parse one AV packet's header (28/36-byte forms). Returns null on junk. */
export function parsePacketHeader(data) {
	if (data.length < 28) return null;
	const frameType = data[1];
	const hdr = { channel: data[0], frameType };
	hdr.headerSize = [FRAME_TYPE.START, FRAME_TYPE.START_ALT, FRAME_TYPE.END_EXT].includes(frameType) ? 36 : 28;
	if (data.length < hdr.headerSize) return null;
	/** The packet index — or the 0x28 FRAMEINFO marker on end packets. */
	let pktIdxOrMarker;
	if (hdr.headerSize === 28) {
		hdr.pktTotal = data.readUInt16LE(12);
		pktIdxOrMarker = data.readUInt16LE(14);
		hdr.payloadSize = data.readUInt16LE(16);
		hdr.frameNo = data.readUInt32LE(24);
	} else {
		hdr.pktTotal = data.readUInt16LE(20);
		pktIdxOrMarker = data.readUInt16LE(22);
		hdr.payloadSize = data.readUInt16LE(24);
		hdr.frameNo = data.readUInt32LE(32);
	}
	if (pktIdxOrMarker === 0x0028 && (isEndFrame(frameType) || hdr.pktTotal === 1)) {
		hdr.hasFrameInfo = true;
		hdr.pktIdx = hdr.pktTotal > 0 ? hdr.pktTotal - 1 : 0;
	} else {
		hdr.pktIdx = pktIdxOrMarker;
	}
	return hdr;
}

export function isStartFrame(t) {
	return t === FRAME_TYPE.START || t === FRAME_TYPE.START_ALT;
}

export function isEndFrame(t) {
	return t === FRAME_TYPE.END_SINGLE || t === FRAME_TYPE.END_MULTI || t === FRAME_TYPE.END_EXT;
}

/** Extract the packet's payload + the frame-info trailer when present. */
function extractPayload(data, channel) {
	if (data.length < 2) return { payload: null, frameInfo: null };
	const frameType = data[1];
	let headerSize = 28;
	let fiSize = 0;
	switch (frameType) {
		case FRAME_TYPE.START:
			headerSize = 36;
			break;
		case FRAME_TYPE.START_ALT:
			headerSize = 36;
			if (data.length >= 22 && data.readUInt16LE(20) === 1) fiSize = FRAME_INFO_SIZE;
			break;
		case FRAME_TYPE.CONT:
		case FRAME_TYPE.CONT_ALT:
			headerSize = 28;
			break;
		case FRAME_TYPE.END_SINGLE:
		case FRAME_TYPE.END_MULTI:
			headerSize = 28;
			fiSize = FRAME_INFO_SIZE;
			break;
		case FRAME_TYPE.END_EXT:
			headerSize = 36;
			fiSize = FRAME_INFO_SIZE;
			break;
	}
	if (data.length < headerSize) return { payload: null, frameInfo: null };
	if (fiSize === 0) return { payload: data.subarray(headerSize), frameInfo: null };
	if (data.length < headerSize + fiSize) return { payload: data.subarray(headerSize), frameInfo: null };
	const frameInfo = parseFrameInfo(data);
	const valid = channel === CHANNEL.AUDIO ? isAudioCodec(frameInfo.codecId) : channel === CHANNEL.IVIDEO || channel === CHANNEL.PVIDEO ? isVideoCodec(frameInfo.codecId) : false;
	return { payload: data.subarray(headerSize, valid ? data.length - FRAME_INFO_SIZE : data.length), frameInfo: valid ? frameInfo : null };
}

/**
 * FrameHandler — channel-keyed AV reassembly. feed(avPacket) with each
 * camera AV datagram; emits "frame" ({ channel, codec, timestamp,
 * isKeyframe, frameNo, sampleRate, channels, data }) per assembled
 * video/audio payload.
 */
export class FrameHandler extends EventEmitter {
	constructor({ maxFrameBytes = 8 * 1024 * 1024 } = {}) {
		super();
		this.states = new Map(); // channel -> reassembly state
		this.maxFrameBytes = maxFrameBytes;
		this.trackers = new Map(); // channel -> { lastRaw, acc }
	}

	/** Timestamp unwrap: a wrapped 32-bit counter maps to accumulated us. */
	updateTimestamp(channel, rawTs) {
		const wrap = 1_000_000;
		let t = this.trackers.get(channel);
		if (!t) {
			t = { lastRaw: rawTs, acc: 0 };
			this.trackers.set(channel, t);
			return 0;
		}
		const delta = rawTs >= t.lastRaw ? rawTs - t.lastRaw : (wrap - t.lastRaw + rawTs) % wrap;
		t.acc = (t.acc + delta) % 4294967296;
		t.lastRaw = rawTs;
		return t.acc;
	}

	/**
	 * Feed one AV packet (channel byte present). Emits "frame" as frames
	 * complete.
	 * @param {Buffer} avPacket
	 */
	handle(avPacket) {
		const hdr = parsePacketHeader(avPacket);
		if (!hdr) return;
		const { payload, frameInfo } = extractPayload(avPacket, hdr.channel);
		if (payload === null) return;
		if (hdr.channel === CHANNEL.AUDIO) {
			this.#handleAudio(payload, frameInfo);
			return;
		}
		if (hdr.channel !== CHANNEL.IVIDEO && hdr.channel !== CHANNEL.PVIDEO) return;
		this.#handleVideo(hdr, payload, frameInfo);
	}

	#handleVideo(hdr, payload, frameInfo) {
		const st = this.#state(hdr.channel);
		if (st.frameNo !== hdr.frameNo) {
			st.frameNo = hdr.frameNo;
			st.reset(hdr.pktTotal);
		} else if (st.frameInfo) {
			// A restarted frame (same number, new packets): keep the trailer.
		}
		if (hdr.pktIdx !== st.waitSeq) {
			// Out-of-order or lost packet: reset the frame (never emit corrupt).
			st.reset(hdr.pktTotal);
			return;
		}
		st.hasStarted = true;
		st.data = Buffer.concat([st.data, payload]);
		st.waitSeq += 1;
		if (frameInfo) st.frameInfo = frameInfo;
		if (st.waitSeq !== st.pktTotal || !st.frameInfo) return;
		const fi = st.frameInfo;
		const assembled = st.data;
		const total = st.data.length;
		st.reset(hdr.pktTotal);
		if (total === 0) return;
		if (fi.payloadSize > 0 && total !== fi.payloadSize) {
			// The camera's own accounting disagrees with the bytes — discard
			// the frame (corruption is never passed downstream).
			return;
		}
		const acc = this.updateTimestamp(hdr.channel, fi.timestamp);
		this.emit("frame", {
			channel: hdr.channel,
			codec: fi.codecId,
			timestamp: Math.floor((acc * 90000) / 1_000_000),
			isKeyframe: fi.isKeyframe(),
			frameNo: fi.frameNo,
			data: assembled,
		});
	}

	#handleAudio(payload, frameInfo) {
		if (payload.length === 0 || !frameInfo) return;
		const sampleRate = frameInfo.sampleRate();
		const channels = frameInfo.channels();
		const acc = this.updateTimestamp(CHANNEL.AUDIO, frameInfo.timestamp);
		this.emit("frame", {
			channel: CHANNEL.AUDIO,
			codec: frameInfo.codecId,
			timestamp: Math.floor((acc * sampleRate) / 1_000_000),
			isKeyframe: false,
			frameNo: frameInfo.frameNo,
			sampleRate,
			channels,
			data: Buffer.from(payload),
		});
	}

	#state(channel) {
		let st = this.states.get(channel);
		if (!st) {
			st = {
				frameNo: 0,
				pktTotal: 0,
				waitSeq: 0,
				data: Buffer.alloc(0),
				frameInfo: null,
				hasStarted: false,
				lastDataLength: 0,
				reset: (pktTotal) => {
					st.pktTotal = pktTotal;
					st.waitSeq = 0;
					st.data = Buffer.alloc(0);
					st.frameInfo = null;
					st.hasStarted = false;
				},
				meta: () => ({}),
			};
			this.states.set(channel, st);
		}
		return st;
	}

}
