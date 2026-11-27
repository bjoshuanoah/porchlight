// keys.js — Wyze DTLS credential derivation and ECDH plumbing (PORCH-131).
//
// Port of the reference auth knowledge (go2rtc pkg/tutk/dtls/auth.go):
// the K-auth key from ENR+MAC, the DTLS-PSK derived from ENR (with the
// TUTK C-string 0x00 truncation the firmware actually applies), and the
// named-curve ECDH keys (X25519 / P-256 / P-384) for the ECDHE-PSK suite.
// Curve wiring rides node:crypto — no third-party crypto dependency.

import { createHash, createPublicKey, diffieHellman, generateKeyPairSync } from "node:crypto";

/**
 * calculateAuthKey — the discovery-auth credential: base64 of the first
 * six sha-256 bytes of ENR + upper-case MAC, with the TUTK alphabet
 * substitutions (+→Z /→9 =→A).
 * @param {string} enr
 * @param {string} mac
 * @returns {string} 8 characters
 */
export function calculateAuthKey(enr, mac) {
	const hash = createHash("sha256").update(Buffer.from(enr + mac.toUpperCase(), "utf8")).digest();
	let b64 = hash.subarray(0, 6).toString("base64");
	b64 = b64.replaceAll("+", "Z").replaceAll("/", "9").replaceAll("=", "A");
	return b64;
}

/**
 * derivePsk — the DTLS prematerial: sha-256 of the ENR, truncated at the
 * first 0x00 byte (the TUTK SDK treats the PSK as a NULL-terminated C
 * string, so the firmware does the same truncation).
 * @param {string} enr
 * @returns {Buffer} up to 32 bytes
 */
export function derivePsk(enr) {
	const hash = createHash("sha256").update(Buffer.from(enr, "utf8")).digest();
	let pskLen = 32;
	for (let i = 0; i < 32; i++) {
		if (hash[i] === 0) {
			pskLen = i;
			break;
		}
	}
	return hash.subarray(0, pskLen);
}

/** The named curves of record (pion default client offer order). */
export const NAMED_CURVE = Object.freeze({
	X25519: 0x001d,
	P256: 0x0017,
	P384: 0x0018,
});
export const NAMED_CURVE_NAME = Object.freeze({
	[NAMED_CURVE.X25519]: "X25519",
	[NAMED_CURVE.P256]: "P256",
	[NAMED_CURVE.P384]: "P384",
});

/**
 * Generate an ECDH keypair for a curve number.
 * @param {number} curve NAMED_CURVE constant
 * @returns {{ curve: number, privateKey: import("node:crypto").KeyObject, publicKeyRaw: Buffer }}
 *   publicKeyRaw: X25519 = 32 bytes; P256/P384 = 65/97-byte 0x04-prefixed point.
 */
export function generateEcdhKeypair(curve) {
	if (curve === NAMED_CURVE.X25519) {
		const { publicKey, privateKey } = generateKeyPairSync("x25519");
		return { curve, privateKey, publicKeyRaw: exportX25519Public(publicKey) };
	}
	const name = curve === NAMED_CURVE.P256 ? "P-256" : curve === NAMED_CURVE.P384 ? "P-384" : null;
	if (!name) throw new Error(`generateEcdhKeypair: unsupported curve 0x${curve.toString(16)}`);
	const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: name });
	return { curve, privateKey, publicKeyRaw: exportEcPublicRaw(publicKey) };
}

/**
 * The ECDH shared secret with the peer's raw public key.
 * @param {{ curve: number, privateKey: import("node:crypto").KeyObject }} mine
 * @param {number} curve the negotiated curve number
 * @param {Buffer} peerRaw peer public key (X25519 raw 32B; EC 0x04 point)
 * @returns {Buffer}
 */
export function ecdhShared(mine, curve, peerRaw) {
	if (curve === NAMED_CURVE.X25519) {
		if (peerRaw.length !== 32) throw new Error(`ecdhShared: X25519 peer key must be 32 bytes (got ${peerRaw.length})`);
		const x = Buffer.from(peerRaw).toString("base64url");
		const peer = createPublicKey({ key: { kty: "OKP", crv: "X25519", x }, format: "jwk" });
		return diffieHellman({ privateKey: mine.privateKey, publicKey: peer });
	}
	const name = curve === NAMED_CURVE.P256 ? "P-256" : curve === NAMED_CURVE.P384 ? "P-384" : null;
	if (!name) throw new Error(`ecdhShared: unsupported curve 0x${curve.toString(16)}`);
	if (peerRaw.length < 65 || peerRaw[0] !== 0x04) {
		throw new Error(`ecdhShared: ${name} peer key must be an uncompressed point (got ${peerRaw.length} bytes)`);
	}
	const key = { kty: "EC", crv: name, x: Buffer.from(peerRaw.subarray(1, 1 + (peerRaw.length - 1) / 2)).toString("base64url"), y: Buffer.from(peerRaw.subarray(1 + (peerRaw.length - 1) / 2)).toString("base64url") };
	const peer = createPublicKey({ key, format: "jwk" });
	return diffieHellman({ privateKey: mine.privateKey, publicKey: peer });
}

function exportX25519Public(key) {
	// SPKI DER is a fixed 12-byte prefix + 32 raw bytes.
	const der = key.export({ type: "spki", format: "der" });
	return Buffer.from(der.subarray(der.length - 32));
}

function exportEcPublicRaw(key) {
	// SPKI DER carries the uncompressed 0x04 point as its final content.
	const der = key.export({ type: "spki", format: "der" });
	const idx = der.indexOf(0x04, der.length - 97);
	if (idx === -1) throw new Error("exportEcPublicRaw: could not locate the uncompressed point");
	return Buffer.from(der.subarray(idx));
}
