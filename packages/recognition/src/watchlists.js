// watchlists.js — the household-trained few-shot classifier of record (PORCH-142).
//
// PORCH-I-010 PRD 3 / TS 3: the household teaches the platform what to watch
// for. Training runs on-device (no training artifact or example image ever
// leaves the hub); the shipped path is the embedding-based few-shot
// classifier — the exemplar pool embeds per crop with the provider's
// `embedImage` stage (qwen3-embedding-class), distance is cosine, and the
// match decision rides THE shared uncertainty law (gallery.decide — the one
// copy; People & Things and watchlists share one discipline, in both
// directions). The detector-head fine-tune is held by design: nothing here
// trains model weights, so there is no training infrastructure beyond the
// exemplar pool.
//
// Vocabulary law (two-layer): the trained label joins the open detection
// vocabulary; every trained-label detection flows through the standard
// DetectedObject contract exactly like a built-in class (the hub plane
// emits it onto the engine detections topic). Tracking-scope flags DERIVE
// from the vocabulary classification — a class whose examples rode a
// built-in tracked superclass registers tracked-scope; everything else is
// detection-only (alertable, never cross-camera tracked, never
// composite-evaluated). The flags are never a manual per-class setting.
//
// Adversarial bound: a similar-but-wrong object never asserts the trained
// label. Assertion requires the class's calibrated threshold of record
// (uncalibrated ⇒ "looks like", never asserted); the near neighbor keeps
// its built-in label, and the trained class can only ever appear as
// low-confidence metadata — a recorded "looks-like" row on the detection
// ring, never a bus detection.

import {
	WATCHLIST_ID_PREFIX,
	WATCHLIST_DETECTION_ID_PREFIX,
	EXEMPLARS_CAP,
	DETECTION_RING_CAP,
	EMISSION_COOLDOWN_SEC,
	assertClassLabel,
	assertExemplarDescriptor,
	assertFrame,
	assertWatchlistBody,
} from "./types.js";
import { bestMatch, decide } from "./gallery.js";
import { RegistryError } from "./registry.js";
import { WATCHLIST_AUDIT_TYPES } from "./audit-types.js";
import { randomUUID } from "node:crypto";

/**
 * Where the watchlist collections ride the recognition plane's store of
 * record (same Mongo; the hub keeps one store — the config-survives-restarts
 * law carries).
 * @type {{ watchlists: string, watchlistDetections: string }}
 */
export const WATCHLIST_COLLECTIONS = {
	watchlists: "recognition_watchlists",
	watchlistDetections: "recognition_watchlist_detections",
};

/** The honesty statement of record (the few-shot bound, stated up front). */
export const ACCURACY_NOTE =
	"Few-shot training is bounded: each example teaches a narrow look-alike class, so expect it to catch what it was shown and close relatives — not everything it resembles. Detections render with confidence, and below the class's calibrated threshold they say \u201clooks like\u201d, never the class name.";

/**
 * @param {unknown} v
 * @returns {v is number}
 */
function isFinite(v) {
	return typeof v === "number" && Number.isFinite(v);
}

