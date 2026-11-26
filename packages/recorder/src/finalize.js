// finalize.js — atomic segment finalization and crash recovery (PORCH-127).
//
// ffmpeg's segment muxer writes every segment as `<HHMMSS>.part`; the recorder
// renames it to the final `<HHMMSS>.mp4` once the muxer has moved on (a newer
// .part exists) or the process exited. Rename within one directory is atomic
// on the same volume, so a final filename is only ever visible for a complete
// file — finalize-on-crash corruption resistance. After a crash the orphan
// .part is probed: playable fragments are finalized (fMP4 + empty_moov keeps
// the written moof fragments readable); unrecoverable fragments are deleted,
// which turns them into missing coverage (a gap the audit reports) rather
// than a corrupt file a player would choke on — "zero unrecoverable corrupt
// files".

import fsDefault from "node:fs";
import { execFile } from "node:child_process";
import { FINAL_SUFFIX, PART_SUFFIX } from "./paths.js";

/**
 * Decide which in-progress segments are complete: every .part older (by start
 * time) than the newest one is final — the muxer has already opened a newer
 * segment. Pure: unit-tested without ffmpeg.
 * @param {{relPath: string, tsMs: number, part: boolean}[]} entries one camera, sorted
 * @returns {string[]} relPaths to finalize
 */
export function finalizePlan(entries) {
	let newest = null;
	for (const e of entries) if (e.part && (!newest || e.tsMs > newest.tsMs)) newest = e;
	const out = [];
	for (const e of entries) {
		if (e.part && newest && e !== newest && e.tsMs < newest.tsMs) out.push(e.relPath);
	}
	return out;
}

/** Final path for a .part path (same directory, same base name). */
export function finalPathOf(partAbsPath) {
	return partAbsPath.slice(0, -PART_SUFFIX.length) + FINAL_SUFFIX;
}

/**
 * Finalize a settled .part (muxer moved on) — atomic rename, sync.
 * @param {typeof fsDefault} fs
 * @param {string} partAbsPath
 */
export function finalizeSegment(fs, partAbsPath) {
	if (!partAbsPath.endsWith(PART_SUFFIX)) {
		throw new Error(`not a part file: ${partAbsPath}`);
	}
	fs.renameSync(partAbsPath, finalPathOf(partAbsPath));
}

/**
 * Probe one media file with ffprobe; resolves to {ok, durationSec}.
 * @param {string} ffprobePath
 * @param {string} file
 * @param {{execFile?: typeof execFile}} [opts]
 * @returns {Promise<{ok: boolean, durationSec: number|null, stderr?: string}>}
 */
export function probeDuration(ffprobePath, file, opts = {}) {
	const run = opts.execFile ?? execFile;
	return new Promise((resolve) => {
		run(
			ffprobePath,
			["-v", "error", "-show_entries", "format=duration", "-of", "json", file],
			{ timeout: 15000 },
			(err, stdout, stderr) => {
				if (err) {
					return resolve({ ok: false, durationSec: null, stderr: String(stderr ?? err.message) });
				}
				try {
					const dur = Number(JSON.parse(String(stdout)).format?.duration);
					resolve({ ok: Number.isFinite(dur) && dur > 0, durationSec: dur || null });
				} catch {
					resolve({ ok: false, durationSec: null, stderr: "unparseable ffprobe output" });
				}
			},
		);
	});
}

/**
 * Recover one orphan .part file after a crash. Playable → finalize (atomic
 * rename); unrecoverable → delete (it becomes an audit coverage gap, never a
 * corrupt file). When no ffprobe is available, finalize blindly.
 * @param {string|null} ffprobePath
 * @param {{absPath: string}} entry
 * @param {{fs?: typeof fsDefault, execFile?: typeof execFile}} [opts]
 * @returns {Promise<{action: "finalized"|"discarded", path: string}>}
 */
export async function recoverSegment(ffprobePath, entry, opts = {}) {
	const fs = opts.fs ?? fsDefault;
	const final = finalPathOf(entry.absPath);
	if (!ffprobePath) {
		fs.renameSync(entry.absPath, final);
		return { action: "finalized", path: final };
	}
	const { ok } = await probeDuration(ffprobePath, entry.absPath, opts);
	if (!ok) {
		fs.rmSync(entry.absPath, { force: true });
		return { action: "discarded", path: entry.absPath };
	}
	fs.renameSync(entry.absPath, final);
	return { action: "finalized", path: final };
}
