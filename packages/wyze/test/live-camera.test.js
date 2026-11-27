// test/live-camera.test.js — the AC-2 live contract suite (PORCH-131),
// env-gated: runs against the deployment's Wyze cameras only when the
// operator sets PORCHLIGHT_WYZE_LIVE=1 and PORCHLIGHT_WYZE_URL to a real
// wyze:// source. Skipped silently otherwise (the default matrix stays
// deterministic without network, per the repo testing contract).

import test from "node:test";
import assert from "node:assert/strict";
import { WyzeCameraSession } from "../src/index.js";

const LIVE = process.env.PORCHLIGHT_WYZE_LIVE === "1";
const URL = process.env.PORCHLIGHT_WYZE_URL;
const STREAM_SECONDS = Number(process.env.PORCHLIGHT_WYZE_STREAM_SECONDS ?? 30);

test("live camera: connect, DTLS up, K-auth, video/audio opens, frames flow", { skip: !LIVE || !URL }, async (t) => {
	t.timeout((STREAM_SECONDS + 30) * 1000);
	const session = new WyzeCameraSession({ url: URL });
	const events = { states: [], frames: { video: 0, audio: 0 }, keyframes: 0, errors: [] };
	session.on("state", (e) => events.states.push(e.state + (e.reason ? `:${e.reason}` : "")));
	session.on("frame", (f) => {
		if (f.channel === 0x05) {
			events.frames.video += 1;
			events.keyframes += f.isKeyframe ? 1 : 0;
		} else if (f.channel === 0x03) events.frames.audio += 1;
	});
	session.on("error", (e) => events.errors.push(e.message));
	let ready = null;
	session.on("ready", (caps) => {
		ready = caps;
	});
	await session.connect();
	await new Promise((resolve) => {
		const probe = setInterval(() => {
			if (session.state === "streaming") {
				clearInterval(probe);
				resolve();
			}
		}, 50);
		setTimeout(() => {
			clearInterval(probe);
			resolve();
		}, 20_000);
	});
	assert.ok(ready, `the stream contract was negotiated (states: ${events.states.join(" > ")})`);
	// Stream for the soak window; the frames must keep flowing.
	const videoAt = [events.frames.video, events.frames.audio];
	await new Promise((r) => setTimeout(r, STREAM_SECONDS * 1000));
	assert.ok(events.frames.video > videoAt[0] + 100, `video kept flowing (${events.frames.video} frames over ${STREAM_SECONDS}s)`);
	if (ready.hasAudio) {
		assert.ok(events.frames.audio > videoAt[1] + 1, "audio kept flowing on an audio-capable camera");
	}
	assert.ok(events.keyframes > 0, "keyframes arrive in-band (SPS/PPS + IDR for a mid-stream recorder join)");
	assert.deepEqual(events.errors, [], `no failures during the soak (${events.errors.join("; ")})`);
	const dropped = events.states.filter((s) => s.startsWith("down")).length;
	session.close();
	console.log(`\n[wyze live] states: ${events.states.join(" > ")}; video: ${events.frames.video}, audio: ${events.frames.audio}, keyframes: ${events.keyframes}; drops: ${dropped}`);
});
