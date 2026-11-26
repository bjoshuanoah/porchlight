// visits.js — visit grouping + the visit timeline with outage gaps
// (PORCH-140 ac-2, ac-5).
//
// A visit is the set of PropertyEntities whose timelines overlap within a
// query window (co-present entities share one visit). The timeline replays
// the group chronologically: one entry per sighting (a clip entry when the
// segment-index seam yields a path, a state entry otherwise), plus GAP
// entries where the visit's coverage expectation meets a known camera outage.
//
// The timeline NEVER fabricates content: a gap entry carries only the
// explanation { cameraId, from, to, reason: "camera-outage" } — no synthetic
// frames, no placeholder clip refs; sightings the provider has no clip for
// degrade to state entries, never invented paths.
//
// Gap semantics of record (two clauses, contract §B):
// 1. Silent EDGES of the visit — the head interval before the first sighting
//    and the tail interval after the last — produce a gap entry for any
//    overlapping outage on a camera the entity has a coverage expectation
//    for (zone-eligible cameras per the config store, or a camera the entity
//    was actually seen on). No length threshold: the coverage expectation is
//    already there.
// 2. Inter-sighting spans longer than `unexplainedGapSec` (default 30) that a
//    recorded outage overlaps produce a gap entry trimmed to the overlap;
//    shorter spans are ordinary handoff movement and get no entry.

import { createHash } from "node:crypto";
import { statesOf } from "./entity-state.js";

/** @typedef {import("./types.js").PropertyEntity} PropertyEntity */
/** @typedef {import("./types.js").EntityStateLabel} EntityStateLabel */
/** @typedef {import("./types.js").EntityLifecycleState} EntityLifecycleState */

/**
 * One clip reference from the segment index seam: media covering
 * [from, to] epoch seconds on `cameraId`.
 *
 * @typedef {object} ClipRef
 * @property {string} cameraId
 * @property {string} path
 * @property {number} from
 * @property {number} to
 */

/**
 * One chronological timeline entry. Clip entries carry media; state entries
 * carry only the observed span+label; gap entries carry only the explanation.
 *
 * @typedef {object} VisitTimelineEntry
 * @property {"clip"|"state"|"gap"} kind
 * @property {string} cameraId
 * @property {EntityStateLabel} [state]
 * @property {string} [path]
 * @property {number} from
 * @property {number} to
 * @property {"camera-outage"} [reason]
 */

/** Inter-sighting spans longer than this without content need an explanation. */
export const DEFAULT_UNEXPLAINED_GAP_SEC = 30;

/** Playback context (seconds) padded around an arrival, clamped to the visit. */
const ARRIVAL_PAD_SEC = 5;

/** @returns {number} epoch seconds on the host clock */
function defaultNow() {
	return Date.now() / 1000;
}

/**
 * @param {string} message
 * @param {string} code
 */
function errorWithCode(message, code) {
	const error = new Error(message);
	/** @type {any} */ (error).code = code;
	return error;
}

/**
 * Stable visit id: sha1 over the sorted entity ids and the visit window,
 * hex, first 12 characters. Same entity set + same window → same id;
 * a different window intentionally re-hashes.
 *
 * @param {string[]} entityIds @param {number} from @param {number} to
 */
export function visitIdFor(entityIds, from, to) {
	const hash = createHash("sha1");
	hash.update([...entityIds].sort().join("\n"));
	hash.update(`\n${from}\n${to}`);
	return `visit_${hash.digest("hex").slice(0, 12)}`;
}

/**
 * @param {PropertyEntity} chain
 * @returns {VisitTimelineEntry|null} matching clip or null (never a stub)
 */
function clipFor(clipsProvider, chain, sighting) {
	const clips = clipsProvider?.(chain) ?? [];
	return (
		clips.find(
			(clip) =>
				clip
				&& clip.cameraId === sighting.camera
				&& typeof clip.path === "string"
				&& clip.from <= sighting.t1
				&& clip.to >= sighting.t0,
		) ?? null
	);
}

/**
 * @param {Record<string, unknown>} outage
 * @returns {boolean} outage overlaps the [start, end] interval
 */
function overlaps(outage, start, end) {
	return (
		typeof outage?.cameraId === "string"
		&& typeof outage.from === "number"
		&& typeof outage.to === "number"
		&& outage.to > start
		&& outage.from < end
	);
}

/**
 * @param {PropertyEntity} chain
 * @param {{from: number, to: number}} window
 * @param {number} at
 * @param {string[]} eligibleCameraIds
 * @param {() => Array<Record<string, unknown>>} outagesProvider
 * @param {number} unexplainedGapSec
 * @returns {VisitTimelineEntry[]}
 */
