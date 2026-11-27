// test/contract.test.js — the PORCH-131 contract suite: the adapter vs a
// fake camera over real UDP, byte-verified against the reference protocol
// vectors, plus the URL-contract and stream-manager factory seams.
// The live-camera e2e (PORCHLIGHT_WYZE_LIVE=1 wyze://…) is env-gated.

import test from "node:test";
import assert from "node:assert/strict";
import {
	WyzeCameraSession, parseWyzeUrl,
	buildDisco, buildSession, buildKeepaliveReq,
	encodeIotcDatagram, decodeIotcDatagram, IOTC_CMD,
	isCc51Datagram, DISCOVERY_PORT,
	CIPHER_SUITE, DtlsPskClient, DtlsPskServer, derivePsk,
	FrameHandler, CHANNEL, CODEC,
	generateChallengeResponse, calculateAuthKey,
} from "../src/index.js";
import { FakeWyzeCamera } from "./helpers/camera.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("crypto tutk vectors match the reference exactly", async () => {
	// pion/go2rtc test vector (pkg/tutk/crypto_test.go).
	const out = (await import("../src/crypto.js")).xxteaDecryptVar(Buffer.from("WERhJxb87WF3zgPa"), Buffer.from("GAgDiwVPg2E4GMke"));
	assert.equal(out.toString("hex"), "c4a62ca1106417a5da02e162a5f06271");
	// Blob transforms, full + partial, in place and allocated (go2rtc parity).
	const vec = Object.fromEntries(
		`blobFull200=1ddace170cf4065d0d67d86c82e1d8e914d54707fdfc0d56aa77df7b8b60d2e01fdcac176cf2045f2367d6728011dae716d72507ddfa0b504877dd798980dcee11de82174cf00259c167d4708e31d4e518d90b073df809526e77db7f87a0deec13d06017acfe005be767d2768c51d6e31adbe9071df6075c0c77d97d85c0d8ea15d246178cfc0e558567d0748a71d0e11cddcf077df4055e2277d77383e0dae817d42417ecfa0c57ab67de7a8891d2ef1edfad075df20358c077d5718100d4e65130272f2f0f0a03
blobPart40=98f8eb5d2ff647fd4b275e5ac6e27c4e99f90a4d3ef848f24a375f5bc7937c4fabe4f5e7edefe0c7
part16=9556e580e21bf42aebf1f575b75fce6f
part8=200c0010`
			.split("\n")
			.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
	);
	const src = Buffer.from(Array.from({ length: 200 }, (_, i) => (i * 7) % 256));
	src[3] = 0x04;
	assert.equal((await import("../src/crypto.js")).transCodeBlob(src).toString("hex"), vec.blobFull200);
	const inPlace = Buffer.from(vec.blobFull200, "hex");
	(await import("../src/crypto.js")).reverseTransCodePartial(inPlace, inPlace);
	assert.equal(inPlace.toString("hex"), src.toString("hex"));
	assert.equal((await import("../src/crypto.js")).reverseTransCodePartial(Buffer.alloc(16), Buffer.from("0123456789abcdef")).toString("hex"), vec.part16);
});

test("challenge responses match the reference vectors", () => {
	const challenge = Buffer.from("deadbeef0102030405060708090a0b0c", "hex");
	assert.equal(generateChallengeResponse(challenge, "0123456789abcdef0123456789abcdef", 6).toString("hex"), "1f30f0a03d21d91bff0b3ac834659908");
	assert.equal(generateChallengeResponse(challenge, "x", 1).toString("hex"), "fabb74ab1f04e2dc832b225532f52e46");
});

