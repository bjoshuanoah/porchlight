// retention.js — rolling retention sweep + disk watchdog (PORCH-127).
//
// Rolling recording is the circular buffer: the window is adjustable, and
// when it closes the oldest day drops. Nothing inside the window is special.
// The disk-usage watchdog is the policy backstop: past the high-water mark
// it prunes the oldest kept days first and emits an alert state (never a
// silent stall).

import fsDefault from "node:fs";
import path from "node:path";
import { DAY_MS, dayStart, dateDirName, listDateDirs } from "./paths.js";

/** Kept day floor: with retentionDays=N, days >= today-(N-1) stay. */
export function keepFloorMs(nowMs, retentionDays) {
	return dayStart(dateDirName(nowMs)) - (retentionDays - 1) * DAY_MS;
}

/**
 * One pruning pass over the date directories. Cold archive moves before
 * deletes when coldRoot is configured.
 * @param {{
 *   root: string, retentionDays: number, nowMs: number,
 *   coldRoot?: string|null,
 *   fs?: typeof fsDefault,
 *   onEvent?: (e: {type: string, dates: string[]}) => void,
 * }} opts
 * @returns {{removed: string[], moved: string[], kept: number}}
 */
export function pruneRolling(opts) {
	const { root, retentionDays, nowMs, coldRoot = null, fs = fsDefault, onEvent } = opts;
	const floor = keepFloorMs(nowMs, retentionDays);
	const dirs = listDateDirs(root, { fs });
	/** @type {string[]} */
	const removed = [];
	/** @type {string[]} */
	const moved = [];
	for (const d of dirs) {
		if (d.dayStartMs >= floor) break;
		if (coldRoot) {
			try {
				moveDir(fs, path.join(root, d.dateKey), path.join(coldRoot, d.dateKey));
				moved.push(d.dateKey);
				continue;
			} catch {
				// fall through to delete — the rolling window cannot stall
			}
		}
		fs.rmSync(path.join(root, d.dateKey), { recursive: true, force: true });
		removed.push(d.dateKey);
	}
	if ((removed.length || moved.length) && onEvent) {
		onEvent({
			type: "retention.pruned",
			dates: [...moved, ...removed],
		});
	}
	return { removed, moved, kept: dirs.length - removed.length - moved.length };
}

/**
 * Event-tier pruning (two-class law, PRD 10): event footage lives in
 * <root>/events — a separate retention class with its own window, never
 * the rolling buffer. Rules refine the class floor within it: a rule's
 * keepDays is the minimum the matching footage stays (the max matching
 * rule wins). Protected manual segments (<root>/manual) are NEVER touched
 * by any sweep — they outlive everything but manual deletion (ac-3); the
 * disk watchdog only ever prunes rolling days for the same reason.
 * @param {{
 *   root: string, eventRetentionDays: number, nowMs: number,
 *   retentionRules?: Array<{cameraId?: string, eventClass?: string, zoneId?: string, keepDays: number}>,
 *   fs?: typeof fsDefault,
 *   onEvent?: (e: {type: string, dates: string[]}) => void,
 * }} opts
 * @returns {{removed: string[]}}
 */
