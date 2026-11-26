// registry.js — the People & Things registry service of record (PORCH-141).
//
// One StoreLike (the hub's Mongo of record) + the audit log carry the
// registry: entries { name, descriptors, sightings }, the per-household
// recognition switch of record (opt-in — the biometric privacy law), the
// calibrated threshold, by-reference annotations, the deletion purge, and
// the household's export. Routes stay thin: every behavior lives here.

import {
	FACE_ID_PREFIX,
	VEHICLE_ID_PREFIX,
	SIGHTINGS_CAP,
	assertDescriptor,
	assertEnrollmentMeta,
	normalizePlateText,
} from "./types.js";
import { UNCALIBRATED_ASSERT_THRESHOLD } from "./gallery.js";
import { randomUUID } from "node:crypto";

/** @typedef {import("./types.js").FaceEntry} FaceEntry */
/** @typedef {import("./types.js").VehicleEntry} VehicleEntry */
/** @typedef {import("./types.js").Sighting} Sighting */
/** @typedef {import("./types.js").Annotation} Annotation */
/** @typedef {import("./types.js").RecognitionSettings} RecognitionSettings */

/** The store collections of record. */
export const COLLECTIONS = {
	entries: "recognition_entries",
	annotations: "recognition_annotations",
	settings: "recognition_settings",
};

/** Audit record types of record (this domain's audit trail). */
export const AUDIT_TYPES = {
	TOGGLE: "recognition-toggle",
	THRESHOLD: "recognition-threshold",
	ENROLL: "registry-enroll",
	PURGE: "registry-entry-purge",
};

