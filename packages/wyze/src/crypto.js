// crypto.js — the TUTK protocol crypto primitives (PORCH-131).
//
// Port of the reverse-engineered Wyze P2P knowledge proven working in
// shaping and mirrored by go2rtc's wyze module (reference:
// AlexxIT/go2rtc pkg/tutk/crypto.go). The "Charlie" transform obfuscates
// every IOTC-layer packet; the XXTEA variants answer the DTLS K-challenge.
// These functions are pure and contract-tested against go2rtc's own test
// vector (test/crypto.test.go) — a byte divergence here is a camera
// rejection, never a degraded stream.

const CHARLIE = Buffer.from("Charlie is the designer of P2P!!", "ascii");
const DELTA = 0x9e3779b9;

/** Rotate a uint32 left (n may be negative for right rotation). */
function rotl32(x, n) {
	// JS bit ops are already 32-bit; >>>0 keeps it unsigned.
	const m = ((n % 32) + 32) % 32;
	if (m === 0) return x >>> 0;
	return ((x << m) | (x >>> (32 - m))) >>> 0;
}

const SWAP_2 = [1, 0];
const SWAP_4 = [2, 3, 0, 1];
const SWAP_8 = [7, 4, 3, 2, 1, 6, 5, 0];
const SWAP_16 = [11, 9, 8, 15, 13, 10, 12, 14, 2, 1, 5, 0, 6, 4, 7, 3];

/** go2rtc swap(): the fixed permutation applied to full 16-byte blocks
 *  (identities for other sizes — plain copy). Reads SRC's block, writes
 *  DST's block. */
function swapBlock(dst, src, off, n) {
	if (n === 16) {
		for (let i = 0; i < 16; i++) dst[off + i] = src[off + SWAP_16[i]];
	} else if (n === 8) {
		for (let i = 0; i < 8; i++) dst[off + i] = src[off + SWAP_8[i]];
	} else if (n === 4) {
		for (let i = 0; i < 4; i++) dst[off + i] = src[off + SWAP_4[i]];
	} else if (n === 2) {
		for (let i = 0; i < 2; i++) dst[off + i] = src[off + SWAP_2[i]];
	} else if (n === 1) {
		dst[off] = src[off];
	} else {
		src.copy(dst, off, off, off + n);
	}
}

/**
 * ReverseTransCodePartial — the IOTC read transform (in place on dst).
 * Full 16-byte blocks ride the charlie XOR + rotations + block permutation;
 * the sub-16 tail is permuted then XORed with the tail-relative charlie
 * bytes (go2rtc's offset-pointer semantics — the index restarts at 0 for
 * the tail). Mutates dst; src is read-only.
 * @param {Buffer} dst destination; regions already decoded are re-read
 * @param {Buffer} src buffer holding the received cipher bytes
 * @returns {Buffer} dst
 */
export function reverseTransCodePartial(dst, src) {
	const n = src.length;
	const tmp = Buffer.alloc(n);
	let off = 0;
	for (; off + 16 <= n; off += 16) {
		for (let i = 0; i < 16; i += 4) {
			tmp.writeUInt32LE(rotl32(src.readUInt32LE(off + i), i + 3), off + i);
		}
		swapBlock(dst, tmp, off, 16);
		for (let i = 0; i < 16; i++) dst[off + i] ^= CHARLIE[i];
		for (let i = 0; i < 16; i += 4) {
			dst.writeUInt32LE(rotl32(dst.readUInt32LE(off + i), i + 1), off + i);
		}
	}
	const r = n - off;
	if (r > 0) {
		swapBlock(tmp, src, off, r);
		for (let i = 0; i < r; i++) dst[off + i] = tmp[off + i] ^ CHARLIE[i];
	}
	return dst;
}

/**
 * TransCodePartial — the IOTC write transform (the inverse partial), also
 * in place on dst. Allocation-free on the send path: the caller's encode
 * buffer becomes the wire buffer.
 */
export function transCodePartial(dst, src) {
	const n = src.length;
	const tmp = Buffer.alloc(n);
	let off = 0;
	for (; off + 16 <= n; off += 16) {
		for (let i = 0; i < 16; i += 4) {
			tmp.writeUInt32LE(rotl32(src.readUInt32LE(off + i), -(i + 1)), off + i);
		}
		for (let i = 0; i < 16; i++) dst[off + i] = tmp[off + i] ^ CHARLIE[i];
		swapBlock(tmp, dst, off, 16);
		for (let i = 0; i < 16; i += 4) {
			dst.writeUInt32LE(rotl32(tmp.readUInt32LE(off + i), -(i + 3)), off + i);
		}
	}
	const r = n - off;
	if (r > 0) {
		for (let i = 0; i < r; i++) tmp[off + i] = src[off + i] ^ CHARLIE[i];
		swapBlock(dst, tmp, off, r);
	}
	return dst;
}

