// soul.js — SOUL injection (PORCH-147).
//
// The SOUL document is the per-member system-injection of record: identity
// lines only, rendered fresh each turn so a SOUL change applies on the next
// inference without a restart. Members own their SOUL; the runtime renders
// it and never invents doctrine — an absent document renders the minimal
// neutral soul.

/**
 * @param {import("./types.js").Soul} soul
 * @returns {string} the injected system content
 */
export function renderSoulInjection(soul) {
	if (!soul || typeof soul.identity !== "string" || soul.identity.length === 0) {
		throw new TypeError("renderSoulInjection: soul.identity (string) is required");
	}
	const lines = [
		"# SOUL",
		"",
		`You are ${soul.identity.trim()}.`,
		"",
		"You are one member's personal agent on their household hub. You answer for the member you are bound to and no one else.",
	];
	if (soul.voice && typeof soul.voice === "string" && soul.voice.trim()) {
		lines.push("", "## Voice", "", soul.voice.trim());
	}
	if (Array.isArray(soul.law) && soul.law.length) {
		lines.push("", "## Law", "", ...soul.law.filter((l) => typeof l === "string" && l.trim()).map((l) => `- ${l.trim()}`));
	}
	return lines.join("\n");
}

/** The minimal soul when a member has authored none. */
export const DEFAULT_SOUL = Object.freeze({
	identity: "the member's personal agent",
});

/**
 * Validate a soul document write shape (identity required; voice/law
 * optional) — the member's authored discipline, nothing synthesized.
 *
 * @param {import("./types.js").Soul} doc
 * @returns {import("./types.js").Soul}
 */
export function normalizeSoul(doc) {
	if (!doc || typeof doc.identity !== "string" || !doc.identity.trim()) {
		throw new TypeError("soul document requires an identity string");
	}
	const law = Array.isArray(doc.law) ? doc.law.filter((l) => typeof l === "string") : undefined;
	return { identity: doc.identity, ...(doc.voice ? { voice: doc.voice } : {}), ...(law ? { law } : {}) };
}