/** Domain service refusal (plain language; `code` reaches transport). */
export class RegistryError extends Error {
	/**
	 * @param {string} message
	 * @param {{ status?: number, code?: string }} [options]
	 */
	constructor(message, { status = 422, code = "E_INVALID" } = {}) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

/**
 * @param {unknown} v
 * @returns {v is string}
 */
function isNonEmpty(v) {
	return typeof v === "string" && v.trim() !== "";
}

/** @param {unknown} v @returns {v is number} */
function isFinite(v) {
	return typeof v === "number" && Number.isFinite(v);
}

/**
 * Factory of record.
 *
 * @param {{
 *   store: import("@porchlight/shared").StoreLike,
 *   audit?: { record(input: { type: string, actorIdentityRef?: string|null, detail?: object, outcome?: string, homeId?: string|null }): unknown },
 *   now?: () => number,
 * }} options
 */
export function createRegistryService({ store, audit, now = () => Math.floor(Date.now() / 1000) } = {}) {
	const entries = store.collection(COLLECTIONS.entries);
	const annotations = store.collection(COLLECTIONS.annotations);
	const settings = store.collection(COLLECTIONS.settings);

	/** @param {string | undefined} v @returns {string} */
	const actor = (v) => (isNonEmpty(v) ? /** @type {string} */ (v) : null);

	/** @param {string} homeId */
	function requireHomeId(homeId) {
		if (!isNonEmpty(homeId)) throw new RegistryError("Recognition is scoped to a home.");
		return homeId;
	}

	// ---- settings: the switch of record + the calibrated threshold ----

	/**
	 * The settings row of record; created on first write. A household that
	 * never opted in reads enabled=false — the opt-in default (biometric
	 * privacy law).
	 * @param {string} homeId
	 * @returns {Promise<RecognitionSettings>}
	 */
	async function settingsOf(homeId) {
		requireHomeId(homeId);
		const row = await settings.findOne({ homeId });
		if (!row) {
			return { homeId, enabled: false, assertThreshold: UNCALIBRATED_ASSERT_THRESHOLD, updatedAt: null, updatedBy: null };
		}
		return {
			homeId,
			enabled: row.enabled === true,
			assertThreshold: isFinite(row.assertThreshold) ? /** @type {number} */ (row.assertThreshold) : null,
			updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
			updatedBy: typeof row.updatedBy === "string" ? row.updatedBy : null,
		};
	}

	/**
	 * Toggle recognition for a household (ac-6; the owner-facing switch at
	 * the People & Things head is this row). Every change lands in audit.
	 * Toggling on resumes without re-enrollment — nothing is deleted on off.
	 * @param {{ homeId: string, enabled: boolean, actorDid?: string | null }} req
	 */
	async function setEnabled({ homeId, enabled, actorDid = null }) {
		requireHomeId(homeId);
		if (typeof enabled !== "boolean") throw new RegistryError("The recognition switch is on or off.");
		const before = await settingsOf(homeId);
		await settings.updateOne(
			{ homeId },
			{ $set: { enabled, updatedAt: new Date(now() * 1000).toISOString(), updatedBy: actorDid }, upsert: true },
		);
		audit?.record({
			type: AUDIT_TYPES.TOGGLE,
			actorIdentityRef: actor(actorDid),
			homeId,
			detail: { from: before.enabled, to: enabled },
		});
		return settingsOf(homeId);
	}

	/**
	 * Record the calibrated gallery threshold (null = uncalibrated, the
	 * default-of-record posture — failing toward uncertainty).
	 * @param {{ homeId: string, assertThreshold: number | null, actorDid?: string | null }} req
	 */
	async function setThreshold({ homeId, assertThreshold, actorDid = null }) {
		requireHomeId(homeId);
		if (assertThreshold !== null && (!isFinite(assertThreshold) || assertThreshold < 0 || assertThreshold > 1)) {
			throw new RegistryError("The calibrated threshold is a number in [0, 1] or null (uncalibrated).");
		}
		const before = await settingsOf(homeId);
		await settings.updateOne(
			{ homeId },
			{ $set: { assertThreshold, updatedAt: new Date(now() * 1000).toISOString(), updatedBy: actorDid }, upsert: true },
		);
		audit?.record({
			type: AUDIT_TYPES.THRESHOLD,
			actorIdentityRef: actor(actorDid),
			homeId,
			detail: { from: before.assertThreshold, to: assertThreshold },
		});
		return settingsOf(homeId);
	}

	// ---- entries ----

	/**
	 * @param {string} homeId
	 * @param {"face" | "vehicle"} [kind]
	 * @returns {Promise<Array<FaceEntry | VehicleEntry>>}
	 */
	async function listEntries(homeId, kind) {
		requireHomeId(homeId);
		const filter = kind ? { homeId, kind } : { homeId };
		const rows = await entries.find(filter);
		return rows.map(toView);
	}

	/**
	 * @param {string} homeId
	 * @param {string} entryId
	 * @returns {Promise<FaceEntry | VehicleEntry>}
	 */
	async function getEntry(homeId, entryId) {
		requireHomeId(homeId);
		const row = await entries.findOne({ _id: entryId, homeId });
		if (!row) throw new RegistryError("No such registry entry.", { status: 404, code: "E_NOT_FOUND" });
		return toView(row);
	}

	/**
	 * Insert an enrolled entry. The caller supplies LOCAL descriptors (the
	 * pipeline computed them on-device; this service never embeds).
	 * @param {{
	 *   homeId: string, kind: "face" | "vehicle", name: string,
	 *   descriptors: number[][], plateText?: string,
	 *   enrolledFor?: "household" | "visit", accountabilityNote?: string,
	 *   actorDid?: string | null,
	 * }} req
	 * @returns {Promise<FaceEntry | VehicleEntry>}
	 */
	async function enroll(req) {
		const meta = assertEnrollmentMeta(req);
		const descriptors = /** @type {unknown[]} */ (req.descriptors);
		const plateOnly = meta.kind === "vehicle" && req.plateText !== undefined;
		if ((!Array.isArray(descriptors) || descriptors.length === 0) && !plateOnly) {
			throw new RegistryError(
				meta.kind === "face"
					? "Enrollment needs at least one local face descriptor."
					: "A vehicle entry carries a plate read or a local descriptor.");
		}
		const stored = Array.isArray(descriptors) ? descriptors.map((d) => assertDescriptor(d)) : [];
		if (meta.kind === "vehicle" && req.plateText !== undefined) {
			req = { ...req, plateText: normalizePlateText(req.plateText) };
		}
		const ts = new Date(now() * 1000).toISOString();
		const doc = {
			_id: `${meta.kind === "face" ? FACE_ID_PREFIX : VEHICLE_ID_PREFIX}${randomUUID().slice(0, 12)}`,
			homeId: meta.homeId,
			kind: meta.kind,
			name: meta.name,
			descriptors: stored,
			sightings: [],
			...(req.plateText !== undefined ? { plateText: req.plateText } : {}),
			...(meta.enrolledFor !== undefined ? { enrolledFor: meta.enrolledFor } : {}),
			...(meta.accountabilityNote !== undefined ? { accountabilityNote: meta.accountabilityNote } : {}),
			createdAt: ts,
			updatedAt: ts,
		};
		await entries.insertOne(doc);
		audit?.record({
			type: AUDIT_TYPES.ENROLL,
			actorIdentityRef: actor(req.actorDid),
			homeId: meta.homeId,
			detail: { entryId: doc._id, kind: meta.kind, name: meta.name, enrolledFor: meta.enrolledFor ?? "household" },
		});
		return toView(doc);
	}

	/**
	 * Rename (retitle) an entry — every annotation rides the entryId
	 * reference, so history renames without a rewrite.
	 * @param {{ homeId: string, entryId: string, name?: string, plateText?: string }} req
	 */
	async function updateEntry({ homeId, entryId, name, plateText }) {
		requireHomeId(homeId);
		const patch = { updatedAt: new Date(now() * 1000).toISOString() };
		if (name !== undefined) {
			if (!isNonEmpty(name)) throw new RegistryError("Every entry carries a name.");
			patch.name = name;
		}
		if (plateText !== undefined) patch.plateText = normalizePlateText(plateText);
		await entries.updateOne({ _id: entryId, homeId }, { $set: patch });
		// A missing row must fail loud, not silently upsert: getEntry throws 404.
		return getEntry(homeId, entryId);
	}

	/**
	 * THE DELETION PURGE (ac-3): descriptors, plate reads, and sighting
	 * history are purged with the entry; the identity annotations on past
	 * events are removed (the annotated events keep their factual content —
	 * the annotation row was the only identity reference). Counts return so
	 * the audit trail shows exactly what went away.
	 * @param {{ homeId: string, entryId: string, actorDid?: string | null }} req
	 */
	async function purgeEntry({ homeId, entryId, actorDid = null }) {
		requireHomeId(homeId);
		const before = await entries.findOne({ _id: entryId, homeId });
		if (!before) throw new RegistryError("No such registry entry.", { status: 404, code: "E_NOT_FOUND" });
		const sighted = Array.isArray(before.sightings) ? before.sightings.length : 0;
		await entries.deleteOne({ _id: entryId, homeId });
		const purgedAnnotations = await annotations.deleteMany({ entryId });
		audit?.record({
			type: AUDIT_TYPES.PURGE,
			actorIdentityRef: actor(actorDid),
			homeId,
			detail: {
				entryId,
				kind: before.kind,
				name: before.name,
				descriptors: Array.isArray(before.descriptors) ? before.descriptors.length : 0,
				plateReads: before.plateText !== undefined ? 1 : 0,
				sightings: sighted,
				annotations: purgedAnnotations.deletedCount,
			},
		});
		return {
			purged: {
				entryId,
				descriptorVectors: Array.isArray(before.descriptors) ? before.descriptors.length : 0,
				plateReads: before.plateText !== undefined ? 1 : 0,
				sightings: sighted,
				annotations: purgedAnnotations.deletedCount,
			},
		};
	}

	/**
	 * Record a sighting (the recognition runs wrote it — this is history,
	 * not interpretation). Bounded by SIGHTINGS_CAP (oldest falls off).
	 * @param {string} homeId
	 * @param {string} entryId
	 * @param {Sighting} sighting
	 */
	async function recordSighting(homeId, entryId, sighting) {
		await getEntry(homeId, entryId);
		const row = await entries.findOne({ _id: entryId, homeId });
		const list = Array.isArray(row?.sightings) ? /** @type {Sighting[]} */ (row.sightings) : [];
		const next = [...list, sighting].slice(-SIGHTINGS_CAP);
		await entries.updateOne({ _id: entryId, homeId }, { $set: { sightings: next, updatedAt: new Date(now() * 1000).toISOString() } });
	}

	// ---- annotations (by reference) ----

	/**
	 * Write an identity annotation that REFERENCES the entry. The target is
	 * an event id / entity id / visit id / raw track identity — never a
	 * duplicated copy of event content.
	 * @param {Omit<Annotation, "_id"> & { targetId: string }} note
	 * @returns {Promise<Annotation>}
	 */
	async function annotate(note) {
		if (!isNonEmpty(note.homeId) || !isNonEmpty(note.entryId) || !isNonEmpty(note.targetId)) {
			throw new RegistryError("An annotation needs homeId, entryId, and a target.");
		}
		if (note.targetKind !== "event" && note.targetKind !== "entity" && note.targetKind !== "track" && note.targetKind !== "visit") {
			throw new RegistryError("An annotation targets an event, entity, track, or visit.");
		}
		if (!isFinite(note.confidence)) throw new RegistryError("An annotation carries its confidence.");
		if (note.decision !== "asserted" && note.decision !== "looks-like") {
			throw new RegistryError("An annotation decision is asserted or looks-like.");
		}
		const doc = {
			_id: `ann_${randomUUID().slice(0, 12)}`,
			homeId: note.homeId,
			entryId: note.entryId,
			targetKind: note.targetKind,
			targetId: note.targetId,
			cameraId: isNonEmpty(note.cameraId) ? note.cameraId : undefined,
			trackId: isNonEmpty(note.trackId) ? note.trackId : undefined,
			confidence: note.confidence,
			decision: note.decision,
			at: new Date(now() * 1000).toISOString(),
		};
		await annotations.insertOne(doc);
		return doc;
	}

	/**
	 * Annotations of record for a home (event and visit surfaces join on
	 * targetId / cameraId+trackId). Works while recognition is disabled —
	 * reading is not recognition (ac-6).
	 * @param {{ homeId: string, entryId?: string, targetKind?: string, targetId?: string, cameraId?: string, trackId?: string }} req
	 * @returns {Promise<Array<Annotation>>}
	 */
	async function listAnnotations({ homeId, entryId, targetKind, targetId, cameraId, trackId }) {
		requireHomeId(homeId);
		const filter = { homeId, ...(entryId ? { entryId } : {}), ...(targetKind ? { targetKind } : {}), ...(targetId ? { targetId } : {}), ...(cameraId ? { cameraId } : {}), ...(trackId ? { trackId } : {}) };
		return /** @type {Annotation[]} */ (await annotations.find(filter));
	}

	// ---- export (the household owns its data) ----

	/**
	 * The registry export of record (ac-3): every entry with its descriptors,
	 * plate reads, and sighting history, plus the settings row. Produced in
	 * the hub, delivered to the household — artifacts stay local to the hub
	 * until the household itself takes them (the Tier-2 off-by-default law).
	 * @param {string} homeId
	 */
	async function exportRegistry(homeId) {
		requireHomeId(homeId);
		const [entryRows, settingRow] = await Promise.all([entries.find({ homeId }), settingsOf(homeId)]);
		return {
			exportedAt: new Date(now() * 1000).toISOString(),
			formatName: "porchlight-recognition-registry/1",
			homeId,
			settings: settingRow,
			entries: entryRows.map(toView),
		};
	}

	return {
		settingsOf,
		setEnabled,
		setThreshold,
		listEntries,
		getEntry,
		enroll,
		updateEntry,
		purgeEntry,
		recordSighting,
		annotate,
		listAnnotations,
		exportRegistry,
	};
}

/**
 * Doc → registry view (descriptors and sightings ride; store internals do
 * not).
 * @param {Record<string, unknown>} row
 */
function toView(row) {
	return {
		_id: /** @type {string} */ (row._id),
		homeId: /** @type {string} */ (row.homeId),
		kind: /** @type {"face" | "vehicle"} */ (row.kind),
		name: /** @type {string} */ (row.name),
		descriptors: Array.isArray(row.descriptors) ? row.descriptors : [],
		sightings: Array.isArray(row.sightings) ? row.sightings : [],
		...(row.plateText !== undefined ? { plateText: /** @type {string} */ (row.plateText) } : {}),
		...(row.enrolledFor !== undefined ? { enrolledFor: row.enrolledFor } : {}),
		...(row.accountabilityNote !== undefined ? { accountabilityNote: row.accountabilityNote } : {}),
		...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
		...(row.updatedAt !== undefined ? { updatedAt: row.updatedAt } : {}),
	};
}
