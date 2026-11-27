// client.js — the DTLS-PSK client engine (PORCH-131): the exact handshake
// the reverse-engineered Wyze session performs against the camera, then
// the record transport both sides ride after handshake. Port of the
// pion/dtls client flights the reference uses, specialized to the two
// suites of record (CCAC preferred, CBC fallback):
//
//   flight 3: ClientHello (→ HelloVerifyRequest → ClientHello with cookie)
//   flight 5: ClientKeyExchange + ChangeCipherSpec + Finished (encrypted)
//   flight 6: server Finished (verified against the transcript before use)
//
// Transport-agnostic: the caller pumps datagrams in (`push()`) and receives
// outbound datagram bursts from the same call. One engine instance carries
// one DTLS session (the IOTC channel 0 or 1 direction).

import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { CONTENT_TYPE, HANDSHAKE_TYPE, DTLS_MTU, parseDatagramRecords, HandshakeFragmenter, recordHeader, parseHandshakeHeader } from "./record.js";
import { CIPHER_SUITE, SUITE_PARAMS, isAeadSuite, cbcEncryptRecord, ccacEncryptRecord, cbcDecryptRecord, ccacDecryptRecord } from "./cipher.js";
import {
	masterSecret, generateEncryptionKeys, verifyDataClient, verifyDataServer,
	pskPreMasterSecret, ecdhePskPreMasterSecret, transcriptHash,
} from "./prf.js";
import { SUITE_HASH_MODE } from "./cipher.js";
import { generateEcdhKeypair, ecdhShared, NAMED_CURVE } from "./keys.js";
import {
	buildClientHello, buildClientKeyExchange, buildFinished,
	parseHelloVerifyRequest, parseServerHello, parseServerKeyExchange,
} from "./handshake.js";

const HANDSHAKE_TIMEOUT_MS = 5000;

/**
 * Agreed session keys of record (serverWrite* for decrypt, clientWrite*
 * for encrypt).
 *
 * @typedef {{
 *   masterSecret: Buffer, cipherSuite: number, curve: number|null,
 *   clientMacKey: Buffer, serverMacKey: Buffer, clientWriteKey: Buffer,
 *   serverWriteKey: Buffer, clientWriteIv: Buffer, serverWriteIv: Buffer,
 * }} DtlsSessionKeys
 */

export class DtlsPskClient extends EventEmitter {
	/** True while the negotiated suite is plain-PSK (no ECDHE point). */
	#plainPskSuite = false;
	/** Set once the handshake's ServerKeyExchange has landed (or is skipped). */
	skeSeen = false;

	/**
	 * @param {{
	 *   psk: Buffer,
	 *   identity: Buffer|string,
	 *   clientRandom?: Buffer,
	 *   sessionId?: Buffer,
	 *   random?: (n: number) => Buffer,
	 *   log?: (line: string) => void,
	 * }} p
	 */
	constructor({ psk, identity, clientRandom = null, sessionId = null, random = (n) => randomBytes(n), log = () => {}, cipherSuites = [CIPHER_SUITE.ECDHE_PSK_CHACHA20_POLY1305_SHA256], curves = [NAMED_CURVE.X25519, NAMED_CURVE.P256, NAMED_CURVE.P384] }) {
		super();
		this.psk = psk;
		this.identity = Buffer.isBuffer(identity) ? identity : Buffer.from(identity, "utf8");
		this.log = log;
		this.random = random;
		this.cipherSuites = cipherSuites;
		this.curves = curves;
		this.clientRandom = clientRandom ?? random(32);
		this.sessionId = sessionId ?? random(32);
		/** @type {DtlsSessionKeys|null} */
		this.keys = null;
		this.clientNextSeq = 0;
		/** epoch-0 record sequence of record (DTLS replay protection upstream) */
		this.epoch0Seq = 0;
		/** handshake wires for the Finished transcript (header+body each) */
		this.transcript = [];
		this.cookie = null;
		this.messageSequence = 0;
		this.fragmenter = new HandshakeFragmenter();
		this.expectingHelloVerify = false;
		/** @type {{ curve: number, privateKey: import("node:crypto").KeyObject, publicKeyRaw: Buffer }|null} */
		this.keypair = null;
		this.serverHello = null;
		/** @type {NodeJS.Timeout|null} */
		this.timer = null;
		this.closed = false;
	}

	/** Start the handshake: flight 3 (ClientHello).
	 *  @returns {Buffer[]} outbound datagrams. */
	start() {
		this.timer = setTimeout(() => this.#timeout(), HANDSHAKE_TIMEOUT_MS);
		this.timer.unref?.();
		return this.#sendHandshake([this.#clientHelloWire()]);
	}

	#clientHelloWire() {
		const wire = buildClientHello({
			random: this.clientRandom,
			sessionId: this.sessionId,
			cookie: this.cookie,
			messageSequence: this.messageSequence++,
			cipherSuites: this.cipherSuites,
			curves: this.curves,
		});
		this.transcript.push(wire);
		return wire;
	}