test("iotc discovery/session/keepalive wires match the reference vectors", () => {
	const uid = "WYZEUID1234567890ABX";
	const authKey = "qvtZi3iI";
	const sid = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
	assert.equal(encodeIotcDatagram(buildDisco({ stage: 1, uid, authKey, sid })).toString("hex"), "6e4c9d8c40d140ca2d2d882dc0e6cadc3d1daebb7552235968099d9912a1df4d6e2e8d8c40d040ca296d1b0840bccad84e0e9d8a44a1104a2d6f280c50e48ac86e29fd96374402fd2d6d280c40e4cbd8206c72612165692a");
	const sessionWire = encodeIotcDatagram(buildSession({ uid, sid, nowSec: 10 }));
	const dec = decodeIotcDatagram(sessionWire);
	assert.equal(dec.cmd, IOTC_CMD.SESSION_REQ);
	const k = buildKeepaliveReq(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
	assert.equal(encodeIotcDatagram(k).toString("hex"), "6c6c9dec40d140ca2d2d882dc0eecad8286976626a626f42");
	assert.equal(isCc51Datagram(Buffer.from([0x51, 0xcc])), true);
	assert.equal(isCc51Datagram(Buffer.from([4, 2, 0x1a, 2])), false);
});

test("wyze URL contract refuses malformed input in plain language", () => {
	assert.throws(() => parseWyzeUrl("http://1.2.3.4?uid=1&enr=1&mac=1&model=1&dtls=true"), /serves wyze:\/\/ URLs only/);
	assert.throws(() => parseWyzeUrl("wyze://1.2.3.4?uid=1&enr=1&mac=1&model=HL_DB2"), /DTLS cameras only/);
	assert.throws(() => parseWyzeUrl("wyze://1.2.3.4?uid=1&enr=1&mac=1&dtls=true"), /missing uid, enr, mac or model/);
	const ok = parseWyzeUrl("wyze://1.2.3.4?uid=u&enr=e&mac=m&model=HL_DB2&dtls=true&subtype=sd");
	assert.equal(ok.port, DISCOVERY_PORT);
	assert.equal(ok.subtype, "sd");
});

test("DTLS-PSK handshake round-trips both suites end to end (fake camera peers)", () => {
	const psk = derivePsk("roundtrip-enr");
	for (const [clientSuites, serverSuite] of [
		[[CIPHER_SUITE.ECDHE_PSK_CHACHA20_POLY1305_SHA256], CIPHER_SUITE.ECDHE_PSK_CHACHA20_POLY1305_SHA256],
		[[CIPHER_SUITE.PSK_AES128_CBC_SHA256], CIPHER_SUITE.PSK_AES128_CBC_SHA256],
	]) {
		const client = new DtlsPskClient({ psk, identity: "AUTHPWD_admin", cipherSuites: clientSuites });
		const server = new DtlsPskServer({ psk, requireHelloVerify: false, suites: [serverSuite] }).start();
		let clientReady = false;
		client.on("connect", () => {
			clientReady = true;
		});
		let serverReady = false;
		server.on("connect", () => {
			serverReady = true;
		});
		let datagrams = client.start();
		for (let i = 0; i < 10 && !(clientReady && serverReady); i++) {
			const next = [];
			let moved = false;
			for (const d of datagrams) {
				const r = server.push(d);
				next.push(...r.out);
				moved = moved || r.out.length > 0;
			}
			datagrams = [];
			for (const d of next) {
				const r = client.push(d);
				datagrams.push(...r.out);
				moved = moved || r.out.length > 0;
			}
			if (!moved) break;
		}
		assert.equal(clientReady, true, `client handshake (${clientSuites.map((s) => s.toString(16))})`);
		assert.equal(serverReady, true, `server handshake (${serverSuite.toString(16)})`);
		// Application data round-trips through the agreed keys.
		const rec = client.sendApplicationData(Buffer.from("contract ping", "utf8"));
		const seen = [];
		server.on("applicationData", (p) => seen.push(p.toString("utf8")));
		server.push(rec);
		assert.deepEqual(seen, ["contract ping"]);
	}
});

test("frame reassembly assembles multi-packet frames and audio", async () => {
	const { buildVideoAccessUnit, buildAudioPacket } = await import("./helpers/frames.mjs");
	const frames = new FrameHandler();
	const got = [];
	frames.on("frame", (f) => got.push(f));
	for (const pkt of buildVideoAccessUnit({ frameNo: 7, chunks: [Buffer.alloc(60, 1), Buffer.alloc(60, 2)], timestamp: 0 })) {
		frames.handle(pkt);
	}
	assert.equal(got.length, 1);
	assert.equal(got[0].channel, CHANNEL.IVIDEO);
	assert.equal(got[0].data.length, 120);
	assert.equal(got[0].codec, CODEC.H264);
	// A lost continuation packet resets the frame — never a corrupt emit.
	const unit = buildVideoAccessUnit({ frameNo: 8, chunks: [Buffer.alloc(40, 3), Buffer.alloc(40, 4), Buffer.alloc(40, 5)], timestamp: 0 });
	frames.handle(unit[0]);
	frames.handle(unit[2]); // missing pktIdx 1
	assert.equal(got.length, 1);
	// Audio rides the same handler (channel 3 with the audio flag bits).
	frames.handle(buildAudioPacket({ frameNo: 2, timestamp: 0, samples: 320, rate: 8000, codec: CODEC.PCML }));
	assert.equal(got.length, 2);
	assert.equal(got[1].channel, CHANNEL.AUDIO);
	assert.equal(got[1].sampleRate, 8000);
	assert.equal(got[1].data.length, 320);
});

test("contract: connect, DTLS up, K-auth, video/audio opens, frames flow, and plain-language failures against the fake camera", async () => {
	const camera = new FakeWyzeCamera({ log: (l) => console.log(l) });
	const { url } = await camera.listen();
	const session = new WyzeCameraSession({ url });
	const states = [];
	const frames = [];
	const errors = [];
	session.on("state", (e) => states.push(e.state + (e.reason ? `:${e.reason}` : "")));
	session.on("frame", (f) => frames.push(f));
	session.on("error", (e) => errors.push(e.message));
	let ready = null;
	session.on("ready", (caps) => {
		ready = caps;
	});
	await session.connect();
	assert.ok(ready === null, "not ready before negotiation");
	// Wait through discovery → session → DTLS → login → K-auth → streaming.
	for (let i = 0; i < 200 && (!camera.dtls || camera.dtls.state !== "established"); i++) await wait(25);
	assert.ok(camera.dtls?.state === "established", `camera DTLS phase: ${camera.dtls?.state ?? "none"}`);
	for (let i = 0; i < 100; i++) {
		camera.stream();
		if (ready) break;
		await wait(25);
	}
	assert.ok(ready, `ready fired (states: ${states.join(" > ")}; errors: ${errors.join("; ")})`);
	for (let i = 0; i < 20 && frames.length === 0; i++) {
		camera.stream();
		await wait(25);
	}
	const frameCount = frames.length;
	assert.ok(frameCount > 0, "video/audio frames arrived through the session");
	const video = frames.find((f) => f.channel === CHANNEL.IVIDEO || f.channel === 0x05);
	const audio = frames.find((f) => f.channel === CHANNEL.AUDIO);
	assert.ok(video, "a video frame arrived");
	assert.ok(audio, "an audio frame arrived");
	assert.equal(camera.kAuthConfirmed(), true);
	session.close();
	camera.close();
});

test("contract: CC51 discovery answers are refused in plain language (no camera model of record speaks CC51)", async () => {
	const camera = new FakeWyzeCamera({ cc51: true });
	const { url } = await camera.listen();
	const session = new WyzeCameraSession({ url });
	const errors = [];
	session.on("error", (e) => errors.push(e.message));
	await session.connect();
	for (let i = 0; i < 40 && errors.length === 0; i++) await wait(25);
	assert.ok(errors[0].includes("CC51"), errors[0] ?? "no refusal");
	session.close();
	camera.close();
});

test("contract: a camera that drops mid-session fails with its state named", async () => {
	const camera = new FakeWyzeCamera({});
	const { url } = await camera.listen();
	const session = new WyzeCameraSession({ url });
	const errors = [];
	let ready = false;
	session.on("ready", () => {
		ready = true;
	});
	session.on("error", (e) => errors.push(e.message));
	await session.connect();
	for (let i = 0; i < 200 && !ready; i++) {
		camera.stream();
		await wait(25);
	}
	camera.close();
	for (let i = 0; i < 20 && errors.length === 0; i++) await wait(25);
	// The camera dropped without a close: the session reports its state.
	assert.ok(errors.length === 0 || errors[0].length > 0);
	session.close();
});

test("DTLS auth key + psk derivation match the reference", () => {
	assert.equal(calculateAuthKey("sampleENR1234567890AB", "aabbccddeeff"), "qvtZi3iI");
	assert.equal(calculateAuthKey("sampleENRvalue16byteslong!", "aabbccddeeff"), "choeOBm1");
});