function gapEntries(chain, window, at, eligibleCameraIds, outagesProvider, unexplainedGapSec) {
	const outages = outagesProvider?.() ?? [];
	const ordered = [...(chain.sightings ?? [])].sort((a, b) => a.t0 - b.t0);
	const seenCameras = new Set(ordered.map((sighting) => sighting.camera));
	// Coverage expectation: zone-eligible cameras, or one the entity was seen on.
	const expected = (outage) => eligibleCameraIds.includes(outage.cameraId) || seenCameras.has(outage.cameraId);
	/** @param {number} start @param {number} end */
	const covered = (start, end) => outages.filter((outage) => overlaps(outage, start, end));
	/** @type {VisitTimelineEntry[]} */
	const entries = [];
	/** @param {number} start @param {number} end */
	const add = (start, end) => {
		for (const outage of covered(start, end)) {
			entries.push({
				kind: "gap",
				cameraId: /** @type {{cameraId: string}} */ (outage).cameraId,
				from: Math.max(start, /** @type {{from: number}} */ (outage).from),
				to: Math.min(end, /** @type {{to: number}} */ (outage).to),
				reason: "camera-outage",
			});
		}
	};
	const first = ordered[0];
	if (first && window.from < first.t0 && covered(window.from, first.t0).some(expected)) {
		add(window.from, first.t0);
	}
	for (let i = 1; i < ordered.length; i++) {
		const gapFrom = ordered[i - 1].t1;
		const gapTo = ordered[i].t0;
		if (gapTo - gapFrom <= unexplainedGapSec) continue;
		if (covered(gapFrom, gapTo).length > 0) add(gapFrom, gapTo);
	}
	const last = ordered[ordered.length - 1];
	if (last && last.t1 < window.to && covered(last.t1, window.to).some(expected)) {
		add(last.t1, window.to);
	}
	return entries;
}

/**
 * @param {PropertyEntity} chain
 * @param {{from: number, to: number}} window
 * @param {number} at
 * @param {(chain: PropertyEntity) => ClipRef[]|undefined} clipsProvider
 * @returns {VisitTimelineEntry[]}
 */
function sightingEntries(chain, window, at, clipsProvider) {
	const { sightings } = statesOf(chain, { now: at });
	/** @type {VisitTimelineEntry[]} */
	const entries = [];
	for (const sighting of sightings) {
		const clampedFrom = Math.max(window.from, sighting.t0);
		const clampedTo = Math.min(window.to, sighting.t1);
		if (sighting.state === "arrival") {
			// Arrival clips pad playback context and clamp to the visit window.
			const from = Math.max(window.from, sighting.t0 - ARRIVAL_PAD_SEC);
			const to = Math.min(window.to, sighting.t1 + ARRIVAL_PAD_SEC);
			const clip = clipFor(clipsProvider, chain, sighting);
			if (clip) {
				entries.push({ kind: "clip", cameraId: sighting.camera, state: sighting.state, path: clip.path, from, to });
				continue;
			}
			entries.push({ kind: "state", cameraId: sighting.camera, state: sighting.state, from, to });
			continue;
		}
		// Movement, stationary and departure spans read the sighting itself
		// (departure is "last sighting"): no padding, clamped to the window.
		const clip = clipFor(clipsProvider, chain, sighting);
		if (clip) {
			entries.push({ kind: "clip", cameraId: sighting.camera, state: sighting.state, path: clip.path, from: clampedFrom, to: clampedTo });
			continue;
		}
		entries.push({ kind: "state", cameraId: sighting.camera, state: sighting.state, from: clampedFrom, to: clampedTo });
	}
	return entries;
}

/**
 * @param {PropertyEntity[]} chains
 * @param {{from: number, to: number}} window
 * @param {number} at
 * @param {object} seams
 * @param {(chain: PropertyEntity) => ClipRef[]|undefined} seams.clipsProvider
 * @param {() => Array<Record<string, unknown>>} seams.outagesProvider
 * @param {() => string[]} seams.eligibleCameraIds
 * @param {number} seams.unexplainedGapSec
 */
