// types.js — contract types for the inference tiering plane (PORCH-133;
// Porchlight Home Engine initiative, PRD 5 / TS 5: _Inference Tiering: the
// `InferenceProvider` protocol_).
//
// The tiering routing of record turns the "local or paid models" requirement
// into an explicit table:
//
//   - tier 0 (free, always-on): the local detection facts the Vision/CoreML
//     per-frame plane already produced (the detection package's
//     InferenceProvider seam) rendered as a plain-language summary. No ML
//     cost beyond detection itself; no network egress.
//   - tier 1 (local LLM/VLM): Ollama on the deployment host, provisioned by
//     the product's own setup (green-field law — never assumed pre-installed).
//     Event descriptions and behavior triage via a vision-capable model,
//     gated by entity FSM transitions (arrival/departure/loitering).
//   - tier 2 (paid, OpenAI-compatible): user-supplied keys, OFF BY DEFAULT;
//     only the gated (high-value) transitions, and only after an explicit
//     opt-in never implied by presence in config.
//
// Routing law (PRD 5): tiers are invoked IN ORDER; the first tier that
// produces a description wins, and a failed tier escalates to the next.
// Tier 2 is never called unless `tier2.optIn === true`.

/** The tier ids of record — closed list. */
export const TIERS = Object.freeze(["tier0", "tier1", "tier2"]);

/** A Validation error: broken config or malformed payloads (plain language). */
export class ValidationError extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = "ValidationError";
	}
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
export function assertObject(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ValidationError(`${label}: must be an object`);
	}
	return /** @type {Record<string, unknown>} */ (value);
}

/**
 * The entity FSM transitions of record that gate LLM/VLM inference
 * (PRD 5 tier 1: "gated by event FSM transitions (arrival/departure/
 * loitering)"). A closed list: the tier config may narrow the set, never
 * extend it (a transition outside this list never gates paid or LLM work).
 */
export const GATED_TRANSITIONS = Object.freeze(["arrival", "departure", "loitering"]);

/**
 * The routing config of record: Tier 2 off by default (privacy/cost law),
 * Tier 1 local-first enabled, Tier 0 always-on and therefore not
 * configurable (it carries no knob).
 */
export const DEFAULT_TIER_CONFIG = Object.freeze({
	tier1: Object.freeze({ enabled: true }),
	tier2: Object.freeze({ optIn: false }),
});

/**
 * One tier entry of the routing table.
 *
 * @typedef {object} TierProvider
 * @property {string} tier                    one of TIERS
 * @property {string} name                    provider id (e.g. "ollama")
 * @property {string} providerClass           "native-mlx" | "openai-spec" | "local-server"
 * @property {(request: import("./types.js").DescriptionRequest) => Promise<import("./types.js").DescriptionResult>} describe
 * @property {() => Record<string, unknown>} [status]
 */

/**
 * The description request one routing pass carries. `image` is an OPTIONAL
 * base64 snapshot still pulled from the event's own recording — never a
 * video frame stream (the privacy law below); providers that need vision
 * ride exactly this field. What each tier may send where is documented per
 * provider in the README (per-provider data boundaries; Tier 2 off by
 * default).
 *
 * @typedef {object} DescriptionRequest
 * @property {string} camera                  engine camera id
 * @property {number} t                       epoch seconds of the event
 * @property {string|null} [cls]              detection class of the event
 * @property {string|null} [trackId]          track identity when tracked
 * @property {string} transition              the entity FSM transition fired
 * @property {Array<{cls: string, conf: number}>} [detections] local tier-0 facts to describe
 * @property {string} [image]                 optional base64 snapshot still
 */

/**
 * What a tier's describe() returns. `text: null` is an EXPLICIT no-answer
 * (never silent, never an invented description) and escalates routing to
 * the next tier.
 *
 * @typedef {object} DescriptionResult
 * @property {string|null} text
 * @property {string|null} [model]
 */

/**
 * One routing outcome entry — an invocation (success or failure) or a skip
 * with its reason (never-silent law: every tier the config governs renders
 * why it did or did not run).
 *
 * @typedef {object} RoutingStep
 * @property {string} tier
 * @property {string} provider
 * @property {"invoked"|"skipped"|"error"} kind
 * @property {string|null} reason             skip reason or failure message
 * @property {string|null} [text]
 * @property {string|null} [model]
 */

/**
 * The full outcome of one routing pass.
 *
 * @typedef {object} RoutingOutcome
 * @property {string} transition
 * @property {string|null} description        first successful tier's text
 * @property {RoutingStep[]} steps            every tier's outcome, in tier order
 * @property {string|null} [provider]
 * @property {string|null} [providerClass]
 * @property {string|null} [model]
 */
