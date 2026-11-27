// embedder.test.js — the embedder clients of record (PORCH-155). fetch is
// injected (opts.fetch) and calls are recorded — no network here. Unwired
// posture is asserted against its plain-language refusal.

import test from "node:test";
import assert from "node:assert/strict";
import { OpenAiSpecEmbedder, LocalServerEmbedder, UnwiredEmbedder } from "../src/embedder.js";
import { ValidationError } from "../src/types.js";

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

/** Assert the vector of record: Float32Array, same length, values within 1e-6. */
function assertVector(result, vec) {
	assert.ok(result.data instanceof Float32Array, "result.data is a Float32Array");
	assert.equal(result.data.length, vec.length);
	for (let i = 0; i < vec.length; i++) {
		assert.ok(Math.abs(result.data[i] - vec[i]) <= 1e-6, `component ${i}: ${result.data[i]} ≈ ${vec[i]}`);
	}
}

test("OpenAiSpecEmbedder POSTs the OpenAI-spec embeddings JSON of record", async () => {
	const { calls, impl } = fetchRecorder(() => jsonResponse({ data: [{ embedding: [0.1, -0.2, 0.3, 0.4] }] }));
	const provider = new OpenAiSpecEmbedder({
		model: "qwen3-embedding",
		endpoint: { url: "https://api.example.com/v1", key: "sk-test" },
		fetch: impl,
	});
	const result = await provider.embed("hello world");

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://api.example.com/v1/embeddings");
	assert.equal(calls[0].method, "POST");
	assert.equal(calls[0].headers.authorization, "Bearer sk-test");
	assert.equal(calls[0].headers["content-type"], "application/json");
	assert.deepEqual(JSON.parse(calls[0].body), { model: "qwen3-embedding", input: "hello world" });
	assertVector(result, [0.1, -0.2, 0.3, 0.4]);
});

test("OpenAiSpecEmbedder sends no authorization header without a key", async () => {
	const { calls, impl } = fetchRecorder(() => jsonResponse({ data: [{ embedding: [1, 2] }] }));
	const provider = new OpenAiSpecEmbedder({
		model: "qwen3-embedding",
		endpoint: { url: "https://api.example.com/v1" }, // no key
		fetch: impl,
	});
	await provider.embed("hello world");
	assert.equal(calls[0].headers.authorization, undefined, "authorization header only when opts.endpoint.key is set");
	assert.equal(calls[0].headers["content-type"], "application/json");
});

test("OpenAiSpecEmbedder returns the embedding body as a Float32Array", async () => {
	const { calls, impl } = fetchRecorder(() => jsonResponse({ data: [{ embedding: [1.5, 2.5, 3.5] }] }));
	const provider = new OpenAiSpecEmbedder({
		model: "qwen3-embedding",
		endpoint: { url: "https://api.example.com/v1" },
		fetch: impl,
	});
	const result = await provider.embed("hello world");
	assertVector(result, [1.5, 2.5, 3.5]);
	assert.equal(calls.length, 1);
});

test("OpenAiSpecEmbedder rejects a response lacking the embedding array", async () => {
	const { calls, impl } = fetchRecorder(() => jsonResponse({ data: [] }));
	const provider = new OpenAiSpecEmbedder({
		model: "qwen3-embedding",
		endpoint: { url: "https://api.example.com/v1" },
		fetch: impl,
	});
	await assert.rejects(
		() => provider.embed("hello world"),
		(err) => {
			assert.ok(err instanceof ValidationError);
			assert.match(err.message, /embedding/);
			return true;
		},
	);
	assert.equal(calls.length, 1);
});

test("OpenAiSpecEmbedder refuses empty text without calling fetch", async () => {
	const { calls, impl } = fetchRecorder(() => jsonResponse({ data: [{ embedding: [1] }] }));
	const provider = new OpenAiSpecEmbedder({
		model: "qwen3-embedding",
		endpoint: { url: "https://api.example.com/v1" },
		fetch: impl,
	});
	for (const bad of ["", "   "]) {
		await assert.rejects(() => provider.embed(bad), ValidationError);
	}
	await assert.rejects(() => provider.embed(42), ValidationError);
	await assert.rejects(() => provider.embed(["a"]), ValidationError);
	assert.equal(calls.length, 0, "empty / non-string input never reaches fetch");
});

