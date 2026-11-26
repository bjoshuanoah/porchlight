// paths.js — segment store layout helpers (PORCH-127).
//
// Layout of record: <root>/<YYYY-MM-DD>/<HH>/<camera>/<HHMMSS>[.part]
// All timestamps are UTC: the recorder spawns ffmpeg with TZ=UTC so the
// strftime names are UTC, matching the Frigate-layout deployment evidence
// the Overwatch harness consumes (hours in UTC).

import fsDefault from "node:fs";
import path from "node:path";

export const PART_SUFFIX = ".part";
export const FINAL_SUFFIX = ".mp4";
/** One UTC day in milliseconds — the layout's smallest folder granularity. */
export const DAY_MS = 86_400_000;

const pad2 = (n) => String(n).padStart(2, "0");

/** @param {number} tsMs epoch millis @returns {string} "YYYY-MM-DD" (UTC) */
export function dateDirName(tsMs) {
	const d = new Date(tsMs);
	return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** @param {number} tsMs epoch millis @returns {string} "HH" (UTC) */
export function hourDirName(tsMs) {
	return pad2(new Date(tsMs).getUTCHours());
}

/** Segment file base name (no suffix) for a start time: "HHMMSS". */
export function segmentBaseName(tsMs) {
	const d = new Date(tsMs);
	return `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;
}

/** Absolute directory for a segment starting at tsMs: <root>/<date>/<hour>/<camera>. */
export function segmentDir(root, camera, tsMs) {
	return path.join(root, dateDirName(tsMs), hourDirName(tsMs), camera);
}

/** Absolute in-progress file path for a segment starting at tsMs. */
export function partPath(root, camera, tsMs) {
	return path.join(segmentDir(root, camera, tsMs), `${segmentBaseName(tsMs)}${PART_SUFFIX}`);
}

/**
 * Parse a relative segment path ("<date>/<hour>/<camera>/<HHMMSS>[.part]") into
 * camera + UTC start epoch millis, or null when the path is not a segment.
 * @param {string} relPath
 * @returns {{camera: string, dateKey: string, hour: string, base: string, tsMs: number, part: boolean}|null}
 */
export function parseSegmentRelPath(relPath) {
	const parts = relPath.split(path.sep);
	if (parts.length !== 4) return null;
	const [dateKey, hour, camera, file] = parts;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !/^\d{2}$/.test(hour)) return null;
	let base = file;
	let part = false;
	if (base.endsWith(PART_SUFFIX)) {
		part = true;
		base = base.slice(0, -PART_SUFFIX.length);
	} else if (base.endsWith(FINAL_SUFFIX)) {
		base = base.slice(0, -FINAL_SUFFIX.length);
	} else {
		return null;
	}
	if (!/^\d{6}$/.test(base) || !camera) return null;
	const [y, mo, d] = dateKey.split("-").map(Number);
	// base is HHMMSS; the HH duplicates the hour dir — minute/second slots follow it.
	const tsMs = Date.UTC(
		y,
		mo - 1,
		d,
		hour === "24" ? 0 : Number(hour),
		Number(base.slice(2, 4)),
		Number(base.slice(4, 6)),
	);
	return { camera, dateKey, hour, base, tsMs, part };
}

/**
 * Walk a store and return every segment file (final and in-progress) parsed
 * into records, sorted by start time.
 * @param {string} root
 * @param {{fs?: typeof import("node:fs")}} [opts]
 * @returns {{relPath: string, absPath: string, camera: string, tsMs: number, part: boolean, mtimeMs: number, size: number}[]}
 */
export function listSegments(root, opts = {}) {
	const fs = opts.fs ?? fsDefault;
	const out = [];
	if (!fs.existsSync(root)) return out;
	for (const dateKey of fs.readdirSync(root)) {
		const dateDir = path.join(root, dateKey);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !fs.statSync(dateDir).isDirectory()) continue;
		for (const hour of fs.readdirSync(dateDir)) {
			const hourDir = path.join(dateDir, hour);
			if (!/^\d{2}$/.test(hour) || !fs.statSync(hourDir).isDirectory()) continue;
			for (const camera of fs.readdirSync(hourDir)) {
				const cameraDir = path.join(hourDir, camera);
				if (!fs.statSync(cameraDir).isDirectory()) continue;
				for (const file of fs.readdirSync(cameraDir)) {
					const relPath = path.join(dateKey, hour, camera, file);
					const parsed = parseSegmentRelPath(relPath);
					if (!parsed) continue;
					const absPath = path.join(root, relPath);
					const st = fs.statSync(absPath);
					out.push({
						relPath,
						absPath,
						camera: parsed.camera,
						tsMs: parsed.tsMs,
						part: parsed.part,
						mtimeMs: st.mtimeMs,
						size: st.size,
					});
				}
			}
		}
	}
	return out.sort((a, b) => a.tsMs - b.tsMs || (a.part === b.part ? 0 : a.part ? -1 : 1));
}

/**
 * Day-start epoch of every date directory under root, oldest first.
 * @param {string} root
 * @param {{fs?: typeof import("node:fs")}} [opts]
 * @returns {{dateKey: string, dayStartMs: number}[]}
 */
export function listDateDirs(root, opts = {}) {
	const fs = opts.fs ?? fsDefault();
	if (!fs.existsSync(root)) return [];
	const out = [];
	for (const name of fs.readdirSync(root)) {
		const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(name);
		if (!m) continue;
		const dayStartMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
		if (fs.statSync(path.join(root, name)).isDirectory()) {
			out.push({ dateKey: name, dayStartMs });
		}
	}
	return out.sort((a, b) => a.dayStartMs - b.dayStartMs);
}

/**
 * Start-of-day epoch millis for a UTC date key "YYYY-MM-DD".
 * Kept exported so audit/retention windows stay on one clock.
 */
export function dayStart(dateKey) {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
	if (!m) throw new Error(`invalid date key: ${dateKey}`);
	return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
