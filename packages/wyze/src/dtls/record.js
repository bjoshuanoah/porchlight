// record.js — DTLS record and handshake wire framing (PORCH-131).
//
// Record header (13 bytes): contentType | version(2) | epoch(2) |
// sequence(6) | length(2). Handshake header (12 bytes): type |
// length(3) | messageSequence(2) | fragmentOffset(3) | fragmentLength(3).
// Fragmentation follows DTLS 1.2 (RFC 6347 §4.2.2): a handshake message
// larger than the datagram MTU rides as fragments the peer reassembles.

/** Record content types. */
export const CONTENT_TYPE = Object.freeze({
	CHANGE_CIPHER_SPEC: 20,
	ALERT: 21,
	HANDSHAKE: 22,
	APPLICATION_DATA: 23,
});

/** Handshake message types. */
export const HANDSHAKE_TYPE = Object.freeze({
	CLIENT_HELLO: 1,
	SERVER_HELLO: 2,
	HELLO_VERIFY_REQUEST: 3,
	SERVER_KEY_EXCHANGE: 12,
	SERVER_HELLO_DONE: 14,
	CLIENT_KEY_EXCHANGE: 16,
	FINISHED: 20,
});

/** DTLS 1.0 / 1.2 wire versions ({0xfe, 0xff} / {0xfe, 0xfd}). */
export const DTLS_VERSION_10 = Object.freeze([0xfe, 0xff]);
export const DTLS_VERSION_12 = Object.freeze([0xfe, 0xfd]);

export const RECORD_HEADER_SIZE = 13;
export const HANDSHAKE_HEADER_SIZE = 12;
/** MTU of record: the DTLS config MTU the reference client sends with. */
export const DTLS_MTU = 1200;

/**
 * Build a DTLS record header.
 * @param {number} contentType
 * @param {number} epoch
 * @param {number} sequence 48-bit sequence number
 * @param {number} contentLen plaintext length the header advertises
 * @returns {Buffer} 13 bytes
 */
export function recordHeader(contentType, epoch, sequence, contentLen) {
	if (sequence < 0 || sequence > 2 ** 48 - 1) throw new Error(`recordHeader: sequence out of 48-bit range (${sequence})`);
	const b = Buffer.alloc(RECORD_HEADER_SIZE);
	b[0] = contentType;
	b[1] = DTLS_VERSION_12[0];
	b[2] = DTLS_VERSION_12[1];
	b.writeUInt16BE(epoch, 3);
	b.writeUIntBE(sequence, 5, 6);
	b.writeUInt16BE(contentLen, 11);
	return b;
}

/**
 * Parse a DTLS record header; null on a malformed/short header.
 * @param {Buffer} wire
 * @returns {{ contentType: number, epoch: number, sequence: number, length: number, size: number } | null}
 */
export function parseRecordHeader(wire) {
	if (!wire || wire.length < RECORD_HEADER_SIZE) return null;
	const contentType = wire[0];
	if (![CONTENT_TYPE.CHANGE_CIPHER_SPEC, CONTENT_TYPE.ALERT, CONTENT_TYPE.HANDSHAKE, CONTENT_TYPE.APPLICATION_DATA].includes(contentType)) {
		return null;
	}
	// version bytes 1..2 (accept only DTLS 1.0/1.2)
	const major = wire[1];
	if (major !== 0xfe) return null;
	return {
		contentType,
		epoch: wire.readUInt16BE(3),
		sequence: readSequence(wire),
		length: wire.readUInt16BE(11),
		size: RECORD_HEADER_SIZE,
	};
}

/**
 * Build a DTLS handshake header.
 * @param {number} type
 * @param {number} length message body length (uint24)
 * @param {number} messageSequence
 * @param {number} fragmentOffset
 * @param {number} fragmentLength
 * @returns {Buffer} 12 bytes
 */
export function handshakeHeader(type, length, messageSequence, fragmentOffset, fragmentLength) {
	const b = Buffer.alloc(HANDSHAKE_HEADER_SIZE);
	b[0] = type;
	b.writeUIntBE(length, 1, 3);
	b.writeUInt16BE(messageSequence, 4);
	b.writeUIntBE(fragmentOffset, 6, 3);
	b.writeUIntBE(fragmentLength, 9, 3);
	return b;
}

/**
 * Parse a DTLS handshake header.
 * @param {Buffer} wire
 * @returns {{ type: number, length: number, messageSequence: number, fragmentOffset: number, fragmentLength: number } | null}
 */
