// events.js — the entity event feed of record (PORCH-130).
//
// The console's timeline plane subscribes the engine's event-bus detections
// family of record (`porchlight/engine/detections/<camera>/<class>` — the
// SAME topic contract the recorder's DETECTIONS_PATTERN and the hub's
// consumer key on) and persists every landing event as append-only JSONL,
// one file per UTC date of the event's own t:
// <root>/config/console/events/<YYYY-MM-DD>.jsonl.
//
// Two payload families ride the topic: DetectedObject
// {camera, trackId, cls, conf, t, bbox?, ...} and AudioEvent
// {camera, timestamp, class, confidence, clipStart, clipEnd} — the audio
// family is recognized by the clip bounds (source: "audio"). Every stored
// row is normalized: `{ t, camera, cls, conf, trackId, source, clipStart?,
// clipEnd? }` with t in epoch SECONDS, UTC. Malformed payloads are skipped
// with a logged line — never a crash, never a silent loss.
//
// Green-field law: the feed is only wired when the config of record carries
// busUrl (or a test client is injected); a feed without a bus answers its
// disabled status in plain language and listEvents still reads what was
// already persisted. Files older than the engine's event retention
// (DEFAULT_EVENT_RETENTION_DAYS) are pruned on each append.

import fsDefault from "node:fs";
import pathDefault from "node:path";
import { createMqttBus, dateDirName, dayStart, DAY_MS, DETECTIONS_PATTERN } from "@porchlight/recorder";
import { consoleDirFor } from "./store.js";
import { DEFAULT_EVENT_RETENTION_DAYS } from "./storage.js";
import { ValidationError } from "./types.js";

const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
/** t values past this are epoch MILLIS (seconds today are ~1.8e9). */
const MILLIS_THRESHOLD = 1e11;

/**
 * Normalize an event time to epoch seconds (UTC). Producers of record
 * publish epoch seconds (detection `t`, audio `timestamp`); a millis value
 * is normalized down so every stored row is seconds.
 */
function secondsOf(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
	return value >= MILLIS_THRESHOLD ? Math.floor(value / 1000) : Math.floor(value);
}

/** Stringify a track id; absence stays null (audio events carry none). */
function trackIdOf(payload) {
	if (payload.trackId === undefined || payload.trackId === null || payload.trackId === "") return null;
	return String(payload.trackId);
}

/** Topic's camera segment — index [3] of the family of record. */
function cameraFromTopic(topic) {
	const parts = String(topic).split("/");
	return parts[3] ?? null;
}

/**
 * Create the event feed.
 * @param {{
 *   root: string,
 *   busUrl?: string | null,
 *   now?: () => Date,
 *   log?: (line: string) => void,
 *   client?: { subscribe(pattern: string, handler: (topic: string, payload: string) => void): unknown, status(): { connected: boolean, url: string | null } },
 * }} opts
 *   busUrl — the seam override (tests); index.js resolves the config of
 *   record's busUrl. Null/absent ⇒ the feed holds a stated disabled status.
 *   client — bus seam injection (tests): mirrors createMqttBus's
 *   subscribe/status surface.
 */
