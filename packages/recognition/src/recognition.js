// recognition.js — the People & Things orchestrator of record (PORCH-141).
//
// The service wires the registry store, the local pipeline (descriptor
// computation lives on-device behind the VisionProvider seam), and the
// gallery match into the recognition runs:
//
//   enrollment:   upload → local pipeline embeds → registry entry
//   sightings:    engine detection (or bus-borne reid/plate evidence) →
//                 gallery match → decision (asserted / looks-like / unknown)
//                 → sighting history + by-reference annotation
//
// The uncertainty law is owned by gallery.decide; the switch of record and
// the zero-computation enforcement are owned by registry.settingsOf plus
// pipeline.enforceAndRun. Nothing here ships an artifact off the hub.

import { bestMatch, decide, CALIBRATION_HINT_COSINE } from "./gallery.js";
import { normalizePlateText } from "./types.js";
import { RegistryError } from "./registry.js";

/** @typedef {import("./types.js").VisionProvider} VisionProvider */
/** @typedef {import("./types.js").RecognitionFrame} RecognitionFrame */

/**
 * One recognition intake: what the pipeline/ bus produced for a detection.
 * `descriptor` — a locally computed face descriptor OR a bus-borne `reid`
 * vector (the engine's descriptor channel — computed upstream, never here
 * when the switch is off: ac-4 enforces zero computations AND zero runs).
 * `plateText` — a locally OCR'd plate read OR its bus extension.
 * @typedef {{
 *   homeId: string,
 *   kind: "face" | "vehicle",
 *   descriptor?: number[],
 *   plateText?: string,
 *   cameraId?: string,
 *   trackId?: string,
 *   at?: number,
 *   eventId?: string,
 *   entityId?: string,
 * }} RecognitionIntake
 */

/**
 * @typedef {{
 *   decision: "asserted" | "looks-like" | "unknown",
 *   entryId: string | null,
 *   name: string | null,
 *   confidence: number,
 * }} MatchOutcome
 */

/**
 * Factory of record.
 *
 * @param {{
 *   registry: ReturnType<typeof import("./registry.js").createRegistryService>,
 *   pipeline: import("./pipeline.js").RecognitionPipeline,
 *   providerName?: string,
 *   now?: () => number,
 * }} options
 */
