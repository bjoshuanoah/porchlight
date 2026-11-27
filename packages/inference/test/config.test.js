// config.test.js — tier config validation (PORCH-133): closed vocabularies,
// tier-0 always-on (no knob), tier-2 off by default, gating never extends.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTierConfig, gatedTransitionsFor, DEFAULT_TIER_CONFIG, GATED_TRANSITIONS } from "../src/index.js";

test("defaults: tier1 enabled, tier2 NOT opted in, tier0 carries no config", () => {
	const config = validateTierConfig({});
	assert.equal(config.tier1.enabled, true);
	assert.equal(config.tier2.optIn, false);
	assert.equal("tier0" in config, false);
	assert.equal(config.tier2.optIn, DEFAULT_TIER_CONFIG.tier2.optIn, "the shipped default is OFF");
});

test("tier0 is always-on law: a tier0 key is rejected outright", () => {
	assert.throws(() => validateTierConfig({ tier0: { enabled: false } }), /tier0 is always-on/);
});

test("unknown tier keys are rejected (closed vocabulary)", () => {
	assert.throws(() => validateTierConfig({ tier3: { optIn: true } }), /not a valid tier/);
});

test("tier2 can never be enabled by an `enabled` knob — only optIn exists", () => {
	assert.throws(() => validateTierConfig({ tier2: { enabled: true } }), /is not a valid field/, "the paid tier has no enabled knob — optIn is the only gate");
	const config = validateTierConfig({ tier2: { optIn: true } });
	assert.equal(config.tier2.optIn, true);
});

test("tier1 transitions may narrow the gated set but never extend it", () => {
	const narrowed = validateTierConfig({ tier1: { transitions: ["arrival"] } });
	assert.deepEqual(gatedTransitionsFor(narrowed, "tier1"), ["arrival"]);
	assert.throws(
		() => validateTierConfig({ tier1: { transitions: ["arrival", "moonrise"] } }),
		/transitions must stay inside the gated set/,
	);
	// The narrowed result is always a subset of the record's closed set.
	for (const t of gatedTransitionsFor(narrowed, "tier1")) assert.ok(GATED_TRANSITIONS.includes(t));
});

test("non-boolean knobs are ValidationErrors; deep-frozen config survives", () => {
	assert.throws(() => validateTierConfig({ tier1: { enabled: "yes" } }), /must be a boolean/);
	const config = validateTierConfig({ tier1: { transitions: ["departure"] } });
	assert.throws(() => Object.assign(config.tier1, { enabled: false }), TypeError);
});

test("gated transitions of record: arrival, departure, loitering (PRD 5)", () => {
	assert.deepEqual([...GATED_TRANSITIONS], ["arrival", "departure", "loitering"]);
});
