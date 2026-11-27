// cipher.js — the DTLS 1.2 record protection suites of the Wyze handshake
// (PORCH-131). Port of pion/dtls's cipher suites the reference client
// negotiates:
//   - TLS_PSK_WITH_AES_128_CBC_SHA256 (IANA 0x00A9): HMAC-SHA256 MAC, AES-128
//     CBC with a per-record random prepended IV (pion CBC record format).
//   - TLS_ECDHE_PSK_WITH_CHACHA20_POLY1305_SHA256 (IANA 0xCCAC): AEAD with
//     the pion nonce/AD layout the camera firmware expects.
//
// Cipher suite IDs:
export const CIPHER_SUITE = Object.freeze({
	/** TLS_PSK_WITH_AES_128_CBC_SHA256 (pion's plain-PSK suite). */
	PSK_AES128_CBC_SHA256: 0x00a9,
	/** TLS_PSK_WITH_AES_256_CBC_SHA (legacy PSK-CBC, HMAC-SHA1). */
	PSK_AES256_CBC_SHA: 0x00ae,
	/** TLS_PSK_WITH_AES_128_CBC_SHA (legacy PSK-CBC, HMAC-SHA1). */
	PSK_AES128_CBC_SHA: 0x008d,
	/** TLS_ECDHE_PSK_WITH_AES_128_CBC_SHA (legacy ECDHE-PSK, HMAC-SHA1). */
	ECDHE_PSK_AES128_CBC_SHA: 0xc035,
	ECDHE_PSK_CHACHA20_POLY1305_SHA256: 0xccac,
});

/** The PRF hash mode per suite: TLS1.2 SHA-256 default; the pre-TLS1.2
 *  SHA1-CBC suites hash with the combined MD5/SHA1 of RFC 5246 §5. */
export const SUITE_HASH_MODE = Object.freeze({
	[CIPHER_SUITE.PSK_AES128_CBC_SHA256]: "sha256",
	[CIPHER_SUITE.PSK_AES128_CBC_SHA]: "md5sha1",
	[CIPHER_SUITE.PSK_AES256_CBC_SHA]: "md5sha1",
	[CIPHER_SUITE.ECDHE_PSK_AES128_CBC_SHA]: "md5sha1",
	[CIPHER_SUITE.ECDHE_PSK_CHACHA20_POLY1305_SHA256]: "sha256",
});

/** Suite parameters of record (pion Init() lens). */
export const SUITE_PARAMS = Object.freeze({
	[CIPHER_SUITE.PSK_AES128_CBC_SHA256]: { macLen: 32, keyLen: 16, ivLen: 16, ecc: false },
	[CIPHER_SUITE.PSK_AES256_CBC_SHA]: { macLen: 20, keyLen: 32, ivLen: 16, ecc: false },
	[CIPHER_SUITE.PSK_AES128_CBC_SHA]: { macLen: 20, keyLen: 16, ivLen: 16, ecc: false },
	[CIPHER_SUITE.ECDHE_PSK_AES128_CBC_SHA]: { macLen: 20, keyLen: 16, ivLen: 16, ecc: true },
	[CIPHER_SUITE.ECDHE_PSK_CHACHA20_POLY1305_SHA256]: { macLen: 0, keyLen: 32, ivLen: 12, ecc: true },
});

