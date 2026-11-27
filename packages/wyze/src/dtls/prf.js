// prf.js — the TLS 1.2 pseudorandom function layer of the Wyze DTLS
// handshake (PORCH-131). Port of pion/dtls pkg/crypto/prf (the DTLS
// implementation the reference Wyze client rides) — master secret, key
// block, and Finished verify data. Contract-tested against pion's own test
// vectors (packages/wyze/test/dtls.prf.test.js).

import { createHmac, createHash } from "node:crypto";

/** PRF hash modes of record: TLS1.2 default (SHA-256) and the
 *  pre-TLS1.2 suites' combined MD5/SHA1 (RFC 5246 §5 / RFC 4279 suites). */
export const PRF_MODE = Object.freeze({
	SHA256: "sha256",
	MD5SHA1: "md5sha1",
});

/**
 * P_hash(secret, seed) with SHA-256 (the hash of every suite of record).
 * @param {Buffer} secret
 * @param {Buffer} seed
 * @param {number} requestedLength
 * @returns {Buffer}
 */
export function pHashLegacy(secret, seed, requestedLength) {
	// The pre-TLS1.2 PRF splits the secret: S1 = the first ceil(n/2) bytes,
	// S2 = the last floor(n/2) bytes (overlapping when n is odd per RFC
	// 5246 §5); compute P_MD5(S1, seed) XOR P_SHA1(S2, seed).
	const split = Math.ceil(secret.length / 2);
	const s1 = secret.subarray(0, split);
	const s2 = split < secret.length ? secret.subarray(secret.length - split) : s1;
	const stream = (alg, key) => {
		const blocks = [];
		let last = seed;
		while (blocks.reduce((n, b) => n + b.length, 0) < requestedLength) {
			last = createHmac(alg, key).update(last).digest();
			blocks.push(createHmac(alg, key).update(Buffer.concat([last, seed])).digest());
		}
		return Buffer.concat(blocks);
	};
	const md5 = stream("md5", s1);
	const sha1 = stream("sha1", s2);
	const out = Buffer.alloc(requestedLength);
	md5.subarray(0, requestedLength).copy(out, 0);
	for (let i = 0; i < requestedLength; i++) out[i] ^= sha1[i];
	return out;
}

/** The legacy suite's Finished hash: md5(transcript) || sha1(transcript). */
function transcriptHashLegacy(handshakeWires) {
	const md5 = createHash("md5");
	const sha1 = createHash("sha1");
	for (const wire of handshakeWires) {
		md5.update(wire);
		sha1.update(wire);
	}
	return Buffer.concat([md5.digest(), sha1.digest()]);
}

export function pHash(secret, seed, requestedLength) {
	if (requestedLength < 0) throw new Error(`pHash needs a non-negative length (got ${requestedLength})`);
	const iterations = Math.ceil(requestedLength / 32);
	const out = [];
	let lastRound = seed;
	for (let i = 0; i < iterations; i++) {
		lastRound = createHmac("sha256", secret).update(lastRound).digest();
		out.push(createHmac("sha256", secret).update(Buffer.concat([lastRound, seed])).digest());
	}
	return Buffer.concat(out).subarray(0, requestedLength);
}

/**
 * TLS 1.2 master secret (non-extended — the extended variant is disabled
 * in the Wyze handshake of record).
 * @param {Buffer} preMasterSecret
 * @param {Buffer} clientRandom 32 bytes
 * @param {Buffer} serverRandom 32 bytes
 * @returns {Buffer} 48 bytes
 */
export function masterSecret(preMasterSecret, clientRandom, serverRandom, mode = PRF_MODE.SHA256) {
	const seed = Buffer.concat([Buffer.from("master secret", "ascii"), clientRandom, serverRandom]);
	return mode === PRF_MODE.MD5SHA1 ? pHashLegacy(preMasterSecret, seed, 48) : pHash(preMasterSecret, seed, 48);
}

