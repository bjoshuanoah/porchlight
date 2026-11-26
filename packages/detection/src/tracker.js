// tracker.js — ByteTrack-style per-camera tracker (PORCH-128).
//
// Validates detections into tracked objects with stable per-camera track ids
// (PORCH-I-009 TS 3: "Tracking: ByteTrack-style FSM validation over
// detections"). Two-stage association by IoU — high-confidence detections
// first, then low-confidence ones — with a tentative → confirmed → lost →
// deleted lifecycle: a track publishes only once it is confirmed (minHits
// frames), so noise never fabricates bus events.

import { assertRawDetection } from "./types.js";

/** @typedef {import("./types.js").RawDetection} RawDetection */
/** @typedef {import("./types.js").DetectedObject} DetectedObject */

/** @typedef {[number, number, number, number]} BBox */

/** @param {BBox} a */
function bboxArea(a) {
	return Math.max(0, a[2]) * Math.max(0, a[3]);
}

/**
 * IoU of two normalized [x, y, w, h] boxes.
 * @param {BBox} a @param {BBox} b @returns {number}
 */
export function iou(a, b) {
	const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
	const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
	const inter = ix * iy;
	if (inter <= 0) return 0;
	return inter / (bboxArea(a) + bboxArea(b) - inter);
}

/**
 * Greedy IoU association: score pairs [i, j, iou] (i → track index, j → det
 * index) sorted best-first, each track and detection claimed at most once.
 * @template T @param {{bbox: BBox}[]} tracks @param {{bbox: BBox}[]} dets @param {number} threshold
 * @returns {[number, number, number][]}
 */
export function associate(tracks, dets, threshold) {
	/** @type {[number, number, number][]} */
	const pairs = [];
	for (const [i, t] of tracks.entries()) {
		for (const [j, d] of dets.entries()) {
			const s = iou(t.bbox, d.bbox);
			if (s >= threshold) pairs.push([i, j, s]);
		}
	}
	pairs.sort((x, y) => y[2] - x[2]);
	const iUsed = new Set();
	const jUsed = new Set();
	/** @type {[number, number, number][]} */
	const chosen = [];
	for (const [i, j, s] of pairs) {
		if (iUsed.has(i) || jUsed.has(j)) continue;
		iUsed.add(i);
		jUsed.add(j);
		chosen.push([i, j, s]);
	}
	return chosen;
}

/**
 * @typedef {object} InternalTrack
 * @property {string} id
 * @property {BBox} bbox
 * @property {number} vx @property {number} vy
 * @property {number} lastT
 * @property {number} hits
 * @property {"tentative"|"confirmed"|"lost"} state
 * @property {string} cls
 * @property {number} conf
 * @property {number[]|undefined} reid
 * @property {boolean} matched
 */

export class DetectionTracker {
	/**
	 * @param {{
	 *   highConf?: number,
	 *   iouThreshold?: number,
	 *   minHits?: number,
	 *   maxAgeSec?: number,
	 *   nextId?: () => string,
	 * }} [opts]
	 */
	constructor(opts = {}) {
		this.highConf = opts.highConf ?? 0.5;
		this.iouThreshold = opts.iouThreshold ?? 0.2;
		this.minHits = opts.minHits ?? 3;
		this.maxAgeSec = opts.maxAgeSec ?? 2;
		this.nextId = opts.nextId ?? (() => `t-${String(++DetectionTracker.#counter)}`);
		/** @type {InternalTrack[]} */
		this.tracks = [];
	}

	static #counter = 0;

	/**
	 * Update with one frame's raw detections; returns the tracked objects to
	 * publish (confirmed tracks matched on this frame). `t` is the frame's
	 * epoch seconds.
	 *
	 * @param {RawDetection[]} dets
	 * @param {number} t
	 * @returns {DetectedObject[]}
	 */
	update(dets, t) {
		for (const d of dets) assertRawDetection(d);
		const high = dets.filter((d) => d.conf >= this.highConf);
		const low = dets.filter((d) => d.conf < this.highConf && d.conf >= 0.05);

		// Constant-velocity prediction to the frame time.
		for (const track of this.tracks) {
			const dt = Math.max(0, t - track.lastT);
			track.bbox = [clip01(track.bbox[0] + track.vx * dt), clip01(track.bbox[1] + track.vy * dt), track.bbox[2], track.bbox[3]];
			track.matched = false;
		}

		// Stage 1: high-confidence detections against all tracks.
		const m1 = associate(this.tracks, high, this.iouThreshold);
		for (const [ti, di] of m1) applyMatch(this.tracks[ti], high[di], t);
		// Stage 2: remaining tracks vs low-confidence detections (ByteTrack
		// second-chance rule — low-conf dets may join a track, never open one).
		const stage2Tracks = this.tracks.filter((tr) => !tr.matched);
		const m2 = associate(stage2Tracks, low, this.iouThreshold * 1.5);
		for (const [si, di] of m2) applyMatch(stage2Tracks[si], low[di], t);

		// New tracks from unmatched high-confidence detections only.
		const claimedHigh = new Set(m1.map((m) => m[1]));
		for (const [di, d] of high.entries()) {
			if (claimedHigh.has(di)) continue;
			this.tracks.push(/** @type {InternalTrack} */ ({
				id: this.nextId(),
				bbox: [...d.bbox],
				vx: 0,
				vy: 0,
				lastT: t,
				hits: 1,
				state: "tentative",
				cls: d.cls,
				conf: d.conf,
				reid: d.reid,
				matched: true,
			}));
		}

		// Lifecycle + emission.
		/** @type {DetectedObject[]} */
		const out = [];
		/** @type {InternalTrack[]} */
		const survivors = [];
		for (const track of this.tracks) {
			if (track.state === "tentative" && track.hits >= this.minHits) track.state = "confirmed";
			else if (track.state === "confirmed" && !track.matched) track.state = "lost";
			else if (track.state === "lost" && track.matched) track.state = "confirmed";
			const expired = t - track.lastT > this.maxAgeSec;
			if (track.state === "confirmed" && track.matched && !expired) {
				out.push(/** @type {DetectedObject} */ ({
					trackId: track.id,
					cls: track.cls,
					conf: track.conf,
					bbox: [...track.bbox],
					t,
					...(track.reid ? { reid: track.reid } : {}),
				}));
			}
			if (!expired) survivors.push(track);
		}
		this.tracks = survivors;
		return out;
	}
}

/**
 * @param {InternalTrack} track
 * @param {RawDetection} d
 * @param {number} t
 */
function applyMatch(track, d, t) {
	const dt = Math.max(0, t - track.lastT);
	const [pcx, pcy] = [track.bbox[0] + track.bbox[2] / 2, track.bbox[1] + track.bbox[3] / 2];
	const [dcx, dcy] = [d.bbox[0] + d.bbox[2] / 2, d.bbox[1] + d.bbox[3] / 2];
	if (dt > 0) {
		// EMA velocity from observed center movement.
		track.vx = track.vx * 0.5 + ((dcx - pcx) / dt) * 0.5;
		track.vy = track.vy * 0.5 + ((dcy - pcy) / dt) * 0.5;
	}
	track.bbox = [...d.bbox];
	track.lastT = t;
	track.hits += 1;
	track.matched = true;
	track.conf = d.conf;
	track.cls = d.cls;
	if (d.reid) track.reid = d.reid;
}

/** @param {number} x */
function clip01(x) {
	return Math.min(1, Math.max(0, x));
}
