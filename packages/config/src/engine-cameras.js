// engine-cameras.js — the engine's camera registration landing (PORCH-152,
// setup coverage ac-4 + the hub-facing TS 7 seam).
//
// The engine camera id of record is ONE registry: platform config of record
// cameras[].name (the recorder fleet) — mirrored 1:1 into the console
// cameras.yaml row so zones/composition key the same id. POST /cameras
// registers into both, then hands the new fleet to the recorder supervisor
// (POST /api/cameras/apply) and the stream manager (its own
// /api/cameras/apply) so the first recording and the live serving both
// start LIVE — no restart on either plane.

import { randomBytes } from "node:crypto";
import { validateStreamUrl } from "./stream-validate.js";
import { readPlatformConfig, writePlatformConfig } from "./compute.js";
import { ValidationError } from "./types.js";

/**
 * Register a validated stream camera and start it recording + streaming.
 * @param {{
 *   root: string,
 *   url: unknown,
 *   cameras: import("./baseconfig.js").ReturnType,
 *   recorderBase?: string,
 *   streamBase?: string,
 *   fetchImpl?: typeof fetch,
 *   ffprobePath?: string,
 *   fs?: typeof import("node:fs"),
 *   now?: () => Date,
 * }} opts
 * @returns {Promise<{ok: true, cameraId: string, aspect: {width:number,height:number},
 *    audio: boolean, recording: {ok: boolean, reason?: string},
 *    streaming: {ok: boolean, reason?: string}}
 *   | {ok: false, reason: string}>}
 */
export async function registerStreamCamera({
	root,
	url,
	cameras,
	recorderBase = "http://127.0.0.1:8971",
	streamBase = "http://127.0.0.1:8972",
	fetchImpl = globalThis.fetch,
	ffprobePath,
	probeImpl,
	fs,
	now = () => new Date(),
} = {}) {
	if (typeof url !== "string" || url.trim() === "") {
		return { ok: false, reason: "a camera URL is required" };
	}
	const platformFile = root.endsWith("/") ? `${root}config/config.yaml` : `${root}/config/config.yaml`;
	const platform = readPlatformConfig(platformFile, { fs });
	if (!platform) {
		return { ok: false, reason: "the platform config of record doesn't exist yet — run the product's own setup first" };
	}
	const probe = await (probeImpl ?? validateStreamUrl)({ url, ffprobePath: ffprobePath ?? /** @type {any} */ (platform).ffprobePath ?? "ffprobe" });
	if (!probe.ok) return { ok: false, reason: probe.reason };

	const cameraId = `cam-${randomBytes(4).toString("hex")}`;
	const doc = /** @type {Record<string, unknown>} */ (structuredClone(platform));
	const fleet = Array.isArray(doc.cameras) ? /** @type {any[]} */ (doc.cameras) : [];
	const existing = fleet.find((/** @type {any} */ c) => c?.source?.url === url.trim());
	if (existing) {
		return { ok: false, reason: "this camera's URL is already registered" + (existing.name ? ` (camera ${existing.name})` : "") };
	}
	if (fleet.some((/** @type {any} */ c) => c?.name === cameraId)) {
		return { ok: false, reason: "camera id collision — retry the registration" };
	}
	// The frame dimensions of record ride the source: ffmpeg decode (the
	// manager's rgb/jpeg lanes) needs w/h and validateStreamUrl already
	// probed the aspect, so it is written once here — no consumer ever
	// re-probes or opens the camera itself.
	fleet.push({ name: cameraId, source: { url: url.trim(), width: probe.aspect.width, height: probe.aspect.height } });
	doc.cameras = fleet;
	let validated;
	try {
		validated = writePlatformConfig(platformFile, doc, { fs });
	} catch (err) {
		return { ok: false, reason: `the platform config refused the camera: ${err instanceof Error ? err.message : String(err)}` };
	}

	// The console registry mirrors the SAME id one-to-one (one camera id of
	// record; zones/composition key it).
	cameras.upsert(cameraId, {
		name: cameraId,
		width: probe.aspect.width,
		height: probe.aspect.height,
	});

	// Hand the fleet to the recorder supervisor live (no restart). A
	// supervisor outage never fakes success — it is named on the answer and
	// the health seams.
	let recording = { ok: false, reason: "unattempted" };
	try {
		const response = await fetchWithTimeout(`${recorderBase.replace(/\/+$/, "")}/api/cameras/apply`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cameras: validated.cameras }),
		}, fetchImpl);
		if (response.ok) {
			recording = { ok: true };
		} else {
			recording = { ok: false, reason: `the recorder refused the fleet update (${response.status})` };
		}
	} catch {
		recording = { ok: false, reason: "the recorder supervisor isn't reachable — recording starts when it is (boot reads the same config of record)" };
	}

	// Hand the SAME fleet to the stream manager so the live-serving plane
	// opens its single upstream per camera without a restart. A manager
	// outage is named — streaming starts when it is (boot reads the same
	// config of record); the registration still succeeds on the recorder's
	// answer, exactly as above.
	const streamApplyUrl = `${streamBase.replace(/\/+$/, "")}/api/cameras/apply`;
	let streaming = { ok: false, reason: "unattempted" };
	try {
		const response = await fetchWithTimeout(streamApplyUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cameras: validated.cameras }),
		}, fetchImpl);
		if (response.ok) {
			streaming = { ok: true };
		} else {
			streaming = { ok: false, reason: `the stream manager refused the fleet update (${response.status})` };
		}
	} catch {
		streaming = { ok: false, reason: "the stream manager isn't reachable — serving starts when it is (boot reads the same config of record)" };
	}
	void now;
	return { ok: true, cameraId, aspect: probe.aspect, audio: probe.audio, recording, streaming };
}

/**
 * @param {string} url @param {RequestInit} init @param {typeof fetch} fetchImpl
 */
async function fetchWithTimeout(url, init, fetchImpl) {
	if (typeof fetchImpl !== "function") throw new TypeError("fetch is required");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 5000);
	try {
		return await fetchImpl(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Throw a ValidationError when the body url is not a string (REST pre-check).
 * @param {unknown} body
 */
export function requireStreamUrl(body) {
	if (!body || typeof body !== "object" || typeof /** @type {any} */ (body).url !== "string") {
		throw new ValidationError("body must be { url: \"rtsp://...\" }");
	}
	return /** @type {any} */ (body).url;
}
