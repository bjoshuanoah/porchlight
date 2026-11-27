// server.js — the DTLS-PSK server engine (PORCH-131). The server role the
// adapter needs twice: the Wyze AV backchannel (intercom — the camera asks
// US to speak DTLS server, the reference's NewDTLSServer semantics) and the
// fake camera the contract test harness runs as a local peer for the
// client role. Same two suites of record. Flight map:
//
//   in: ClientHello → out: HelloVerifyRequest (then ServerHello + SKE + SHD)
//   in: ClientKeyExchange (epoch 0)        → nothing; keys derive
//   in: Finished (epoch 1, decrypted)      → out: ChangeCipherSpec + Finished
//
// After "connect", sendApplicationData/receive applicationData exchange
// keyed records.

import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { CONTENT_TYPE, HANDSHAKE_TYPE, parseDatagramRecords, HandshakeFragmenter, recordHeader, parseHandshakeHeader } from "./record.js";
import { CIPHER_SUITE, SUITE_PARAMS, isAeadSuite, cbcEncryptRecord, ccacEncryptRecord, cbcDecryptRecord, ccacDecryptRecord } from "./cipher.js";
import {
	masterSecret, generateEncryptionKeys, verifyDataClient, verifyDataServer,
	pskPreMasterSecret, ecdhePskPreMasterSecret, transcriptHash,
} from "./prf.js";
import { SUITE_HASH_MODE } from "./cipher.js";
import { generateEcdhKeypair, ecdhShared, NAMED_CURVE } from "./keys.js";
import {
	buildServerHello, buildHelloVerifyRequest, buildServerKeyExchange,
	buildServerHelloDone, buildFinished, makeRandom,
} from "./handshake.js";

const PSK_IDENTITY_HINT = "AUTHPWD_admin";
const SESSION_TIMEOUT_MS = 10_000;
const DTLS_MTU = 1200;

export class DtlsPskServer extends EventEmitter {
	/**
	 * @param {{
	 *   psk: Buffer,
	 *   suites?: number[],
	 *   requireHelloVerify?: boolean,
	 *   cookie?: (n: number) => Buffer,
	 *   random?: (n: number) => Buffer,
	 *   log?: (line: string) => void,
	 * }} p
	 */
	constructor({ psk, suites = [CIPHER_SUITE.PSK_AES128_CBC_SHA256, CIPHER_SUITE.PSK_AES128_CBC_SHA, CIPHER_SUITE.PSK_AES256_CBC_SHA, CIPHER_SUITE.ECDHE_PSK_AES128_CBC_SHA, CIPHER_SUITE.ECDHE_PSK_CHACHA20_POLY1305_SHA256], requireHelloVerify = true, cookie = null, random = (n) => randomBytes(n), log = () => {} }) {
		super();
		this.psk = psk;
		this.suites = suites;
		this.requireHelloVerify = requireHelloVerify;
		this.random = random;
		this.log = log;
		this.serverRandom = makeRandom(undefined, random);
		this.sessionId = random(32);
		this.cookieBytes = requireHelloVerify ? (cookie?.(32) ?? random(32)) : null;
		/** @type {{ cipherSuite: number, curve: number|null }|null} */
		this.negotiated = null;
		/** handshake wires the Finished transcript hashes (header+body each) */
		this.transcript = [];
		/** @type {Buffer|null} the processed ClientHello's full wire */
		this.clientHelloWire = null;
		this.clientRandom = null;
		this.messageSequence = 0;
		/** The client's renegotiation_info offer (echoed in ServerHello). */
		this.clientSupportsRenegotiation = false;
		/** epoch-0 record sequence of record (DTLS replay protection upstream) */
		this.epoch0Seq = 0;
		this.fragmenter = new HandshakeFragmenter();
		/** @type {{ curve: number, privateKey: import("node:crypto").KeyObject, publicKeyRaw: Buffer }|null} */
		this.keypair = null;
		/** @type {null|import("./client.js").DtlsSessionKeys} */
		this.keys = null;
		this.serverNextSeq = 0;
		this.clientHelloCount = 0;
		/** @type {Buffer[]|null} last flight-4 burst for duplicate-CH retransmit */
		this.flight4 = null;
		this.state = "wait-ch";
		/** @type {NodeJS.Timeout|null} */
		this.timer = null;
		this.closed = false;
	}

