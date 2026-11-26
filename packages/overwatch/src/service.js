// service.js — the spike entity service: consumes DetectedObject streams,
// emits merged PropertyEntity trajectories (PORCH-I-010 TS 1 entity chain).
//
// Tracks derive solely from the per-camera DetectedObject streams; the
// correlator never fabricates a track (annotations-never-tracks law). Weak
// association evidence keeps chains separate: below the join threshold an
// entering track opens its own entity.

import {
	DEFAULT_TRACK_IDLE_SEC,
	assertDetectedObject,
} from "./types.js";
import { correlate, travelPrior } from "./correlation.js";

/** Slack seconds beyond the travel prior a join window widens. */
const JOIN_SLACK_SEC = 2;

/**
 * @typedef {import("./types.js").DetectedObject} DetectedObject
 * @typedef {import("./types.js").CameraTrack} CameraTrack
 * @typedef {import("./types.js").CorrelationConfig} CorrelationConfig
 * @typedef {import("./types.js").PropertyEntity} PropertyEntity
 * @typedef {import("./types.js").EntitySighting} EntitySighting
 * @typedef {import("./types.js").ZoneHandoff} ZoneHandoff
 */

/**
 * @typedef {object} CrossJoin
 * @property {number} fromSeq  occurrence seq of the exiting camera track
 * @property {number} toSeq    occurrence seq of the entering camera track
 * @property {string} fromCamera
 * @property {string} toCamera
 * @property {number} score
 * @property {number} temporal
 * @property {number} spatial
 * @property {number} appearance
 */

/**
 * Incremental merge service. Feed every camera stream in per-camera time
 * order; the service interleaves cameras by timestamp on finalize. `add`
 * closes stale tracks (no samples for trackIdleSec) and correlates closing
 * tracks with adjacent cameras in both directions.
 */
export class EntityMergeService {
	/** @param {CorrelationConfig} config */
	constructor(config) {
		this.config = config;
		this.trackIdleSec = config.trackIdleSec ?? DEFAULT_TRACK_IDLE_SEC;
		/** @type {Map<string, Map<string, CameraTrack>>} camera -> trackId -> open track */
		this.open = new Map();
		/** @type {Map<number, CameraTrack>} occurrence seq -> track */
		this.tracks = new Map();
		/** @type {Map<number, number>} seq -> union-find parent */
		this.parent = new Map();
		/** exit seq -> entry seq; an exit joins at most once */
		this.joinedTo = new Map();
		/** entry seq -> handoff evidence; an entry joins at most once */
		this.handoffs = new Map();
		/** @type {CrossJoin[]} */
		this.joins = [];
		this.nextSeq = 0;
	}

	/**
	 * Feed one stream sample. Any cross-camera arrival order is accepted;
	 * per-camera order must be non-decreasing in t.
	 *
	 * @param {DetectedObject} obj
	 */
	add(obj) {
		assertDetectedObject(obj);
		this.sweep(obj.t);
		const byTrackId = this.open.get(obj.camera) ?? new Map();
		if (!this.open.has(obj.camera)) this.open.set(obj.camera, byTrackId);
		const existing = byTrackId.get(obj.trackId);
		if (existing) {
			existing.objects.push(obj);
			existing.t1 = Math.max(existing.t1, obj.t);
			return;
		}
		// A recycled trackId after the idle gap is a new track occurrence.
		/** @type {CameraTrack} */
		const track = {
			camera: obj.camera,
			trackId: obj.trackId,
			cls: obj.cls,
			seq: this.nextSeq++,
			t0: obj.t,
			t1: obj.t,
			objects: [obj],
			reid: obj.reid ? [...obj.reid] : undefined,
			closed: false,
		};
		this.parent.set(track.seq, track.seq);
		this.tracks.set(track.seq, track);
		byTrackId.set(obj.trackId, track);
		this.pairAsEntry(track);
	}

	/**
	 * Close every open track and emit the entity chains ordered by start time.
	 *
	 * @returns {{entities: PropertyEntity[], joins: CrossJoin[]}}
	 */
	finalize() {
		for (const byTrackId of [...this.open.values()]) {
			for (const track of [...byTrackId.values()]) this.closeTrack(track);
		}
		/** @type {Map<number, EntitySighting[]>} root seq -> sightings */
		const groups = new Map();
		for (const track of this.tracks.values()) {
			const root = this.find(track.seq);
			/** @type {EntitySighting} */
			const sighting = {
				camera: track.camera,
				trackId: track.trackId,
				t0: track.t0,
				t1: track.t1,
				sampleCount: track.objects.length,
				cls: track.cls,
			};
			const handoff = this.handoffs.get(track.seq);
			if (handoff) sighting.handoff = handoff;
			const group = groups.get(root);
			if (group) group.push(sighting);
			else groups.set(root, [sighting]);
		}
		/** @type {PropertyEntity[]} */
		const entities = [...groups.entries()].map(([root, sightings]) => {
			const ordered = [...sightings].sort((a, b) => a.t0 - b.t0);
			return {
				entityId: `pe_${root}`,
				cls: mode(ordered.map((s) => s.cls ?? "unknown")),
				t0: ordered[0].t0,
				t1: ordered.at(-1).t1,
				sightings: ordered,
			};
		});
		entities.sort((a, b) => a.t0 - b.t0);
		return { entities, joins: this.joins };
	}