test("OpenAiSpecEmbedder constructor law: model + resolved endpoint required", () => {
	assert.throws(
		() => new OpenAiSpecEmbedder({ endpoint: { url: "https://api.example.com/v1" } }),
		(err) => err instanceof ValidationError && /model: required/.test(err.message),
	);
	assert.throws(
		() => new OpenAiSpecEmbedder({ model: "qwen3-embedding", endpoint: {} }),
		(err) => err instanceof ValidationError && /endpoint\.url: required/.test(err.message),
	);
});

test("LocalServerEmbedder POSTs {input, model} to /embeddings", async () => {
	const { calls, impl } = fetchRecorder(() => jsonResponse({ embedding: [0.1, 0.2, 0.3, 0.4] }));
	const provider = new LocalServerEmbedder({
		model: "qwen3-embedding",
		endpoint: { url: "https://srv.example.com", key: "local-key" },
		fetch: impl,
	});
	const result = await provider.embed("hello world");

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://srv.example.com/embeddings");
	assert.equal(calls[0].method, "POST");
	assert.equal(calls[0].headers.authorization, "Bearer local-key");
	assert.deepEqual(JSON.parse(calls[0].body), { input: "hello world", model: "qwen3-embedding" });
	assertVector(result, [0.1, 0.2, 0.3, 0.4]);
});

test("LocalServerEmbedder accepts the bare {embedding:[...]} shape", async () => {
	const { calls, impl } = fetchRecorder(() => jsonResponse({ embedding: [1, 2, 3] }));
	const provider = new LocalServerEmbedder({
		model: "qwen3-embedding",
		endpoint: { url: "https://srv.example.com" },
		fetch: impl,
	});
	const result = await provider.embed("hello world");
	assertVector(result, [1, 2, 3]);
	assert.equal(calls.length, 1);
});

test("LocalServerEmbedder accepts the OpenAI-spec {data:[{embedding:[...]}]} shape", async () => {
	const { calls, impl } = fetchRecorder(() => jsonResponse({ data: [{ embedding: [0.25, -0.25, 0.75] }] }));
	const provider = new LocalServerEmbedder({
		model: "qwen3-embedding",
		endpoint: { url: "https://srv.example.com" },
		fetch: impl,
	});
	const result = await provider.embed("hello world");
	assertVector(result, [0.25, -0.25, 0.75]);
	assert.equal(calls.length, 1, "one fetch per embed call");
});

test("LocalServerEmbedder rejects failure shapes with a ValidationError", async () => {
	for (const shape of [{}, { embedding: [] }, { data: [] }, { data: [{}] }]) {
		const { calls, impl } = fetchRecorder(() => jsonResponse(shape));
		const provider = new LocalServerEmbedder({
			model: "qwen3-embedding",
			endpoint: { url: "https://srv.example.com" },
			fetch: impl,
		});
		await assert.rejects(
			() => provider.embed("hello world"),
			(err) => {
				assert.ok(err instanceof ValidationError);
				assert.match(err.message, /embedding/);
				return true;
			},
		);
		assert.equal(calls.length, 1, `shape ${JSON.stringify(shape)} was actually served by the fake`);
	}
});

test("LocalServerEmbedder refuses empty / non-string input without calling fetch", async () => {
	const { calls, impl } = fetchRecorder(() => jsonResponse({ embedding: [1] }));
	const provider = new LocalServerEmbedder({
		model: "qwen3-embedding",
		endpoint: { url: "https://srv.example.com" },
		fetch: impl,
	});
	for (const bad of ["", "   ", 7, null]) {
		await assert.rejects(() => provider.embed(bad), ValidationError);
	}
	assert.equal(calls.length, 0);
});

test("UnwiredEmbedder refuses embed() with its plain-language reason", async () => {
	const unwired = new UnwiredEmbedder();
	const reason = "the embedding stage has no provider yet — re-point it on the Models/Compute surface";
	await assert.rejects(
		() => unwired.embed("anything at all"),
		(err) => {
			assert.ok(err instanceof ValidationError);
			assert.equal(err.message, reason);
			return true;
		},
	);
});

test("UnwiredEmbedder reports the not-provisioned engine-none state", () => {
	const st = new UnwiredEmbedder().status();
	assert.equal(st.engine, "none");
	assert.equal(st.state, "not-provisioned");
});
