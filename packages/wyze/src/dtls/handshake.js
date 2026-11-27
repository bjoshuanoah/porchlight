// handshake.js — DTLS handshake message builders/parsers (PORCH-131).
//
// Wire shapes per pion/dtls (the DTLS implementation the reference Wyze
// client rides). Only the message set this session can carry is ported:
// ClientHello, HelloVerifyRequest, ServerHello, ServerKeyExchange,
// ServerHelloDone, ClientKeyExchange, Finished. Unknown ServerHello
// extensions are preserved as opaque bytes (the renegotiation_info the
// server may echo) — never dropped, so the transcript stays exact.

import { randomBytes } from "node:crypto";
import { HANDSHAKE_TYPE, DTLS_VERSION_12 } from "./record.js";
import { CIPHER_SUITE } from "./cipher.js";
import { NAMED_CURVE } from "./keys.js";

/** Random of record: 4-byte unix seconds + 28 random bytes (pion layout).
 *  Inject the clock/rng for deterministic tests. */
export function makeRandom(nowSec = Math.floor(Date.now() / 1000), rng = (n) => randomBytes(n)) {
	const b = Buffer.alloc(32);
	b.writeUInt32BE(nowSec >>> 0, 0);
	rng(28).copy(b, 4);
	return b;
}

/**
 * buildClientHello — either the initial hello or the post-HelloVerifyRequest
 * retry (cookie present). The Wyze client of record offers ONLY the CCAC
 * suite and the three curves, no extended-master-secret (disabled by the
 * reference config), sigalgs + renegotiation_info first.
 * @param {{
 *   random?: Buffer,
 *   sessionId: Buffer,
 *   cookie?: Buffer|null,
 *   messageSequence: number,
 *   cipherSuites?: number[],
 *   curves?: number[],
 * }} p
 * @returns {Buffer} full handshake message (header + body)
 */
export function buildClientHello({ random = makeRandom(), sessionId, cookie = null, messageSequence, cipherSuites = [CIPHER_SUITE.ECDHE_PSK_CHACHA20_POLY1305_SHA256], curves = [NAMED_CURVE.X25519, NAMED_CURVE.P256, NAMED_CURVE.P384] }) {
	const body = [];
	body.push(DTLS_VERSION_12[0], DTLS_VERSION_12[1]); // 254.3
	body.push(...random);
	body.push(sessionId.length);
	body.push(...sessionId);
	body.push(cookie?.length ?? 0);
	if (cookie?.length) body.push(...cookie);
	const cs = Buffer.alloc(2 + cipherSuites.length * 2);
	cs.writeUInt16BE(cipherSuites.length * 2, 0);
	cipherSuites.forEach((id, i) => cs.writeUInt16BE(id, 2 + i * 2));
	body.push(...cs);
	body.push(1, 0); // one compression method: null
	const extensions = [];
	// supported_signature_algorithms (13): sha256+ecdsa(0x0403), sha256+rsa(0x0401) etc —
	// the four entries pion sends by default.
	const sigalgs = [0x0401, 0x0403, 0x0501, 0x0503, 0x0601, 0x0603, 0x0201, 0x0203];
	const extSig = Buffer.alloc(6 + sigalgs.length * 2);
	extSig.writeUInt16BE(13, 0);
	extSig.writeUInt16BE(2 + sigalgs.length * 2, 2);
	extSig.writeUInt16BE(sigalgs.length * 2, 4);
	sigalgs.forEach((id, i) => extSig.writeUInt16BE(id, 6 + i * 2));
	extensions.push(extSig);
	// renegotiation_info (65281): [00]
	extensions.push(Buffer.from([0xff, 0x01, 0x00, 0x01, 0x00]));
	// supported_elliptic_curves (10) + supported_point_formats (11)
	const ec = Buffer.alloc(6 + curves.length * 2);
	ec.writeUInt16BE(10, 0);
	ec.writeUInt16BE(2 + curves.length * 2, 2);
	ec.writeUInt16BE(curves.length * 2, 4);
	curves.forEach((id, i) => ec.writeUInt16BE(id, 6 + i * 2));
	extensions.push(ec);
	extensions.push(Buffer.from([0x00, 0x0b, 0x00, 0x02, 0x01, 0x00]));
	const extLen = extensions.reduce((n, e) => n + e.length, 0);
	const extPrefix = Buffer.alloc(2);
	extPrefix.writeUInt16BE(extLen, 0);
	body.push(...extPrefix);
	for (const e of extensions) body.push(...e);
	return Buffer.concat([handshakeEnvelope(HANDSHAKE_TYPE.CLIENT_HELLO, messageSequence, Buffer.from(body)), Buffer.from(body)]);
}

