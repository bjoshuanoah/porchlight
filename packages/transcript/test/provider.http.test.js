// provider.http.test.js — the HTTP transcription providers of record
// (PORCH-155). fetch is injected (opts.fetch) and every call is recorded —
// no network in this suite. Assertions read the exact URL, method, headers,
// and body each provider builds, and the responses it normalizes.

import test from "node:test";
import assert from "node:assert/strict";
import { OpenAiSpecTranscriptionProvider, LocalServerTranscriptionProvider } from "../src/provider.http.js";
import { ValidationError } from "../src/types.js";
import { chunk } from "./helpers.js";

/** A minimal Response-shaped fake: the surface safeText/json/ok/status read. */
function jsonResponse(doc, { status = 200, statusText = "OK", body } = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText,
		text: async () => body ?? JSON.stringify(doc),
		json: async () => doc,
	};
}

/** An injected fetch seam that records {url, method, headers, body} calls. */
function fetchRecorder(responder) {
	const calls = [];
	const impl = async (url, init) => {
		const record = { url, method: init?.method, headers: { ...(init?.headers ?? {}) }, body: init?.body };
		calls.push(record);
		return responder(record);
	};
	return { calls, impl };
}

/** Multipart form fields of record as {name → string | File}. */
function formEntries(formData) {
	const entries = {};
	for (const [name, value] of formData.entries()) entries[name] = value;
	return entries;
}

test("OpenAiSpecTranscriptionProvider POSTs the multipart transcription form of record", async () => {
	let audio;
	const { calls, impl } = fetchRecorder(() => jsonResponse({ text: "hello world" }));
	const provider = new OpenAiSpecTranscriptionProvider({
		model: "whisper-large",
		endpoint: { url: "https://api.example.com/v1/", key: "sk-test" },
		fetch: impl,
	});
	const frame = chunk("cam-1", 60_000, 1, 16_000, 0.5);
	const out = await provider.transcribe(frame);

	// Exactly ${url without trailing slash}/audio/transcriptions — the slash
	// strip on the resolved endpoint is part of the contract.
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://api.example.com/v1/audio/transcriptions");
	assert.equal(calls[0].method, "POST");
	assert.equal(calls[0].headers.authorization, "Bearer sk-test");
	assert.equal(calls[0].headers["content-type"], undefined, "Content-Type must be left to fetch's FormData boundary");

	// Multipart fields: model + response_format=json + file named audio.wav
	// with audio/wav type; language only when configured.
	const entries = formEntries(calls[0].body);
	assert.equal(entries.model, "whisper-large");
	assert.equal(entries.response_format, "json");
	assert.equal(entries.language, undefined, "no language field unless configured");
	const file = entries.file;
	assert.ok(file, "file field present");
	assert.equal(file.name, "audio.wav");
	assert.equal(file.type, "audio/wav");
	audio = Buffer.from(await file.arrayBuffer());
	assert.equal(audio.subarray(0, 4).toString("ascii"), "RIFF", "file bytes are a WAV container");
	assert.equal(audio.readUInt32LE(24), 16_000, "WAV header carries the frame sample rate");
	assert.equal(audio.readUInt16LE(34), 16, "16-bit samples");
	assert.equal(audio.byteLength, 44 + 2 * frame.data.length);

	assert.deepEqual(out, { text: "hello world", language: undefined });
});

test("OpenAiSpecTranscriptionProvider appends language only when configured", async () => {
	const { calls, impl } = fetchRecorder(() => jsonResponse({ text: "Hola." }));
	const provider = new OpenAiSpecTranscriptionProvider({
		model: "whisper-large",
		endpoint: { url: "https://api.example.com/v1" },
		language: "es",
		fetch: impl,
	});
	await provider.transcribe(chunk("cam-1", 0, 1, 16_000, 0.5));

	assert.equal(calls[0].headers.authorization, undefined, "Bearer header only when opts.endpoint.key set");
	assert.deepEqual(Object.keys(calls[0].headers), [], "no headers at all without a key");
	const entries = formEntries(calls[0].body);
	assert.equal(entries.language, "es");
});

