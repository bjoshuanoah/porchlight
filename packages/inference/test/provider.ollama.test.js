// provider.ollama.test.js — the tier-1 local Ollama integration (PORCH-133
// ac-2): gated event → local description, fetch-injected, endpoint resolved.

import { test } from "node:test";
import assert from "node:assert/strict";
import { OllamaProvider, promptOf, factsLineOf } from "../src/index.js";

const ENDPOINT = { url: "http://127.0.0.1:11434/" };

/** Minimal fetch double. @param {(body: Record<string, unknown>, init: RequestInit) => unknown} implement */
function fetchDouble(implement) {
	/** @type {Record<string, unknown>[]} */
	const bodies = [];
	/** @type {unknown} */
	const impl = async (url, init) => {
		bodies.push(JSON.parse(String(init?.body)));
		return implement(bodies.at(-1), init);
	};
	return { bodies, fetch: impl };
}

test("ac-2: describe posts an Ollama /api/chat call carrying the gated event's facts", async () => {
	const { bodies, fetch } = fetchDouble(() => new Response(JSON.stringify({ message: { content: "One person is walking up to the door." } }), { status: 200 }));
	const provider = new OllamaProvider({ model: "ornith-1.5:9b", endpoint: ENDPOINT, fetch });
	const result = await provider.describe({
		camera: "front-door",
		t: 1764264000,
		cls: "person",
		trackId: "7",
		transition: "arrival",
		detections: [{ cls: "person", conf: 0.93 }],
	});
	assert.equal(result.text, "One person is walking up to the door.");
	assert.equal(result.model, "ornith-1.5:9b");
	const body = bodies[0];
	assert.equal(body.model, "ornith-1.5:9b");
	assert.equal(body.stream, false);
	assert.match(String(body.messages[0].content), /Camera: front-door/);
	assert.match(String(body.messages[0].content), /changed to "arrival"/);
	assert.match(String(body.messages[0].content), /person 0\.93/);
	assert.equal(body.images, undefined, "no still attached → no images field");
});

test("ac-2: a vision-capable call carries the snapshot still in images[]", async () => {
	const { bodies, fetch } = fetchDouble(() => new Response(JSON.stringify({ message: { content: "A person stands at the door." } }), { status: 200 }));
	const provider = new OllamaProvider({ model: "gemma4:e2b-mlx", endpoint: ENDPOINT, fetch });
	await provider.describe({ camera: "driveway", t: 1764264000, transition: "loitering", image: "aGVsbG8=" });
	assert.deepEqual(bodies[0].messages[0].images, ["aGVsbG8="], "vision-capable tier-1 rides the still, never video");
});

test("posture: an unreachable or failing endpoint throws plain-language errors (never silent)", async () => {
	const { fetch } = fetchDouble(() => new Response("model not found", { status: 404, statusText: "Not Found" }));
	const provider = new OllamaProvider({ model: "ornith-1.5:9b", endpoint: ENDPOINT, fetch });
	await assert.rejects(() => provider.describe({ camera: "c", t: 1764264000, transition: "arrival" }), /ollama: description failed \(404 Not Found\): model not found/);
	const offline = new OllamaProvider({ model: "m", endpoint: ENDPOINT, fetch: async () => { throw new TypeError("fetch failed"); } });
	await assert.rejects(() => offline.describe({ camera: "c", t: 1764264000, transition: "arrival" }), /fetch failed|ECONNREFUSED|fetch/);
});

test("ac-2: an empty local answer is an explicit no-answer (null escalates)", async () => {
	const { fetch } = fetchDouble(() => new Response(JSON.stringify({ message: { content: "   " } }), { status: 200 }));
	const provider = new OllamaProvider({ model: "m", endpoint: ENDPOINT, fetch });
	const result = await provider.describe({ camera: "c", t: 1764264000, transition: "arrival" });
	assert.equal(result.text, null);
});

test("status: the never-silent compute posture reports the local-server class and model", () => {
	const provider = new OllamaProvider({ model: "ornith-1.5:9b", endpoint: ENDPOINT, fetch: async () => new Response("{}", { status: 200 }) });
	assert.deepEqual(provider.status(), { engine: "ollama-chat", providerClass: "local-server", model: "ornith-1.5:9b", state: "configured", endpointResolved: true });
	assert.equal(provider.tier, "tier1");
	assert.equal(provider.name, "ollama");
});

test("construction requires the setup-provisioned model and a resolved endpoint", () => {
	assert.throws(() => new OllamaProvider({ endpoint: ENDPOINT }), TypeError);
	assert.throws(() => new OllamaProvider({ model: "m" }), TypeError);
});

test("prompt/facts contract: facts first, interpretation never asserted as fact", () => {
	const prompt = promptOf({ camera: "front-door", t: 1764264000, transition: "arrival", detections: [{ cls: "person", conf: 0.93 }] });
	assert.match(prompt, /say\s+so plainly instead of guessing/);
	assert.equal(factsLineOf({ camera: "front-door", t: 1764264000, transition: "arrival", detections: [{ cls: "person", conf: 0.93 }, { cls: "person", conf: 0.88 }, { cls: "dog", conf: 0.7 }] }), "Seen: 2 person, 1 dog at front-door (arrival)");
	assert.equal(factsLineOf({ camera: "front-door", t: 1764264000, transition: "arrival" }), "No detections carried at front-door (arrival)");
});
