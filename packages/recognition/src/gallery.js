// gallery.js — the gallery match of record (PORCH-141 TS 2).
//
// "Gallery matching is nearest-descriptor with a calibrated threshold;
// above threshold the sighting annotates the event as the entry's name;
// below threshold it renders as 'looks like' with the confidence shown,
// never asserted." Until a calibration lands, matching fails toward
// uncertainty: an uncalibrated system renders "looks like" by default and
// NEVER asserts a name.

/**
 * Cosine similarity of two equal-length vectors. Returns a value in [-1, 1];
 * caller normalizes to [0, 1] confidence.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function cosine(a, b) {
	let dot = 0;
	let na = 0;
	let nb = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i += 1) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) return 0;
	return dot / Math.sqrt(na * nb);
}

/**
 * The uncalibrated posture of record (TS 2): no threshold of record exists,
 * so the gallery match NEVER asserts. The floor is the "recognizable at
 * all" bar for rendering "looks like" at all — below it the sighting stays
 * unannotated.
 */
export const UNCALIBRATED_ASSERT_THRESHOLD = null;
export const DEFAULT_LOOKS_LIKE_FLOOR = 0.6;
/** Confidence above which an uncalibrated system would have asserted —
 * surfaced in metrics so the calibration pass has its measured trade. */
export const CALIBRATION_HINT_COSINE = 0.85;

/** @typedef {"asserted" | "looks-like" | "unknown"} MatchDecision */

/**
 * @typedef {{
 *   assertThreshold: number | null,
 *   looksLikeFloor?: number,
 * }} GalleryPolicy
 * assertThreshold — the calibrated threshold of record; null = uncalibrated.
 * looksLikeFloor — below it a similarity is not recognizable at all.
 */

/**
 * The uncertainty decision law (the one copy of it; the web shares the
 * decision, never restates it).
 *
 * @param {number} similarity cosine similarity of the best gallery match
 * @param {GalleryPolicy} policy
 * @returns {{ decision: MatchDecision, confidence: number }}
 */
export function decide(similarity, { assertThreshold = null, looksLikeFloor = DEFAULT_LOOKS_LIKE_FLOOR } = {}) {
	const confidence = Math.max(0, Math.min(1, (similarity + 1) / 2));
	if (assertThreshold !== null && similarity >= assertThreshold) {
		return { decision: "asserted", confidence };
	}
	if (similarity < looksLikeFloor) {
		return { decision: "unknown", confidence };
	}
	// Uncalibrated or below the calibrated bar: "looks like" with the
	// confidence shown — never silently asserted.
	return { decision: "looks-like", confidence };
}

/**
 * Nearest-descriptor match of an incoming descriptor against a gallery of
 * {entryId, descriptor} rows.
 *
 * @param {number[]} descriptor
 * @param {Array<{ entryId: string, descriptor: number[] }>} gallery
 * @returns {{ entryId: string | null, similarity: number }}
 */
export function bestMatch(descriptor, gallery) {
	let bestId = null;
	let best = -1;
	for (const row of gallery) {
		const similarity = cosine(descriptor, row.descriptor);
		if (similarity > best) {
			best = similarity;
			bestId = row.entryId;
		}
	}
	return { entryId: bestId, similarity: best };
}
