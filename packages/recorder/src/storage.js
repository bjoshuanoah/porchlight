// storage.js — the storage backend plane (PORCH-136).
//
// Storage is asked, never assumed (PRD 10 / TS 10): the setup flow asks for
// the primary location and, optionally, the failover location, and validates
// each answer with a create/read/write/delete write test. The backend state
// is explicit — primary | degraded-write (failover) | unavailable — and every
// transition lands as a plain-language event the status surfaces render.
// Failback is always manual: no surprise volume flips.

import fsDefault from "node:fs";
import path from "node:path";
import { diskUsage } from "./retention.js";
import { listSegments } from "./paths.js";

/** Backend states, in the explicit order the status surface renders them. */
export const STORAGE_STATES = Object.freeze(["primary", "degraded-write", "unavailable"]);

const PROBE_NAME = ".porchlight-write-test";

/** Plain-language reasons per write-test step (never a raw errno alone). */
const STEP_COPY = {
	create: "could not create the directory",
	write: "could not write a test file",
	read: "could not read back the test file — the drive may be failing",
	delete: "could not delete the test file",
};

/**
 * Plain-language explanation for one errno at one write-test step. The
 * wording names the reason (permissions, missing volume, full disk, I/O
 * error) as TS 10 requires — problematic access is never a silent stall.
 * @param {string} code
 * @param {string} step
 */
export function writeTestReason(code, step) {
	const base = STEP_COPY[step] ?? "storage location test failed";
	if (code === "EACCES" || code === "EPERM") return `${base} — permission denied`;
	if (code === "ENOENT") return `${base} — the parent path does not exist`;
	if (code === "ENOSPC") return `${base} — no space left on the storage location`;
	if (code === "EROFS") return `${base} — the storage location is read-only`;
	if (code === "EIO") return `${base} — the drive reported an I/O error`;
	if (code === "EBUSY") return `${base} — the device is busy`;
	if (code === "EXDEV") return `${base} — cross-device link error`;
	return `${base} (${code})`;
}

/**
 * The write test of record: create the location, write a probe file,
 * read it back, and delete it — the exact create/read/write/delete chain
 * the setup question validates (ac-1). Injectable fs keeps fault injection
 * deterministic.
 * @param {string} location
 * @param {{fs?: typeof fsDefault, now?: () => number}} [opts]
 * @returns {{ok: boolean, location: string, reason?: string, step?: string}}
 */
export function writeTest(location, opts = {}) {
	const fs = opts.fs ?? fsDefault;
	const probe = path.join(location, `${PROBE_NAME}-${process.pid}-${(opts.now ?? Date.now)()}`);
	try {
		fs.mkdirSync(location, { recursive: true });
	} catch (err) {
		return { ok: false, location, step: "create", reason: writeTestReason(/** @type {any} */ (err).code ?? "ERROR", "create") };
	}
	try {
		fs.writeFileSync(probe, Buffer.from("porchlight storage write test\n"), "utf8");
	} catch (err) {
		return { ok: false, location, step: "write", reason: writeTestReason(/** @type {any} */ (err).code ?? "ERROR", "write") };
	}
	try {
		const back = fs.readFileSync(probe, "utf8");
		if (back !== "porchlight storage write test\n") {
			return { ok: false, location, step: "read", reason: `${STEP_COPY.read} — the content did not match` };
		}
	} catch (err) {
		return { ok: false, location, step: "read", reason: writeTestReason(/** @type {any} */ (err).code ?? "ERROR", "read") };
	}
	try {
		fs.unlinkSync(probe);
	} catch (err) {
		return { ok: false, location, step: "delete", reason: writeTestReason(/** @type {any} */ (err).code ?? "ERROR", "delete") };
	}
	return { ok: true, location };
}

/**
 * Check the OS-exposed health signals of the filesystem holding root:
 * a write probe plus the statfs view. A failing statfs is the OS telling
 * us the device is in trouble even before a write fails (ac-5).
 * @param {string} root
 * @param {{fs?: typeof fsDefault}} [opts]
 * @returns {{healthy: boolean, signal: "write-failure"|"statfs-failure"|"ok", reason?: string}}
 */
