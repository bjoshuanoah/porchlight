// args.js — upstream ffmpeg argv construction for the stream manager (PORCH-154).
// Pure module: the unit layer of every stream decision.
//
// Binding constraints (PORCH-154 contract):
//   - ONE ffmpeg child per camera, ONE `-i` for network cameras; hardware
//     decode choices come from the HAL backend (`hal.videoDecodeArgs()`),
//   - four output lanes of record, always the same byte destinations:
//       pipe:1  video-copy mpegts (audio transcoded AAC/16 kHz once, at the
//               single upstream — mpegts cannot carry raw PCM demuxably)
//               → relay / recorder,
//       pipe:3  rgb24 rawvideo (in-process consumers),   ported at rgbFps,
//       pipe:4  mjpeg (live grid),                        ported at jpegFps,
//       pipe:5  f32le mono 16 kHz PCM (audio consumers),
//   (the contract's `-fps <n>` lane-rate shorthand is ffmpeg's output
//    framerate flag `-r <n>` on the wire — real ffmpeg has no `-fps` option)
//   - `-rtsp_transport tcp` on every rtsp://rtsps:// ingest,
//   - synthetic cameras: lavfi testsrc2/sine to the SAME lanes. The mpegts
//     lane of a synthetic origin cannot use `-c:v copy` (lavfi emits raw
//     video), so it encodes through the HAL's hardware encoder — the same
//     decision the recorder's synthetic branch makes (PORCH-127 args.js).
//
// source.url visibility law: this module is part of packages/stream — the
// only plane allowed to read source.url (plus config-plane registration of
// record). Consumers never open camera connections directly.

import { createHal } from "@porchlight/hal";

/** Lane destinations (ffmpeg fd numbers — 1 = stdout, then extras 3/4/5). */
export const STREAM_LANE = Object.freeze({ mpegts: "pipe:1", rgb: "pipe:3", jpeg: "pipe:4", pcm: "pipe:5" });

/** The stdio layout of record: fd 0 ignored, fd 1 mpegts, fd 2 stderr,
 *  fd 3 rgb, fd 4 jpeg, fd 5 pcm. The parent reads child.stdout and
 *  child.stdio[3..5]. */
export const STREAM_STDIO = Object.freeze(["ignore", "pipe", "pipe", "pipe", "pipe", "pipe"]);

/** PCM lane of record: mono f32le at 16 kHz (matches @porchlight/audio's
 *  AudioChunk contract exactly). */
export const PCM_SAMPLE_RATE = 16000;

/**
 * Resolve the demux dimensions of a camera's video lane.
 * Synthetic: parsed from source.synthetic.size (default 1280x720 — the
 * recorder's soak default). URL camera: source.width/source.height, written
 * by config-plane registration from the ffprobe probe — a URL camera without
 * them returns null and the source refuses to open (state "down" naming the
 * missing dims; never a silent failure, never an upstream connection).
 * @param {import("./types.js").StreamCamera} camera
 * @returns {{ w: number, h: number } | null}
 */
export function resolveStreamDimensions(camera) {
	const source = camera?.source;
	if (source?.synthetic && typeof source.synthetic === "object") {
		const size = String(source.synthetic.size ?? "1280x720");
		const m = /^(\d+)x(\d+)$/.exec(size);
		if (!m) return null;
		return { w: Number(m[1]), h: Number(m[2]) };
	}
	if (typeof source?.url === "string") {
		const { width, height } = source;
		if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) return null;
		return { w: width, h: height };
	}
	return null;
}

/**
 * Build the full upstream ffmpeg argv for one camera. Every lane block maps
 * explicitly so the byte destinations stay stable for any fleet shape.
 * @param {import("./types.js").StreamCamera} camera
 * @param {{ rgbFps?: number, jpegFps?: number }} cfg
 * @param {ReturnType<typeof import("@porchlight/hal").createHal>} [hal]
 * @returns {string[]}
 * @throws {Error} when the camera carries neither source.url nor source.synthetic
 */