/** Wrap a body with the DTLS handshake header. */
export function handshakeEnvelope(type, messageSequence, body) {
	const b = Buffer.alloc(12);
	b[0] = type;
	b.writeUIntBE(body.length, 1, 3);
	b.writeUInt16BE(messageSequence, 4);
	b.writeUIntBE(0, 6, 3);
	b.writeUIntBE(body.length, 9, 3);
	return b;
}

/**
 * buildFinished — verify data already carries the 12-byte header.
 * @param {{ messageSequence: number, verifyData: Buffer }} p
 * @returns {Buffer}
 */
export function buildFinished({ messageSequence, verifyData }) {
	return Buffer.concat([handshakeEnvelope(HANDSHAKE_TYPE.FINISHED, messageSequence, verifyData), verifyData]);
}

/** Parse ServerHello @returns {{ version: [number,number], random: Buffer, sessionId: Buffer, cipherSuite: number, extensions: Buffer|null } | null}
 */
export function parseServerHello(body) {
	if (body.length < 2 + 32 + 1 + 2 + 1) return null;
	const sessionIdLen = body[34];
	let off = 35 + sessionIdLen;
	if (body.length < off + 3) return null;
	return {
		version: [body[0], body[1]],
		random: Buffer.from(body.subarray(2, 34)),
		sessionId: Buffer.from(body.subarray(35, 35 + sessionIdLen)),
		cipherSuite: body.readUInt16BE(off),
		compression: body[off + 2],
		extensions: body.length > off + 3 ? Buffer.from(body.subarray(off + 3)) : null,
	};
}

/** Parse HelloVerifyRequest: version + cookie. */
export function parseHelloVerifyRequest(body) {
	if (body.length < 3) return null;
	const len = body[2];
	if (body.length < 3 + len) return null;
	return { version: [body[0], body[1]], cookie: Buffer.from(body.subarray(3, 3 + len)) };
}

/**
 * Parse ServerKeyExchange (PSK|ECDHE_PSK shapes).
 * @returns {{
 *   identityHint: Buffer|null,
 *   curve?: number,
 *   publicKey?: Buffer,
 * } | null}
 */
export function parseServerKeyExchange(body, { pskMode = true, ecdheMode = false } = {}) {
	let off = 0;
	let identityHint = null;
	if (pskMode && body.length >= 2) {
		const hintLen = body.readUInt16BE(off);
		identityHint = Buffer.from(body.subarray(2, 2 + hintLen));
		off += 2 + hintLen;
	}
	if (!ecdheMode) {
		return { identityHint };
	}
	// elliptic curve type (1 byte: 3 = named_curve) + curve number (2) + key
	if (off + 4 > body.length || body[off] !== 3) return { identityHint };
	const curve = body.readUInt16BE(off + 1);
	off += 3; // type(1) + curve(2) → the key-length byte
	if (off >= body.length) return { identityHint, curve };
	const pkLen = body[off];
	off += 1;
	return { identityHint, curve, publicKey: Buffer.from(body.subarray(off, off + pkLen)) };
}

