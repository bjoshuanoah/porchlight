// config.js — the tier routing config of record (PORCH-133; PRD 5 / TS 5).
//
// The routing table's knobs, validated against the closed vocabularies:
//   - tier 0 is ALWAYS-ON by law (free, per-frame detection feeding local
//     facts) — it carries no config knob and cannot appear in the config.
//   - tier 1 (local Ollama): `enabled` (default true). A narrowed
//     `transitions` list may cut the gated set down; it can never extend
//     beyond GATED_TRANSITIONS.
//   - tier 2 (paid OpenAI-compatible): `optIn` (default FALSE — the
//     privacy/cost law: the paid tier is OFF until the user explicitly
//     opts in; presence in config or a provider registration must never
//     silently enable it).

import { ValidationError, assertObject, TIERS, GATED_TRANSITIONS } from "./types.js";

/** Copy-on-write freeze for nested config docs. @param {unknown} value */
function deepFreeze(value) {
	if (value !== null && typeof value === "object") {
		for (const entry of Object.values(value)) deepFreeze(entry);
		Object.freeze(value);
	}
	return value;
}

/**
 * A tier slice is a CLOSED envelope: only its declared fields exist (the
 * config-compose law's "no hidden overrides" cuts both ways — an unknown
 * knob is a broken config, never a silently-ignored one).
 * @param {Record<string, unknown>} value
 * @param {string[]} allowed
 * @param {string} label
 */
function rejectUnknown(value, allowed, label) {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) {
		throw new ValidationError(`${label}: "${unknown.join('", "')}" is not a valid field — fields of record: ${allowed.map((f) => `"${f}"`).join(" | ")}`);
	}
}

/**
 * Boolean with a default. `undefined` → default; anything non-boolean →
 * Validation error ("must be a boolean").
 * @param {unknown} value
 * @param {boolean} fallback
 * @param {string} label
 */
function boolOf(value, fallback, label) {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new ValidationError(`${label}: must be a boolean`);
	return value;
}

/**
 * Validate one tier's slice.
 * @param {unknown} value
 * @param {string} label
 */
function validateTier1(value, label) {
	assertObject(value, label);
	rejectUnknown(value, ["enabled", "transitions"], label);
	const out = { enabled: boolOf(value.enabled, true, `${label}.enabled`) };
	if (value.transitions !== undefined) {
		if (!Array.isArray(value.transitions)) {
			throw new ValidationError(`${label}.transitions: must be an array of gated FSM transitions`);
		}
		const unknown = value.transitions.filter((t) => !GATED_TRANSITIONS.includes(t));
		if (unknown.length > 0) {
			throw new ValidationError(
				`${label}.transitions: transitions must stay inside the gated set — unknown: ${unknown.map((t) => `"${t}"`).join(", ")} (gated: ${GATED_TRANSITIONS.map((t) => `"${t}"`).join(" | ")})`,
			);
		}
		if (value.transitions.length > 0) {
			// Dedupe while preserving the user's order — a repeated transition is
			// harmless but the config of record renders one entry each.
			out.transitions = [...new Set(value.transitions)];
		}
	}
	return out;
}

/**
 * Validate one tier-2 slice. `optIn` defaults to false; the paid tier is
 * never on by implication.
 * @param {unknown} value
 * @param {string} label
 */
function validateTier2(value, label) {
	assertObject(value, label);
	rejectUnknown(value, ["optIn"], label);
	return { optIn: boolOf(value.optIn, false, `${label}.optIn`) };
}

/**
 * Validate a tier routing config. Unknown tier keys are rejected (tier0 is
 * always-on law, not a knob; the closed tier vocabulary is tier1/tier2).
 * Returns a NORMALIZED, deep-frozen config.
 * @param {unknown} value
 * @param {string} [label]
 */
export function validateTierConfig(value, label = "tierConfig") {
	assertObject(value, label);
	for (const key of Object.keys(value)) {
		if (!TIERS.includes(key)) {
			throw new ValidationError(`${label}: "${key}" is not a valid tier — tiers are "${TIERS.join('", "')}" (tier0 is always-on and carries no config)`);
		}
		if (key === "tier0") {
			throw new ValidationError(`${label}: tier0 is always-on (free, local, per-frame detection) — it has no config`);
		}
	}
	const out = {
		tier1: value.tier1 !== undefined
			? validateTier1(value.tier1, `${label}.tier1`)
			: { enabled: true },
		tier2: value.tier2 !== undefined
			? validateTier2(value.tier2, `${label}.tier2`)
			: { optIn: false },
	};
	return deepFreeze(out);
}

/**
 * The effective gated transition set for tier `tier` — the closed set
 * narrowed by (validated) config. Tier 0 is ungated (always-on).
 * @param {ReturnType<typeof validateTierConfig>} config
 * @param {"tier1"|"tier2"} tier
 */
export function gatedTransitionsFor(config, tier) {
	const narrowed = config[tier]?.transitions;
	return narrowed ? narrowed.filter((t) => GATED_TRANSITIONS.includes(t)) : [...GATED_TRANSITIONS];
}
