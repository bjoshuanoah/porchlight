// args.js — ffmpeg argv construction for the per-camera segment recorders
// (PORCH-127; hardware decisions moved to the HAL in PORCH-132). Pure module:
// the unit layer of every recorder decision.
//
// Binding constraints from the task directive:
//   - hardware decode/encode choices come from the HAL backend (@porchlight/hal):
//     `videotoolbox` hwaccel and `h264_videotoolbox`/nv12 on macOS — the argv
//     builder itself stays platform-free and runs unmodified on any backend,
//   - fMP4 segments written with movflags +frag_keyframe+empty_moov
//     (proven shaping pattern), date/hour/camera path layout,
//   - PCM ingest (8 kHz-class vendor adapters) transcoded to AAC/16 kHz at
//     ingest for browser MSE compatibility.

import { createHal } from "@porchlight/hal";

/** Default fMP4 flags: fragmented on keyframes, empty moov, MSE-safe. */
export const SEGMENT_MOVFLAGS = "+frag_keyframe+empty_moov+default_base_moof";

/** Transcode target for PCM ingest: AAC at 16 kHz (browser MSE contract). */
export const AUDIO_TRANSCODE = { codec: "aac", sampleRate: 16000, bitrate: "96k" };

/**
 * Audio handling per camera. Default is "transcode": every ingest is
 * re-encoded to AAC/16 kHz, which satisfies the MSE contract for both PCM
 * (vendor adapters) and native AAC sources. "copy" is the opt-out for
 * known-AAC cameras to skip re-encoding.
 * @param {import("./types.js").CameraConfig} camera
 * @returns {"transcode"|"copy"}
 */
export function resolveAudioMode(camera) {
	const mode = camera.audioMode ?? "transcode";
	if (mode !== "transcode" && mode !== "copy") {
		throw new Error(`camera ${camera.name}: invalid audioMode ${JSON.stringify(mode)}`);
	}
	return mode;
}

/**
 * Build the full ffmpeg argv for one camera recording into root.
 * The output template uses strftime so every segment lands at
 * <root>/<YYYY-MM-DD>/<HH>/<camera>/<HHMMSS>.part (UTC — the daemon spawns
 * ffmpeg with TZ=UTC).
 *
 * Hardware decisions are the HAL's: decode argv and encode defaults come from
 * the backend instance (`hal`, defaulting to the running host) so the same
 * argv builder runs unmodified against any HAL implementation.
 * @param {import("./types.js").CameraConfig} camera
 * @param {{segmentSeconds: number}} cfg
 * @param {ReturnType<typeof import("@porchlight/hal").resolveHal>} [hal]
 * @returns {string[]}
 */
export function buildFfmpegArgs(camera, cfg, hal = createHal()) {
	const argv = ["-hide_banner", "-loglevel", "warning", "-nostdin"];
	const out = [
		"-avoid_negative_ts", "make_zero",
		"-f", "segment",
		"-segment_time", String(cfg.segmentSeconds),
		"-reset_timestamps", "1",
		"-segment_format", "mp4",
		"-segment_format_options", `movflags=${SEGMENT_MOVFLAGS}`,
		"-strftime", "1",
	];
	if (camera.source?.synthetic) {
		// Soak-only origin: a lavfi test signal exercising the full recorder
		// pipeline, encoded through the HAL's hardware encoder so the run is
		// Apple-Silicon native end to end on macOS. Its PCM audio rides the
		// same AAC/16 kHz transcode branch a vendor adapter's PCM ingest takes.
		const s = camera.source.synthetic;
		const enc = hal.videoEncode();
		const fps = s.fps ?? 12;
		argv.push(
			"-re", "-f", "lavfi", "-i", `testsrc2=size=${s.size ?? "1280x720"}:rate=${fps}`,
		);
		if (s.audio !== false) {
			argv.push(
				"-re", "-f", "lavfi", "-i",
				`sine=frequency=${s.audioFreq ?? 440}:sample_rate=${s.audioSampleRate ?? 8000}`,
				"-map", "0:v:0", "-map", "1:a:0",
			);
		} else {
			argv.push("-map", "0:v:0", "-an");
		}
		if (camera.audioMode === "copy") {
			throw new Error(`camera ${camera.name}: synthetic PCM source cannot use audioMode "copy"`);
		}
		argv.push(
			"-c:v", s.encoder ?? enc.name,
			"-pix_fmt", s.pixFmt ?? enc.pixFmt,
			"-b:v", s.bitrate ?? "500k",
			"-g", String(fps * 2),
			// PCM lavfi ingest → the MSE transcode branch.
			"-c:a", AUDIO_TRANSCODE.codec,
			"-ar", String(AUDIO_TRANSCODE.sampleRate),
			"-b:a", AUDIO_TRANSCODE.bitrate,
		);
	} else if (typeof camera.source?.url === "string") {
		const url = camera.source.url;
		// Hardware decode is the host's platform capability, decided by the
		// HAL (VideoToolbox on macOS); with -c:v copy the flag is inert but
		// present on every real-camera ingest command.
		argv.push(...hal.videoDecodeArgs());
		if (url.startsWith("rtsp://") || url.startsWith("rtsps://")) {
			argv.push("-rtsp_transport", "tcp");
		}
		if (camera.source.loop) argv.push("-stream_loop", "-1");
		argv.push("-i", url, "-map", "0:v:0", "-map", "0:a:0?");
		argv.push("-c:v", "copy");
		if (resolveAudioMode(camera) === "transcode") {
			argv.push(
				"-c:a", AUDIO_TRANSCODE.codec,
				"-ar", String(AUDIO_TRANSCODE.sampleRate),
				"-b:a", AUDIO_TRANSCODE.bitrate,
			);
		} else {
			argv.push("-c:a", "copy");
		}
	} else {
		throw new Error(`camera ${camera.name}: needs source.url or source.synthetic`);
	}
	return [...argv, ...out, partPathTemplate(camera.name)];
}

/**
 * Output template (relative to the ffmpeg cwd, which the daemon pins to the
 * storage root): <date>/<hour>/<camera>/<HHMMSS>.part with UTC strftime
 * names — the deployment segment layout of record (hours in UTC).
 * @param {string} cameraName
 */
export function partPathTemplate(cameraName) {
	return `./%Y-%m-%d/%H/${cameraName}/%H%M%S.part`;
}

/**
 * The store root is passed via ffmpeg's `-chdir`-style cwd: the daemon runs
 * ffmpeg with cwd = storage root so the template stays relative and
 * hour/date rolling needs no template surgery.
 * @param {import("./types.js").CameraConfig} camera
 * @param {{segmentSeconds: number}} cfg
 * @param {ReturnType<typeof import("@porchlight/hal").resolveHal>} [hal]
 */
export function buildFfmpegCommand(camera, cfg, hal = createHal()) {
	return { file: "ffmpeg", args: buildFfmpegArgs(camera, cfg, hal) };
}