export function createEventsFeed(opts = {}) {
	const root = opts.root;
	const fs = opts.fs ?? fsDefault;
	const log = opts.log ?? (() => {});
	const now = opts.now ?? (() => new Date());
	const dir = pathDefault.join(consoleDirFor(root), "events");

	const busUrl = opts.busUrl ?? null;
	const bus = opts.client ?? (busUrl ? createMqttBus({ url: busUrl, clientId: "porchlight-console", log }) : null);
	if (bus) bus.subscribe(DETECTIONS_PATTERN, onTopicMessage);

	/**
	 * One bus landing: parse → normalize → append. A malformed payload is a
	 * logged skip, never a crash.
	 */
	function onTopicMessage(topic, raw) {
		let payload = null;
		try {
			payload = JSON.parse(raw);
		} catch {
			log(`[events] skipped unparseable payload on ${topic}`);
			return;
		}
		const row = normalizeRow(topic, payload);
		if (!row) {
			log(`[events] skipped malformed event payload on ${topic}`);
			return;
		}
		append(row);
	}

	/**
	 * Payload → stored row (`{ t, camera, cls, conf, trackId, source,
	 * clipStart?, clipEnd? }`), or null when the landing isn't an event of
	 * record. Camera comes from the payload with the topic segment as
	 * fallback; the audio family is recognized by its clip bounds.
	 */
	function normalizeRow(topic, payload) {
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
		const t = secondsOf(payload.t ?? payload.timestamp);
		if (t === null) return null;
		const camera = typeof payload.camera === "string" && payload.camera !== "" ? payload.camera : cameraFromTopic(topic);
		if (!camera) return null;
		const cls = typeof payload.cls === "string" && payload.cls !== "" ? payload.cls : (typeof payload.class === "string" ? payload.class : null);
		if (!cls) return null;
		const conf = typeof payload.conf === "number" && Number.isFinite(payload.conf) ? payload.conf
			: (typeof payload.confidence === "number" && Number.isFinite(payload.confidence) ? payload.confidence : null);
		if (conf === null) return null;
		const row = {
			t,
			camera,
			cls,
			conf,
			trackId: trackIdOf(payload),
			source: payload.clipStart !== undefined || payload.clipEnd !== undefined ? "audio" : "detection",
		};
		if (row.source === "audio") {
			const clipStart = secondsOf(payload.clipStart ?? undefined);
			const clipEnd = secondsOf(payload.clipEnd ?? undefined);
			if (clipStart !== null) row.clipStart = clipStart;
			if (clipEnd !== null) row.clipEnd = clipEnd;
		}
		return row;
	}

	/** Atomic append to the event's UTC-date JSONL + the retention sweep. */
	function append(row) {
		try {
			fs.mkdirSync(dir, { recursive: true });
			const file = pathDefault.join(dir, `${dateDirName(row.t * 1000)}.jsonl`);
			// appendFileSync is one O_APPEND write of a one-line row — the
			// append-only discipline of record for JSONL.
			fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
		} catch (err) {
			log(`[events] append failed: ${err?.message ?? err}`);
			return;
		}
		prune();
	}

	/** Drop event files whose UTC date name is older than event retention. */
	function prune() {
		const cutoff = now().getTime() - DEFAULT_EVENT_RETENTION_DAYS * DAY_MS;
		let names = [];
		try {
			names = fs.readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			const match = DATE_FILE_RE.exec(name);
			if (!match) continue;
			if (dayStart(match[1]) < cutoff) {
				try {
					fs.unlinkSync(pathDefault.join(dir, name));
				} catch {
					// Already gone or momentarily locked — the next append retries.
				}
			}
		}
	}

	/**
	 * All persisted events in [from, to] (epoch seconds, UTC), t ascending,
	 * capped at limit (default 500, max 2000). Only the date files
	 * intersecting the window are read.
	 */
	function listEvents(query = {}) {
		const from = requireEpochSeconds(query.from, "from");
		const to = requireEpochSeconds(query.to, "to");
		let limit = query.limit ?? DEFAULT_LIMIT;
		if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
			throw new ValidationError("events: limit must be a positive integer");
		}
		if (limit > MAX_LIMIT) limit = MAX_LIMIT;
		const cameraId = typeof query.cameraId === "string" && query.cameraId !== "" ? query.cameraId : null;

		const events = [];
		// One calendar day-step across the window; each existing date file is
		// read once. Out-of-order appends are re-ordered by the sort below.
		const firstDay = dayStart(dateDirName(from * 1000));
		const lastDay = dayStart(dateDirName(to * 1000));
		for (let dayMs = firstDay; dayMs <= lastDay; dayMs += DAY_MS) {
			const file = pathDefault.join(dir, `${dateDirName(dayMs)}.jsonl`);
			let raw = "";
			try {
				raw = fs.readFileSync(file, "utf8");
			} catch {
				continue;
			}
			for (const line of raw.split("\n")) {
				if (line.trim() === "") continue;
				let row = null;
				try {
					row = JSON.parse(line);
				} catch {
					continue; // torn tail line — never fatal to the listing
				}
				if (!row || typeof row !== "object") continue;
				if (typeof row.t !== "number" || !Number.isFinite(row.t)) continue;
				if (row.t < from || row.t > to) continue;
				if (cameraId && row.camera !== cameraId) continue;
				events.push(row);
			}
		}
		events.sort((a, b) => a.t - b.t);
		return { events: events.slice(0, limit) };
	}

	/** The bus seam's plain-language state (never a silent blank). */
	function status() {
		if (!bus) {
			return {
				connected: false,
				url: null,
				detail: "the event bus isn't configured — the config of record needs a busUrl before detections and audio events land here",
			};
		}
		return bus.status();
	}

	/** Close the seam when the composition hands the feed a closable bus. */
	function close() {
		return bus?.close?.() ?? Promise.resolve();
	}

	function requireEpochSeconds(value, label) {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw new ValidationError(`events: ${label} must be an epoch-seconds timestamp (UTC)`);
		}
		return value;
	}

	return { listEvents, status, close };
}
