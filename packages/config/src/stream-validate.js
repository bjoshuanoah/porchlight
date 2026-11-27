// stream-validate.js — camera/stream connectivity validation (PORCH-152,
// engine setup coverage ac-4). One ffprobe invocation with a hard deadline:
// the probe answers whether a stream URL is reachable and decodes (video
// dimensions/codec, audio track presence) — the engine's answer the hub's
// add-camera flow and the console both consume. Never silent: every failure
// carries a plain-language reason naming what happened.

import { spawn } from "node:child_process";

/**
 * Validate a stream URL with ffprobe.
 * @param {{
 *   url: string,
 *   ffprobePath?: string,
 *   timeoutMs?: number,
 *   spawnImpl?: typeof spawn,
 * }} opts
 * @returns {Promise<{ok: true, aspect: {width: number, height: number}, audio: boolean, codec: string}
 *            | {ok: false, reason: string}>}
 */
export function validateStreamUrl({ url, ffprobePath = "ffprobe", timeoutMs = 6000, spawnImpl = spawn } = {}) {
	if (typeof url !== "string" || url.trim() === "") {
		return Promise.resolve({ ok: false, reason: "a stream URL is required" });
	}
	if (!/^([a-z][a-z0-9+.-]*):/i.test(url.trim())) {
		return Promise.resolve({ ok: false, reason: "that isn't a stream URL — an rtsp:// camera address is expected" });
	}
	return new Promise((resolve) => {
		let settled = false;
		/** @type {ReturnType<typeof setTimeout> | undefined} */
		let timer;
		/** @type {import("node:child_process").ChildProcess | undefined} */
		let child;
		const done = (/** @type {any} */ answer) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(answer);
		};
		try {
			child = spawnImpl(ffprobePath, [
				"-v", "error",
				"-print_format", "json",
				"-show_streams",
				"-timeout", String(Math.min(timeoutMs, 10_000) * 1000),
				url.trim(),
			], { stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			done({ ok: false, reason: "the stream probe couldn't start on this host" });
			return;
		}
		timer = setTimeout(() => {
			child?.kill("SIGKILL");
			done({ ok: false, reason: `the camera didn't answer within ${timeoutMs}ms — check the address and the camera's reachability` });
		}, timeoutMs);
		/** @type {Buffer[]} */
		const chunks = [];
		child.stdout?.on("data", (/** @type {Buffer} */ c) => chunks.push(c));
		child.stderr?.on("data", () => {});
		child.on("error", (err) => {
			if (/** @type {any} */ (err)?.code === "ENOENT") {
				done({ ok: false, reason: "ffprobe isn't available on this host — install ffmpeg (the engine's decode of record)" });
				return;
			}
			done({ ok: false, reason: `the stream probe failed: ${err.message}` });
		});
		child.on("exit", (code) => {
			if (settled) return;
			const out = Buffer.concat(chunks).toString("utf8");
			if (code !== 0) {
				done({ ok: false, reason: "the stream didn't open — the camera refused the connection or the URL is wrong" });
				return;
			}
			let parsed = null;
			try { parsed = JSON.parse(out); } catch { parsed = null; }
			const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
			const video = streams.find((/** @type {any} */ s) => s.codec_type === "video");
			if (!video || typeof video.width !== "number" || typeof video.height !== "number") {
				done({ ok: false, reason: "the stream opened but carries no decodable video track" });
				return;
			}
			done({
				ok: true,
				aspect: { width: video.width, height: video.height },
				audio: streams.some((/** @type {any} */ s) => s.codec_type === "audio"),
				codec: String(video.codec_name ?? "unknown"),
			});
		});
	});
}