	#timeout() {
		if (this.closed || this.keys) return;
		this.closed = true;
		this.emit("error", new Error("the camera did not complete its DTLS handshake within five seconds"));
	}

	/**
	 * Pump one inbound datagram (one direction's DTLS channel).
	 * @param {Buffer} wire
	 * @returns {{ out: Buffer[], error?: Error }} outbound datagrams
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
		if (header.contentType === CONTENT_TYPE.HANDSHAKE) {
			for (const msg of this.fragmenter.feed(body)) {
				const reply = this.#handleHandshake(msg);
				if (reply?.length) return reply;
			}
			return [];
		}
		if (header.contentType === CONTENT_TYPE.CHANGE_CIPHER_SPEC) return [];
		const reason = `the camera sent an unexpected DTLS record (type ${header.contentType}) during the handshake${header.contentType === CONTENT_TYPE.ALERT ? `: level ${body[0]} description ${(body[1] << 8) | body[2]}` : ""}`;
		this.closed = true;
		this.emit("error", new Error(reason));
		return [];
	}

	#handleHandshake(msg) {
		if (msg.type === HANDSHAKE_TYPE.HELLO_VERIFY_REQUEST) {
			const hvr = parseHelloVerifyRequest(msg.wire.subarray(12));
			if (!hvr || !hvr.cookie.length) {
				this.#fail("the camera requested a DTLS cookie but sent an empty one");
				return [];
			}
			this.cookie = hvr.cookie;
			this.transcript = []; // the HVR round never joins the Finished transcript
			this.expectingHelloVerify = true;
			return this.#sendHandshake([this.#clientHelloWire()]);
		}
		if (msg.type === HANDSHAKE_TYPE.SERVER_HELLO && !this.serverHello) {
			const sh = parseServerHello(msg.wire.subarray(12));
			if (!sh) {
				this.#fail("the camera's DTLS ServerHello could not be parsed");
				return [];
			}
			if (sh.version[0] !== 0xfe || sh.version[1] !== 0xfd) {
				this.#fail("the camera answered DTLS with a different wire version than DTLS 1.2");
				return [];
			}
			this.serverHello = sh;
			this.skeSeen = false;
			this.#plainPskSuite = !SUITE_PARAMS[sh.cipherSuite]?.ecc;
			this.transcript.push(msg.wire);
			if (!SUITE_PARAMS[sh.cipherSuite]) {
				this.#fail(`the camera chose an unsupported cipher suite (0x${sh.cipherSuite.toString(16)})`);
				return [];
			}
			return [];
		}
		if (!this.serverHello || this.flight5Sent) return [];
		if (msg.type === HANDSHAKE_TYPE.SERVER_KEY_EXCHANGE) {
			const ske = parseServerKeyExchange(msg.wire.subarray(12), {
				pskMode: true,
				ecdheMode: !!SUITE_PARAMS[this.serverHello.cipherSuite].ecc,
			});
			this.transcript.push(msg.wire);
			const err = this.#deriveKeys(ske);
			this.skeSeen = true;
			if (err) {
				this.closed = true;
				this.emit("error", err);
			}
			return [];
		}
		if (msg.type === HANDSHAKE_TYPE.SERVER_HELLO_DONE && this.keys) {
			this.transcript.push(msg.wire);
			return this.#startFlight5();
		}
		if (msg.type === HANDSHAKE_TYPE.SERVER_HELLO_DONE && !this.keys && this.#plainPsk) {
			// Plain-PSK sessions may skip the ServerKeyExchange entirely (pion:
			// "handshakeMessageServerKeyExchange is optional for PSK").
			this.transcript.push(msg.wire);
			const err = this.#deriveKeys(null);
			if (err) {
				this.closed = true;
				this.emit("error", err);
				return [];
			}
			return this.#startFlight5();
		}
		return [];
	}

	get #plainPsk() {
		return this.#plainPskSuite === true && !this.skeSeen;
	}

	#deriveKeys(ske) {
		if (ske) this.skeSeen = true;
		const suite = this.serverHello.cipherSuite;
		const params = SUITE_PARAMS[suite];
		const mode = SUITE_HASH_MODE[suite] ?? "sha256";
		/** @type {Buffer} */
		let preMaster;
		if (params.ecc) {
			if (!ske?.curve || !ske?.publicKey) {
				return new Error("the camera's ECDHE key exchange arrived without curve/point");
			}
			const keypair = generateEcdhKeypair(ske.curve);
			this.keypair = keypair;
			let shared;
			try {
				shared = ecdhShared(keypair, ske.curve, ske.publicKey);
			} catch (err) {
				return err instanceof Error ? err : new Error(String(err));
			}
			preMaster = ecdhePskPreMasterSecret(this.psk, shared);
		} else {
			preMaster = pskPreMasterSecret(this.psk);
		}
		const ms = masterSecret(preMaster, this.clientRandom, this.serverHello.random, mode);
		this.keys = { masterSecret: ms, cipherSuite: suite, hashMode: mode, curve: this.keypair?.curve ?? null, ...generateEncryptionKeys(ms, this.clientRandom, this.serverHello.random, params, mode) };
		return null;
	}

	#startFlight5() {
		if (!this.keys || this.flight5Sent) return [];
		this.flight5Sent = true;
		const cke = buildClientKeyExchange({ identity: this.identity, publicKeyRaw: this.keypair?.publicKeyRaw ?? null, messageSequence: this.messageSequence++ });
		this.transcript.push(cke);
		const verifyData = verifyDataClient(this.keys.masterSecret, transcriptHash(this.transcript, this.keys.hashMode), this.keys.hashMode);
		const finished = buildFinished({ messageSequence: this.messageSequence++, verifyData });
		this.transcript.push(finished); // the server's Finished verify covers ours too
		const packets = [
			// CKE still rides an epoch-0 handshake record.
			Buffer.concat([recordHeader(CONTENT_TYPE.HANDSHAKE, 0, this.epoch0Seq++, cke.length), cke]),
		];
		// ChangeCipherSpec: plaintext single byte, still at epoch 0.
		packets.push(Buffer.concat([recordHeader(CONTENT_TYPE.CHANGE_CIPHER_SPEC, 0, this.epoch0Seq++, 1), Buffer.from([1])]));
		// Our Finished is the FIRST encrypted record: epoch 1, sequence 0.
		packets.push(this.#encryptRecord(CONTENT_TYPE.HANDSHAKE, finished, 0));
		this.clientNextSeq = 1;
		return this.#toDatagrams(packets);
	}

	/**
	 * Verify the server's Finished (arrives on this.keys' epoch-1 channel).
	 * The transcript for the server's verify data ends at OUR Finished.
	 * @param {Buffer} plain decrypted record body (handshake header + verify)
	 */
	#verifyServerFinished(plain) {
		const mh = parseHandshakeHeader(plain);
		if (!mh || mh.type !== HANDSHAKE_TYPE.FINISHED || plain.length !== 12 + 12) {
			this.#fail("the camera post-handshake DTLS Finished message is malformed");
			return true;
		}
		const verifyData = plain.subarray(12);
		const expected = verifyDataServer(this.keys.masterSecret, transcriptHash(this.transcript, this.keys.hashMode), this.keys.hashMode);
		if (!verifyData.equals(expected)) {
			this.#fail("the camera's DTLS Finished verify data did not match — the camera and this session do not share the same keys");
			return true;
		}
		this.clearTimer();
		this.emit("connect", this.keys);
		return true;
	}

	#fail(message) {
		this.closed = true;
		this.emit("error", new Error(message));
	}

	/**
	 * Encrypt one application-data record (after "connect").
	 * @param {Buffer} payload
	 * @returns {Buffer}
	 */
	sendApplicationData(payload) {
		if (!this.keys) throw new Error("the DTLS session has not connected yet");
		return this.#encryptRecord(CONTENT_TYPE.APPLICATION_DATA, payload, this.clientNextSeq++);
	}

	/**
	 * Decrypt one inbound post-handshake record.
	 * @param {{ header: ReturnType<typeof parseRecordHeader>, body: Buffer }} p
	 * @returns {Buffer|null} plaintext body (null when nothing matches)
	 */
	#decryptEpoch1Record(header, body) {
		if (!this.keys) return null;
		const wire = Buffer.concat([recordHeader(header.contentType, header.epoch, header.sequence, body.length), body]);
		if (isAeadSuite(this.keys.cipherSuite)) {
			return ccacDecryptRecord(wire, { key: this.keys.serverWriteKey, iv: this.keys.serverWriteIv });
		}
		return cbcDecryptRecord(wire, { key: this.keys.serverWriteKey, macKey: this.keys.serverMacKey });
	}

	#handleEpoch1Record(header, body) {
		if (!this.keys || header.epoch !== 1) return [];
		let plain;
		try {
			plain = this.#decryptEpoch1Record(header, body);
		} catch (err) {
			this.#fail(`a post-handshake DTLS record failed to decrypt: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
		if (header.contentType === CONTENT_TYPE.APPLICATION_DATA) {
			this.emit("applicationData", plain);
			return [];
		}
		if (header.contentType === CONTENT_TYPE.HANDSHAKE) {
			if (!this.#verifyServerFinished(Buffer.from(plain))) return [];
		}
		return [];
	}

	#encryptRecord(contentType, body, seq) {
		const header = { contentType, epoch: 1, sequence: seq };
		if (isAeadSuite(this.keys.cipherSuite)) {
			return ccacEncryptRecord({ header, payload: body, key: this.keys.clientWriteKey, iv: this.keys.clientWriteIv });
		}
		return cbcEncryptRecord({ header, payload: body, key: this.keys.clientWriteKey, macKey: this.keys.clientMacKey });
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

	#sendHandshake(wires) {
		const packets = wires.map((wire) => Buffer.concat([recordHeader(CONTENT_TYPE.HANDSHAKE, 0, this.epoch0Seq++, wire.length), wire]));
		return this.#toDatagrams(packets);
	}

	clearTimer() {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}
}
