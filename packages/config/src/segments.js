// segments.js — the recorded-media index of record (PORCH-130).
//
// The timeline plane answers "what is recorded": days/hours holding settled
// segments, the segment list for one hour, the segment covering one instant,
// the window listing the hub's HttpEngineAdapter consumes, and the open() of
// a settled segment file for byte-range serving.
//
// Layout of record is the recorder's (packages/recorder/src/paths.js):
// <root>/<YYYY-MM-DD>/<HH>/<camera>/<HHMMSS>[.part], UTC — listSegments and
// parseSegmentRelPath are the listing/parse of record, never a second
// convention. The storage root is read from the config of record
// (<root>/config/config.yaml `storageRoot`) with the root itself as the
// fallback when the config is absent/unreadable (resolveRecorderBase
// precedent); `storageRootOverride` is the test injection.
//
// All times crossing this boundary are epoch SECONDS, UTC.

import fsDefault from "node:fs";
import pathDefault from "node:path";
import { parse as parseYaml } from "yaml";
import { dayStart, listSegments, parseSegmentRelPath } from "@porchlight/recorder";
import { configYamlPathFor } from "./storage.js";
import { ID_RE, NotFoundError, ValidationError, assertId } from "./types.js";

/** Final (settled) suffix from the recorder's layout of record (paths.js). */
const FINAL_SUFFIX = ".mp4";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_RE = /^\d{2}$/;
const BASE_RE = /^\d{6}$/;

/** Console-surface media path prefix (GET /api/media/...). */
export const CONSOLE_MEDIA_PREFIX = "/api/media";
/** Engine-seam media path prefix (GET /media/...; the hub's openMedia rides it). */
export const SEAM_MEDIA_PREFIX = "/media";

/**
 * The storage root of record for a Porchlight root: `storageRoot` from
 * <root>/config/config.yaml, falling back to the root itself when the config
 * of record is absent or unreadable (never a construction crash).
 */
export function storageRootOfRecord(root, opts = {}) {
	const fs = opts.fs ?? fsDefault;
	try {
		const cfg = parseYaml(fs.readFileSync(configYamlPathFor(root), "utf8"));
		if (typeof cfg?.storageRoot === "string" && cfg.storageRoot.trim() !== "") return cfg.storageRoot;
	} catch {
		// No config of record (fresh root, pre-setup boot) — the root itself
		// is the store of record until setup answers the storage question.
	}
	return root;
}

/**
 * The recorder's own span budget from the config of record: open-tail spans
 * (the last settled segment with no successor yet) close at start +
 * segmentSeconds — the recorder's own naming budget (`cfg.segmentSeconds`,
 * recorder validateConfig default 600), never zero, because a zero-length
 * span renders "nothing recorded" for footage that demonstrably exists.
 */
export function segmentSecondsOfRecord(root, opts = {}) {
	const fs = opts.fs ?? fsDefault;
	try {
		const cfg = parseYaml(fs.readFileSync(configYamlPathFor(root), "utf8"));
		if (Number.isInteger(cfg?.segmentSeconds) && cfg.segmentSeconds >= 1) return cfg.segmentSeconds;
	} catch {
		// fresh root, pre-setup boot — recorder default.
	}
	return 600;
}

/**
 * @param {{
 *   root: string,
 *   fs?: typeof import("node:fs"),
 *   now?: () => Date,
 *   storageRootOverride?: string | null,
 *   cameras?: { get(id: string): unknown } | null,
 * }} opts
 *   root — Porchlight root dir. fs/now — injectables (tests).
 *   storageRootOverride — test injection for the storage root of record.
 *   cameras — the camera registry part; its get() resolves the camera ids of
 *   record (unknown-camera discipline).
 */