	// --- internals ---

	/**
	 * Close open tracks idle longer than trackIdleSec at time `t`.
	 *
	 * @private @param {number} t
	 */
	sweep(t) {
		for (const byTrackId of this.open.values()) {
			for (const track of [...byTrackId.values()]) {
				if (t - track.t1 > this.trackIdleSec) this.closeTrack(track);
			}
		}
	}

	/**
	 * @private @param {CameraTrack} track
	 */
	closeTrack(track) {
		if (track.closed) return;
		this.open.get(track.camera)?.delete(track.trackId);
		track.closed = true;
		// The closing track may be an exit pairing with an already-open entry
		// in an adjacent camera (person visible in both views at once).
		this.pairAsExit(track);
	}

	/**
	 * Pair `entryTrack` (just opened, entry side) with recent exits in adjacent
	 * cameras: closed exits and still-open exits within the gap window.
	 *
	 * @private @param {CameraTrack} entryTrack
	 */
	pairAsEntry(entryTrack) {
		if (this.handoffs.has(entryTrack.seq)) return;
		for (const [a, b] of this.config.adjacency) {
			const other = a === entryTrack.camera ? b : b === entryTrack.camera ? a : null;
			if (!other) continue;
			const prior = travelPrior(this.config, other, entryTrack.camera);
			const candidates = [...this.tracks.values()].filter(
				(t) => t.camera === other && t.seq !== entryTrack.seq && !this.joinedTo.has(t.seq) && inWindow(entryTrack.t0 - this.currentEnd(t), prior),
			);
			this.joinBest(candidates, entryTrack);
		}
	}

	/**
	 * Pair `exitTrack` (just closed, exit side) with an open entry already
	 * running in an adjacent camera.
	 *
	 * @private @param {CameraTrack} exitTrack
	 */
	pairAsExit(exitTrack) {
		if (this.joinedTo.has(exitTrack.seq)) return;
		for (const [a, b] of this.config.adjacency) {
			const other = a === exitTrack.camera ? b : b === exitTrack.camera ? a : null;
			if (!other) continue;
			const prior = travelPrior(this.config, exitTrack.camera, other);
			const candidateEntries = [...(this.open.get(other)?.values() ?? [])].filter(
				(entryTrack) => !this.handoffs.has(entryTrack.seq) && inWindow(entryTrack.t0 - exitTrack.t1, prior),
			);
			for (const entryTrack of candidateEntries) this.joinBest([exitTrack], entryTrack);
		}
	}

	/**
	 * Greedy one-shot pairing between candidate exits and the entering track:
	 * best accepted score wins; below-threshold candidates stay separate.
	 *
	 * @private @param {CameraTrack[]} candidateExits @param {CameraTrack} entryTrack
	 */
	joinBest(candidateExits, entryTrack) {
		const accepted = candidateExits
			.map((exit) => ({ exit, result: correlate(this.config, exit, entryTrack) }))
			.filter((c) => c.result.rejected === undefined && c.result.score >= (this.config.joinThreshold ?? 0.5))
			.sort((a, b) => b.result.score - a.result.score);
		if (accepted.length === 0) return;
		const { exit, result } = accepted[0];
		this.union(exit.seq, entryTrack.seq);
		this.joinedTo.set(exit.seq, entryTrack.seq);
		/** @type {ZoneHandoff} */
		const handoff = {
			fromCamera: exit.camera,
			toCamera: entryTrack.camera,
			fromT: exit.t1,
			toT: entryTrack.t0,
			gapSec: Math.round((entryTrack.t0 - exit.objects.at(-1).t) * 1000) / 1000,
			score: result.score,
			exitObject: exit.objects.at(-1),
			entryObject: entryTrack.objects.at(0),
		};
		this.handoffs.set(entryTrack.seq, handoff);
		this.joins.push({
			fromSeq: exit.seq,
			toSeq: entryTrack.seq,
			fromCamera: exit.camera,
			toCamera: entryTrack.camera,
			score: result.score,
			temporal: result.temporal,
			spatial: result.spatial,
			appearance: result.appearance,
		});
	}

	/** @private @param {number} a @param {number} b */
	union(a, b) {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra === rb) return;
		if (ra < rb) this.parent.set(rb, ra);
		else this.parent.set(ra, rb);
	}

	/** @private @param {number} x @returns {number} */
	find(x) {
		let root = x;
		while (this.parent.get(root) !== root) root = /** @type {number} */ (this.parent.get(root));
		while (this.parent.get(x) !== x) {
			const next = /** @type {number} */ (this.parent.get(x));
			this.parent.set(x, root);
			x = next;
		}
		return root;
	}

	/** Last sample time of a closed or open track. @private */
	currentEnd(track) {
		return track.t1;
	}
}

/**
 * @param {number} gap
 * @param {{min: number, max: number}} prior
 */
function inWindow(gap, prior) {
	return gap >= prior.min - JOIN_SLACK_SEC && gap <= prior.max + JOIN_SLACK_SEC;
}

/**
 * @param {string[]} values
 */
function mode(values) {
	const counts = new Map();
	let best = values[0];
	let bestCount = 0;
	for (const v of values) {
		const c = (counts.get(v) ?? 0) + 1;
		counts.set(v, c);
		if (c > bestCount) {
			best = v;
			bestCount = c;
		}
	}
	return best;
}