/**
 * buildClientKeyExchange — ECDHE-PSK shape: 2-byte identity length +
 * identity + 1-byte key length + client point (pion CKE marshal).
 * @param {{ identity: Buffer, publicKeyRaw?: Buffer|null }} p
 * @returns {Buffer} full handshake message
 */
export function buildClientKeyExchange({ identity, publicKeyRaw = null, messageSequence }) {
	const body = Buffer.alloc(2 + identity.length + (publicKeyRaw ? 1 + publicKeyRaw.length : 0));
	body.writeUInt16BE(identity.length, 0);
	identity.copy(body, 2);
	if (publicKeyRaw) {
		body[2 + identity.length] = publicKeyRaw.length;
		publicKeyRaw.copy(body, 3 + identity.length);
	}
	return Buffer.concat([handshakeEnvelope(HANDSHAKE_TYPE.CLIENT_KEY_EXCHANGE, messageSequence, body), body]);
}

/** buildServerHello (server role). */
export function buildServerHello({ random, sessionId, cipherSuite, extensions = null, messageSequence }) {
	const sessionIdPart = Buffer.concat([Buffer.from([sessionId.length]), sessionId]);
	const cs = Buffer.alloc(2);
	cs.writeUInt16BE(cipherSuite, 0);
	const body = Buffer.concat([
		Buffer.from([DTLS_VERSION_12[0], DTLS_VERSION_12[1]]),
		random,
		sessionIdPart,
		cs,
		Buffer.from([0]),
		// The 2-byte extensions block length precedes the extension bytes.
		...(extensions && extensions.length ? [Buffer.alloc(0)] : []),
		extensions && extensions.length ? (() => { const p = Buffer.alloc(2); p.writeUInt16BE(extensions.length, 0); return [p, extensions]; })() : [Buffer.alloc(0)],
	].flat());
	return Buffer.concat([handshakeEnvelope(HANDSHAKE_TYPE.SERVER_HELLO, messageSequence, body), body]);
}

/** buildHelloVerifyRequest (server role). */
export function buildHelloVerifyRequest({ cookie, messageSequence }) {
	const body = Buffer.concat([Buffer.from([DTLS_VERSION_12[0], DTLS_VERSION_12[1]]), Buffer.from([cookie.length]), cookie]);
	return Buffer.concat([handshakeEnvelope(HANDSHAKE_TYPE.HELLO_VERIFY_REQUEST, messageSequence, body), body]);
}

/** buildServerKeyExchange (server role; ECDHE-PSK: hint + curve + point). */
export function buildServerKeyExchange({ identityHint, curve = null, publicKeyRaw = null, messageSequence }) {
	const parts = [];
	const hint = Buffer.isBuffer(identityHint) ? identityHint : Buffer.from(identityHint, "utf8");
	const hintLen = Buffer.alloc(2);
	hintLen.writeUInt16BE(hint.length, 0);
	parts.push(hintLen, hint);
	if (publicKeyRaw) {
		if (curve !== NAMED_CURVE.X25519 && curve !== NAMED_CURVE.P256 && curve !== NAMED_CURVE.P384) {
			throw new Error(`buildServerKeyExchange: unsupported curve 0x${curve?.toString(16)}`);
		}
		// go2rtc/pion wire: curve type (3 = named_curve) + curve number (2 bytes).
		parts.push(Buffer.from([3, (curve >> 8) & 0xff, curve & 0xff]), Buffer.from([publicKeyRaw.length]), publicKeyRaw);
	}
	const body = Buffer.concat(parts);
	return Buffer.concat([handshakeEnvelope(HANDSHAKE_TYPE.SERVER_KEY_EXCHANGE, messageSequence, body), body]);
}

/** Empty ServerHelloDone body (server role). */
export function buildServerHelloDone({ messageSequence }) {
	return Buffer.concat([handshakeEnvelope(HANDSHAKE_TYPE.SERVER_HELLO_DONE, messageSequence, Buffer.alloc(0))]);
}