function isPartialEncrypted(headerByte) {
	return (headerByte & 1) !== 0;
}

/**
 * ReverseTransCodeBlob — the session0 discovery/read transform, allocated.
 * Header (16 bytes) always transformed; body transformed fully (bit 2 = 0)
 * or partially (first 48 bytes after the header) per the decrypted flag.
 * @param {Buffer} buf the wire bytes
 * @returns {Buffer} a new decrypted buffer
 */
export function reverseTransCodeBlob(buf) {
	if (buf.length < 16) return reverseTransCodePartial(Buffer.alloc(buf.length), buf);
	const dst = Buffer.alloc(buf.length);
	const header = Buffer.from(buf.subarray(0, 16));
	reverseTransCodePartial(header, header);
	header.copy(dst, 0);
	if (buf.length > 16) {
		const remaining = buf.length - 16;
		if (isPartialEncrypted(dst[3])) {
			const decryptLen = Math.min(remaining, 48);
			const body = Buffer.from(buf.subarray(16, 16 + decryptLen));
			reverseTransCodePartial(body, body);
			body.copy(dst, 16);
			if (remaining > 48) buf.copy(dst, 64, 64);
		} else {
			const body = Buffer.from(buf.subarray(16));
			reverseTransCodePartial(body, body);
			body.copy(dst, 16);
		}
	}
	return dst;
}

/**
 * TransCodeBlob — the session0 discovery/write counterpart of the above.
 * @param {Buffer} buf plaintext packet
 * @returns {Buffer} a new encrypted buffer
 */
export function transCodeBlob(buf) {
	if (buf.length < 16) return transCodePartial(Buffer.alloc(buf.length), buf);
	const dst = Buffer.alloc(buf.length);
	const header = Buffer.from(buf.subarray(0, 16));
	transCodePartial(header, header);
	header.copy(dst, 0);
	if (buf.length > 16) {
		const remaining = buf.length - 16;
		if (isPartialEncrypted(buf[3])) {
			const encryptLen = Math.min(remaining, 48);
			const body = Buffer.from(buf.subarray(16, 16 + encryptLen));
			transCodePartial(body, body);
			body.copy(dst, 16);
			if (remaining > 48) buf.copy(dst, 64, 64);
		} else {
			const body = Buffer.from(buf.subarray(16));
			transCodePartial(body, body);
			body.copy(dst, 16);
		}
	}
	return dst;
}

/** XXTEA MX mixer (the round function of the Corrected Block TEA) —
 *  go2rtc uses plain 32-bit shifts (not rotations) here; >>>0 keeps the
 *  wrap semantics of Go's unsigned arithmetic. */
function xxteaMx(sum, y, z, p, e, k) {
	return (((z >>> 5) ^ rotl32(y << 2, 0)) + ((y >>> 3) ^ (z << 4))) ^ ((sum ^ y) + (k[(p & 3) ^ e] ^ z));
}

/**
 * XXTEA decrypt of a 16-byte block under a 16-byte key.
 * @param {Buffer} data 16 bytes (decrypted in place into a fresh buffer)
 * @param {Buffer} key 16 bytes
 * @returns {Buffer} 16-byte plaintext
 */
export function xxteaDecrypt16(data, key) {
	if (data.length !== 16 || key.length < 16) {
		throw new Error(`xxteaDecrypt16 needs 16 data bytes and 16 key bytes (got ${data.length}/${key.length})`);
	}
	const w = new Uint32Array(4);
	const k = new Uint32Array(4);
	for (let i = 0; i < 4; i++) {
		w[i] = data.readUInt32LE(i * 4);
		k[i] = key.readUInt32LE(i * 4);
	}
	let rounds = 52 / 4 + 6; // 19
	let sum = Math.imul(rounds, DELTA) >>> 0;
	while (rounds > 0) {
		let w0 = w[0];
		const i2 = (sum >>> 2) & 3;
		for (let i = 3; i >= 0; i--) {
			const wi = w[(i - 1) & 3];
			const ki = k[i ^ i2];
			const t1 = ((w0 ^ sum) + (wi ^ ki)) >>> 0;
			const t2 = (((wi >>> 5) ^ rotl32(w0, 2)) >>> 0);
			const t3 = (((w0 >>> 3) ^ rotl32(wi, 4)) >>> 0);
			w[i] = (w[i] - (t1 ^ ((t2 + t3) >>> 0))) >>> 0;
			w0 = w[i];
		}
		sum = (sum - DELTA) >>> 0;
		rounds--;
	}
	const out = Buffer.alloc(16);
	for (let i = 0; i < 4; i++) out.writeUInt32LE(w[i], i * 4);
	return out;
}

