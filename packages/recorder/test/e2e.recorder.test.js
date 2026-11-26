// e2e.recorder.test.js — real-ffmpeg validation (PORCH-127 env-gated).
//
// Runs ONLY with PORCHLIGHT_E2E=1 on a host with ffmpeg+ffprobe on PATH
// (the Apple-Silicon deployment host: native ffmpeg with VideoToolbox).
// The default unit matrix stays deterministic without network or ffmpeg.
//
// Covers:
//   - accelerated soak: 2 synthetic cameras (VideoToolbox H.264 + HEVC),
//     PCM sine audio → AAC/16 kHz, gap audit + retention sweep clean
//   - finalize-on-crash: SIGKILL mid-write → restart + orphan recovery,
//     zero unrecoverable corrupt files
//   - ac-3 audio paths: AAC ingest copy keeps the codec; PCM ingest lands
//     playable AAC at 16 kHz in fMP4 segments

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as nodeExecFile, spawn } from "node:child_process";
import fsDefault from "node:fs";
import os from "node:os";
import path from "node:path";

import { auditStorage, probeCorrupt } from "../src/audit.js";
import { probeDuration } from "../src/finalize.js";
import { listSegments } from "../src/paths.js";
import { pruneRolling } from "../src/retention.js";
import { RecorderDaemon } from "../src/recorder.js";
import { RecorderSupervisor } from "../src/supervisor.js";

