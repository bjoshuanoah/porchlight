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
//     ingest for browser MSE compatibility,
//   - PORCH-154 recording input law: url cameras ingest the stream manager's
//     localhost mpegts relay, never the camera itself. The single upstream
//     connection per camera belongs to the manager (packages/stream — its
//     src/args.js owns the decode argv and -rtsp_transport tcp on the real
//     source), and camera.source.url never reaches a recorder ffmpeg command.

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

// The stream manager's base port default — the ONE config knob of the
// PORCH-154 shared contract (platform `streams.base`, validated >= 1024 down
// in config.js). Kept in sync with packages/stream; no cross-package import
// so this package stays independent of the manager's runtime.
const DEFAULT_STREAM_BASE = 8972;

/**
 * The stream manager relay TCP port for one camera (PORCH-154): the camera's
 * position in the NAME-SORTED fleet — plain `Array.prototype.sort()`,
 * codepoint order, deliberately not localeCompare — offsets the manager's
 * base port: `streams.base + 1 + sortedIndex(name)`. This is byte-for-byte
 * the formula packages/stream uses for its relay listeners; both sides
 * derive it from the same config of record, neither hardcodes one.
 * @param {{cameras?: import("./types.js").CameraConfig[], streams?: {base?: number}}} cfg
 *   the platform config of record (at least its cameras fleet)
 * @param {string} cameraName
 * @returns {number}
 */
export function relayPortFor(cfg, cameraName) {
	const fleet = cfg?.cameras;
	if (!Array.isArray(fleet)) {
		throw new Error(`relayPortFor: config.cameras is missing — the relay port for ${JSON.stringify(cameraName)} is a property of the camera's position in the camera fleet (PORCH-154)`);
	}
	// Default comparison throughout: codepoint order, both sides of the law.
	const sorted = fleet.map((c) => c?.name).sort();
	const position = sorted.indexOf(cameraName);
	if (position === -1) {
		throw new Error(`relayPortFor: camera ${JSON.stringify(cameraName)} is not in the config's camera fleet — relay ports come from each camera's sorted position, so unknown names cannot be placed (fleet: ${sorted.join(", ")})`);
	}
	return (cfg.streams?.base ?? DEFAULT_STREAM_BASE) + 1 + position;
}

/**
 * The ffmpeg `-i` value for a url camera record: the manager's localhost
 * mpegts relay socket. This — never camera.source.url — is the ingest input
 * of every real-camera recording (PORCH-154): the manager holds the only
 * upstream connection and fans its copy lane to every relay consumer.
 * @param {{cameras?: import("./types.js").CameraConfig[], streams?: {base?: number}}} cfg
 * @param {string} cameraName
 * @returns {string}
 */
export function relayInputFor(cfg, cameraName) {
	return `tcp://127.0.0.1:${relayPortFor(cfg, cameraName)}`;
}

/**
 * Build the full ffmpeg argv for one camera recording into root.
 * The output template uses strftime so every segment lands at
 * <root>/<YYYY-MM-DD>/<HH>/<camera>/<HHMMSS>.part (UTC — the daemon spawns
 * ffmpeg with TZ=UTC).
 *
 * Hardware decisions: the synthetic branch's encoder defaults come from the
 * backend instance (`hal`, defaulting to the running host) so the same argv
 * builder runs unmodified against any HAL implementation. The url branch
 * carries NO hardware decode — the manager's upstream ffmpeg decodes the
 * camera (PORCH-154); the recorder only copies its relayed mpegts.
 * @param {import("./types.js").CameraConfig} camera
 * @param {{segmentSeconds: number, cameras?: import("./types.js").CameraConfig[],
 *   streams?: {base?: number}}} cfg the config of record — the camera fleet
 *   and streams.base place the camera on the manager relay (relayInputFor)
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
		// PORCH-154: this input is a LOCAL test signal generated in-process by
		// ffmpeg — not a camera connection (documented, not hidden); relay
		// input argv exists only on the url branch above.
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
		// PORCH-154 recording input law — this `-i` is the stream manager's
		// localhost mpegts relay, not the camera. The single upstream
		// connection per camera belongs to the manager: hardware decode
		// (hal.videoDecodeArgs) and -rtsp_transport tcp now ride the manager's
		// upstream ffmpeg (packages/stream/src/args.js), not the recorder.
		// camera.source.url never appears in a recorder ffmpeg command.
		//
		// The relay carries the manager's FULL mpegts copy lane (video copy +
		// audio copy), so `-c:v copy` and the audioMode transcode/copy
		// decision below are unchanged shape.
		if (camera.source.loop) argv.push("-stream_loop", "-1");
		argv.push("-i", relayInputFor(cfg, camera.name), "-map", "0:v:0", "-map", "0:a:0?");
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
