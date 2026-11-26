// audit.js — gap audit over the segment store (PORCH-127).
//
// Coverage model: segment N spans from its start (filename, UTC) to segment
// N+1's start — the muxer opens the next segment the moment the previous
// ends. A GAP therefore exists exactly when two consecutive segment starts
// are further apart than one segment's maximum length
// (segmentSeconds + toleranceSeconds): intermediate segments went missing
// (crash without recovery, dead disk, killed daemon with no restart).
// Window edges (since/until) produce the same test at the boundaries.
//
// In-progress (.part) files are counted separately — during a live run
// exactly one per camera should exist; after a crash recovery none should.

import fsDefault from "node:fs";
import { listSegments } from "./paths.js";
import { probeDuration } from "./finalize.js";

/**
 * @param {{
 *   root: string,
 *   cameras: string[],
 *   segmentSeconds: number,
 *   toleranceSeconds?: number,   // keyframe/JPEG-bound slack; default segmentSeconds
 *   sinceMs?: number, untilMs?: number,
 *   fs?: typeof fsDefault,
 * }} opts
 */
export function auditStorage(opts) {
	const {
		root,
		cameras,
		segmentSeconds,
		toleranceSeconds = segmentSeconds,
		sinceMs = null,
		untilMs = null,
		fs = fsDefault,
	} = opts;
	const maxLenMs = (segmentSeconds + toleranceSeconds) * 1000;
	const entries = listSegments(root, { fs });
	/** @type {unknown[]} */
	const perCamera = [];
	let totals = { segments: 0, inProgress: 0, gaps: 0 };
	for (const camera of cameras) {
		const mine = entries.filter((e) => e.camera === camera);
		const finals = mine.filter((e) => !e.part);
		if (sinceMs != null) {
			while (finals.length && finals[0].tsMs < sinceMs) finals.shift();
		}
		// window-trim finals (keep parts intact for reporting)
		const windowFinals = sinceMs != null || untilMs != null
			? finals.filter((e) => (sinceMs == null || e.tsMs >= sinceMs) && (untilMs == null || e.tsMs <= untilMs))
			: finals;
		/** @type {{from: number, to: number, ms: number}[]} */
		const gaps = [];
		if (windowFinals.length === 0) {
			if (sinceMs != null && untilMs != null) {
				gaps.push({ from: sinceMs, to: untilMs, ms: untilMs - sinceMs });
			}
		} else {
			if (sinceMs != null && windowFinals[0].tsMs - sinceMs > maxLenMs) {
				gaps.push({ from: sinceMs, to: windowFinals[0].tsMs, ms: windowFinals[0].tsMs - sinceMs });
			}
			for (let i = 1; i < windowFinals.length; i++) {
				const d = windowFinals[i].tsMs - windowFinals[i - 1].tsMs;
				if (d > maxLenMs) {
					gaps.push({
						from: windowFinals[i - 1].tsMs + segmentSeconds * 1000,
						to: windowFinals[i].tsMs,
						ms: d - segmentSeconds * 1000,
					});
				}
			}
			if (untilMs != null && untilMs - windowFinals[windowFinals.length - 1].tsMs > maxLenMs) {
				gaps.push({
					from: windowFinals[windowFinals.length - 1].tsMs + segmentSeconds * 1000,
					to: untilMs,
					ms: untilMs - windowFinals[windowFinals.length - 1].tsMs - segmentSeconds * 1000,
				});
			}
		}
		const inProgress = mine.filter((e) => e.part
			&& (sinceMs == null || e.tsMs >= sinceMs)
			&& (untilMs == null || e.tsMs <= untilMs)).length;
		totals = {
			segments: totals.segments + windowFinals.length,
			inProgress: totals.inProgress + inProgress,
			gaps: totals.gaps + gaps.length,
		};
		perCamera.push({
			camera,
			segments: windowFinals.length,
			inProgress,
			coverageStart: windowFinals[0]?.tsMs ?? null,
			coverageEnd: windowFinals.length
				? windowFinals[windowFinals.length - 1].tsMs + segmentSeconds * 1000
				: null,
			gaps,
		});
	}
	return {
		window: { since: sinceMs, until: untilMs },
		maxLenMs,
		cameras: perCamera,
		totals,
		ok: totals.gaps === 0,
	};
}

/**
 * ffprobe every final segment in a window; anything unreadable, empty, or
 * with an impossible (overlong) duration counts as corrupt. Playable but
 * short fragments (a bounded run's trailing segment, a recovered crash
 * left-over) are coverage tails the gap audit measures — not corrupt files.
 * Run this AFTER a crash recovery pass — orphaned .part files have already
 * been finalized or discarded at that point.
 * @param {{
 *   root: string, cameras: string[], ffprobePath: string,
 *   segmentSeconds: number, sinceMs?: number, untilMs?: number,
 *   maxFraction?: number,
 *   fs?: typeof fsDefault,
 *   execFile?: typeof import("node:child_process").execFile,
 * }} opts
 * @returns {Promise<{checked: number, corrupt: {file: string, reason: string, durationSec: number|null}[], ok: boolean}>}
 */
export async function probeCorrupt(opts) {
	const {
		root,
		cameras,
		ffprobePath,
		segmentSeconds,
		sinceMs = null,
		untilMs = null,
		maxFraction = 2,
		fs = fsDefault,
		execFile,
	} = opts;
	const entries = listSegments(root, { fs }).filter((e) => {
		if (e.part || !cameras.includes(e.camera)) return false;
		if (sinceMs != null && e.tsMs < sinceMs) return false;
		if (untilMs != null && e.tsMs > untilMs) return false;
		return true;
	});
	/** @type {{file: string, reason: string, durationSec: number|null}[]} */
	const corrupt = [];
	let checked = 0;
	for (const e of entries) {
		checked += 1;
		const res = await probeFiles(ffprobePath, e.absPath, execFile);
		if (!res.ok) {
			corrupt.push({
				file: e.relPath,
				reason: res.reason ?? "ffprobe failed",
				durationSec: res.durationSec,
			});
			continue;
		}
		const ms = (res.durationSec ?? 0) * 1000;
		if (ms > segmentSeconds * maxFraction * 1000) {
			corrupt.push({
				file: e.relPath,
				reason: `implausible duration ${res.durationSec}s`,
				durationSec: res.durationSec,
			});
		}
	}
	return { checked, corrupt, ok: corrupt.length === 0 };
}

async function probeFiles(ffprobePath, file, execFile) {
	const res = await probeDuration(ffprobePath, file, { execFile });
	if (!res.ok) {
		return { ok: false, durationSec: null, reason: res.stderr ?? "unreadable" };
	}
	return { ok: true, durationSec: res.durationSec };
}
