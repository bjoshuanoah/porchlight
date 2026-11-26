// storage.js — the REST storage plane of the config console (PORCH-136).
//
// One service answering the storage setup question end to end: validate a
// location with the recorder's write test before anything is persisted, keep
// the storage doc under <root>/config/console/storage.yaml, and keep the
// platform config of record (<root>/config/config.yaml) in sync — the daemon
// reads that document every boot, so the console's answer only counts when it
// lands there. Status proxies the recorder supervisor (it owns the live
// storage plane); when the recorder is unreachable the state is stated in
// plain language — never a silent stall.

import fsDefault from "node:fs";
import pathDefault from "node:path";
import { parse as parseYaml } from "yaml";
import { validateConfig, writeTest } from "@porchlight/recorder";
import { NotFoundError, ValidationError } from "./types.js";

export const DEFAULT_EVENT_RETENTION_DAYS = 30;

/** Safe path/URL component — same discipline as camera and profile ids. */
export const RULE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const RULE_SCOPE_KEYS = ["cameraId", "eventClass", "zoneId"];

/**
 * Write text atomically: tmp file in the same directory, then rename over
 * the target (same discipline as Store.writeDoc — a reader never sees a
 * torn document).
 */
function writeAtomically(fs, file, text) {
	fs.mkdirSync(pathDefault.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, text, "utf8");
	fs.renameSync(tmp, file);
}

/** Safely parse a fetch body as JSON; null for empty/non-JSON bodies. */
async function jsonBody(res) {
	try {
		return await res.json();
	} catch {
		return null;
	}
}

/** Storage config of record for a Porchlight root. */
export function configYamlPathFor(root) {
	return pathDefault.join(root, "config", "config.yaml");
}

/**
 * The recorder supervisor's base URL from the config of record: its `port`
 * field names the supervisor's health port (recorder default 8971). A
 * missing document falls back to the default — the deployment that only has
 * the console still states the right place to look.
 * @param {string} configYaml
 * @param {{fs?: typeof fsDefault}} [opts]
 */
export function resolveRecorderBase(configYaml, opts = {}) {
	const fs = opts.fs ?? fsDefault;
	let port = 8971;
	try {
		const cfg = parseYaml(fs.readFileSync(configYaml, "utf8"));
		if (Number.isInteger(cfg?.port) && cfg.port >= 1 && cfg.port <= 65535) port = cfg.port;
	} catch { /* stated later by the status call, never a construction crash */ }
	return `http://127.0.0.1:${port}`;
}

/**
 * @typedef {{
 *   state?: "primary"|"degraded-write"|"unavailable",
 *   activeLocation?: string | null,
 *   primary?: string | null,
 *   failover?: string | null,
 *   reason?: string | null,
 *   driveHealthy?: boolean | null,
 *   driveReason?: string | null,
 *   paused?: boolean | null,
 * }} StorageState
 */

/**
 * @param {{
 *   store: import("./store.js").Store,
 *   recorderBase?: string,
 *   fs?: typeof fsDefault,
 *   fetch?: typeof fetch,
 *   timeoutMs?: number,
 * }} opts
 *   store — the console Store (docs under <root>/config/console/). The
 *   Porchlight root rides on the store. recorderBase — recorder supervisor
 *   base URL (default: resolved from the platform config of record's
 *   `port` field — the supervisor's health port — falling back to the
 *   recorder default 8971).
 */