export function parseHandshakeHeader(wire) {
	if (!wire || wire.length < HANDSHAKE_HEADER_SIZE) return null;
	return {
		type: wire[0],
		length: Number(wire.readUIntBE(1, 3)),
		messageSequence: wire.readUInt16BE(4),
		fragmentOffset: Number(wire.readUIntBE(6, 3)),
		fragmentLength: Number(wire.readUIntBE(9, 3)),
	};
}

/**
 * Split a datagram into its record envelopes: { header, body } pairs —
 * bodies are subarrays of the wire (may span fragment boundaries).
 * @param {Buffer} datagram
 * @returns {{ header: NonNullable<ReturnType<typeof parseRecordHeader>>, body: Buffer }[]}
 */
export function parseDatagramRecords(datagram) {
	const out = [];
	let off = 0;
	while (off + RECORD_HEADER_SIZE <= datagram.length) {
		const header = parseRecordHeader(datagram.subarray(off));
		if (!header) break;
		const bodyEnd = off + RECORD_HEADER_SIZE + header.length;
		if (bodyEnd > datagram.length) break;
		out.push({ header, body: datagram.subarray(off + RECORD_HEADER_SIZE, bodyEnd) });
		off = bodyEnd;
	}
	return out;
}

/**
 * The handshake fragment reassembler: pulls (type, messageSequence)-keyed
 * full messages out of handshake fragments as they arrive.
 */
export class HandshakeFragmenter {
	constructor() {
		/** @type {Map<string, { total: number, parts: Map<number, Buffer>, received: number, start: number }>}} */
		this.pending = new Map();
	}

	/**
	 * Add one handshake record's content. Returns fully-assembled messages
	 * as { type, sequence, wire } (header + body) in arrival order.
	 * @param {Buffer} body
	 * @returns {{ type: number, sequence: number, wire: Buffer }[]}
	 */
	feed(body) {
		/** @type {{ type: number, sequence: number, wire: Buffer }[]} */
		const completed = [];
		let off = 0;
		while (off + HANDSHAKE_HEADER_SIZE <= body.length) {
			const mh = parseHandshakeHeader(body.subarray(off));
			if (!mh) break;
			if (off + HANDSHAKE_HEADER_SIZE + mh.fragmentLength > body.length) break;
			const msgStart = off;
			const fragment = body.subarray(off + HANDSHAKE_HEADER_SIZE, off + HANDSHAKE_HEADER_SIZE + mh.fragmentLength);
			off += HANDSHAKE_HEADER_SIZE + mh.fragmentLength;
			if (mh.fragmentOffset === 0 && mh.fragmentLength === mh.length) {
				completed.push({ type: mh.type, sequence: mh.messageSequence, wire: Buffer.from(body.subarray(msgStart, off)) });
				continue;
			}
			const key = `${mh.type}:${mh.messageSequence}`;
			let entry = this.pending.get(key);
			if (!entry) {
				entry = { total: mh.length, parts: new Map(), received: 0, start: msgStart };
				this.pending.set(key, entry);
			}
			if (!entry.parts.has(mh.fragmentOffset)) {
				entry.parts.set(mh.fragmentOffset, Buffer.from(fragment));
				entry.received += fragment.length;
			}
			if (entry.received === entry.total) {
				const orderedFragments = [...entry.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, buf]) => buf);
				const wire = Buffer.concat([
					handshakeHeader(mh.type, mh.length, mh.messageSequence, 0, mh.length),
					...orderedFragments,
				]);
				completed.push({ type: mh.type, sequence: mh.messageSequence, wire });
				this.pending.delete(key);
			}
		}
		return completed;
	}
}

/** Read the 48-bit record sequence number. */
export function readSequence(wire) {
	return wire.readUIntBE(5, 6);
}

export function fragmentHandshakeMessage(message, mtu = DTLS_MTU) {
	const budget = mtu - RECORD_HEADER_SIZE - HANDSHAKE_HEADER_SIZE;
	const wire = [];
	for (let off = 0; off < message.body.length; off += budget) {
		const slice = message.body.subarray(off, off + budget);
		wire.push(Buffer.concat([handshakeHeader(message.type, message.body.length, message.sequence, off, slice.length), slice]));
	}
	if (wire.length === 0) {
		wire.push(Buffer.concat([handshakeHeader(message.type, 0, message.sequence, 0, 0)]));
	}
	return wire;
}
