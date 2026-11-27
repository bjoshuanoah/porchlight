// router.js — the tier routing policy (PORCH-133; PRD 5 / TS 5: "Routing
// policy: per task and per event value. Tier 0 free per-frame inference
// always-on; LLM/VLM calls gated by event FSM transitions or user action;
// Tier 2 opt-in with per-provider data boundaries.").
//
// The router owns the ordering law: tiers walk IN ORDER (tier0 → tier1 →
// tier2); the first tier that yields a description wins; a failed tier
// escalates to the next. Gating:
//   - tier0: always invoked (free, local, always-on).
//   - tier1: invoked only when enabled AND `transition` is gated.
//   - tier2: invoked only when explicitly opted in (`tier2.optIn === true`)
//     AND the transition is gated — presence in the routing table is never
//     an opt-in.
//
// Every skip is RECORDED with its reason (never-silent law): the outcome's
// steps render why each configured tier did or did not run.

import { ValidationError, assertObject } from "./types.js";
import { TIERS, GATED_TRANSITIONS } from "./types.js";
import { validateTierConfig, gatedTransitionsFor } from "./config.js";

/**
 * @param {import("./types.js").TierProvider} provider
 */
function validateProvider(provider) {
	assertObject(provider, "router providers[]");
	if (!TIERS.includes(provider.tier)) {
		throw new ValidationError(`router: provider "${provider.name}" declares tier "${provider.tier}" — tiers are "${TIERS.join('", "')}"`);
	}
	if (typeof provider.name !== "string" || provider.name.trim() === "") {
		throw new ValidationError("router: every provider needs a non-empty name");
	}
	if (typeof provider.describe !== "function") {
		throw new ValidationError(`router: provider "${provider.name}" must implement describe(request)`);
	}
	if (typeof provider.providerClass !== "string" || provider.providerClass.trim() === "") {
		throw new ValidationError(`router: provider "${provider.name}" must declare its providerClass`);
	}
	return provider;
}

/**
 * Create the tier router.
 * @param {{
 *   config?: unknown,
 *   providers: import("./types.js").TierProvider[],
 * }} opts
 * @returns {{
 *   config: ReturnType<typeof validateTierConfig>,
 *   route: (request: import("./types.js").DescriptionRequest) => Promise<import("./types.js").RoutingOutcome>,
 * }}
 */
export function createTierRouter({ config, providers }) {
	if (!Array.isArray(providers) || providers.length === 0) {
		throw new ValidationError("router: providers must be a non-empty array");
	}
	// Ascending tier order is the invocation order of record: routing
	// escalates from free/local toward paid, never the reverse.
	const ordered = [...providers].map(validateProvider).sort(
		(a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier),
	);
	const seen = new Set();
	for (const provider of ordered) {
		if (seen.has(provider.tier)) {
			throw new ValidationError(`router: two providers declare tier ${provider.tier} ("${ordered.find((p) => p.tier === provider.tier)?.name}" and "${provider.name}") — one provider per tier`);
		}
		seen.add(provider.tier);
	}
	const tiers = validateTierConfig(config ?? {});

	return {
		tierConfig: tiers,
		/**
		 * One routing pass: walk the tiers in order, gate, invoke, escalate.
		 * @param {import("./types.js").DescriptionRequest} request
		 * @returns {Promise<import("./types.js").RoutingOutcome>}
		 */
		async route(request) {
			assertObject(request, "route request");
			if (typeof request.transition !== "string" || request.transition.trim() === "") {
				throw new ValidationError("route: request.transition must be a non-empty string");
			}
			const outcome = /** @type {import("./types.js").RoutingOutcome} */ ({
				transition: request.transition,
				steps: [],
				description: null,
				provider: null,
				providerClass: null,
				model: null,
			});
			for (const provider of ordered) {
				const allowed = provider.tier === "tier0" || allowedFor(tiers, provider.tier, request.transition);
				if (!allowed) {
					outcome.steps.push({ tier: provider.tier, provider: provider.name, kind: "skipped", reason: skipReason(tiers, provider.tier, request.transition) });
					continue;
				}
				try {
					const result = await provider.describe(request);
					const text = result?.text ?? null;
					outcome.steps.push({
						tier: provider.tier,
						provider: provider.name,
						kind: "invoked",
						reason: null,
						text: typeof text === "string" && text.trim() !== "" ? text.trim() : null,
						model: result?.model ?? null,
					});
					if (outcome.steps.at(-1).text !== null) {
						// First tier that answers wins — later tiers are never charged.
						outcome.description = outcome.steps.at(-1).text;
						outcome.provider = provider.name;
						outcome.providerClass = provider.providerClass;
						outcome.model = outcome.steps.at(-1).model ?? null;
						break;
					}
				} catch (error) {
					// Never-silent: the failure is a step in the outcome, then routing
					// escalates — a dead local model degrades to the next tier under
					// the same gating, never to a silent stall.
					const message = error instanceof Error ? error.message : String(error);
					outcome.steps.push({ tier: provider.tier, provider: provider.name, kind: "error", reason: message });
				}
			}
			return outcome;
		},
	};
}

/**
 * Whether tier `tier` may run for this transition: enablement first (tier 1
 * must be enabled; tier 2 must be EXPLICITLY opted in), then the gated
 * transition set.
 * @param {ReturnType<typeof validateTierConfig>} tiers
 * @param {string} tier
 * @param {string} transition
 */
function allowedFor(tiers, tier, transition) {
	if (tier === "tier1" && tiers.tier1.enabled === false) return false;
	if (tier === "tier2" && tiers.tier2.optIn !== true) return false;
	return gated(tiers, tier, transition);
}

/**
 * @param {ReturnType<typeof validateTierConfig>} tiers
 * @param {string} tier
 * @param {string} transition
 */
function gated(tiers, tier, transition) {
	return gatedTransitionsFor(tiers, /** @type {"tier1"|"tier2"} */ (tier)).includes(transition);
}

/**
 * @param {ReturnType<typeof validateTierConfig>} tiers
 * @param {string} tier
 * @param {string} transition
 */
function skipReason(tiers, tier, transition) {
	if (tier === "tier1" && tiers.tier1.enabled === false) return "tier1-disabled";
	if (tier === "tier2" && tiers.tier2.optIn !== true) return "tier2-not-opted-in";
	if (!GATED_TRANSITIONS.includes(transition)) return "transition-not-gated";
	return "transition-not-configured";
}