/**
 * XXTEADecryptVar — variable-length XXTEA over data whose length is a
 * multiple of 4 (padded to at least 8 bytes), decoded under key.
 * @param {Buffer} data 8+ bytes, length % 4 === 0 in practice
 * @param {Buffer} key 16-byte key
 * @returns {Buffer|null} plaintext of the same length, or null on shape error
 */
export function xxteaDecryptVar(data, key) {
	if (data.length < 8 || key.length < 16) return null;
	const k = new Uint32Array(4);
	for (let i = 0; i < 4; i++) k[i] = key.readUInt32LE(i * 4);
	const n = Math.max((data.length / 4) | 0, 2);
	const v = new Uint32Array(n);
	for (let i = 0; i < (data.length / 4) | 0; i++) v[i] = data.readUInt32LE(i * 4);
	let rounds = 6 + 52 / n;
	let sum = Math.imul(rounds, DELTA) >>> 0;
	let y = v[0];
	let z = 0;
	while (rounds > 0) {
		const e = (sum >>> 2) & 3;
		for (let p = n - 1; p > 0; p--) {
			z = v[p - 1];
			v[p] = (v[p] - xxteaMx(sum, y, z, p, e, k)) >>> 0;
			y = v[p];
		}
		z = v[n - 1];
		v[0] = (v[0] - xxteaMx(sum, y, z, 0, e, k)) >>> 0;
		y = v[0];
		sum = (sum - DELTA) >>> 0;
		rounds--;
	}
	const out = Buffer.alloc(n * 4);
	for (let i = 0; i < n; i++) out.writeUInt32LE(v[i], i * 4);
	return out.subarray(0, data.length);
}

/**
 * The three K10002 challenge-status classes of record.
 */
export const CHALLENGE_STATUS = Object.freeze({
	DEFAULT: 1,
	ENR16: 3,
	ENR32: 6,
});

/**
 * generateChallengeResponse — K10002's 16-byte answer, keyed by the status
 * byte the camera chose on K10001 (go2rtc pkg/wyze/client.go
 * generateChallengeResponse, ported exactly).
 * @param {Buffer} challenge 16 bytes from K10001
 * @param {string} enr the camera's ENR
 * @param {number} status 1 | 3 | 6
 * @returns {Buffer} 16-byte response (first 16 bytes are the wire answer)
 */
export function generateChallengeResponse(challengeBytes, enr, status) {
	let secretKey;
	let work = Buffer.from(challengeBytes);
	const enrBuf = Buffer.from(enr, "utf8");
	switch (status) {
		case CHALLENGE_STATUS.DEFAULT:
			secretKey = Buffer.from("FFFFFFFFFFFFFFFF", "ascii");
			break;
		case CHALLENGE_STATUS.ENR16:
			if (enrBuf.length >= 16) secretKey = enrBuf.subarray(0, 16);
			else {
				secretKey = Buffer.alloc(16);
				enrBuf.copy(secretKey, 0);
			}
			break;
		case CHALLENGE_STATUS.ENR32:
			if (enrBuf.length >= 16) {
				const firstKey = enrBuf.subarray(0, 16);
				work = xxteaDecryptVar(work, firstKey);
				if (!work) work = Buffer.from(challengeBytes);
			}
			if (enrBuf.length >= 32) secretKey = enrBuf.subarray(16, 32);
			else if (enrBuf.length > 16) {
				secretKey = Buffer.alloc(16);
				enrBuf.subarray(16).copy(secretKey);
			} else secretKey = Buffer.from("FFFFFFFFFFFFFFFF", "ascii");
			break;
		default:
			secretKey = Buffer.from("FFFFFFFFFFFFFFFF", "ascii");
	}
	return xxteaDecryptVar(work, secretKey) ?? Buffer.alloc(16);
}
