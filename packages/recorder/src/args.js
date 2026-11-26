// args.js — ffmpeg argv construction for the per-camera segment recorders
// (PORCH-127). Pure module: the unit layer of every recorder decision.
//
// Binding constraints from the task directive:
//   - native ffmpeg with `-hwaccel videotoolbox` (hardware decode; the encoder
//     for synthetic soak cameras is h264/hevc_videotoolbox),
//   - fMP4 segments written with movflags +frag_keyframe+empty_moov
//     (proven shaping pattern), date/hour/camera path layout,
//   - PCM ingest (8 kHz-class vendor adapters) transcoded to AAC/16 kHz at
//     ingest for browser MSE compatibility.

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
 * @param {import("./types.js").CameraConfig} camera
 * @param {{segmentSeconds: number}} cfg
 * @returns {string[]}
 */
export function buildFfmpegArgs(camera, cfg) {
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
		// pipeline, encoded through VideoToolbox so the run is Apple-Silicon
		// native end to end. Its PCM audio rides the same AAC/16 kHz
		// transcode branch a vendor adapter's PCM ingest takes.
		const s = camera.source.synthetic;
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
			"-c:v", s.encoder ?? "h264_videotoolbox",
			"-pix_fmt", "nv12",
			"-b:v", s.bitrate ?? "500k",
			"-g", String(fps * 2),
			// PCM lavfi ingest → the MSE transcode branch.
			"-c:a", AUDIO_TRANSCODE.codec,
			"-ar", String(AUDIO_TRANSCODE.sampleRate),
			"-b:a", AUDIO_TRANSCODE.bitrate,
		);
	} else if (typeof camera.source?.url === "string") {
		const url = camera.source.url;
		// VideoToolbox hardware decode is a platform capability of this
		// recorder (binding directive); with -c:v copy the flag is inert but
		// present on every real-camera ingest command.
		argv.push("-hwaccel", "videotoolbox");
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
 */
export function buildFfmpegCommand(camera, cfg) {
	return { file: "ffmpeg", args: buildFfmpegArgs(camera, cfg) };
}