	/** Arm the arrival timer — the server role never idles on a dead peer. */
	start() {
		this.timer = setTimeout(() => {
			if (this.keys || this.closed) return;
			this.closed = true;
			this.emit("error", new Error("no DTLS client arrived within ten seconds — this server role does not idle"));
		}, SESSION_TIMEOUT_MS);
		this.timer.unref?.();
		return this;
	}

	clearTimer() {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	/**
	 * Pump one inbound datagram.
	 * @param {Buffer} wire
	 * @returns {{ out: Buffer[], error?: Error }}
	 */
	push(wire) {
		if (this.closed && !this.keys) return { out: [] };
		try {
			const records = parseDatagramRecords(wire);
			/** @type {Buffer[]} */
			let out = [];
			for (const { header, body } of records) {
				out = out.concat(header.epoch === 0 ? this.#handleEpoch0Record(header, body) : this.#handleEpoch1Record(header, body));
			}
			return { out };
		} catch (err) {
			return { out: [], error: err instanceof Error ? err : new Error(String(err)) };
		}
	}

	#handleEpoch0Record(header, body) {
		if (header.contentType !== CONTENT_TYPE.HANDSHAKE) {
			// ChangeCipherSpec (the client's) needs no reply.
			return [];
		}
		for (const msg of this.fragmenter.feed(body)) {
			if (msg.type === HANDSHAKE_TYPE.CLIENT_HELLO) {
				const reply = this.#handleClientHello(msg.wire);
				if (reply?.length) return reply;
				continue;
			}
			if (msg.type === HANDSHAKE_TYPE.CLIENT_KEY_EXCHANGE && !this.keys && this.negotiated) {
				this.#onClientKeyExchange(msg.wire);
				continue;
			}
		}
		return [];
	}

	#handleClientHello(wire) {
		this.clientHelloCount += 1;
		if (this.requireHelloVerify && this.cookieBytes && !this.#clientCarriedCookie(wire)) {
			const hvr = buildHelloVerifyRequest({ cookie: this.cookieBytes, messageSequence: this.messageSequence++ });
			return [Buffer.concat([recordHeader(CONTENT_TYPE.HANDSHAKE, 0, this.epoch0Seq++, hvr.length), hvr])];
		}
		if (this.clientHelloCount > 1 && this.flight4) {
			// Duplicate ClientHello before the client's flight 5: replay flight 4
			// (DTLS retransmission semantics; not a protocol error).
			return this.flight4;
		}
		const wanted = this.#clientCipherSuites(wire);
		const chosen = this.suites.find((sid) => wanted.includes(sid));
		if (!chosen) {
			this.#fail("the DTLS client offered no cipher suite of record");
			return [];
		}
		const body = wire.subarray(12);
		this.clientRandom = Buffer.from(body.subarray(2, 34));
		this.clientSupportsRenegotiation = this.#clientHasRenegotiationInfo(wire);
		this.clientHelloWire = Buffer.from(wire);
		this.negotiated = { cipherSuite: chosen, curve: null };
		this.transcript = [wire];
		const params = SUITE_PARAMS[chosen];
		if (params.ecc) {
			const offered = this.#clientCurves(wire);
			const curve = [NAMED_CURVE.X25519, NAMED_CURVE.P256, NAMED_CURVE.P384].find((c) => offered.includes(c));
			if (!curve) {
				this.#fail("the DTLS client offered no supported ECDHE curve");
				return [];
			}
			this.negotiated.curve = curve;
			this.keypair = generateEcdhKeypair(curve);
		} else {
			this.keypair = null;
		}
		this.flight4 = this.#flight4Burst();
		return this.flight4;
	}