export function buildStreamArgs(camera, cfg, hal = createHal()) {
	const cfgRgb = cfg?.rgbFps ?? 10;
	const cfgJpeg = cfg?.jpegFps ?? 5;
	const argv = ["-hide_banner", "-loglevel", "warning", "-nostdin"];

	if (camera.source?.synthetic && typeof camera.source.synthetic === "object") {
		// Synthetics ride the manager like any camera (the lavfi signal is a
		// local test signal, not a camera connection — documented, not hidden);
		// recorder consumes the relay like any camera source of record.
		const s = camera.source.synthetic;
		const fps = s.fps ?? 12;
		const enc = hal.videoEncode();
		argv.push("-re", "-f", "lavfi", "-i", `testsrc2=size=${s.size ?? "1280x720"}:rate=${fps}`);
		const hasAudio = s.audio !== false;
		if (hasAudio) {
			argv.push(
				"-re", "-f", "lavfi", "-i",
				`sine=frequency=${s.audioFreq ?? 440}:sample_rate=${s.audioSampleRate ?? 8000}`,
			);
		}
		// mpegts lane: encode raw lavfi video through the HAL's hardware
		// encoder; audio transcoded to AAC/16 kHz (the recorder ingest shape).
		// -bsf:v dump_extra repeats SPS/PPS per keyframe (the hardware encoder
		// carries them as extradata — a mid-stream recorder join demuxes
		// nothing without them; verified on-host).
		argv.push(
			"-map", "0:v:0", "-c:v", s.encoder ?? enc.name, "-pix_fmt", enc.pixFmt,
			"-b:v", s.bitrate ?? "500k", "-g", String(fps * 2), "-bsf:v", "dump_extra",
		);
		if (hasAudio) {
			argv.push("-map", "1:a:0?", "-c:a", "aac", "-ar", String(PCM_SAMPLE_RATE), "-b:a", "96k");
		}
		argv.push("-f", "mpegts", STREAM_LANE.mpegts);
		// rgb + jpeg lanes map the lavfi video input directly.
		argv.push(
			"-map", "0:v:0", "-r", String(cfgRgb), "-pix_fmt", "rgb24", "-f", "rawvideo", STREAM_LANE.rgb,
			"-map", "0:v:0", "-r", String(cfgJpeg), "-q:v", "5", "-f", "mjpeg", STREAM_LANE.jpeg,
		);
		if (hasAudio) {
			argv.push("-map", "1:a:0?", "-f", "f32le", "-ac", "1", "-ar", String(PCM_SAMPLE_RATE), STREAM_LANE.pcm);
		}
	} else if (typeof camera.source?.url === "string") {
		const url = camera.source.url;
		// Decode argv is the host's platform capability, decided by the HAL
		// (VideoToolbox on macOS); with -c:v copy the flag is inert but present
		// on every real-camera ingest command.
		argv.push(...hal.videoDecodeArgs());
		if (url.startsWith("rtsp://") || url.startsWith("rtsps://")) {
			argv.push("-rtsp_transport", "tcp");
		}
		if (camera.source.loop) argv.push("-stream_loop", "-1");
		argv.push("-i", url, "-map", "0:v:0", "-map", "0:a:0?");
		// mpegts lane: video copy passthrough; audio TRANSCODED ONCE, here at
		// the single upstream — mpegts cannot carry raw PCM demuxably (it
		// surfaces as bin_data downstream), so `-c:a copy` is refused by
		// contract amendment. Vendor PCM ingest still meets the MSE contract:
		// the manager emits AAC/16 kHz, and the recorder's transcode branch
		// re-encodes AAC→AAC/16 kHz (one extra generational loss, accepted at
		// build and documented in the package README).
		// -bsf:v dump_extra: a recorder ffmpeg joining MID-STREAM must see the
		// parameter sets — dump_extra repeats SPS/PPS in-band before every
		// keyframe (no-op for AnnexB in-band camera streams, which carry no
		// extradata; verified on-host: mid-join without it demuxes nothing).
		argv.push(
			"-map", "0:v:0", "-c:v", "copy", "-bsf:v", "dump_extra",
			"-map", "0:a:0?", "-c:a", "aac", "-ar", String(PCM_SAMPLE_RATE), "-b:a", "96k",
			"-f", "mpegts", STREAM_LANE.mpegts,
		);
		argv.push(
			"-map", "0:v:0", "-r", String(cfgRgb), "-pix_fmt", "rgb24", "-f", "rawvideo", STREAM_LANE.rgb,
			"-map", "0:v:0", "-r", String(cfgJpeg), "-q:v", "5", "-f", "mjpeg", STREAM_LANE.jpeg,
			"-map", "0:a:0?", "-f", "f32le", "-ac", "1", "-ar", String(PCM_SAMPLE_RATE), STREAM_LANE.pcm,
		);
	} else {
		throw new Error(`camera ${camera.name}: needs source.url or source.synthetic`);
	}
	return argv;
}