test("OpenAiSpecTranscriptionProvider maps blank text to the explicit no-speech null", async () => {
	const { calls, impl } = fetchRecorder(() => jsonResponse({ text: "   " }));
	const provider = new OpenAiSpecTranscriptionProvider({
		model: "whisper-large",
		endpoint: { url: "https://api.example.com/v1" },
		fetch: impl,
	});
	const out = await provider.transcribe(chunk("cam-1", 0, 1, 16_000, 0.5));
	assert.deepEqual(out, { text: null, language: undefined });
	assert.equal(calls.length, 1);
});

test("OpenAiSpecTranscriptionProvider joins a results segment array", async () => {
	const { calls, impl } = fetchRecorder(() => jsonResponse({ results: [{ text: "a" }, { text: "b" }] }));
	const provider = new OpenAiSpecTranscriptionProvider({
		model: "whisper-large",
		endpoint: { url: "https://api.example.com/v1" },
		fetch: impl,
	});
	const out = await provider.transcribe(chunk("cam-1", 0, 1, 16_000, 0.5));
	assert.deepEqual(out, { text: "a b", language: undefined });
	assert.equal(calls.length, 1);
});

test("OpenAiSpecTranscriptionProvider surfaces non-2xx status + body excerpt as ValidationError", async () => {
	const { calls, impl } = fetchRecorder(() =>
		jsonResponse({}, { status: 503, statusText: "Service Unavailable", body: "upstream exploded" }));
	const provider = new OpenAiSpecTranscriptionProvider({
		model: "whisper-large",
		endpoint: { url: "https://api.example.com/v1" },
		fetch: impl,
	});
	await assert.rejects(
		() => provider.transcribe(chunk("cam-1", 0, 1, 16_000, 0.5)),
		(err) => {
			assert.ok(err instanceof ValidationError);
			assert.match(err.message, /503/);
			assert.match(err.message, /upstream exploded/);
			return true;
		},
	);
	assert.equal(calls.length, 1);
});

test("OpenAiSpecTranscriptionProvider reports a thrown fetch as unreachable", async () => {
	const provider = new OpenAiSpecTranscriptionProvider({
		model: "whisper-large",
		endpoint: { url: "https://api.example.com/v1" },
		fetch: async () => {
			throw new Error("ECONNREFUSED");
		},
	});
	await assert.rejects(
		() => provider.transcribe(chunk("cam-1", 0, 1, 16_000, 0.5)),
		(err) => {
			assert.ok(err instanceof ValidationError);
			assert.match(err.message, /unreachable/);
			assert.match(err.message, /ECONNREFUSED/);
			return true;
		},
	);
});

test("OpenAiSpecTranscriptionProvider constructor law: model + resolved endpoint required", () => {
	assert.throws(
		() => new OpenAiSpecTranscriptionProvider({ endpoint: { url: "https://api.example.com/v1" } }),
		(err) => err instanceof ValidationError && /model: required/.test(err.message),
	);
	assert.throws(
		() => new OpenAiSpecTranscriptionProvider({ model: "whisper-large", endpoint: {} }),
		(err) => err instanceof ValidationError && /endpoint\.url: required/.test(err.message),
	);
	assert.throws(() => new OpenAiSpecTranscriptionProvider({ model: "whisper-large" }), ValidationError);
});

test("LocalServerTranscriptionProvider POSTs the JSON transcribe shape of record", async () => {
	const { calls, impl } = fetchRecorder(() => jsonResponse({ text: "hello world" }));
	const provider = new LocalServerTranscriptionProvider({
		model: "lfm3-1b",
		endpoint: { url: "https://srv.example.com" },
		fetch: impl,
	});
	const frame = chunk("cam-1", 60_000, 1, 16_000, 0.5);
	const out = await provider.transcribe(frame);

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://srv.example.com/transcribe");
	assert.equal(calls[0].method, "POST");
	assert.equal(calls[0].headers["content-type"], "application/json");
	assert.equal(calls[0].headers.authorization, undefined);

	const body = JSON.parse(calls[0].body);
	assert.equal(body.model, "lfm3-1b");
	assert.equal(body.format, "f32le");
	assert.equal(body.sampleRate, 16_000);
	assert.equal("language" in body, false, "language only when configured");

	// Round-trip: the base64 audio decodes to the exact f32le input samples.
	const audio = Buffer.from(body.audio, "base64");
	assert.equal(audio.byteLength, frame.data.byteLength);
	for (let i = 0; i < frame.data.length; i++) {
		assert.equal(audio.readFloatLE(i * 4), frame.data[i], `sample ${i} round-trips exactly`);
	}
	assert.equal(audio.readFloatLE(0), 0.5);

	assert.deepEqual(out, { text: "hello world", language: undefined });
});