	/** Detect renegotiation_info (0xff01) among the CH extensions. */
	#clientHasRenegotiationInfo(wire) {
		const body = wire.subarray(12);
		let off = 2 + 32;
		off += 1 + body[off];
		off += 1 + body[off];
		off += 2 + body.readUInt16BE(off);
		off += 1 + body[off];
		if (off + 2 > body.length) return false;
		const extLen = body.readUInt16BE(off);
		off += 2;
		const end = Math.min(off + extLen, body.length);
		while (off + 4 <= end) {
			const type = body.readUInt16BE(off);
			const len = body.readUInt16BE(off + 2);
			if (type === 0xff01) return true;
			off += 4 + len;
		}
		return false;
	}

	#clientCarriedCookie(wire) {
		const body = wire.subarray(12);
		let off = 2 + 32;
		off += 1 + body[off];
		return body[off] > 0;
	}

	#clientCipherSuites(wire) {
		const body = wire.subarray(12);
		let off = 2 + 32;
		off += 1 + body[off];
		off += 1 + body[off];
		const suitesLen = body.readUInt16BE(off);
		off += 2;
		/** @type {number[]} */
		const suites = [];
		for (let i = 0; i + 2 <= suitesLen; i += 2) suites.push(body.readUInt16BE(off + i));
		return suites;
	}

	#clientCurves(wire) {
		const body = wire.subarray(12);
		let off = 2 + 32;
		off += 1 + body[off];
		off += 1 + body[off];
		const suitesLen = body.readUInt16BE(off);
		off += 2 + suitesLen;
		off += 1 + body[off]; // compression methods
		if (off + 2 > body.length) return [];
		const extLen = body.readUInt16BE(off);
		off += 2;
		const extEnd = Math.min(off + extLen, body.length);
		/** @type {number[]} */
		const curves = [];
		while (off + 4 <= extEnd) {
			const type = body.readUInt16BE(off);
			const len = body.readUInt16BE(off + 2);
			const value = body.subarray(off + 4, Math.min(off + 4 + len, body.length));
			if (type === 10 && value.length >= 2) {
				for (let i = 0; i + 2 <= value.length; i += 2) curves.push(value.readUInt16BE(i));
			}
			off += 4 + len;
		}
		return curves;
	}

	/**
	 * Flight 4 burst: ServerHello + ServerKeyExchange + ServerHelloDone.
	 * @returns {Buffer[]}
	 */
	#flight4Burst() {
		const suite = this.negotiated.cipherSuite;
		const sh = buildServerHello({
			random: this.serverRandom,
			sessionId: this.sessionId,
			cipherSuite: suite,
			messageSequence: this.messageSequence,
			extensions: this.clientSupportsRenegotiation ? Buffer.from([0xff, 0x01, 0x00, 0x01, 0x00]) : null,
		});
		this.messageSequence += 1;
		this.transcript.push(sh);
		const ske = buildServerKeyExchange({
			identityHint: PSK_IDENTITY_HINT,
			curve: this.keypair?.curve ?? null,
			publicKeyRaw: this.keypair?.publicKeyRaw ?? null,
			messageSequence: this.messageSequence,
		});
		this.messageSequence += 1;
		this.transcript.push(ske);
		const shd = buildServerHelloDone({ messageSequence: this.messageSequence });
		this.messageSequence += 1;
		this.transcript.push(shd);
		return [sh, ske, shd]
			.map((wire) => Buffer.concat([recordHeader(CONTENT_TYPE.HANDSHAKE, 0, this.epoch0Seq++, wire.length), wire]))
			.flatMap((record) => this.#toDatagrams([record]));
	}

	/**
	 * ClientKeyExchange (epoch 0): derive the session keys.
	 * @param {Buffer} wire
	 */
	#onClientKeyExchange(wire) {
		const body = wire.subarray(12);
		const suite = this.negotiated.cipherSuite;
		const params = SUITE_PARAMS[suite];
		const mode = SUITE_HASH_MODE[suite] ?? "sha256";
		try {
			const parsed = this.#clientKeyExchangeParse(body, params.ecc);
			this.transcript.push(Buffer.from(wire));
			/** @type {Buffer} */
			let preMaster;
			if (params.ecc) {
				const shared = ecdhShared(this.keypair, this.keypair.curve, parsed.publicKey);
				preMaster = ecdhePskPreMasterSecret(this.psk, shared);
			} else {
				preMaster = pskPreMasterSecret(this.psk);
			}
			const ms = masterSecret(preMaster, this.clientRandom, this.serverRandom, mode);
			const k = generateEncryptionKeys(ms, this.clientRandom, this.serverRandom, params, mode);
			this.keys = {
				masterSecret: ms,
				cipherSuite: suite,
				curve: params.ecc ? this.negotiated.curve : null,
				// Server role: we encrypt with the SERVER keys, decrypt with CLIENT.
				hashMode: mode,
				clientMacKey: k.clientMacKey,
				serverMacKey: k.serverMacKey,
				clientWriteKey: k.clientWriteKey,
				serverWriteKey: k.serverWriteKey,
				clientWriteIv: k.clientWriteIv,
				serverWriteIv: k.serverWriteIv,
			};
			this.state = "wait-finished";
		} catch (err) {
			this.#fail(err instanceof Error ? err.message : String(err));
		}
	}

	#clientKeyExchangeParse(body, ecdhe) {
		if (body.length < 2) throw new Error("the client's DTLS ClientKeyExchange is too short");
		const identityLen = body.readUInt16BE(0);
		const identity = Buffer.from(body.subarray(2, 2 + identityLen));
		let off = 2 + identityLen;
		if (!ecdhe) return { identity, publicKey: null };
		if (off >= body.length) throw new Error("the client's ECDHE ClientKeyExchange carries no curve point");
		const pkLen = body[off];
		off += 1;
		const publicKey = Buffer.from(body.subarray(off, off + pkLen));
		if (publicKey.length !== pkLen) throw new Error("the client's ECDHE ClientKeyExchange point is truncated");
		return { identity, publicKey };
	}

	#handleEpoch1Record(header, body) {
		if (!this.keys || header.epoch !== 1) return [];
		let plain;
		try {
			const wire = Buffer.concat([recordHeader(header.contentType, header.epoch, header.sequence, body.length), body]);
			plain = isAeadSuite(this.keys.cipherSuite)
				? ccacDecryptRecord(wire, { key: this.keys.clientWriteKey, iv: this.keys.clientWriteIv })
				: cbcDecryptRecord(wire, { key: this.keys.clientWriteKey, macKey: this.keys.clientMacKey });
		} catch (err) {
			this.#fail(`the client's keyed DTLS record failed to decrypt: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
		if (header.contentType === CONTENT_TYPE.APPLICATION_DATA) {
			this.emit("applicationData", plain);
			return [];
		}
		if (header.contentType === CONTENT_TYPE.HANDSHAKE) {
			return this.#verifyClientFinished(Buffer.from(plain));
		}
		return [];
	}

	/**
	 * Verify the client's Finished; its verify data covers the transcript up
	 * to (and including) ClientKeyExchange. Replies with flight 6.
	 * @param {Buffer} plain decrypted handshake wire (header + verify data)
	 * @returns {Buffer[]}
	 */
	#verifyClientFinished(plain) {
		if (this.state !== "wait-finished") return [];
		const mh = parseHandshakeHeader(plain);
		if (!mh || mh.type !== HANDSHAKE_TYPE.FINISHED || plain.length !== 24) {
			this.#fail("the client's keyed DTLS Finished message is malformed");
			return [];
		}
		if (!Buffer.from(plain.subarray(12)).equals(verifyDataClient(this.keys.masterSecret, transcriptHash(this.transcript, this.keys.hashMode), this.keys.hashMode))) {
			this.#fail("the client's DTLS Finished verify data did not match — no shared premaster secret");
			return [];
		}
		// The SERVER's Finished verify covers the transcript incl. client Finished.
		this.transcript.push(plain);
		const verifyData = verifyDataServer(this.keys.masterSecret, transcriptHash(this.transcript, this.keys.hashMode), this.keys.hashMode);
		const finished = buildFinished({ messageSequence: this.messageSequence, verifyData });
		this.messageSequence += 1;
		this.state = "established";
		this.clearTimer();
		this.emit("connect", { cipherSuite: this.keys.cipherSuite, curve: this.keys.curve });
		const packets = [
			Buffer.concat([recordHeader(CONTENT_TYPE.CHANGE_CIPHER_SPEC, 0, this.epoch0Seq++, 1), Buffer.from([1])]),
			this.#encryptRecord(CONTENT_TYPE.HANDSHAKE, finished, this.serverNextSeq++),
		];
		return this.#toDatagrams(packets);
	}

	#encryptRecord(contentType, body, seq) {
		const header = { contentType, epoch: 1, sequence: seq };
		if (isAeadSuite(this.keys.cipherSuite)) {
			return ccacEncryptRecord({ header, payload: body, key: this.keys.serverWriteKey, iv: this.keys.serverWriteIv });
		}
		return cbcEncryptRecord({ header, payload: body, key: this.keys.serverWriteKey, macKey: this.keys.serverMacKey });
	}

	/** Encrypt one application-data record (after "connect"). */
	sendApplicationData(payload) {
		if (!this.keys || this.state !== "established") throw new Error("the DTLS session has not connected yet");
		return this.#encryptRecord(CONTENT_TYPE.APPLICATION_DATA, payload, this.serverNextSeq++);
	}

	#fail(message) {
		this.closed = true;
		this.emit("error", new Error(message));
	}

	#toDatagrams(records) {
		/** @type {Buffer[]} */
		const out = [];
		for (const record of records) {
			for (let off = 0; off < record.length; off += DTLS_MTU) {
				out.push(Buffer.from(record.subarray(off, Math.min(off + DTLS_MTU, record.length))));
			}
		}
		return out;
	}
}

