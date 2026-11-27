// provider.openai.test.js — the tier-2 paid provider (PORCH-133): the
// OpenAI-compatible chat-completions contract, the only tier whose requests
// may leave the hub — and only under the router's explicit opt-in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAiSpecProvider } from "../src/index.js";

const ENDPOINT = { url: "https://api.example.com/v1", key: "user-supplied" };
const IMAGE = "aGVsbG8=";

/** @param {(url: URL|string, init?: RequestInit) => unknown} responder */
function responderOf(responder) {
	/** @type {Array<{ url: string, init?: RequestInit, body: Record<string, unknown> }>} */
	const calls = [];
	const fetch = /** @type {unknown} */ (async (url, init) => {
		calls.push({ url: String(url), init, body: JSON.parse(String(init?.body)) });
		return responder(String(url), init);
	});
	return { calls, fetch };
}

test("talks the chat-completions contract with the user's key and model", async () => {
	const { calls, fetch } = responderOf(() => new Response(JSON.stringify({ choices: [{ message: { content: "A person is at the porch." } }] }), { status: 200 }));
	const provider = new OpenAiSpecProvider({ model: "gpt-6-vision", endpoint: ENDPOINT, fetch });
	const result = await provider.describe({ camera: "porch", t: 1764264000, cls: "person", transition: "arrival", detections: [{ cls: "person", conf: 0.93 }] });
	assert.equal(result.text, "A person is at the porch.");
	assert.equal(result.model, "gpt-6-vision");
	const call = calls[0];
	assert.equal(String(call.url), "https://api.example.com/v1/chat/completions");
	assert.equal(call.init.headers.authorization, "Bearer user-supplied");
	assert.equal(call.body.model, "gpt-6-vision");
	assert.equal(call.body.messages[0].role, "user");
	const text = call.body.messages[0].content.find((p) => p.type === "text");
	assert.match(text.text, /changed to "arrival"/);
	assert.equal(call.body.messages[0].content.length, 1, "no still → no image part");
});

test("vision contract: the still rides as a data-URL image part", async () => {
	const { calls, fetch } = responderOf(() => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));
	const provider = new OpenAiSpecProvider({ model: "gpt-6-vision", endpoint: ENDPOINT, fetch });
	await provider.describe({ camera: "porch", t: 1764264000, transition: "loitering", image: IMAGE });
	const parts = calls[0].body.messages[0].content;
	assert.deepEqual(parts[1], { type: "image_url", image_url: { url: `data:image/jpeg;base64,${IMAGE}` } });
});

test("failures are plain-language and never silent", async () => {
	const { fetch } = responderOf(() => new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429, statusText: "Too Many Requests" }));
	const provider = new OpenAiSpecProvider({ model: "m", endpoint: ENDPOINT, fetch });
	await assert.rejects(() => provider.describe({ camera: "c", t: 1764264000, transition: "arrival" }), /openai: description failed \(429 Too Many Requests\)/);
});

test("posture + construction: providerClass openai-spec, tier2, required model/endpoint", () => {
	const provider = new OpenAiSpecProvider({ model: "gpt-6-vision", endpoint: ENDPOINT, fetch: async () => new Response("{}", { status: 200 }) });
	assert.equal(provider.providerClass, "openai-spec");
	assert.equal(provider.tier, "tier2");
	assert.equal(provider.status().state, "configured");
	assert.throws(() => new OpenAiSpecProvider({ endpoint: ENDPOINT }), TypeError);
});

test("privacy: nothing but the request's facts and one still ever leave the hub", async () => {
	const { calls, fetch } = responderOf(() => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));
	const provider = new OpenAiSpecProvider({ model: "m", endpoint: ENDPOINT, fetch });
	await provider.describe({ camera: "porch", t: 1764264000, transition: "arrival" });
	const serialized = JSON.stringify(calls[0].body);
	assert.doesNotMatch(serialized, /video|segment|\.mp4|rtsp/i, "video never rides any provider");
});