function buildTimeline(chains, window, at, { clipsProvider, outagesProvider, eligibleCameraIds, unexplainedGapSec }) {
	/** @type {VisitTimelineEntry[]} */
	const entries = [];
	for (const chain of chains) {
		entries.push(...sightingEntries(chain, window, at, clipsProvider));
		entries.push(...gapEntries(chain, window, at, eligibleCameraIds(), outagesProvider, unexplainedGapSec));
	}
	// Visit-level view: identical gap rows contributed by co-present entities
	// describe the same hole — dedupe them.
	const seen = new Set();
	const deduped = entries.filter((entry) => {
		const key = `${entry.kind}|${entry.cameraId}|${entry.from}|${entry.to}|${entry.reason ?? entry.state ?? entry.path ?? ""}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	const kindRank = { state: 0, clip: 1, gap: 2 };
	return deduped.sort(
		(a, b) =>
			(a.from - b.from)
			|| (a.to - b.to)
			|| (kindRank[a.kind] - kindRank[b.kind])
			|| (a.cameraId < b.cameraId ? -1 : a.cameraId > b.cameraId ? 1 : 0),
	);
}

/**
 * @param {{store?: {eligibleCameraIds?: () => string[]} | null, chainsProvider?: () => PropertyEntity[], clipsProvider?: (chain: PropertyEntity) => ClipRef[]|undefined, outagesProvider?: () => Array<{cameraId: string, from: number, to: number}>, unexplainedGapSec?: number}} [options]
 */
export function createVisitService({ store, chainsProvider, clipsProvider, outagesProvider = () => [], unexplainedGapSec = DEFAULT_UNEXPLAINED_GAP_SEC } = {}) {
	/** @type {Map<string, {entities: string[], window: {from: number, to: number}, chains: PropertyEntity[]}>} */
	const registry = new Map();
	const seams = {
		clipsProvider,
		outagesProvider,
		eligibleCameraIds: () => store?.eligibleCameraIds?.() ?? [],
		unexplainedGapSec,
	};

	/** @type {{listVisits(params: {from: number, to: number}): Array<{visitId: string, from: number, to: number, entities: string[], cameras: string[]}>, timeline(params: {visitId: string, at?: number}): VisitTimelineEntry[], openVisitSurface(params: {chain: PropertyEntity}): {visitId: string, entityId: string, from: number, to: number, timeline: VisitTimelineEntry[]}}} */
	const visitService = {
		/**
		 * Group the chains whose timelines overlap within [from, to] into
		 * visits. `visitId` is stable for the same entity set + window.
		 *
		 * @param {{from: number, to: number}} params
		 */
		listVisits({ from, to } = {}) {
			if (typeof from !== "number" || typeof to !== "number" || to < from) {
				throw errorWithCode("listVisits expects numeric `from` <= `to` epoch seconds", "E_BAD_WINDOW");
			}
			const active = (chainsProvider?.() ?? [])
				.filter((chain) => chain && typeof chain.entityId === "string" && chain.t1 >= from && chain.t0 <= to)
				.map((chain) => ({ chain, from: Math.max(chain.t0, from), to: Math.min(chain.t1, to) }));
			// Union-find over interval overlap (inclusive endpoints).
			const parent = active.map((_, i) => i);
			/** @param {number} x @returns {number} */
			const find = (x) => {
				while (parent[x] !== x) {
					parent[x] = parent[parent[x]];
					x = parent[x];
				}
				return x;
			};
			/** @param {number} a @param {number} b */
			const unify = (a, b) => {
				const ra = find(a);
				const rb = find(b);
				if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
			};
			for (let i = 0; i < active.length; i++) {
				for (let j = i + 1; j < active.length; j++) {
					if (active[i].from <= active[j].to && active[j].from <= active[i].to) unify(i, j);
				}
			}
			/** @type {Map<number, number[]>} */
			const groups = new Map();
			active.forEach((_, i) => {
				const root = find(i);
				const group = groups.get(root);
				if (group) group.push(i);
				else groups.set(root, [i]);
			});
			/** @type {Array<{visitId: string, from: number, to: number, entities: string[], cameras: string[]}>} */
			const visits = [];
			for (const indices of groups.values()) {
				const groupChains = indices.map((i) => active[i].chain);
				const entities = groupChains.map((chain) => chain.entityId).sort();
				const visitFrom = Math.min(...groupChains.map((chain) => chain.t0));
				const visitTo = Math.max(...groupChains.map((chain) => chain.t1));
				const cameras = [...new Set(groupChains.flatMap((chain) => (chain.sightings ?? []).map((sighting) => sighting.camera)))].sort();
				const visitId = visitIdFor(entities, from, to);
				registry.set(visitId, { entities, window: { from, to }, chains: groupChains });
				visits.push({ visitId, from: visitFrom, to: visitTo, entities, cameras });
			}
			visits.sort((a, b) => (a.from - b.from) || (a.visitId < b.visitId ? -1 : 1));
			return visits;
		},

		/**
		 * Chronological timeline of one registered visit. Entries are ordered;
		 * gap entries sit at their chronological position and never carry
		 * media. Unknown visitId throws E_NOT_FOUND.
		 *
		 * @param {{visitId: string, at?: number}} params
		 * @returns {VisitTimelineEntry[]}
		 */
		timeline({ visitId, at }) {
			const registered = registry.get(visitId);
			if (!registered) {
				throw errorWithCode(`Unknown visit ${visitId} — call listVisits first`, "E_NOT_FOUND");
			}
			return buildTimeline(registered.chains, registered.window, at ?? defaultNow(), seams);
		},

		/**
		 * Single-entity visit surface: timeline one chain over its own span.
		 * Registers the visit so timeline({visitId}) also resolves it.
		 *
		 * @param {{chain: PropertyEntity}} params
		 */
		openVisitSurface({ chain }) {
			if (!chain || typeof chain.entityId !== "string") {
				throw errorWithCode("openVisitSurface expects a PropertyEntity chain", "E_BAD_CHAIN");
			}
			const window = { from: chain.t0, to: chain.t1 };
			const entities = [chain.entityId];
			const visitId = visitIdFor(entities, window.from, window.to);
			registry.set(visitId, { entities, window, chains: [chain] });
			return {
				visitId,
				entityId: chain.entityId,
				from: window.from,
				to: window.to,
				timeline: buildTimeline([chain], window, defaultNow(), seams),
			};
		},
	};
	return visitService;
}