export function createStorageService(opts = {}) {
	const { store } = opts;
	const fs = opts.fs ?? fsDefault;
	const doFetch = opts.fetch ?? fetch;
	const timeoutMs = opts.timeoutMs ?? 2000;
	const configYaml = configYamlPathFor(store.root);
	const recorderBase = opts.recorderBase ?? resolveRecorderBase(configYaml, { fs });

	/** The persisted storage doc (or the empty default when unconfigured). */
	function readDoc() {
		return store.readDoc("storage");
	}

	/** The API surface of the storage doc: stated even when empty. */
	function get() {
		const doc = readDoc();
		return {
			configured: Boolean(doc.primary),
			primary: doc.primary ?? null,
			failover: doc.failover ?? null,
			eventRetentionDays: doc.eventRetentionDays ?? DEFAULT_EVENT_RETENTION_DAYS,
			rules: Array.isArray(doc.rules) ? doc.rules : [],
		};
	}

	/**
	 * The write test of record for one candidate location — plain
	 * pass-through of the recorder's create/read/write/delete probe.
	 */
	function testLocation(location) {
		if (typeof location !== "string" || location.trim() === "") {
			throw new ValidationError("storage test: location must be a non-empty string path");
		}
		return writeTest(location);
	}

	/**
	 * Assert a candidate location: a non-empty string path for the required
	 * primary; optional/null for the failover (no failover is a valid setup).
	 */
	function assertLocation(location, label, required) {
		if (location === undefined || location === null) {
			if (required) throw new ValidationError(`storage setup: ${label} location is required — give a non-empty path`);
			return null;
		}
		if (typeof location !== "string" || location.trim() === "") {
			throw new ValidationError(`storage setup: ${label} location must be a non-empty string path`);
		}
		return location;
	}

	/** Write-test one location; a failure is a plain-language ValidationError. */
	function assertWritable(location, label) {
		const result = writeTest(location);
		if (!result.ok) {
			throw new ValidationError(`storage setup: ${label} storage location test failed: ${result.reason} (${location})`);
		}
		return result;
	}

	/**
	 * Load the platform config of record; a missing document is a stated
	 * error — the console refines the installer's config of record, it never
	 * invents one.
	 */
	function loadPlatformConfig() {
		if (!fs.existsSync(configYaml)) {
			throw new ValidationError(`storage setup: the platform config of record (${configYaml}) does not exist yet — run the porchlight installer bootstrap first`);
		}
		const raw = fs.readFileSync(configYaml, "utf8");
		return parseYaml(raw) ?? {};
	}

	/**
	 * Apply the storage doc (or a rules mutation) to the config of record:
	 * set storageRoot/failoverRoot/eventRetentionDays/retentionRules, ride
	 * the recorder contract validator, write back atomically as JSON text
	 * (the repo renderConfigYaml style). Throws before any field changes
	 * when the resulting config of record would be invalid.
	 */
	function syncPlatformConfig(doc) {
		const cfg = loadPlatformConfig();
		if (doc.primary) cfg.storageRoot = doc.primary;
		if (doc.failover) cfg.failoverRoot = doc.failover;
		else delete cfg.failoverRoot;
		if (doc.eventRetentionDays !== undefined) cfg.eventRetentionDays = doc.eventRetentionDays;
		// Rule ids are console bookkeeping — the config of record carries the
		// recorder's retentionRules shape (scope keys + keepDays only).
		cfg.retentionRules = (doc.rules ?? []).map((rule) => {
			const out = {};
			for (const key of RULE_SCOPE_KEYS) if (rule[key] !== undefined) out[key] = rule[key];
			out.keepDays = rule.keepDays;
			return out;
		});
		try {
			validateConfig(cfg);
		} catch (err) {
			throw new ValidationError(`storage setup: the platform config of record would be invalid: ${/** @type {Error} */ (err).message}`);
		}
		writeAtomically(fs, configYaml, JSON.stringify(cfg, null, "\t") + "\n");
		return cfg;
	}

	/**
	 * Configure storage: write-test both locations first (never persist a
	 * setup whose location cannot take a file), then persist the doc and the
	 * config of record. The primary is the recording root — storageRoot in
	 * the config of record follows it.
	 * @param {{ primary?: unknown, failover?: unknown, eventRetentionDays?: unknown }} body
	 */
	function configure(body = {}) {
		const primary = assertLocation(body?.primary, "primary", true);
		const failover = assertLocation(body?.failover, "failover", false);
		const eventRetentionDays = body?.eventRetentionDays ?? DEFAULT_EVENT_RETENTION_DAYS;
		if (!Number.isInteger(eventRetentionDays) || eventRetentionDays < 1) {
			throw new ValidationError("storage setup: eventRetentionDays must be an integer >= 1 — how many days event clips are kept");
		}
		assertWritable(primary, "primary");
		if (failover) assertWritable(failover, "failover");

		const previous = readDoc();
		const doc = {
			configured: true,
			primary: /** @type {string} */ (primary),
			failover: failover ?? null,
			eventRetentionDays,
			rules: Array.isArray(previous.rules) ? previous.rules : [],
		};
		syncPlatformConfig(doc);
		store.writeDoc("storage", doc);
		return doc;
	}

	/**
	 * Full live storage status. Proxies the recorder supervisor's
	 * /api/storage surface (it owns the live state machine); the recorder's
	 * flat storage fields and its usage/bus blocks are merged. Unreachable
	 * — because the recorder is down, or because nothing is configured yet —
	 * is stated in plain language, never silent.
	 */
	async function status() {
		const doc = get();
		try {
			const res = await doFetch(`${recorderBase}/api/storage`, { signal: AbortSignal.timeout(timeoutMs) });
			if (!res.ok) throw new Error(`recorder /api/storage responded ${res.status}`);
			const body = await jsonBody(res) ?? {};
			// /api/storage spreads the backend status (state, activeLocation,
			// primary, failover, reason, driveHealthy, …) next to usage/bus.
			const st = body.storage ?? body;
			return {
				source: "recorder",
				...body,
				...st,
				configured: doc.configured,
				eventRetentionDays: doc.eventRetentionDays,
			};
		} catch {
			if (!doc.configured) {
				return {
					source: "unreachable",
					state: "not-configured",
					configured: false,
					primary: null,
					failover: null,
					reason: "storage is not configured yet — test a primary recording location, then save the storage setup",
				};
			}
			return {
				source: "unreachable",
				state: `unknown — recorder unreachable`,
				configured: true,
				primary: doc.primary,
				failover: doc.failover,
				reason: `the recorder service at ${recorderBase} is unreachable — storage state cannot be confirmed; recordings still follow the configured locations, but check that the recording service is running`,
			};
		}
	}

	/** POST /api/storage/failback on the supervisor (failback is manual). */
	async function failback() {
		try {
			const res = await doFetch(`${recorderBase}/api/storage/failback`, { method: "POST", signal: AbortSignal.timeout(timeoutMs) });
			const body = await jsonBody(res);
			if (res.ok) return body ?? { ok: true };
			return { ok: false, reason: body?.error ?? `the recorder refused the failback (HTTP ${res.status})` };
		} catch {
			return {
				ok: false,
				reason: "the recorder service is unreachable — failback moves recordings back to the primary location, so it needs the recording service running; retry once it is reachable",
			};
		}
	}

	/**
	 * Manual recording controls: POST record/start|stop through to the
	 * supervisor. Refusals stay plain-language {ok:false, reason} — the
	 * console renders them verbatim.
	 */
	async function trigger(cameraId, action) {
		if (typeof cameraId !== "string" || cameraId.trim() === "") {
			throw new ValidationError("camera recording control: camera id is required");
		}
		if (action !== "start" && action !== "stop") {
			throw new ValidationError(`camera recording control: action must be "start" or "stop" — got ${JSON.stringify(action)}`);
		}
		try {
			const res = await doFetch(`${recorderBase}/api/cameras/${encodeURIComponent(cameraId)}/record/${action}`, { method: "POST", signal: AbortSignal.timeout(timeoutMs) });
			const body = await jsonBody(res);
			if (res.ok) return body ?? { ok: true };
			return { ok: false, reason: body?.error ?? `the recorder refused to ${action} recording for camera "${cameraId}" (HTTP ${res.status})` };
		} catch {
			return {
				ok: false,
				reason: `the recorder service is unreachable — ${action === "start" ? "starting" : "stopping"} recording for "${cameraId}" needs the recording service running; retry once it is reachable`,
			};
		}
	}

	/** Validate one retention rule body; returns the normalized copy. */
	function validateRuleFields(rule, label) {
		if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
			throw new ValidationError(`${label}: expected an object`);
		}
		const out = { };
		let scopes = 0;
		for (const key of RULE_SCOPE_KEYS) {
			const value = rule[key];
			if (value === undefined || value === null) continue;
			if (typeof value !== "string" || !RULE_ID_RE.test(value)) {
				throw new ValidationError(`${label}: ${key} must be a safe identifier (letters, digits, dot, underscore, dash — at most 64 characters)`);
			}
			out[key] = value;
			scopes += 1;
		}
		if (scopes === 0) {
			throw new ValidationError(`${label}: needs at least one scope — cameraId, eventClass, or zoneId`);
		}
		if (!Number.isInteger(rule.keepDays) || rule.keepDays < 1) {
			throw new ValidationError(`${label}: keepDays must be an integer >= 1 — how many days matching event clips are kept`);
		}
		out.keepDays = rule.keepDays;
		return out;
	}

	/** Next `rule-<n>` sequence id across the persisted rules. */
	function nextRuleId(rules) {
		let max = 0;
		for (const rule of rules) {
			const m = /^rule-(\d+)$/.exec(rule.id ?? "");
			if (m) max = Math.max(max, Number(m[1]));
		}
		return `rule-${max + 1}`;
	}

	function listRules() {
		return get().rules;
	}

	/** Persist the rules array of the storage doc (and the config of record). */
	function persistRules(rules) {
		const doc = { ...get(), rules };
		syncPlatformConfig(doc);
		store.writeDoc("storage", doc);
	}

	function addRule(rule) {
		const fields = validateRuleFields(rule, "retention rule");
		const rules = listRules();
		const created = { id: nextRuleId(rules), ...fields };
		persistRules([...rules, created]);
		return created;
	}

	function updateRule(id, patch) {
		const rules = listRules();
		const index = rules.findIndex((rule) => rule.id === id);
		if (index === -1) {
			throw new NotFoundError(`retention rule "${id}" does not exist — GET /api/storage/rules lists the current rules`);
		}
		if (patch && typeof patch === "object" && "id" in patch && patch.id !== id) {
			throw new ValidationError("retention rule: id cannot be changed — remove and re-add the rule instead");
		}
		const fields = validateRuleFields({ ...rules[index], ...patch }, "retention rule");
		const updated = { id, ...fields };
		const next = [...rules];
		next[index] = updated;
		persistRules(next);
		return updated;
	}

	function removeRule(id) {
		const rules = listRules();
		const index = rules.findIndex((rule) => rule.id === id);
		if (index === -1) {
			throw new NotFoundError(`retention rule "${id}" does not exist — GET /api/storage/rules lists the current rules`);
		}
		const removed = rules[index];
		persistRules(rules.filter((_, i) => i !== index));
		return { ok: true, removed };
	}

	return {
		get,
		testLocation,
		configure,
		status,
		failback,
		trigger,
		listRules,
		addRule,
		updateRule,
		removeRule,
	};
}
