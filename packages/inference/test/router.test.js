// router.test.js — the tier routing policy (PORCH-133 ac-1): configured
// tiers invoked IN ORDER on gated FSM transitions; Tier 2 never called
// unless explicitly opted in; failures escalate in order; skips recorded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTierRouter } from "../src/index.js";

/** Spy provider: records each describe() call, returns the given result.
 * @param {string} tier @param {{ text?: string|null, throws?: Error }} behavior @param {{ name?: string }} [meta] */
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
				return { text: behavior.text === undefined ? `described by ${tier}` : behavior.text, model: meta.model ?? `${tier}-model` };
			},
			status() {
				return { model: meta.model ?? null };
			},
		},
	};
}

const EVENT = { camera: "front-door", t: 1764264000, cls: "person", trackId: "7", detections: [{ cls: "person", conf: 0.93 }] };

test("ac-1: tiers are invoked in order on a gated transition", async () => {
	const tier0 = spyProvider("tier0", { text: "Seen: 1 person at front-door (arrival)" }, { providerClass: "native-mlx" });
	const tier1 = spyProvider("tier1", { text: "A person arrives at the front door." });
	const router = createTierRouter({ providers: [tier1.provider, tier0.provider] }); // deliberately out of order
	const outcome = await router.route({ ...EVENT, transition: "arrival" });
	assert.deepEqual(outcome.steps.map((s) => `${s.tier}:${s.kind}`), ["tier0:invoked"], "invocation opens at tier order, not registration order");
	assert.equal(outcome.description, "Seen: 1 person at front-door (arrival)");
	assert.equal(outcome.provider, tier0.provider.name);
	assert.deepEqual(tier1.calls, [], "the first tier that answers wins — the later tier is never charged");
	// Order is observable when tier 0 cannot answer: escalation walks tier1 next.
	const tier0Silent = spyProvider("tier0", { text: null }, { providerClass: "native-mlx", name: "silent-facts" });
	const escalation = await createTierRouter({ providers: [tier1.provider, tier0Silent.provider] })
		.route({ ...EVENT, transition: "arrival" });
	assert.deepEqual(escalation.steps.map((s) => `${s.tier}:${s.kind}`), ["tier0:invoked", "tier1:invoked"], "tiers walk IN ORDER");
	assert.equal(escalation.description, "A person arrives at the front door.");
});

test("ac-1: tier 2 configured is NOT tier 2 opted in — never called", async () => {
	const tier1 = spyProvider("tier1", { throws: new Error("ollama: connection refused") });
	const tier2 = spyProvider("tier2", { text: "paid answer" }, { providerClass: "openai-spec" });
	const router = createTierRouter({ providers: [tier1.provider, tier2.provider] });
	const outcome = await router.route({ ...EVENT, transition: "arrival" });
	assert.equal(tier2.calls.length, 0, "a paid provider listed in the table is never invoked without explicit optIn");
	const step = outcome.steps.find((s) => s.tier === "tier2");
	assert.equal(step.kind, "skipped");
	assert.equal(step.reason, "tier2-not-opted-in");
	assert.deepEqual(outcome.steps.map((s) => `${s.tier}:${s.kind}`), ["tier1:error", "tier2:skipped"]);
});

test("ac-1: explicit tier2 optIn unlocks the paid tier — only after earlier tiers fail", async () => {
	const tier0 = spyProvider("tier0", { throws: new Error("vision helper down") }, { providerClass: "native-mlx" });
	const tier1 = spyProvider("tier1", { throws: new Error("ollama: connection refused") });
	const tier2 = spyProvider("tier2", { text: "Paid, high-value description." }, { providerClass: "openai-spec", model: "gpt-6-vision" });
	const router = createTierRouter({ config: { tier2: { optIn: true } }, providers: [tier0.provider, tier1.provider, tier2.provider] });
	const outcome = await router.route({ ...EVENT, transition: "loitering" });
	assert.deepEqual(outcome.steps.map((s) => `${s.tier}:${s.kind}`), ["tier0:error", "tier1:error", "tier2:invoked"], "failures escalate in tier order");
	assert.equal(outcome.description, "Paid, high-value description.");
	assert.equal(outcome.providerClass, "openai-spec");
	assert.equal(outcome.model, "gpt-6-vision");
});

test("ac-1: ungated transitions never charge LLM/VLM tiers", async () => {
	const tier1 = spyProvider("tier1", { text: "local model answer" });
	const tier2 = spyProvider("tier2", { text: "paid" }, { providerClass: "openai-spec" });
	const router = createTierRouter({ config: { tier2: { optIn: true } }, providers: [tier1.provider, tier2.provider] });
	for (const transition of ["movement", "stationary"]) {
		const outcome = await router.route({ ...EVENT, transition });
		assert.deepEqual(tier1.calls, [], `${transition} never gates tier1`);
		assert.deepEqual(outcome.steps.map((s) => `${s.tier}:${s.kind}`), ["tier1:skipped", "tier2:skipped"]);
		assert.equal(outcome.steps[0].reason, "transition-not-gated");
		assert.equal(outcome.steps[1].reason, "transition-not-gated");
		assert.equal(outcome.description, null);
	}
});

test("ac-1: tier1 disabled by config → skipped with reason even on gated transitions", async () => {
	const tier1 = spyProvider("tier1", { text: "local model answer" });
	const router = createTierRouter({ config: { tier1: { enabled: false } }, providers: [tier1.provider] });
	const outcome = await router.route({ ...EVENT, transition: "departure" });
	assert.deepEqual(tier1.calls, []);
	const step = outcome.steps.find((s) => s.tier === "tier1");
	assert.equal(step.reason, "tier1-disabled");
});

test("ac-1: tier1 gated set narrowed by config honors the narrow", async () => {
	const tier1 = spyProvider("tier1", { text: "local model answer" });
	const router = createTierRouter({ config: { tier1: { transitions: ["arrival", "loitering"] } }, providers: [tier1.provider] });
	const onDeparture = await router.route({ ...EVENT, transition: "departure" });
	assert.deepEqual(tier1.calls, []);
	assert.equal(onDeparture.steps.find((s) => s.tier === "tier1").reason, "transition-not-configured");
	const onArrival = await router.route({ ...EVENT, transition: "arrival" });
	assert.equal(onArrival.description, "local model answer");
});

test("ac-1: a tier returning an explicit null text escalates without storing", async () => {
	const tier1 = spyProvider("tier1", { text: null });
	const tier2 = spyProvider("tier2", { text: "paid answer" }, { providerClass: "openai-spec" });
	const router = createTierRouter({ config: { tier2: { optIn: true } }, providers: [tier1.provider, tier2.provider] });
	const outcome = await router.route({ ...EVENT, transition: "arrival" });
	assert.deepEqual(outcome.steps.map((s) => `${s.tier}:${s.kind}`), ["tier1:invoked", "tier2:invoked"]);
	assert.equal(outcome.description, "paid answer");
});

test("structure: two providers on one tier is a wiring error, empty providers rejected", () => {
	const a = spyProvider("tier1", { text: "a" }, { name: "a" });
	const b = spyProvider("tier1", { text: "b" }, { name: "b" });
	assert.throws(() => createTierRouter({ providers: [a.provider, b.provider] }), /one provider per tier/);
	assert.throws(() => createTierRouter({ providers: [] }), /non-empty array/);
	assert.throws(() => createTierRouter({ providers: [{ tier: "tier9", name: "x", providerClass: "c", describe: async () => ({ text: "" }) }] }), /tiers are/);
});