test("LocalServerTranscriptionProvider includes language only when configured", async () => {
	const { calls, impl } = fetchRecorder(() => jsonResponse({ text: "Hola." }));
	const provider = new LocalServerTranscriptionProvider({
		model: "lfm3-1b",
		endpoint: { url: "https://srv.example.com" },
		language: "es",
		fetch: impl,
	});
	await provider.transcribe(chunk("cam-1", 0, 1, 16_000, 0.5));
	const body = JSON.parse(calls[0].body);
	assert.equal(body.language, "es");
});

test("LocalServerTranscriptionProvider strips the endpoint trailing slash", async () => {
	const { calls, impl } = fetchRecorder(() => jsonResponse({ text: "hi" }));
	const provider = new LocalServerTranscriptionProvider({
		model: "lfm3-1b",
		endpoint: { url: "https://srv.example.com/" },
		fetch: impl,
	});
	await provider.transcribe(chunk("cam-1", 0, 1, 16_000, 0.5));
	assert.equal(calls[0].url, "https://srv.example.com/transcribe");
});

test("LocalServerTranscriptionProvider maps {text:null} to the explicit no-speech null", async () => {
	const { calls, impl } = fetchRecorder(() => jsonResponse({ text: null }));
	const provider = new LocalServerTranscriptionProvider({
		model: "lfm3-1b",
		endpoint: { url: "https://srv.example.com" },
		fetch: impl,
	});
	const out = await provider.transcribe(chunk("cam-1", 0, 1, 16_000, 0.5));
	assert.deepEqual(out, { text: null, language: undefined });
	assert.equal(calls.length, 1);
});

test("LocalServerTranscriptionProvider joins a results segment array", async () => {
	const { calls, impl } = fetchRecorder(() => jsonResponse({ results: [{ text: "a" }, { text: "b" }] }));
	const provider = new LocalServerTranscriptionProvider({
		model: "lfm3-1b",
		endpoint: { url: "https://srv.example.com" },
		fetch: impl,
	});
	const out = await provider.transcribe(chunk("cam-1", 0, 1, 16_000, 0.5));
	assert.deepEqual(out, { text: "a b", language: undefined });
	assert.equal(calls.length, 1);
});

test("LocalServerTranscriptionProvider surfaces non-2xx as ValidationError", async () => {
	const { calls, impl } = fetchRecorder(() =>
		jsonResponse({}, { status: 500, statusText: "Internal Server Error", body: "boom" }));
	const provider = new LocalServerTranscriptionProvider({
		model: "lfm3-1b",
		endpoint: { url: "https://srv.example.com" },
		fetch: impl,
	});
	await assert.rejects(
		() => provider.transcribe(chunk("cam-1", 0, 1, 16_000, 0.5)),
		(err) => {
			assert.ok(err instanceof ValidationError);
			assert.match(err.message, /500/);
			assert.match(err.message, /boom/);
			return true;
		},
	);
	assert.equal(calls.length, 1);
});

test("LocalServerTranscriptionProvider reports a thrown fetch as unreachable", async () => {
	const provider = new LocalServerTranscriptionProvider({
		model: "lfm3-1b",
		endpoint: { url: "https://srv.example.com" },
		fetch: async () => {
			throw new Error("socket hang up");
		},
	});
	await assert.rejects(
		() => provider.transcribe(chunk("cam-1", 0, 1, 16_000, 0.5)),
		(err) => {
			assert.ok(err instanceof ValidationError);
			assert.match(err.message, /unreachable/);
			return true;
		},
	);
});
