// provider.local.test.js — the whisper-class local binary provider of
// record (PORCH-155), driven through the injected spawn seam (arrays are
// the seam's collect() stream shape — no binary, no network, no timing).
// The seam contract is (cmd, args) → { stdin, stdout, stderr, onExit? }.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { WhisperLocalProvider } from "../src/provider.local.js";
import { ValidationError } from "../src/types.js";
import { chunk } from "./helpers.js";

/** An injected spawn seam: records calls and stdin writes, streams plain
 * arrays for stdout/stderr (collect() drains them immediately). */
function spawnFake({ stdout = [], stderr = [] } = {}) {
	const calls = [];
	const writes = [];
	const fake = (cmd, args, opts) => {
		const child = {
			stdin: {
				write(b) {
					writes.push(b);
				},
				end() {},
			},
			stdout,
			stderr,
			onExit: undefined,
		};
		calls.push({ cmd, args, opts });
		return child;
	};
	return { spawn: fake, calls, writes };
}

/** A real file the injected fs.exists check can see: this package's index. */
const realBin = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("WhisperLocalProvider spawns the CLI arg order of record", async () => {
	const seam = spawnFake({ stdout: ["hello"] });
	const provider = new WhisperLocalProvider({
		bin: "/opt/whisper/whisper-cli",
		model: "/opt/whisper/models/ggml-base.en",
		spawn: seam.spawn,
	});
	await provider.transcribe(chunk("cam-1", 0, 1, 16_000, 0.5));

	assert.equal(seam.calls.length, 1);
	assert.equal(seam.calls[0].cmd, "/opt/whisper/whisper-cli");
	assert.deepEqual(seam.calls[0].args.slice(0, 4), ["-m", "/opt/whisper/models/ggml-base.en", "-f", "-"]);
	assert.equal(seam.calls[0].args.length, 4, "-l appended only when opts.language set");
});

test("WhisperLocalProvider appends -l only when language is configured", async () => {
	const seam = spawnFake({ stdout: ["hola"] });
	const provider = new WhisperLocalProvider({
		bin: "/opt/whisper/whisper-cli",
		model: "/opt/whisper/models/ggml-base",
		language: "es",
		spawn: seam.spawn,
	});
	await provider.transcribe(chunk("cam-1", 0, 1, 16_000, 0.5));
	assert.deepEqual(seam.calls[0].args.slice(0, 6), ["-m", "/opt/whisper/models/ggml-base", "-f", "-", "-l", "es"]);
});

/** First stdin write must be a WAV container built from the frame's PCM. */
function assertWav(writeBuf, frame) {
	assert.ok(Buffer.isBuffer(writeBuf), "stdin write receives a Buffer");
	assert.equal(writeBuf.subarray(0, 4).toString("ascii"), "RIFF", "bytes start with a RIFF marker");
	assert.equal(writeBuf.readUInt32LE(24), frame.sampleRate, "WAV header carries the frame sample rate");
	const first = writeBuf.readInt16LE(44);
	assert.ok(Math.abs(first - Math.round(frame.data[0] * 0x7fff)) <= 1, `first Int16 sample encodes ${frame.data[0]} near full scale (got ${first})`);
}

test("WhisperLocalProvider writes the frame's WAV to stdin", async () => {
	const seam = spawnFake({ stdout: [""] });
	const provider = new WhisperLocalProvider({
		bin: "/opt/whisper/whisper-cli",
		model: "/opt/whisper/models/ggml-base.en",
		spawn: seam.spawn,
	});
	const frame = chunk("cam-1", 0, 1, 16_000, 0.5);
	await provider.transcribe(frame);
	assert.equal(seam.writes.length, 1, "exactly one stdin write");
	assertWav(seam.writes[0], frame);
});

test("WhisperLocalProvider joins stdout JSON transcription segments with result language", async () => {
	const doc = JSON.stringify({ transcription: [{ text: "a" }, { text: "b" }], result: { language: "en" } });
	const seam = spawnFake({ stdout: [doc] });
	const provider = new WhisperLocalProvider({
		bin: "/opt/whisper/whisper-cli",
		model: "/opt/whisper/models/ggml-base.en",
		spawn: seam.spawn,
	});
	const out = await provider.transcribe(chunk("cam-1", 0, 1, 16_000, 0.5));
	assert.deepEqual(out, { text: "a b", language: "en" });
});

test("WhisperLocalProvider reads plain-text stdout as the trimmed transcript", async () => {
	const seam = spawnFake({ stdout: ["  hello there\n  "] });
	const provider = new WhisperLocalProvider({
		bin: "/opt/whisper/whisper-cli",
		model: "/opt/whisper/models/ggml-base.en",
		spawn: seam.spawn,
	});
	const out = await provider.transcribe(chunk("cam-1", 0, 1, 16_000, 0.5));
	assert.deepEqual(out, { text: "hello there" });
});

test("WhisperLocalProvider answers empty stdout with the explicit no-speech null", async () => {
	const seam = spawnFake({ stdout: [], stderr: [] });
	const provider = new WhisperLocalProvider({
		bin: "/opt/whisper/whisper-cli",
		model: "/opt/whisper/models/ggml-base.en",
		spawn: seam.spawn,
	});
	const out = await provider.transcribe(chunk("cam-1", 0, 1, 16_000, 0.5));
	assert.deepEqual(out, { text: null });
});

test("WhisperLocalProvider maps ENOENT stderr to the provisioning ValidationError", async () => {
	const seam = spawnFake({ stdout: [], stderr: ["spawning failed: ENOENT no such file"] });
	const provider = new WhisperLocalProvider({
		bin: "/opt/whisper/whisper-cli",
		model: "/opt/whisper/models/ggml-base.en",
		spawn: seam.spawn,
	});
	await assert.rejects(
		() => provider.transcribe(chunk("cam-1", 0, 1, 16_000, 0.5)),
		(err) => {
			assert.ok(err instanceof ValidationError);
			assert.match(err.message, /provision/i);
			return true;
		},
	);
});

test("WhisperLocalProvider status() is configured when the real binary exists", () => {
	// fsDefault sees the real filesystem; this package's index.js is a file
	// that provably exists, standing in for the provisioned binary.
	const provider = new WhisperLocalProvider({
		bin: realBin,
		model: "/opt/whisper/models/ggml-base.en",
	});
	assert.equal(provider.fs.existsSync(realBin), true);
	const st = provider.status();
	assert.equal(st.state, "configured");
	assert.equal(st.model, "/opt/whisper/models/ggml-base.en");
});

test("WhisperLocalProvider status() is degraded with the provisioning reason when the binary is missing", () => {
	const provider = new WhisperLocalProvider({
		bin: "/nonexistent/porchlight/whisper-cli",
		model: "/opt/whisper/models/ggml-base.en",
	});
	assert.equal(provider.fs.existsSync("/nonexistent/porchlight/whisper-cli"), false);
	const st = provider.status();
	assert.equal(st.state, "degraded");
	assert.match(st.reason, /provision/i);
});

test("WhisperLocalProvider constructor law: bin and model required", () => {
	assert.throws(
		() => new WhisperLocalProvider({ model: "/opt/whisper/models/ggml-base.en" }),
		(err) => err instanceof ValidationError && /bin: required/.test(err.message),
	);
	assert.throws(
		() => new WhisperLocalProvider({ bin: "/opt/whisper/whisper-cli" }),
		(err) => err instanceof ValidationError && /model: required/.test(err.message),
	);
});
