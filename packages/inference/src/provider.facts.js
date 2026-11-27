// provider.facts.js — the tier-0 provider (PORCH-133; PRD 5: "Tier 0 (free,
// always-on): Vision framework + CoreML per-frame detection/tracking").
//
// Tier 0 in the description routing table is the LOCAL FACTS summarizer: it
// renders the deterministic, plain-language summary of the detections the
// always-on Vision/CoreML per-frame plane already produced. No new ML cost,
// no model call, no network — this tier is local-only by construction and
// always invoked.

/**
 * Class tallies from the request's detections. @param {unknown[]} detections
 * @returns {Array<[string, number]>} classes with counts, input order
 */
function tallies(detections) {
	const order = /** @type {string[]} */ ([]);
	const counts = new Map();
	for (const detection of detections ?? []) {
		const cls = /** @type {{cls?: unknown}} */ (detection)?.cls;
		if (typeof cls !== "string" || cls.trim() === "") continue;
		if (!counts.has(cls)) order.push(cls);
		counts.set(cls, (counts.get(cls) ?? 0) + 1);
	}
	return order.map((cls) => [cls, /** @type {number} */ (counts.get(cls))]);
}

/**
 * The tier-0 facts line: "1 person at front-door (arrival)". Deterministic,
 * plain-language, labeled as local facts (what detection saw is fact; the
 * interpretation is each higher tier's job).
 * @param {import("./types.js").DescriptionRequest} request
 */
export function factsLineOf(request) {
	const parts = tallies(request.detections).map(([cls, count]) => `${count} ${cls}`);
	const seen = parts.length > 0 ? `Seen: ${parts.join(", ")}` : "No detections carried";
	return `${seen} at ${request.camera} (${request.transition})`;
}

/**
 * Create the tier-0 facts provider.
 * @param {{ name?: string }} [opts]
 * @returns {import("./types.js").TierProvider}
 */
export function createFactsProvider({ name = "vision-facts" } = {}) {
	return {
		tier: "tier0",
		name,
		providerClass: "native-mlx",
		async describe(request) {
			return { text: factsLineOf(request), model: null };
		},
		status() {
			return { engine: "local-facts", providerClass: "native-mlx", model: null, state: "native" };
		},
	};
}