/** @param {string | undefined} v @returns {string | null} */
function actor(v) {
	return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** @param {string | undefined} homeId */
function requireHomeId(homeId) {
	if (!homeId || String(homeId).trim() === "") throw new RegistryError("Training is scoped to a home.");
	return homeId;
}

/**
 * The example images' on-hub form: the uploaded frame rides a data URL the
 * trained-classes surface renders directly. Nothing here leaves the hub.
 * @param {import("./types.js").RecognitionFrame} frame
 * @returns {string | null}
 */
function imageDataUrl(frame) {
	if (frame.format !== "jpeg") return null;
	return `data:image/jpeg;base64,${Buffer.from(frame.data).toString("base64")}`;
}

/**
 * Embed one uploaded frame via the provider's embedImage stage — the
 * on-device exemplar embedding. Missing stage = training refuses closed
 * (never a silent fallback, the never-silent law).
 * @param {import("./types.js").VisionProvider} provider
 * @param {import("./types.js").RecognitionFrame} frame
 * @returns {Promise<number[][]>}
 */
async function embedFrame(provider, frame) {
	if (typeof provider.embedImage !== "function") {
		throw new RegistryError(
			"Training needs a local exemplar embedder — the vision provider is missing the embedImage stage. Provision it via setup; training never falls back silently.");
	}
	const vectors = await provider.embedImage(frame);
	if (!Array.isArray(vectors) || vectors.length === 0) {
		throw new RegistryError("The examples could not be embedded on-device — try clearer images.");
	}
	return vectors.map((d) => assertExemplarDescriptor(d));
}

/**
 * The held-replay evaluation of record. Rows { descriptor, expect(label) }
 * face the FULL exemplar pool (nearest exemplar across every trained class
 * of the home); a hit is the nearest pool label matching the row's
 * expectation. This is the classifier's measured hit rate — honest numbers,
 * null when there is nothing held out to measure.
 * @param {Array<{ descriptor: number[], expect: string }>} rows
 * @param {Array<import("./types.js").WatchlistClass>} classDocs
 * @param {string} at
 * @returns {{ hitRate: number | null, heldOut: number, exemplars: number, at: string }}
 */
export function evaluateReplay(rows, classDocs, at) {
	const gallery = [];
	for (const cls of classDocs) {
		for (const exemplar of cls.exemplars ?? []) {
			gallery.push({ entryId: cls.label, descriptor: exemplar.descriptor });
		}
	}
	const held = (Array.isArray(rows) ? rows : []).filter((r) => r && Array.isArray(r.descriptor) && r.descriptor.length > 0);
	if (held.length === 0 || gallery.length === 0) {
		return { hitRate: null, heldOut: held.length, exemplars: gallery.length, at };
	}
	let hits = 0;
	for (const row of held) {
		const { entryId, similarity } = bestMatch(row.descriptor, gallery);
		if (entryId === row.expect && similarity > 0) hits += 1;
	}
	return { hitRate: hits / held.length, heldOut: held.length, exemplars: gallery.length, at };
}

/**
 * Leave-one-out hold-out over a class's own pool plus its neighbors — the
 * honest when-there-is-no-held-back-footage baseline ac-4 reports alongside
 * real replays. Each exemplar is re-recognized against the pool WITHOUT
 * itself; a hit is the nearest remaining exemplar saying the same label.
 * @param {import("./types.js").WatchlistClass} doc
 * @param {Array<import("./types.js").WatchlistClass>} allDocs
 * @param {string} at
 */
export function leaveOneOut(doc, allDocs, at) {
	const own = doc.exemplars ?? [];
	const others = [];
	for (const cls of allDocs) {
		if (doc._id !== undefined && cls._id === doc._id) continue;
		for (const exemplar of cls.exemplars ?? []) {
			others.push({ entryId: cls.label, descriptor: exemplar.descriptor });
		}
	}
	const heldOut = own.length;
	if (heldOut === 0) {
		return { hitRate: null, heldOut: 0, exemplars: others.length, at };
	}
	let hits = 0;
	for (const row of own) {
		const pool = [
			...own.filter((r) => r !== row).map((r) => ({ entryId: doc.label, descriptor: r.descriptor })),
			...others,
		];
		if (pool.length === 0) continue; // one exemplar, no neighbors: nothing to hold out against
		const { entryId, similarity } = bestMatch(row.descriptor, pool);
		if (entryId === doc.label && similarity > 0) hits += 1;
	}
	return { hitRate: hits / heldOut, heldOut, exemplars: heldOut + others.length, at };
}

/**
 * Factory of record.
 *
 * @param {{
 *   store: import("@porchlight/shared").StoreLike,
 *   audit?: { record(input: { type: string, actorIdentityRef?: string|null, detail?: object, outcome?: string, homeId?: string|null }): unknown },
 *   trackedClasses?: string[],
 *   providerRef?: (() => Promise<import("./types.js").VisionProvider>) | null,
 *   now?: () => number,
 * }} options
 */
export function createWatchlistService({ store, audit, trackedClasses = [], providerRef = null, now = () => Math.floor(Date.now() / 1000) } = {}) {
	if (!store) throw new TypeError("The watchlist classifier needs the hub store of record.");
	const classes = store.collection(WATCHLIST_COLLECTIONS.watchlists);
	const detections = store.collection(WATCHLIST_COLLECTIONS.watchlistDetections);
	const tracked = /** @type {string[]} */ (Array.isArray(trackedClasses) ? trackedClasses : []);

	const iso = () => new Date(now() * 1000).toISOString();

	/**
	 * The pool embeds with the injected provider; the providerRef seam is
	 * the deployment's provisioning point — absent means no class can be
	 * trained on this hub yet (refuse closed, plain language).
	 */
	async function providerOf() {
		if (!providerRef) throw new RegistryError("Training needs a local exemplar embedder — none is provisioned on this hub yet.");
		return providerRef();
	}

	/** Tracking scope DERIVES: the examples' source built-in class ∈ tracked ⇒ tracked. */
	function scopeOf(sourceLabel) {
		return typeof sourceLabel === "string" && tracked.includes(sourceLabel) ? "tracked" : "detection-only";
	}

	/** Doc → REST view. Descriptors NEVER ride a view (they stay local). */
	function toView(doc) {
		return {
			_id: doc._id,
			homeId: doc.homeId,
			label: doc.label,
			exemplars: (doc.exemplars ?? []).map(({ image, origin, at }) => ({ image: image ?? null, origin, at })),
			exemplarCount: Array.isArray(doc.exemplars) ? doc.exemplars.length : 0,
			assertThreshold: isFinite(doc.assertThreshold) ? doc.assertThreshold : null,
			trackingScope: doc.trackingScope === "tracked" ? "tracked" : "detection-only",
			trackingSource: typeof doc.trackingSource === "string" ? doc.trackingSource : null,
			expectedAccuracy: {
				note: ACCURACY_NOTE,
				hitRate: doc.heldReplay ? doc.heldReplay.hitRate : null,
				exemplars: Array.isArray(doc.exemplars) ? doc.exemplars.length : 0,
			},
			heldReplay: doc.heldReplay ?? null,
			createdAt: doc.createdAt,
			updatedAt: doc.updatedAt,
		};
	}

	async function classDocsOf(homeId) {
		const rows = await classes.find({ homeId });
		return /** @type {Array<import("./types.js").WatchlistClass>} */ (rows ?? []);
	}

	/** Train rows from uploaded frames: embed on-device, one exemplar per vector. */
	async function exemplarRowsOf(frames) {
		const provider = await providerOf();
		const list = Array.isArray(frames) ? frames : [];
		if (list.length === 0) throw new RegistryError("Training needs at least one example image.");
		if (list.length > EXEMPLARS_CAP) {
			throw new RegistryError(`Keep the example pool bounded — up to ${EXEMPLARS_CAP} images per class.`);
		}
		const rows = [];
		for (const raw of list) {
			const frame = assertFrame(raw);
			for (const descriptor of await embedFrame(provider, frame)) {
				rows.push({ descriptor, image: imageDataUrl(frame), origin: "train", at: iso() });
			}
		}
		return rows;
	}

	/**
	 * TRAIN (ac-1): name + uploaded examples → the class trains on-device,
	 * joins the detection vocabulary (the plane serves it through
	 * vocabulary()), and the derived tracking-scope flags ride the
	 * registration.
	 * @param {{ homeId: string, label: unknown, frames: unknown[], trackingSource?: string | null, actorDid?: string | null }} req
	 * @returns {Promise<{ view: object, expectedAccuracy: object, heldReplay: object | null }>}
	 */
	async function createClass(req) {
		const meta = assertWatchlistBody(req);
		requireHomeId(meta.homeId);
		const label = assertClassLabel(req.label);
		const siblings = await classDocsOf(meta.homeId);
		if (siblings.some((c) => String(c.label).toLowerCase() === label.toLowerCase())) {
			throw new RegistryError(`This household already teaches the class "${label}".`, { status: 409, code: "E_CONFLICT" });
		}
		const exemplars = await exemplarRowsOf(req.frames);
		const ts = iso();
		const doc = /** @type {import("./types.js").WatchlistClass} */ ({
			_id: `${WATCHLIST_ID_PREFIX}${randomUUID().slice(0, 12)}`,
			homeId: meta.homeId,
			label,
			exemplars,
			assertThreshold: null,
			trackingScope: scopeOf(meta.trackingSource),
			trackingSource: meta.trackingSource,
			heldReplay: leaveOneOut({ exemplars, label }, siblings, ts),
			createdAt: ts,
			updatedAt: ts,
		});
		await classes.insertOne(doc);
		audit?.record({
			type: WATCHLIST_AUDIT_TYPES.TRAIN,
			actorIdentityRef: actor(req.actorDid),
			homeId: meta.homeId,
			detail: { classId: doc._id, label, exemplars: exemplars.length, trackingScope: doc.trackingScope, source: meta.trackingSource },
		});
		return { view: toView(doc), expectedAccuracy: toView(doc).expectedAccuracy, heldReplay: doc.heldReplay };
	}

	/**
	 * RETRAIN (ac-4): added examples REPLACE the artifact set in one write
	 * (the exemplar pool is the classifier); the held-replay hit rate is
	 * measured before and after and returned — the improvement is evidenced
	 * here and rides the audit trail.
	 * @param {{ homeId: string, classId: string, frames?: unknown[], replay?: Array<{ descriptor: number[], expect: string }>, actorDid?: string | null }} req
	 */
	async function retrain(req) {
		requireHomeId(req.homeId);
		const doc = await classes.findOne({ _id: req.classId, homeId: req.homeId });
		if (!doc) throw new RegistryError("No such trained class.", { status: 404, code: "E_NOT_FOUND" });
		const beforeDoc = /** @type {import("./types.js").WatchlistClass} */ (doc);
		const siblings = await classDocsOf(req.homeId);
		const replay = Array.isArray(req.replay) ? req.replay : [];
		const newRows = req.frames && req.frames.length > 0 ? await exemplarRowsOf(req.frames) : [];
		if (newRows.length === 0 && replay.length === 0) {
			throw new RegistryError("Retraining needs new example images (or a replay to evaluate).");
		}
		if (newRows.length + beforeDoc.exemplars.length > EXEMPLARS_CAP) {
			throw new RegistryError(`Keep the example pool bounded — up to ${EXEMPLARS_CAP} images per class.`);
		}
		const updated = {
			...beforeDoc,
			exemplars: [...beforeDoc.exemplars, ...newRows],
			updatedAt: iso(),
		};
		const nextClassDocs = siblings.map((c) => (c._id === req.classId ? updated : c));
		// The improvement measure of record: a provided held replay is
		// evaluated against the old pool, then the new one. Without a replay
		// the honest leave-one-out over the (replaced) pool refreshes.
		const before = replay.length > 0
			? evaluateReplay(replay, siblings, iso())
			: beforeDoc.heldReplay ?? null;
		const after = replay.length > 0
			? evaluateReplay(replay, nextClassDocs, iso())
			: leaveOneOut(updated, nextClassDocs, iso());
		updated.heldReplay = after;
		await classes.updateOne({ _id: req.classId, homeId: req.homeId }, {
			$set: {
				exemplars: updated.exemplars,
				heldReplay: updated.heldReplay,
				updatedAt: updated.updatedAt,
			},
		});
		audit?.record({
			type: WATCHLIST_AUDIT_TYPES.RETRAIN,
			actorIdentityRef: actor(req.actorDid),
			homeId: req.homeId,
			detail: {
				classId: req.classId,
				label: beforeDoc.label,
				addedExamples: newRows.length,
				exemplars: updated.exemplars.length,
				heldReplayBefore: before ? before.hitRate : null,
				heldReplayAfter: after ? after.hitRate : null,
			},
		});
		return { view: toView(updated), heldReplay: { before, after } };
	}

	/**
	 * CLASSIFY (ac-2): the per-frame similarity classification of a
	 * bus-borne crop descriptor against every trained class of the home.
	 * The decision rides the shared uncertainty law with the PER-CLASS
	 * calibrated threshold; uncalibrated never asserts. Asserted
	 * classifications are marked for emission — one asserted detection per
	 * track per cooldown window (the family pipeline's own dedup does the
	 * rest; the bus is never flooded).
	 * @param {{ homeId: string, descriptor?: number[], cameraId?: string, trackId?: string, eventId?: string, t?: number }} req
	 * @returns {Promise<{ decision: "asserted" | "looks-like", label: string, classId: string, confidence: number, similarity: number, shouldEmit: boolean } | null>}
	 */
	async function classify(req) {
		requireHomeId(req.homeId);
		if (!Array.isArray(req.descriptor) || req.descriptor.length === 0) return null;
		const docs = await classDocsOf(req.homeId);
		if (docs.length === 0) return null;
		const gallery = [];
		for (const cls of docs) {
			for (const exemplar of cls.exemplars ?? []) {
				gallery.push({ entryId: cls._id, descriptor: exemplar.descriptor });
			}
		}
		if (gallery.length === 0) return null;
		const best = bestMatch(req.descriptor, gallery);
		if (!best.entryId) return null;
		const cls = docs.find((c) => c._id === best.entryId);
		if (!cls) return null;
		const { decision, confidence } = decide(best.similarity, { assertThreshold: isFinite(cls.assertThreshold) ? cls.assertThreshold : null });
		if (decision === "unknown") return null;
		const at = typeof req.t === "number" && Number.isFinite(req.t) ? req.t : now();
		let shouldEmit = false;
		if (decision === "asserted") {
			const horizon = at - EMISSION_COOLDOWN_SEC;
			const recent = /** @type {Array<{ emitted?: boolean, trackId?: string, atEpoch?: number }>} */ (
				await detections.find({ classId: cls._id, emitted: true }));
			const within = (recent ?? []).filter((r) =>
				Number(r.atEpoch ?? 0) >= horizon
				&& (req.trackId === undefined || r.trackId === undefined || r.trackId === req.trackId));
			shouldEmit = within.length === 0;
		}
		const row = {
			_id: `${WATCHLIST_DETECTION_ID_PREFIX}${randomUUID().slice(0, 12)}`,
			homeId: req.homeId,
			classId: cls._id,
			label: cls.label,
			decision,
			confidence,
			similarity: best.similarity,
			descriptor: req.descriptor,
			emitted: shouldEmit,
			atEpoch: at,
			at: new Date(at * 1000).toISOString(),
			...(req.cameraId !== undefined ? { cameraId: req.cameraId } : {}),
			...(req.trackId !== undefined ? { trackId: req.trackId } : {}),
			...(req.eventId !== undefined ? { eventId: req.eventId } : {}),
		};
		await detections.insertOne(row);
		await trimRing(cls._id);
		return { decision, label: cls.label, classId: cls._id, confidence, similarity: best.similarity, shouldEmit };
	}

	/** Cap the per-class ring (oldest falls off — the store stays a store). */
	async function trimRing(classId) {
		const rows = /** @type {Array<{ _id: string, atEpoch?: number }>} */ (await detections.find({ classId }) ?? []);
		if (rows.length <= DETECTION_RING_CAP) return;
		const victims = rows.sort((a, b) => Number(b.atEpoch ?? 0) - Number(a.atEpoch ?? 0)).slice(DETECTION_RING_CAP);
		for (const victim of victims) {
			await detections.deleteOne({ _id: victim._id });
		}
	}

	/**
	 * CORRECTION (ac-3): the flag control feeds the flagged detection's crop
	 * descriptor into the exemplar pool for retraining. Either an explicit
	 * { classId, descriptor } or the flagged event's camera/track — the ring
	 * supplies the descriptor of record.
	 * @param {{ homeId: string, classId?: string, descriptor?: number[], eventId?: string, cameraId?: string, trackId?: string, actorDid?: string | null }} req
	 */
	async function correct(req) {
		requireHomeId(req.homeId);
		let classId = typeof req.classId === "string" ? req.classId : null;
		let descriptor = Array.isArray(req.descriptor) ? assertExemplarDescriptor(req.descriptor) : null;
		if (!descriptor) {
			const query = {
				homeId: req.homeId,
				...(classId ? { classId } : {}),
				...(req.eventId !== undefined ? { eventId: req.eventId } : {}),
				...(req.cameraId !== undefined ? { cameraId: req.cameraId } : {}),
				...(req.trackId !== undefined ? { trackId: req.trackId } : {}),
			};
			const rows = /** @type {Array<{ classId: string, descriptor: number[], atEpoch?: number }>} */ (
				await detections.find(query) ?? []);
			const hit = rows.sort((a, b) => Number(b.atEpoch ?? 0) - Number(a.atEpoch ?? 0))[0];
			if (!hit) {
				throw new RegistryError("No recorded detection to feed back — flag the event where the classifier ran, or pass the crop descriptor.", { status: 404, code: "E_NOT_FOUND" });
			}
			classId = hit.classId;
			descriptor = hit.descriptor;
		}
		if (!classId) throw new RegistryError("A correction names the trained class it feeds.");
		const doc = await classes.findOne({ _id: classId, homeId: req.homeId });
		if (!doc) throw new RegistryError("No such trained class.", { status: 404, code: "E_NOT_FOUND" });
		const beforeDoc = /** @type {import("./types.js").WatchlistClass} */ (doc);
		if (beforeDoc.exemplars.length >= EXEMPLARS_CAP) {
			throw new RegistryError(`Keep the example pool bounded — up to ${EXEMPLARS_CAP} images per class.`);
		}
		const updated = {
			...beforeDoc,
			exemplars: [...beforeDoc.exemplars, { descriptor, image: null, origin: "correction", at: iso() }],
			updatedAt: iso(),
		};
		const siblings = await classDocsOf(req.homeId);
		updated.heldReplay = leaveOneOut(updated, siblings, iso());
		await classes.updateOne({ _id: classId, homeId: req.homeId }, {
			$set: {
				exemplars: updated.exemplars,
				heldReplay: updated.heldReplay,
				updatedAt: updated.updatedAt,
			},
		});
		audit?.record({
			type: WATCHLIST_AUDIT_TYPES.CORRECTION,
			actorIdentityRef: actor(req.actorDid),
			homeId: req.homeId,
			detail: { classId, label: beforeDoc.label, exemplars: updated.exemplars.length },
		});
		return { view: toView(updated), correction: { exemplars: updated.exemplars.length } };
	}

	/**
	 * The per-class calibration of record (TS 3: thresholds calibrated on
	 * real footage within the shared "looks like" discipline) — audited.
	 * @param {{ homeId: string, classId: string, assertThreshold: number | null, actorDid?: string | null }} req
	 */
	async function setClassThreshold(req) {
		requireHomeId(req.homeId);
		if (req.assertThreshold !== null && (!isFinite(req.assertThreshold) || req.assertThreshold < 0 || req.assertThreshold > 1)) {
			throw new RegistryError("The calibrated threshold is a number in [0, 1] or null (uncalibrated).");
		}
		const doc = await classes.findOne({ _id: req.classId, homeId: req.homeId });
		if (!doc) throw new RegistryError("No such trained class.", { status: 404, code: "E_NOT_FOUND" });
		const before = isFinite(doc.assertThreshold) ? doc.assertThreshold : null;
		await classes.updateOne({ _id: req.classId, homeId: req.homeId }, {
			$set: { assertThreshold: req.assertThreshold, updatedAt: iso() },
		});
		audit?.record({
			type: WATCHLIST_AUDIT_TYPES.THRESHOLD,
			actorIdentityRef: actor(req.actorDid),
			homeId: req.homeId,
			detail: { classId: req.classId, label: doc.label, from: before, to: req.assertThreshold },
		});
		return getClass(req.homeId, req.classId);
	}

	/** One class, view form. */
	async function getClass(homeId, classId) {
		requireHomeId(homeId);
		const doc = await classes.findOne({ _id: classId, homeId });
		if (!doc) throw new RegistryError("No such trained class.", { status: 404, code: "E_NOT_FOUND" });
		return toView(doc);
	}

	async function listClasses(homeId) {
		requireHomeId(homeId);
		const docs = await classDocsOf(homeId);
		return docs
			.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
			.map((doc) => toView(doc));
	}

	/**
	 * DELETE (ac-5): the label leaves the vocabulary (it derives from this
	 * store), the exemplar artifacts and the recorded detection rows purge
	 * with counts, and nothing dangles — the family events keep their
	 * factual content because they never referenced the class.
	 * @param {{ homeId: string, classId: string, actorDid?: string | null }} req
	 */
	async function deleteClass(req) {
		requireHomeId(req.homeId);
		const doc = await classes.findOne({ _id: req.classId, homeId: req.homeId });
		if (!doc) throw new RegistryError("No such trained class.", { status: 404, code: "E_NOT_FOUND" });
		const exemplars = Array.isArray(doc.exemplars) ? doc.exemplars.length : 0;
		await classes.deleteOne({ _id: req.classId, homeId: req.homeId });
		const purgedRows = await detections.deleteMany({ classId: req.classId });
		audit?.record({
			type: WATCHLIST_AUDIT_TYPES.PURGE,
			actorIdentityRef: actor(req.actorDid),
			homeId: req.homeId,
			detail: { classId: req.classId, label: doc.label, exemplars, detections: purgedRows.deletedCount },
		});
		return { purged: { classId: req.classId, exemplars, detections: purgedRows.deletedCount } };
	}

	/**
	 * The recorded trained-class detections (bounded page, newest first) —
	 * the detections' class annotations the surfaces render; descriptors
	 * never ride the view.
	 * @param {{ homeId: string, classId?: string, decision?: string, limit?: number }} req
	 */
	async function listDetections(req) {
		requireHomeId(req.homeId);
		const limit = Math.min(Math.max(Math.floor(Number(req.limit) || 25), 1), 100);
		const rows = /** @type {Array<Record<string, unknown>>} */ (await detections.find({
			homeId: req.homeId,
			...(req.classId !== undefined ? { classId: req.classId } : {}),
			...(req.decision !== undefined ? { decision: req.decision } : {}),
		}) ?? []);
		return rows
			.sort((a, b) => Number(b.atEpoch ?? 0) - Number(a.atEpoch ?? 0))
			.slice(0, limit)
			.map((row) => {
				const { _id, classId, label, decision, confidence, cameraId, trackId, eventId, emitted, at } = row;
				return {
					_id, classId, label, decision, confidence,
					...(cameraId !== undefined ? { cameraId } : {}),
					...(trackId !== undefined ? { trackId } : {}),
					...(eventId !== undefined ? { eventId } : {}),
					emitted: emitted === true,
					at,
				};
			});
	}

	/**
	 * The open detection vocabulary of record (two-layer law): built-in
	 * tracked classes + the household's trained classes with their DERIVED
	 * tracking-scope flags.
	 * @param {string} homeId
	 */
	async function vocabulary(homeId) {
		requireHomeId(homeId);
		const docs = await classDocsOf(homeId);
		return {
			builtIn: tracked.map((label) => ({ label, kind: "built-in", trackingScope: "tracked" })),
			trained: docs
				.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
				.map((doc) => ({
					label: doc.label,
					kind: "trained",
					trackingScope: doc.trackingScope === "tracked" ? "tracked" : "detection-only",
					assertThreshold: isFinite(doc.assertThreshold) ? doc.assertThreshold : null,
					classId: doc._id,
				})),
		};
	}

	/**
	 * The derived tracked-scope trained labels (the hub feeds these to
	 * Overwatch's scope law — the only writer of that extension).
	 * @param {string} [homeId]
	 * @returns {Promise<string[]>}
	 */
	async function trackedTrainedLabels(homeId) {
		const docs = homeId ? await classDocsOf(homeId) : /** @type {Array<import("./types.js").WatchlistClass>} */ (await classes.find({}) ?? []);
		const labels = (docs ?? [])
			.filter((doc) => doc.trackingScope === "tracked")
			.map((doc) => doc.label);
		return [...new Set(labels)];
	}

	return {
		createClass, retrain, classify, correct, setClassThreshold,
		getClass, listClasses, deleteClass, listDetections,
		vocabulary, trackedTrainedLabels,
	};
}