export function driveHealth(root, opts = {}) {
	const fs = opts.fs ?? fsDefault;
	try {
		fs.statfsSync(root);
	} catch (err) {
		return { healthy: false, signal: "statfs-failure", reason: writeTestReason(/** @type {any} */ (err).code ?? "ERROR", "read") };
	}
	const probe = writeTest(root, { fs });
	if (!probe.ok) return { healthy: false, signal: "write-failure", reason: probe.reason ?? "write test failed" };
	return { healthy: true, signal: "ok" };
}

/**
 * Tier usage of one storage root: rolling, events, and manual segment
 * counts with their byte sizes plus the disk-usage fraction.
 * @param {string} root
 * @param {{fs?: typeof fsDefault}} [opts]
 */
export function tierUsage(root, opts = {}) {
	const fs = opts.fs ?? fsDefault;
	const usage = diskUsage(fs, root);
	const tiers = { rolling: { segments: 0, bytes: 0 }, events: { segments: 0, bytes: 0 }, manual: { segments: 0, bytes: 0 } };
	for (const tier of Object.keys(tiers)) {
		const tierRoot = tier === "rolling" ? root : path.join(root, tier);
		for (const seg of listSegments(tierRoot, { fs })) {
			tiers[tier].segments += 1;
			tiers[tier].bytes += seg.size;
		}
	}
	return { tiers, diskUsedFraction: usage?.usedFraction ?? null };
}

/**
 * The failover state machine (TS 10; semantics marked [Assumed] in the
 * directive are treated as confirmed for this build, per the status field
 * of record in update notes):
 *   - a write failure on the active location is reported via
 *     reportWriteFailure(); with a healthy failover configured, new writes
 *     switch there and the state becomes "degraded-write";
 *   - with no writable failover the state becomes "unavailable" and
 *     recording pauses — the state is named, never silent;
 *   - failback to the primary is ALWAYS manual (failback()).
 * @typedef {(e: {type: string, at: number, detail?: string}) => void} StorageEventHandler
 */
export class StorageBackend {
	/**
	 * @param {{
	 *   primary: string,
	 *   failover?: string | null,
	 *   fs?: typeof fsDefault,
	 *   now?: () => number,
	 *   onEvent?: StorageEventHandler,
	 * }} opts
	 */
	constructor(opts) {
		this.primary = opts.primary;
		this.failover = opts.failover ?? null;
		this.fs = opts.fs ?? fsDefault;
		this.now = opts.now ?? Date.now;
		/** @type {StorageEventHandler} */
		this.onEvent = opts.onEvent ?? (() => {});
		this.state = /** @type {"primary"|"degraded-write"|"unavailable"} */ ("primary");
		this.reason = null;
		this.driveHealthy = true;
		this.driveSignal = "ok";
		this.driveReason = null;
		this.switchedAt = null;
		/** Last fault report time — keeps repeated write failures from spamming events. */
		this.lastFaultAt = 0;
	}

	/** @returns {string | null} the location new writes target, null when paused. */
	activeLocation() {
		if (this.state === "unavailable") return null;
		if (this.state === "degraded-write") return this.failover;
		return this.primary;
	}

	/** Run the create/read/write/delete write test against one location. */
	probe(location) {
		return writeTest(location, { fs: this.fs, now: this.now });
	}