export function createSegmentIndex(opts = {}) {
	const root = opts.root;
	const fs = opts.fs ?? fsDefault;
	const now = opts.now ?? (() => new Date());
	const cameras = opts.cameras ?? null;
	const storageRoot = () =>
		opts.storageRootOverride ?? storageRootOfRecord(root, { fs });
	const tailSeconds = () => segmentSecondsOfRecord(root, { fs });

	/** Camera ids the registry of record knows (no registry ⇒ disk decides). */
	function knownCamera(cameraId) {
		if (!cameras) return true;
		try {
			return cameras.get(cameraId) !== null && cameras.get(cameraId) !== undefined;
		} catch {
			return false;
		}
	}

	function assertCamera(cameraId) {
		assertId(cameraId, "camera id");
		if (!knownCamera(cameraId)) throw new NotFoundError(`unknown camera "${cameraId}"`);
	}

	/**
	 * One ordered walk of the store of record: the camera's settled segment
	 * spans with ref + relative components. Span model of record: end = the
	 * next segment's start in the camera's ordered listing, but ONLY when the
	 * two starts sit within the recorder's gap-audit allowance
	 * (segmentSeconds + tolerance = 2× segmentSeconds, packages/recorder/src/
	 * audit.js) — a farther jump is a recording gap, and the span closes at
	 * start + segmentSeconds instead of claiming coverage it doesn't have.
	 * A tail with no successor closes the same way, capped at the current
	 * time. `.part` files are never listed.
	 */
	function spansOfRecord(cameraId) {
		const rows = listSegments(storageRoot(), { fs });
		const budget = tailSeconds() * 2;
		const nowSec = Math.floor(now().getTime() / 1000);
		const settled = [];
		for (const row of rows) {
			if (row.camera !== cameraId) continue;
			const parsed = parseSegmentRelPath(row.relPath);
			if (!parsed || parsed.part) continue;
			settled.push({
				camera: cameraId,
				date: parsed.dateKey,
				hour: parsed.hour,
				base: parsed.base,
				start: Math.floor(parsed.tsMs / 1000),
			});
		}
		// listSegments orders by start; build spans over that order in place.
		return settled.map((row, i) => {
			const next = settled[i + 1] ?? null;
			let end;
			if (next && next.start - row.start <= budget) {
				end = next.start;
			} else {
				// No successor within the gap allowance: the span closes at the
				// recorder's own segment budget, capped at the current time.
				end = Math.min(row.start + tailSeconds(), nowSec);
			}
			return {
				...row,
				end,
				ref: `seg:${row.camera}/${row.date}/${row.hour}/${row.base}`,
			};
		});
	}

	const mediaPath = (prefix, row) => `${prefix}/${row.camera}/${row.date}/${row.hour}/${row.base}`;

	/** Real calendar date in the UTC sense: "2026-02-30" is refused, not rolled. */
	function assertDate(dateKey) {
		if (typeof dateKey !== "string" || !DATE_RE.test(dateKey)) {
			throw new ValidationError("date must be a UTC date (YYYY-MM-DD)");
		}
		const [y, m, d] = dateKey.split("-").map(Number);
		const round = new Date(Date.UTC(y, m - 1, d));
		if (round.getUTCFullYear() !== y || round.getUTCMonth() !== m - 1 || round.getUTCDate() !== d) {
			throw new ValidationError(`date must be a real calendar date ("${dateKey}" isn't one)`);
		}
	}

	function assertHour(hour) {
		if (typeof hour !== "string" || !HOUR_RE.test(hour) || Number(hour) > 23) {
			throw new ValidationError("hour must be a UTC hour " + '"00"-"23"');
		}
	}

	/**
	 * UTC days holding at least one settled segment for the camera, each with
	 * its hours (00–23, UTC) — days/date keys sorted ascending.
	 */
	function days(cameraId) {
		assertCamera(cameraId);
		const hoursByDate = new Map();
		for (const row of spansOfRecord(cameraId)) {
			if (!HOUR_RE.test(row.hour) || Number(row.hour) > 23) continue;
			const hours = hoursByDate.get(row.date) ?? new Set();
			hours.add(row.hour);
			hoursByDate.set(row.date, hours);
		}
		const daysList = [...hoursByDate.keys()].sort().map((date) => ({
			date,
			hours: [...hoursByDate.get(date)].sort(),
		}));
		return { days: daysList };
	}

	/** The camera's settled segments for one UTC day+hour, ordered by start. */
	function hour(cameraId, date, hourValue) {
		assertCamera(cameraId);
		assertDate(date);
		assertHour(hourValue);
		const windowStartSec = dayStart(date) / 1000 + Number(hourValue) * 3600;
		const segments = spansOfRecord(cameraId)
			.filter((row) => row.start >= windowStartSec && row.start < windowStartSec + 3600)
			.map((row) => ({ start: row.start, end: row.end, ref: row.ref, path: mediaPath(CONSOLE_MEDIA_PREFIX, row) }));
		return { cameraId, date, hour: hourValue, segments };
	}

	/**
	 * The settled segment covering an instant: `{ ref, path, start, end,
	 * kind: "segment" }`, else the plain `{ gap: "unavailable" }` 200 shape
	 * (the hub adapter's gap contract; an unknown camera answers the gap, not
	 * a 404). Coverage is strict interval math against the span of record —
	 * an open tail closes at the recorder's own segment budget so recorded
	 * hours never render empty. `opts.mediaPrefix` repoints the media path for
	 * the engine seams (`/media/...`); the console default rides `/api/media/...`.
	 */
	function at(cameraId, atSec, opts = {}) {
		const second = requireAtSecond(atSec);
		if (!knownCamera(cameraId)) return { gap: "unavailable" };
		const hit = coverage(cameraId, second);
		if (!hit) return { gap: "unavailable" };
		return {
			ref: hit.ref,
			path: mediaPath(opts.mediaPrefix ?? CONSOLE_MEDIA_PREFIX, hit),
			start: hit.start,
			end: hit.end,
			kind: "segment",
		};
	}

	/**
	 * Evidence of record at an instant (v0): the recording clip itself.
	 * Same coverage as at(); the media path rides the engine-seam prefix the
	 * hub's openMedia resolves against its engine base URL.
	 */
	function evidence(cameraId, atSec) {
		const second = requireAtSecond(atSec);
		if (!knownCamera(cameraId)) return { gap: "unavailable" };
		const hit = coverage(cameraId, second);
		if (!hit) return { gap: "unavailable" };
		return { kind: "clip", ref: hit.ref, path: mediaPath(SEAM_MEDIA_PREFIX, hit) };
	}

	function requireAtSecond(atSec) {
		if (typeof atSec !== "number" || !Number.isFinite(atSec)) {
			throw new ValidationError("at must be an epoch-seconds timestamp");
		}
		return Math.floor(atSec);
	}

	/** The camera's settled span covering `second`, or null (strict interval). */
	function coverage(cameraId, second) {
		let hit = null;
		for (const row of spansOfRecord(cameraId)) {
			if (row.start <= second) hit = row;
			else break;
		}
		if (!hit || second >= hit.end) return null;
		return hit;
	}

	/**
	 * Segments overlapping [from, to] (epoch seconds, UTC) — the ordered
	 * listing is taken once and filtered. Bounded spans overlap half-open
	 * ([start, end) ∩ [from, to)); an open tail counts by its full budgeted
	 * span, so a live tail still renders in the window it started in.
	 * Unknown camera ⇒ NotFoundError; from/to must be epoch seconds.
	 */
	function listWindow(cameraId, from, to) {
		assertCamera(cameraId);
		requireEpochSeconds(from, "from");
		requireEpochSeconds(to, "to");
		const fromSec = Math.floor(from);
		const toSec = Math.floor(to);
		const segments = spansOfRecord(cameraId)
			.filter((row) => {
				if (row.end > row.start) return row.start < toSec && row.end > fromSec;
				return row.start >= fromSec && row.start <= toSec;
			})
			.map((row) => ({ start: row.start, end: row.end, ref: row.ref, path: mediaPath(SEAM_MEDIA_PREFIX, row) }));
		return segments;
	}

	/**
	 * Resolve a settled segment FILE for serving: strict component discipline
	 * (camera id per types.js ID_RE, date/hour/base literal grammar), the
	 * resolved path must land inside the storage root, and the file must
	 * exist as a settled segment. `.part` files and anything outside
	 * [0-9]{6} are refused — every refusal is NotFoundError in plain
	 * language, never a path join of unvalidated input.
	 */
	function open(cameraId, date, hourValue, base) {
		const settled = typeof cameraId === "string" && ID_RE.test(cameraId)
			&& typeof date === "string" && DATE_RE.test(date) && isRealDate(date)
			&& typeof hourValue === "string" && HOUR_RE.test(hourValue) && Number(hourValue) <= 23
			&& typeof base === "string" && BASE_RE.test(base);
		if (!settled) throw new NotFoundError("segment file not found");
		const storeRoot = pathDefault.resolve(storageRoot());
		const absPath = pathDefault.resolve(storeRoot, date, hourValue, cameraId, `${base}${FINAL_SUFFIX}`);
		if (!absPath.startsWith(storeRoot + pathDefault.sep)) throw new NotFoundError("segment file not found");
		let stat = null;
		try {
			stat = fs.statSync(absPath);
		} catch {
			stat = null;
		}
		if (!stat || !stat.isFile()) throw new NotFoundError("segment file not found");
		return { absPath, size: stat.size, type: "video/mp4" };
	}

	/** Calendar round-trip without throwing (the open() refusal path). */
	function isRealDate(dateKey) {
		const [y, m, d] = dateKey.split("-").map(Number);
		const round = new Date(Date.UTC(y, m - 1, d));
		return round.getUTCFullYear() === y && round.getUTCMonth() === m - 1 && round.getUTCDate() === d;
	}

	function requireEpochSeconds(value, label) {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw new ValidationError(`${label}: must be an epoch-seconds timestamp (UTC)`);
		}
	}

	return { days, hour, at, evidence, listWindow, open };
}