export function createRecognitionService({ registry, pipeline, providerName = "local", now = () => Math.floor(Date.now() / 1000) } = {}) {
	if (!registry || !pipeline) throw new TypeError("Recognition needs the registry store and the local pipeline.");

	/**
	 * Live switch of record (read per run — the toggle bites immediately,
	 * no cached posture).
	 * @param {string} homeId
	 */
	async function enabled(homeId) {
		const settings = await registry.settingsOf(homeId);
		return settings.enabled;
	}

	/**
	 * ENROLLMENT (ac-1): embed the uploaded photo(s) LOCALLY via the
	 * provider, insert the entry. Plate-only vehicle enrollment skips the
	 * descriptor stage when no photo rides. Refused while switched off.
	 *
	 * @param {{
	 *   homeId: string, kind: "face" | "vehicle", name: string,
	 *   frames?: RecognitionFrame[],
	 *   plateText?: string,
	 *   enrolledFor?: "household" | "visit",
	 *   accountabilityNote?: string,
	 *   actorDid?: string | null,
	 * }} req
	 * @returns {Promise<import("./types.js").FaceEntry | import("./types.js").VehicleEntry>}
	 */
	async function enroll(req) {
		if (!(await enabled(req.homeId))) {
			pipeline.metrics.bump("refusedDisabled");
			throw new RegistryError('Recognition is switched off for this home — flip it on at the People & Things head to enroll.', { code: "E_RECOGNITION_DISABLED" });
		}
		const frames = Array.isArray(req.frames) ? req.frames : [];
		const descriptorRows = [];
		let plateText = req.plateText !== undefined ? normalizePlateText(req.plateText) : undefined;
		if (frames.length > 0) {
			const provider = pipeline.registry.create(providerName);
			for (const frame of frames) {
				// Vehicle enrollment reads plates first (local OCR-class stage);
				// an explicit plateText in the request wins.
				if (req.kind === "vehicle" && plateText === undefined && typeof provider.readPlates === "function") {
					const { plates } = await pipeline.computePlates({ enabled: true, provider, frame });
					const hit = plates.find((p) => typeof p.text === "string" && p.text.trim() !== "");
					if (hit) plateText = normalizePlateText(hit.text);
				}
				const { embeddings } = await pipeline.computeDescriptor({ enabled: true, provider, frame });
				for (const embedding of embeddings) descriptorRows.push(embedding.descriptor);
			}
			if (descriptorRows.length === 0 && req.kind === "face") {
				throw new RegistryError("No face was found in the uploaded photo — try a clearer one.");
			}
		}
		return registry.enroll({
			homeId: req.homeId,
			kind: req.kind,
			name: req.name,
			descriptors: descriptorRows,
			plateText,
			enrolledFor: req.enrolledFor,
			accountabilityNote: req.accountabilityNote,
			actorDid: req.actorDid ?? null,
		});
	}

	/**
	 * THE GALLERY MATCH (ac-1/ac-2): nearest descriptor + the calibrated
	 * threshold of record. Uncalibrated ⇒ never asserts.
	 * @param {{ homeId: string, descriptor: number[] }} req
	 * @returns {Promise<MatchOutcome>}
	 */
	async function matchFace({ homeId, descriptor }) {
		const settings = await registry.settingsOf(homeId);
		const entries = await registry.listEntries(homeId, "face");
		const gallery = [];
		for (const entry of entries) {
			for (const row of entry.descriptors) gallery.push({ entryId: entry._id, descriptor: row });
		}
		const { entryId, similarity } = bestMatch(descriptor, gallery);
		const { decision, confidence } = decide(similarity, { assertThreshold: settings.assertThreshold });
		if (decision === "unknown" || !entryId) return { decision: "unknown", entryId: null, name: null, confidence };
		const entry = entries.find((e) => e._id === entryId);
		const name = entry ? entry.name : null;
		return { decision, entryId, name, confidence };
	}

	/**
	 * THE VEHICLE MATCH: plate text equality asserts the entry; otherwise
	 * descriptor similarity through the same uncertainty law.
	 * @param {{ homeId: string, descriptor?: number[], plateText?: string }} req
	 * @returns {Promise<MatchOutcome>}
	 */
	async function matchVehicle({ homeId, descriptor, plateText }) {
		const settings = await registry.settingsOf(homeId);
		const entries = await registry.listEntries(homeId, "vehicle");
		if (plateText) {
			const normalized = normalizePlateText(plateText);
			const plateHit = entries.find((e) => e.plateText === normalized);
			if (plateHit) {
				return { decision: "asserted", entryId: plateHit._id, name: plateHit.name, confidence: 1 };
			}
		}
		if (!descriptor) return { decision: "unknown", entryId: null, name: null, confidence: 0 };
		const gallery = [];
		for (const entry of entries) {
			for (const row of entry.descriptors) gallery.push({ entryId: entry._id, descriptor: row });
		}
		const { entryId, similarity } = bestMatch(descriptor, gallery);
		const { decision, confidence } = decide(similarity, { assertThreshold: settings.assertThreshold });
		if (decision === "unknown" || !entryId) return { decision: "unknown", entryId: null, name: null, confidence };
		const entry = entries.find((e) => e._id === entryId);
		return { decision, entryId: entryId, name: entry ? entry.name : null, confidence };
	}

	/**
	 * ONE RECOGNITION RUN (ac-1 sighting annotation): match the intake, and
	 * on a recognizable match write the sighting history row and the
	 * by-reference annotation for the event/entity/track/visit surfaces.
	 *
	 * The disabled enforcement is upstream: callers must not run this at all
	 * when the switch is off (see `recognitionEnabledOfRecord`); a defensive
	 * refusal still here is counted and thrown, never silent (ac-4).
	 *
	 * @param {RecognitionIntake} intake
	 * @returns {Promise<{ outcome: MatchOutcome, annotated: boolean, annotationId: string | null }>}
	 */
	async function recognize(intake) {
		if (!(await enabled(intake.homeId))) {
			pipeline.metrics.bump("refusedDisabled");
			throw Object.assign(new Error("Recognition is switched off for this home — no recognition runs."), { code: "E_RECOGNITION_DISABLED" });
		}
		// Every gallery match counts as a recognition run in the audit
		// (descriptor recomputation would be separate — a bus-borne descriptor
		// is matched, never recomputed).
		pipeline.metrics.bump("recognitionRuns");
		if (intake.kind !== "face" && intake.kind !== "vehicle") {
			throw new RegistryError("A recognition run is face or vehicle.");
		}
		const outcome = intake.kind === "vehicle"
			? await matchVehicle({ homeId: intake.homeId, descriptor: intake.descriptor, plateText: intake.plateText })
			: await matchFace({ homeId: intake.homeId, descriptor: /** @type {number[]} */ (intake.descriptor) });
		if (outcome.decision === "unknown" || !outcome.entryId) {
			// Unknown sightings stay unannotated (ac-2) — and unrecorded: no
			// sighting history accrues for a non-match.
			return { outcome, annotated: false, annotationId: null };
		}
		const sighting = {
			at: intake.at ?? now(),
			cameraId: intake.cameraId,
			trackId: intake.trackId,
			eventId: intake.eventId,
			entityId: intake.entityId,
			confidence: outcome.confidence,
			decision: outcome.decision === "asserted" ? "asserted" : "looks-like",
		};
		await registry.recordSighting(intake.homeId, outcome.entryId, sighting);
		const targetKind = intake.eventId ? "event" : intake.entityId ? "entity" : intake.trackId ? "track" : null;
		if (!outcome.entryId || !targetKind) {
			return { outcome, annotated: false, annotationId: null };
		}
		const note = await registry.annotate({
			homeId: intake.homeId,
			entryId: outcome.entryId,
			targetKind,
			targetId: /** @type {string} */ (intake.eventId ?? intake.entityId ?? intake.trackId),
			cameraId: intake.cameraId,
			trackId: intake.trackId,
			confidence: outcome.confidence,
			decision: outcome.decision === "asserted" ? "asserted" : "looks-like",
		});
		return { outcome, annotated: true, annotationId: note._id };
	}

	/**
	 * The metrics surface of record (ac-4): the zero-computation audit reads
	 * these counters; the calibration hint shows how many uncalibrated runs
	 * would have asserted at the hint cosine (the measured trade lives in the
	 * task trail, per TS 2).
	 */
	function metrics() {
		return pipeline.metrics.snapshot();
	}

	return { enabled, enroll, matchFace, matchVehicle, recognize, metrics, CALIBRATION_HINT_COSINE };
}

/**
 * The upstream gate other services consult before computing any descriptor
 * (the enforcement point engine providers attach to; TS 2's "enforced
 * upstream"). Reads the switch of record live — never a cached posture.
 * @param {{ registry: ReturnType<typeof import("./registry.js").createRegistryService> }} deps
 */
export function createUpstreamRecognitionGate({ registry }) {
	/** @param {string} homeId */
	async function isEnabled(homeId) {
		return registry.settingsOf(homeId).then((s) => s.enabled);
	}
	return { isEnabled };
}