import { createHmac, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { RECORD_HEADER_SIZE, CONTENT_TYPE, DTLS_VERSION_12, parseRecordHeader, recordHeader } from "./record.js";

/** True when the suite protects records with the CCAC AEAD; the other
 *  suites of record are MAC-then-CBC. */
export function isAeadSuite(suite) {
	return suite === CIPHER_SUITE.ECDHE_PSK_CHACHA20_POLY1305_SHA256;
}

/** The MAC hash follows the MAC-key length of record: 32 bytes → SHA-256,
 *  20 bytes → SHA-1 (the legacy CBC-SHA suite). */
function macHash(macKey) {
	return macKey.length === 20 ? "sha1" : "sha256";
}
const BLOCK_SIZE = 16;

/**
 * The CBC record MAC input: epoch(2)|seq(6)|type(1)|ver(2)|len(2) || payload.
 * @param {number} epoch @param {number} seq @param {number} contentType
 * @param {Buffer} payload @param {Buffer} macKey
 * @returns {Buffer} 32-byte HMAC-SHA256
 */
export function cbcMac(epoch, seq, contentType, payload, macKey) {
	const msg = Buffer.alloc(13);
	msg.writeUInt16BE(epoch, 0);
	msg.writeUIntBE(seq, 2, 6);
	msg[8] = contentType;
	msg[9] = DTLS_VERSION_12[0];
	msg[10] = DTLS_VERSION_12[1];
	msg.writeUInt16BE(payload.length, 11);
	return createHmac(macHash(macKey), macKey).update(msg).update(payload).digest();
}

const CHACHA_NONCE_LEN = 12;

/**
 * CCAC nonce: epoch||sequence in a 12-byte big-endian buffer XOR write IV.
 * (pion go2rtc cipher.go computeNonce: seq uint64 at [4..12) with its top
 * two bytes overwritten by the epoch.)
 */
function ccacNonce(iv, epoch, seq) {
	const nonce = Buffer.alloc(CHACHA_NONCE_LEN);
	nonce.writeUInt32BE(0, 0);
	nonce.writeUInt16BE(epoch, 4);
	nonce.writeUIntBE(seq, 6, 6);
	for (let i = 0; i < CHACHA_NONCE_LEN; i++) nonce[i] ^= iv[i];
	return nonce;
}

/**
 * CCAC additional data — the pion generateAEADAdditionalData layout:
 * epoch(2)|seq(6)|type(1)|version(2)|payloadLen(2), all big-endian.
 */
function ccacAdditionalData(contentType, epoch, seq, payloadLen) {
	const ad = Buffer.alloc(13);
	ad.writeUInt16BE(epoch, 0);
	ad.writeUIntBE(seq, 2, 6);
	ad[8] = contentType;
	ad[9] = DTLS_VERSION_12[0];
	ad[10] = DTLS_VERSION_12[1];
	ad.writeUInt16BE(payloadLen, 11);
	return ad;
}

/**
 * Encrypt one plaintext record body under the AES-CBC suite. Returns the
 * full record wire (header + IV + ciphertext).
 * @param {{
 *   header: { contentType: number, epoch: number, sequence: number },
 *   payload: Buffer,
 *   key: Buffer, iv: Buffer, macKey: Buffer,
 *   randomIv?: Buffer,
 * }} p
 * @returns {Buffer}
 */
export function cbcEncryptRecord({ header, payload, key, macKey, randomIv }) {
	const mac = cbcMac(header.epoch, header.sequence, header.contentType, payload, macKey);
	const withMac = Buffer.concat([payload, mac]);
	const padLen = BLOCK_SIZE - (withMac.length % BLOCK_SIZE);
	const padded = Buffer.concat([withMac, Buffer.alloc(padLen, padLen - 1)]);
	const recordIv = randomIv ?? randomBytes(BLOCK_SIZE);
	if (recordIv.length !== BLOCK_SIZE) throw new Error("cbcEncryptRecord needs a 16-byte record IV");
	const plainHeader = recordHeader(header.contentType, header.epoch, header.sequence, recordIv.length + padded.length);
	const cipher = createCipheriv(`aes-${key.length * 8}-cbc`, key, recordIv);
	const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
	return Buffer.concat([plainHeader, recordIv, encrypted]);
}

/**
 * Decrypt one AES-CBC record from the wire.
 * @param {Buffer} wire full record (header+body)
 * @param {{ key: Buffer, macKey: Buffer }} p
 * @returns {Buffer} plaintext body
 */
export function cbcDecryptRecord(wire, { key, macKey }) {
	const header = parseRecordHeader(wire);
	if (!header || header.contentType === CONTENT_TYPE.CHANGE_CIPHER_SPEC) {
		return wire.subarray(RECORD_HEADER_SIZE);
	}
	const body = wire.subarray(RECORD_HEADER_SIZE);
	const macSize = macKey.length;
	if (body.length % BLOCK_SIZE !== 0 || body.length < BLOCK_SIZE + macSize + 1) {
		throw new Error(`cbcDecryptRecord: record body is too short (${body.length} bytes)`);
	}
	const recordIv = body.subarray(0, BLOCK_SIZE);
	const decipher = createDecipheriv(`aes-${key.length * 8}-cbc`, key, recordIv);
	decipher.setAutoPadding(false);
	const plain = Buffer.concat([decipher.update(body.subarray(BLOCK_SIZE)), decipher.final()]);
	const paddingLen = plain[plain.length - 1] + 1;
	if (paddingLen > plain.length) throw new Error("cbcDecryptRecord: padding out of range");
	const dataEnd = plain.length - macSize - paddingLen;
	if (dataEnd < 0) throw new Error("cbcDecryptRecord: MAC window out of range");
	const expectedMac = plain.subarray(dataEnd, dataEnd + macSize);
	const actualMac = cbcMac(header.epoch, header.sequence, header.contentType, plain.subarray(0, dataEnd), macKey);
	if (!expectedMac.equals(actualMac)) {
		throw new Error("cbcDecryptRecord: record MAC mismatch — the record is corrupt or the session keys are wrong");
	}
	return plain.subarray(0, dataEnd);
}

/**
 * Encrypt one plaintext record body under the CCAC AEAD suite. Returns the
 * full record wire (header + ciphertext incl. 16-byte tag).
 * @param {{
 *   header: { contentType: number, epoch: number, sequence: number },
 *   payload: Buffer,
 *   key: Buffer, iv: Buffer,
 * }} p
 * @returns {Buffer}
 */
export function ccacEncryptRecord({ header, payload, key, iv }) {
	const plainHeader = recordHeader(header.contentType, header.epoch, header.sequence, payload.length + 16);
	const nonce = ccacNonce(iv, header.epoch, header.sequence);
	// Additional data: seq(8)|epoch(2)|type(1)|ver(2)|payloadLen(2) — the
	// pion generateAEADAdditionalData layout.
	const ad = Buffer.alloc(13);
	ad.writeUIntBE(header.sequence, 2, 6);
	ad.writeUInt16BE(header.epoch, 8);
	ad[10] = header.contentType;
	ad[11] = DTLS_VERSION_12[0];
	ad[12] = DTLS_VERSION_12[1];
	ad.writeUInt16BE(payload.length, 11);
	const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
	cipher.setAAD(ccacAdditionalData(header.contentType, header.epoch, header.sequence, payload.length));
	const encrypted = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
	return Buffer.concat([plainHeader, encrypted]);
}

/**
 * Decrypt one CCAC AEAD record from the wire.
 * @param {Buffer} wire
 * @param {{ key: Buffer, iv: Buffer }} p
 * @returns {Buffer} plaintext body
 */
export function ccacDecryptRecord(wire, { key, iv }) {
	const header = parseRecordHeader(wire);
	if (!header || header.contentType === CONTENT_TYPE.CHANGE_CIPHER_SPEC) {
		return wire.subarray(RECORD_HEADER_SIZE);
	}
	const body = wire.subarray(RECORD_HEADER_SIZE);
	if (body.length <= 16) throw new Error(`ccacDecryptRecord: ciphertext too short (${body.length} bytes)`);
	const nonce = ccacNonce(iv, header.epoch, header.sequence);
	const decipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
	decipher.setAAD(ccacAdditionalData(header.contentType, header.epoch, header.sequence, body.length - 16));
	decipher.setAuthTag(body.subarray(body.length - 16));
	const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
	return plain;
}