	/**
	 * Report a write failure observed by any writer; decides the state
	 * transition. Repeated faults while already degraded keep only the
	 * latest reason — never a silent stall, never event spam.
	 * @param {{where?: string, err?: unknown}} fault
	 */
	reportWriteFailure(_fault) {
		const now = this.now();
		this.lastFaultAt = now;
		const primaryProbe = this.probe(this.primary);
		if (!primaryProbe.ok) {
			if (this.state === "primary" && this.failover && this.probe(this.failover).ok) {
				// Switch exactly once per fault — repeated faults while already
				// degraded must not re-trigger migrations or event storms.
				this.state = "degraded-write";
				this.switchedAt = now;
				this.reason = `primary storage failing (${primaryProbe.reason}); recording continues on the failover location`;
				this.emit("storage.failover", this.reason);
				return { switched: true, state: this.state };
			}
			if (this.state === "degraded-write") {
				// Already writing to a healthy failover: keep everything as is.
				return { switched: false, state: this.state };
			}
			const wasTransitioning = this.state !== "unavailable";
			this.state = "unavailable";
			this.reason = primaryProbe.reason
				? `recording paused — no writable location (${this.failover ? `primary fails: ${primaryProbe.reason}` : `no failover configured; primary fails: ${primaryProbe.reason}`})`
				: "recording paused — no writable location";
			this.switchedAt = now;
			if (wasTransitioning) this.emit("storage.unavailable", this.reason);
			return { switched: false, state: this.state };
		}
		// Primary writes again? Failback stays manual (no surprise volume
		// flips); the degraded state persists until the operator acts.
		this.reason = this.state === "primary" ? null : this.reason;
		return { switched: false, state: this.state };
	}

	/** Manual failback to the primary (the only failback path). */
	failback() {
		const now = this.now();
		if (this.state === "primary") {
			return { ok: false, state: this.state, reason: "already recording on the primary location — nothing to fail back" };
		}
		if (this.state === "unavailable") {
			return { ok: false, state: this.state, reason: "recording is paused (no writable location) — resolve the storage fault first, then trigger failover recovery" };
		}
		const probe = this.probe(this.primary);
		if (!probe.ok) {
			this.emit("storage.failback-rejected", `failback refused — the primary location still fails: ${probe.reason}`);
			return { ok: false, state: this.state, reason: `failback refused — the primary location still fails: ${probe.reason}` };
		}
		this.state = "primary";
		this.switchedAt = now;
		this.reason = null;
		this.emit("storage.failback", "recording returned to the primary location (manual failback)");
		return { ok: true, state: this.state };
	}

	/** Drive-health check against the active location (ac-5). */
	checkDriveHealth() {
		if (this.state === "unavailable") {
			// Recording is paused; the only recovery is the location becoming
			// writable again (probe the primary — no failover flip, failback
			// law stays manual for the degraded-write state).
			if (this.probe(this.primary).ok) {
				this.state = "primary";
				this.switchedAt = this.now();
				this.reason = null;
				this.driveHealthy = true;
				this.driveSignal = "ok";
				this.driveReason = null;
				this.emit("storage.recovered", "storage is writable again — recording resumes");
				return this.status();
			}
			this.driveHealthy = false;
			this.driveSignal = "write-failure";
			this.driveReason = this.reason;
			return this.status();
		}
		const target = this.activeLocation();
		if (!target) {
			this.driveHealthy = false;
			this.driveSignal = "write-failure";
			this.driveReason = this.reason;
			return this.status();
		}
		const health = driveHealth(target, { fs: this.fs });
		const was = this.driveHealthy;
		this.driveHealthy = health.healthy;
		this.driveSignal = health.signal;
		this.driveReason = health.healthy ? null : health.reason ?? "problematic drive access";
		if (!health.healthy) {
			if (was || this.driveSignal === "statfs-failure") {
				this.emit("storage.drive-health", `drive problem on ${target}: ${this.driveReason}`);
			}
		} else if (!was) {
			this.emit("storage.drive-recovered", `drive access recovered on ${target}`);
		}
		return this.status();
	}

	/**
	 * @param {string} type
	 * @param {string} [detail]
	 */
	emit(type, detail) {
		this.onEvent({ type, at: this.now(), detail });
	}

	/** The status plane of record (rendered + published, ac-4). */
	status() {
		return {
			state: this.state,
			activeLocation: this.activeLocation(),
			primary: this.primary,
			failover: this.failover,
			configuredFailover: this.failover != null,
			reason: this.reason,
			driveHealthy: this.driveHealthy,
			driveSignal: this.driveSignal,
			driveReason: this.driveReason,
			switchedAt: this.switchedAt,
		};
	}
}