/**
 * The TLS 1.2 key block, split in the of-record order
 * (clientMAC | serverMAC | clientKey | serverKey | clientIV | serverIV).
 * @param {Buffer} masterSecret 48 bytes
 * @param {Buffer} clientRandom
 * @param {Buffer} serverRandom
 * @param {{ macLen: number, keyLen: number, ivLen: number }} lens
 * @returns {{ clientMacKey: Buffer, serverMacKey: Buffer, clientWriteKey: Buffer, serverWriteKey: Buffer, clientWriteIv: Buffer, serverWriteIv: Buffer }}
 */
export function generateEncryptionKeys(masterSecret, clientRandom, serverRandom, { macLen, keyLen, ivLen }, mode = PRF_MODE.SHA256) {
	const seed = Buffer.concat([Buffer.from("key expansion", "ascii"), serverRandom, clientRandom]);
	const needed = 2 * macLen + 2 * keyLen + 2 * ivLen;
	const material = mode === PRF_MODE.MD5SHA1 ? pHashLegacy(masterSecret, seed, needed) : pHash(masterSecret, seed, needed);
	let off = 0;
	const take = (n) => material.subarray(off, (off += n));
	return {
		clientMacKey: take(macLen),
		serverMacKey: take(macLen),
		clientWriteKey: take(keyLen),
		serverWriteKey: take(keyLen),
		clientWriteIv: take(ivLen),
		serverWriteIv: take(ivLen),
	};
}

/** Finished verify data (12 bytes) — label per side. */
function prfVerifyData(master, hash, label, mode) {
	const seed = Buffer.concat([Buffer.from(label, "ascii"), hash]);
	return (mode === PRF_MODE.MD5SHA1 ? pHashLegacy(master, seed, 12) : pHash(master, seed, 12)).subarray(0, 12);
}

/**
 * Client Finished verify data ("client finished" label).
 * @param {Buffer} master 48 bytes
 * @param {Buffer} handshakeHash transcript hash (sha256; md5||sha1 for legacy)
 * @param {string} [mode] PRF_MODE — legacy suites hash with md5sha1
 * @returns {Buffer} 12 bytes
 */
export function verifyDataClient(master, handshakeHash, mode = PRF_MODE.SHA256) {
	return prfVerifyData(master, handshakeHash, "client finished", mode);
}

/**
 * Server Finished verify data ("server finished" label).
 * @param {Buffer} master 48 bytes
 * @param {Buffer} handshakeHash
 * @param {string} [mode]
 * @returns {Buffer} 12 bytes
 */
export function verifyDataServer(master, handshakeHash, mode = PRF_MODE.SHA256) {
	return prfVerifyData(master, handshakeHash, "server finished", mode);
}

/**
 * Plain-PSK premaster secret (RFC 4279 §2): [len][len zero octets][len][psk].
 * @param {Buffer} psk
 * @returns {Buffer}
 */
export function pskPreMasterSecret(psk) {
	const n = psk.length;
	const out = Buffer.alloc(4 + 2 * n);
	out.writeUInt16BE(n, 0);
	out.writeUInt16BE(n, 2 + n);
	psk.copy(out, 4 + n);
	return out;
}

/**
 * ECDHE-PSK premaster secret (RFC 5489 §2): [len][ECDH shared][len][psk].
 * @param {Buffer} psk
 * @param {Buffer} ecdhShared
 * @returns {Buffer}
 */
export function ecdhePskPreMasterSecret(psk, ecdhShared) {
	const out = Buffer.alloc(2 + ecdhShared.length + 2 + psk.length);
	out.writeUInt16BE(ecdhShared.length, 0);
	ecdhShared.copy(out, 2);
	out.writeUInt16BE(psk.length, 2 + ecdhShared.length);
	psk.copy(out, 4 + ecdhShared.length);
	return out;
}

/**
 * The DTLS 1.2 transcript hash for Finished: sha-256 over the exact
 * handshake wire bodies as sent/received (12-byte handshake header
 * included, per the reference cache semantics).
 * @param {Buffer[]} handshakeWires full handshake messages (header+body)
 * @returns {Buffer} 32 bytes
 */
export function transcriptHash(handshakeWires, mode = PRF_MODE.SHA256) {
	if (mode === PRF_MODE.MD5SHA1) return transcriptHashLegacy(handshakeWires);
	const h = createHash("sha256");
	for (const wire of handshakeWires) h.update(wire);
	return h.digest();
}