export function pruneEventTier(opts) {
	const { root, eventRetentionDays, nowMs, retentionRules = [], fs = fsDefault, onEvent } = opts;
	const eventsRoot = path.join(root, "events");
	/** @type {string[]} */
	const removed = [];
	for (const d of listDateDirs(eventsRoot, { fs })) {
		if (d.dayStartMs > nowMs) continue;
		const dateDir = path.join(eventsRoot, d.dateKey);
		for (const hour of fs.readdirSync(dateDir)) {
			const hourDir = path.join(dateDir, hour);
			if (!/^\d{2}$/.test(hour) || !fs.statSync(hourDir).isDirectory()) continue;
			for (const camera of fs.readdirSync(hourDir)) {
				const cameraDir = path.join(hourDir, camera);
				if (!fs.statSync(cameraDir).isDirectory()) continue;
				const floorDays = Math.max(
					eventRetentionDays,
					...retentionRules
						.filter((rule) => !rule.cameraId || rule.cameraId === camera)
						.map((rule) => rule.keepDays),
				);
				if (d.dayStartMs <= nowMs - floorDays * DAY_MS) {
					fs.rmSync(cameraDir, { recursive: true, force: true });
					if (!removed.includes(d.dateKey)) removed.push(d.dateKey);
				}
			}
			// Best-effort empty-dir cleanup so the tree reads honestly.
			try {
				if (fs.readdirSync(hourDir).length === 0) fs.rmdirSync(hourDir);
			} catch { /* raced with a writer — next pass cleans it */ }
		}
		try {
			if (fs.readdirSync(dateDir).length === 0) fs.rmdirSync(dateDir);
		} catch { /* same */ }
	}
	if (removed.length && onEvent) onEvent({ type: "retention.events.pruned", dates: removed });
	return { removed };
}

/**
 * Disk-usage watchdog: while used fraction exceeds highWaterFraction, prune
 * the oldest kept day directory. Alerts once when it engages.
 * @param {{
 *   root: string,
 *   highWaterFraction: number,
 *   fs?: typeof fsDefault,
 *   onEvent?: (e: {type: string, detail?: string, dates?: string[]}) => void,
 * }} opts
 * @returns {{usedFraction: number|null, pruned: string[], alerted: boolean}|null}
 *   null when the filesystem usage is not observable on this host.
 */
export function retentionWatchdog(opts) {
	const { root, highWaterFraction, fs = fsDefault, onEvent } = opts;
	const usage = diskUsage(fs, root);
	if (!usage) return null;
	/** @type {string[]} */
	const pruned = [];
	let alerted = false;
	while (usage.usedFraction > highWaterFraction) {
		const dirs = listDateDirs(root, { fs }).filter((d) => fs.statSync(path.join(root, d.dateKey)).isDirectory());
		if (dirs.length === 0) {
			if (onEvent) {
				onEvent({ type: "storage.critical", detail: "disk high-water reached with no prunable day left" });
			}
			break;
		}
		const oldest = dirs[0];
		fs.rmSync(path.join(root, oldest.dateKey), { recursive: true, force: true });
		pruned.push(oldest.dateKey);
		const next = diskUsage(fs, root);
		if (!next) break;
		usage.usedFraction = next.usedFraction;
		if (!alerted) {
			alerted = true;
			onEvent?.({
				type: "storage.high-water",
				detail: `usedFraction ${next.usedFraction.toFixed(3)} > ${highWaterFraction}`,
			});
		}
	}
	return { usedFraction: usage.usedFraction, pruned, alerted };
}

/**
 * Usage fraction of the filesystem holding root, or null when unobservable.
 * @param {typeof fsDefault} fs
 * @param {string} root
 * @returns {{usedFraction: number}|null}
 */
export function diskUsage(fs, root) {
	const statfs = /** @type {any} */ (fs).statfsSync;
	if (typeof statfs !== "function") return null;
	try {
		const s = statfs(root);
		const total = Number(s.blocks);
		const free = Number(s.bfree);
		if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0) return null;
		return { usedFraction: (total - free) / total };
	} catch {
		return null;
	}
}

/** Move a directory tree, tolerating EXDEV/merge targets (copy-then-delete). */
function moveDir(fs, from, to) {
	try {
		fs.renameSync(from, to);
		return;
	} catch (err) {
		if (/** @type {any} */ (err).code !== "EXDEV" && /** @type {any} */ (err).code !== "ENOTEMPTY" && /** @type {any} */ (err).code !== "EEXIST") {
			throw err;
		}
	}
	fs.mkdirSync(path.dirname(to), { recursive: true });
	fs.cpSync(from, to, { recursive: true });
	fs.rmSync(from, { recursive: true, force: true });
}