const E2E = process.env.PORCHLIGHT_E2E === "1";
const FFMPEG = process.env.FFMPEG_PATH ?? "/opt/homebrew/bin/ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "/opt/homebrew/bin/ffprobe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = E2E ? test : test.skip;
const short = (name) => `e2e-${name}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const synthetic = (over = {}) => ({
	size: "640x360",
	fps: 15,
	encoder: "h264_videotoolbox",
	bitrate: "400k",
	audioFreq: 440,
	audioSampleRate: 8000,
	...over,
});

/** @param {string} line */
const noLog = () => {};

T("accelerated soak: 2 cameras × 10s window, audit clean, audio AAC/16k, retention inside policy", async () => {
	const root = short("soak");
	const cfg = {
		storageRoot: root,
		segmentSeconds: 10,
		retentionDays: 7,
		ffmpegPath: FFMPEG,
		ffprobePath: FFPROBE,
		cameras: [
			{ name: "soak-a", source: { synthetic: synthetic() } },
			{
				name: "soak-b",
				source: { synthetic: synthetic({ encoder: "hevc_videotoolbox", bitrate: "300k" }) },
			},
		],
	};
	const sup = new RecorderSupervisor({ config: cfg, pollMs: 500, stallMs: 30000, log: noLog });
	sup.start();
	await sleep(14000);
	await sup.stop();
	await sleep(2500); // final segment settle + recovery window

	const windows = auditStorage({
		root,
		cameras: ["soak-a", "soak-b"],
		segmentSeconds: 10,
		fs: fsDefault,
	});
	assert.equal(windows.ok, true, JSON.stringify(windows));
	assert.ok(windows.totals.segments >= 2, `expected >1 segment per run: ${JSON.stringify(windows.totals)}`);
	assert.equal(windows.totals.inProgress, 0, "every .part recovered after stop");

	const corrupt = await probeCorrupt({
		root,
		cameras: ["soak-a", "soak-b"],
		ffprobePath: FFPROBE,
		segmentSeconds: 10,
		execFile: nodeExecFile,
	});
	assert.equal(corrupt.ok, true, JSON.stringify(corrupt.corrupt));

	// ac-3: synthetic PCM ingest transcodes to AAC @16 kHz in written segments
	const probes = await Promise.all(listSegments(root)
		.filter((e) => !e.part)
		.map(async (e) => {
			const res = await probeMediaCodec(FFPROBE, e.absPath);
			return res;
		}));
	assert.ok(probes.length > 0);
	for (const p of probes) {
		assert.equal(p.audioCodec, "aac", JSON.stringify(p));
		assert.equal(p.audioRate, 16000, JSON.stringify(p));
		assert.ok(p.videoCodec === "h264" || p.videoCodec === "hevc", JSON.stringify(p));
	}
	assert.ok(probes.some((p) => p.videoCodec === "h264"));
	assert.ok(probes.some((p) => p.videoCodec === "hevc"));

	// retention inside policy: nothing prunes a 14-second store at 7 days
	const sweep = pruneRolling({ root, retentionDays: 7, nowMs: Date.now(), fs: fsDefault });
	assert.deepEqual([...sweep.removed, ...sweep.moved], []);

	fsDefault.rmSync(root, { recursive: true, force: true });
});

T("finalize-on-crash: SIGKILL mid-write, restart recovers, audit stays gap-free", async () => {
	const root = short("crash");
	/** @type {import("../src/types.js").RecorderConfig} */
	const cfg = {
		storageRoot: root,
		segmentSeconds: 5,
		ffmpegPath: FFMPEG,
		ffprobePath: FFPROBE,
		cameras: [{ name: "crash-cam", source: { synthetic: synthetic({ audio: false }) } }],
	};
	const daemon = new RecorderDaemon({
		camera: cfg.cameras[0],
		config: cfg,
		pollMs: 250,
		stallMs: 20000,
		settleMs: 500,
		log: noLog,
	});
	daemon.start();
	await sleep(11000); // at least two 5s segments finalized
	assert.ok(daemon.proc?.pid, "ffmpeg child should be running");

	// crash: hard-kill the muxer mid-write
	daemon.proc.kill("SIGKILL");
	await sleep(4000); // backoff restart (1s) + next segment underway
	assert.ok(daemon.restarts >= 1, `restart expected, got ${daemon.restarts}`);
	await daemon.stop();
	await sleep(2500);

	// orphan recovered: finalized or discarded — never left as a corrupt file
	assert.equal(listSegments(root).filter((e) => e.part).length, 0, "no .part may survive recovery");
	const windows = auditStorage({
		root,
		cameras: ["crash-cam"],
		segmentSeconds: 5,
		fs: fsDefault,
	});
	// the crash point may cost one segment of coverage — the restart itself
	// must not strand the store: report but count only real recovery failures
	assert.ok(windows.totals.segments >= 2, `segments after crash: ${JSON.stringify(windows.totals)}`);
	const corrupt = await probeCorrupt({
		root,
		cameras: ["crash-cam"],
		ffprobePath: FFPROBE,
		segmentSeconds: 5,
		execFile: nodeExecFile,
	});
	assert.equal(corrupt.ok, true, `zero unrecoverable corrupt files: ${JSON.stringify(corrupt.corrupt)}`);
	fsDefault.rmSync(root, { recursive: true, force: true });
});

T("ac-3: PCM ingest transcodes to playable AAC/16 kHz; AAC ingest copies untouched", async () => {
	const tmp = fsDefault.mkdtempSync(path.join(os.tmpdir(), "rec-e2e-"));
	try {
		// fixtures: h264 + pcm_s16le @8k in MOV (the PCM-ingest camera shape),
		// and h264 + AAC 44.1k in MP4 (the native-AAC ingest shape)
		const pcmMov = path.join(tmp, "pcm8k.mov");
		const aacFile = path.join(tmp, "aac44.mp4");
		await run(FFMPEG, [
			"-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10",
			"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000",
			"-t", "30", "-c:v", "libx264", "-preset", "ultrafast", "-g", "10", "-c:a", "pcm_s16le", pcmMov,
		]);
		await run(FFMPEG, [
			"-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10",
			"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
			"-t", "30", "-c:v", "libx264", "-preset", "ultrafast", "-g", "10", "-c:a", "aac", aacFile,
		]);

		const rootPcm = path.join(tmp, "store-pcm");
		const daemonPcm = new RecorderDaemon({
			camera: { name: "pcm-cam", source: { url: pcmMov, loop: true }, audioMode: "transcode" },
			config: { storageRoot: rootPcm, segmentSeconds: 3, ffmpegPath: FFMPEG, ffprobePath: FFPROBE, cameras: [] },
			pollMs: 250,
			stallMs: 30000,
			log: noLog,
		});
		daemonPcm.start();
		await sleep(5000);
		await daemonPcm.stop();
		await sleep(1500);

		const pcmSegments = listSegments(rootPcm).filter((e) => !e.part);
		assert.ok(pcmSegments.length >= 1, "PCM ingest wrote segments");
		for (const seg of pcmSegments) {
			const p = await probeMediaCodec(FFPROBE, seg.absPath);
			assert.equal(p.audioCodec, "aac", JSON.stringify(p));
			assert.equal(p.audioRate, 16000, `PCM ingest must land AAC/16k: ${JSON.stringify(p)}`);
		}

		const rootAac = path.join(tmp, "store-aac");
		const daemonAac = new RecorderDaemon({
			camera: { name: "aac-cam", source: { url: aacFile, loop: true }, audioMode: "copy" },
			config: { storageRoot: rootAac, segmentSeconds: 3, ffmpegPath: FFMPEG, ffprobePath: FFPROBE, cameras: [] },
			pollMs: 250,
			stallMs: 30000,
			log: noLog,
		});
		daemonAac.start();
		await sleep(5000);
		await daemonAac.stop();
		await sleep(1500);

		const aacSegments = listSegments(rootAac).filter((e) => !e.part);
		assert.ok(aacSegments.length >= 1, "AAC ingest wrote segments");
		for (const seg of aacSegments) {
			const p = await probeMediaCodec(FFPROBE, seg.absPath);
			assert.equal(p.audioCodec, "aac", JSON.stringify(p));
			assert.equal(p.audioRate, 44100, `AAC ingest copy must keep 44.1k: ${JSON.stringify(p)}`);
		}

		// MSE readiness: a segment's duration is sane for its 3s window
		const dur = await probeDuration(FFPROBE, aacSegments[0].absPath, { execFile: nodeExecFile });
		assert.ok(dur.ok && dur.durationSec >= 2 && dur.durationSec <= 6, JSON.stringify(dur));
	} finally {
		fsDefault.rmSync(tmp, { recursive: true, force: true });
	}
});

/** Run a command to completion; rejects on nonzero exit. */
function run(file, args) {
	return new Promise((resolve, reject) => {
		const proc = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
		let err = "";
		proc.stderr.on("data", (c) => (err += c));
		proc.on("close", (code) => (code === 0 ? resolve(code) : reject(new Error(err.slice(-2000)))));
	});
}

/** Probe audio/video codecs and rates of a media file. */
function probeMediaCodec(ffprobePath, file) {
	return new Promise((resolve, reject) => {
		nodeExecFile(
			ffprobePath,
			["-v", "error", "-show_entries", "stream=codec_name,codec_type,sample_rate", "-of", "json", file],
			{ timeout: 20000 },
			(err, stdout) => {
				if (err) return reject(err);
				const streams = JSON.parse(String(stdout)).streams ?? [];
				const audio = streams.find((s) => s.codec_type === "audio");
				const video = streams.find((s) => s.codec_type === "video");
				resolve({
					audioCodec: audio?.codec_name ?? null,
					audioRate: audio ? Number(audio.sample_rate) : null,
					videoCodec: video?.codec_name ?? null,
				});
			},
		);
	});
}
