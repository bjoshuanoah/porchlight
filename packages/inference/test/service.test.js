// service.test.js — the tiering service composition (PORCH-133): router +
// store wired, descriptions STORED WITH THE EVENT (ac-2), status posture,
// and the never-silent degradation when no tier answers.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createTieringService,
	createDescriptionStore,
	createTierRouter,
	OllamaProvider,
	OpenAiSpecProvider,
	createFactsProvider,
} from "../src/index.js";

/** @param {{ text?: string|null, throws?: Error }} behavior @param {string} tier @param {{ name?: string, providerClass?: string, model?: string }} [meta] */
function spyProvider(tier, behavior, meta = {}) {
	/** @type {unknown[]} */
	const calls = [];
	return {
		calls,
		provider: {
			tier,
			name: meta.name ?? `${tier}-spy`,
			providerClass: meta.providerClass ?? "local-server",
			async describe(request) {
				calls.push(request);
				if (behavior.throws) throw behavior.throws;
				return { text: behavior.text === undefined ? `${tier} answer` : behavior.text, model: meta.model ?? null };
			},
		},
	};
}

/** @param {(t: number) => void} [seed] */
function tmpRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "porch-inference-"));
}

const EVENT = { t: 1764264000, camera: "front-door", cls: "person", trackId: "7", detections: [{ cls: "person", conf: 0.93 }] };

test("ac-2: a gated event's locally generated description is stored WITH the event", async () => {
	const dir = tmpRoot();
	const ollama = new OllamaProvider({ model: "ornith-1.5:9b", endpoint: { url: "http://127.0.0.1:11434" }, fetch: async () => new Response(JSON.stringify({ message: { content: "One person arrived at the front door." } }), { status: 200 }) });
	const service = createTieringService({ providers: [createFactsProvider(), ollama], store: createDescriptionStore({ dir }) });
	const { outcome, stored } = await service.onEvent({ event: EVENT, transition: "arrival" });
	assert.equal(outcome.provider, "vision-facts", "tier 0 answers first — free/local wins the description");
	assert.equal(outcome.description, "Seen: 1 person at front-door (arrival)");
	assert.equal(stored.provider, "vision-facts");
	// Stored with the event: addressable by the event's own identity.
	const rows = service.forEvent({ t: EVENT.t, camera: EVENT.camera, trackId: EVENT.trackId });
	assert.equal(rows.length, 1);
	assert.equal(rows[0].text, "Seen: 1 person at front-door (arrival)");
	assert.equal(rows[0].provider, "vision-facts");
	assert.equal(rows[0].providerClass, "native-mlx"); // full provenance rides the record
	assert.equal(rows[0].transition, "arrival");
	assert.equal(typeof rows[0].at, "string");
});

test("ac-2: when tier 0 cannot describe, tier 1's LOCAL Ollama answer is stored", async () => {
	const dir = tmpRoot();
	const tier1 = spyProvider("tier1", { text: "A person is walking to the door." }, { name: "ollama" });
	const service = createTieringService({ providers: [tier1.provider], store: createDescriptionStore({ dir }) });
	const { outcome, stored } = await service.onEvent({ event: EVENT, transition: "arrival" });
	assert.equal(outcome.provider, "ollama");
	assert.equal(stored.model, null);
	const rows = service.forEvent({ t: EVENT.t, camera: "front-door" });
	assert.equal(rows[0].text, "A person is walking to the door.");
	assert.equal(rows[0].tier, "tier1");
	assert.equal(rows[0].provider, "ollama");
});

test("ac-2: no tier answers → nothing stored, the absence is explicit in the outcome", async () => {
	const dir = tmpRoot();
	const failing = spyProvider("tier1", { throws: new Error("ollama: connection refused") }, { name: "ollama" });
	const service = createTieringService({ providers: [failing.provider], store: createDescriptionStore({ dir }) });
	const { outcome, stored } = await service.onEvent({ event: EVENT, transition: "arrival" });
	assert.equal(outcome.description, null);
	assert.equal(stored, null);
	assert.equal(service.forEvent({ t: EVENT.t, camera: "front-door" }).length, 0, "no invented record, ever");
	assert.equal(outcome.steps[0].kind, "error");
	assert.match(outcome.steps[0].reason, /connection refused/);
});

test("tier 2 stays a router-gated promise: opted in after failures, recorded with provenance", async () => {
	const dir = tmpRoot();
	const failing = spyProvider("tier1", { throws: new Error("ollama down") }, { name: "ollama" });
	const tier2 = new OpenAiSpecProvider({
		model: "gpt-6-vision",
		endpoint: { url: "https://api.example.com/v1", key: "k" },
		fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "A person waits at the porch." } }] }), { status: 200 }),
	});
	const service = createTieringService({ config: { tier2: { optIn: true } }, providers: [failing.provider, tier2], store: createDescriptionStore({ dir }) });
	const { outcome, stored } = await service.onEvent({ event: { t: EVENT.t, camera: "porch" }, transition: "loitering" });
	assert.equal(outcome.provider, "openai");
	assert.equal(outcome.providerClass, "openai-spec");
	assert.equal(stored.tier, "tier2");
	assert.equal(service.forEvent({ t: EVENT.t, camera: "porch" })[0].providerClass, "openai-spec");
});

test("status renders the never-silent posture per tier", () => {
	const dir = tmpRoot();
	const service = createTieringService({ config: { tier2: { optIn: false } }, providers: [createFactsProvider()], store: createDescriptionStore({ dir }) });
	const status = service.status();
	assert.equal(status.stage, "event-description");
	const byTier = Object.fromEntries(status.tiers.map((t) => [t.tier, t]));
	assert.equal(byTier.tier0.alwaysOn, true);
	assert.equal(byTier.tier0.enabled, true);
	assert.equal(byTier.tier1.enabled, true);
	assert.deepEqual(byTier.tier1.gatedTransitions, ["arrival", "departure", "loitering"]);
	assert.equal(byTier.tier2.enabled, false, "tier 2 configured-but-not-opted-in renders disabled");
	assert.equal(byTier.tier2.optIn, false);
});

test("wiring: the router is reachable through the service contract (route via onEvent only)", () => {
	const dir = tmpRoot();
	const service = createTieringService({ providers: [createFactsProvider()], store: createDescriptionStore({ dir }) });
	assert.ok(createTierRouter); // the exported seam used by the service and tests
	assert.equal(service.tierConfig.tier2.optIn, false);
});

test("malformed inputs are plain-language ValidationErrors", async () => {
	const dir = tmpRoot();
	const service = createTieringService({ providers: [createFactsProvider()], store: createDescriptionStore({ dir }) });
	await assert.rejects(() => service.onEvent({ event: { t: -1, camera: "c" }, transition: "arrival" }), /event\.t must be a positive epoch time/);
	await assert.rejects(() => service.onEvent({ event: { t: 5 }, transition: "arrival" }), /event\.camera must be a non-empty string/);
	assert.throws(() => createTieringService({ providers: [createFactsProvider()] }), /store must implement/);
});
