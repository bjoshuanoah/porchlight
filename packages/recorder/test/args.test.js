// args.test.js — ffmpeg argv construction (PORCH-127 binding constraints)
// and the PORCH-154 recording input law: a url camera's `-i` is the stream
// manager's localhost relay, ported from the name-sorted fleet.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AUDIO_TRANSCODE, SEGMENT_MOVFLAGS, buildFfmpegArgs, buildFfmpegCommand, relayInputFor, relayPortFor, resolveAudioMode } from "../src/args.js";
import { LinuxBackend, resolveHal } from "@porchlight/hal";

// PORCH-154 fleet of record: a url camera's relay port is a property of its
// position in the name-sorted fleet, so every url-camera test uses a member
// of this fleet. "Lobby" is the deliberate trap — plain Array.prototype.sort
// (codepoint order) puts "L" before every lowercase letter; localeCompare
// would sort case-insensitively and place it last of these.
const CFG = {
	segmentSeconds: 600,
	streams: { base: 9500 },
	cameras: [
		{ name: "Lobby", source: { url: "rtsp://cam/kiosk" } },
		{ name: "back_lot", source: { url: "rtsp://cam/b" } },
		{ name: "front_left", source: { url: "rtsp://cam/l" } },
		{ name: "zoom_deck", source: { url: "rtsp://cam/z" } },
	],
};

/**
 * The PORCH-154 port formula recomputed independently of args.js (this test
 * file must not delegate to the function under test): base + 1 + the
 * camera's index in the plain codepoint-sorted fleet.
 * @param {typeof CFG} cfg
 * @param {string} cameraName
 */
function expectedRelayPort(cfg, cameraName) {
	const sorted = cfg.cameras.map((c) => c.name).sort();
	const i = sorted.indexOf(cameraName);
	assert.notEqual(i, -1, `fixture bug: ${cameraName} is not in the fleet`);
	return (cfg.streams?.base ?? 8972) + 1 + i;
}

test("url camera: `-i` is the manager relay, port recomputed from the sorted fleet", () => {
	// The darwin backend is injected explicitly to PIN that the url branch is
	// hal-free since PORCH-154: decode argv lives on the manager's upstream.
	const argv = buildFfmpegArgs(
		{ name: "front_left", source: { url: "rtsp://cam/l" } },
		CFG,
		resolveHal({ platform: "darwin" }),
	);
	// Independent recomputation + literal: codepoint sort places "Lobby" (0),
	// "back_lot" (1), "front_left" (2) → 9500 + 1 + 2 = 9503.
	const expectedPort = expectedRelayPort(CFG, "front_left");
	assert.equal(expectedPort, 9503, "fleet of record sorts Lobby, back_lot, front_left, zoom_deck");
	assert.deepEqual(
		argv.slice(argv.indexOf("-i"), argv.indexOf("-i") + 2),
		["-i", "tcp://127.0.0.1:9503"],
	);
	// The camera URL is the manager's upstream problem; it never appears in a
	// recorder ffmpeg command (PORCH-154).
	assert.ok(!argv.includes("rtsp://cam/l"), `source.url leaked into recorder argv: ${argv.join(" ")}`);
	// Upstream-only argv stays upstream: no hardware decode, no rtsp transport
	// on a relay input (the manager's source connection owns both).
	assert.ok(!argv.includes("-hwaccel"));
	assert.ok(!argv.includes("-rtsp_transport"));
	// Relay carries the manager's FULL mpegts copy lane: video copy + the
	// default audioMode transcode branch are unchanged shape.
	assert.deepEqual(
		argv.slice(argv.indexOf("-c:v"), argv.indexOf("-c:v") + 2),
		["-c:v", "copy"],
	);
	assert.deepEqual(
		argv.slice(argv.indexOf("-c:a"), argv.indexOf("-c:a") + 2),
		["-c:a", AUDIO_TRANSCODE.codec],
	);
	assert.ok(argv.includes("-ar") && argv.includes(String(AUDIO_TRANSCODE.sampleRate)));
	// fMP4 segment tail untouched (PORCH-127 binding constraints).
	assert.deepEqual(
		argv.slice(argv.indexOf("-f", 8)).slice(0, 2),
		["-f", "segment"],
	);
	assert.ok(argv.includes(`movflags=${SEGMENT_MOVFLAGS}`));
	assert.ok(argv.some((a) => a.includes("movflags=+frag_keyframe+empty_moov")));
	const tmpl = argv[argv.length - 1];
	assert.equal(tmpl, "./%Y-%m-%d/%H/front_left/%H%M%S.part");
	assert.deepEqual(argv.slice(argv.indexOf("-segment_time"), argv.indexOf("-segment_time") + 2),
		["-segment_time", "600"]);
	assert.ok(argv.includes("-strftime"));
});

test("audioMode defaults to transcode; copy is the explicit opt-out", () => {
	assert.equal(resolveAudioMode({ name: "a", source: { url: "rtsp://x" } }), "transcode");
	const argv = buildFfmpegArgs(
		{ name: "back_lot", source: { url: "rtsp://x" }, audioMode: "copy" },
		CFG,
	);
	assert.ok(argv.includes("copy"));
	assert.ok(!argv.includes("-ar"));
});

test("synthetic soak camera: VideoToolbox encoder + PCM routed through the same AAC/16k branch", () => {
	const argv = buildFfmpegArgs(
		{
			name: "soak-1",
			source: {
				synthetic: { size: "640x360", fps: 12, encoder: "h264_videotoolbox", bitrate: "500k" },
			},
		},
		CFG,
	);
	assert.ok(argv.includes("h264_videotoolbox"));
	assert.ok(!argv.includes("-hwaccel")); // encode path, not decode path
	assert.ok(argv.some((a) => a.startsWith("testsrc2=")));
	assert.ok(argv.some((a) => a.startsWith("sine=") && a.includes("sample_rate=8000")));
	assert.ok(argv.includes("-ar") && argv.includes("16000"));
	assert.ok(argv.includes("-g") && argv[argv.indexOf("-g") + 1] === "24");
	// PORCH-154 (documented, not hidden): the synthetic lavfi branch is a
	// LOCAL test signal — not a camera connection, so no relay/tcp input.
	assert.ok(!argv.some((a) => a.startsWith("tcp://")), "synthetic ingest must stay local");
	const tmpl = argv[argv.length - 1];
	assert.equal(tmpl, "./%Y-%m-%d/%H/soak-1/%H%M%S.part");
});

test("synthetic source refuses audioMode copy (PCM has nothing safe to copy)", () => {
	assert.throws(
		() => buildFfmpegArgs(
			{ name: "s", source: { synthetic: {} }, audioMode: "copy" },
			CFG,
		),
		/cannot use audioMode "copy"/,
	);
});

test("camera without a usable source throws", () => {
	assert.throws(() => buildFfmpegArgs({ name: "x", source: {} }, CFG), /needs source/);
});

test("relayPortFor/relayInputFor: the shared formula plus plain-language refusals", () => {
	assert.equal(relayInputFor(CFG, "front_left"), "tcp://127.0.0.1:9503");
	// No streams.base in the config of record → the contract default 8972.
	const noBaseCfg = { segmentSeconds: 600, cameras: CFG.cameras };
	assert.equal(relayPortFor(noBaseCfg, "Lobby"), 8973, "default base 8972 + 1 + sorted index 0");
	// Off-fleet camera: plain-language, naming the camera and the fleet —
	// never a silently wrong relay port.
	assert.throws(
		() => relayPortFor(CFG, "ghost_cam"),
		/is not in the config's camera fleet/,
	);
	// A config without a fleet cannot place anything at all (plain language).
	assert.throws(
		() => relayPortFor({ segmentSeconds: 600 }, "front_left"),
		/config\.cameras is missing/,
	);
});

// PORCH-132 leftover, PORCH-154 scope: hardware decisions come from the HAL.
// The url branch is now hal-free entirely (the manager decodes); the hal
// surface that remains is the synthetic branch's encode defaults.

test("portability: url branch is platform-free — identical argv across hal backends", () => {
	const hal = resolveHal({ platform: "linux" });
	assert.ok(hal instanceof LinuxBackend);
	const urlArgv = buildFfmpegArgs({ name: "front_left", source: { url: "rtsp://cam/l" } }, CFG, hal);
	assert.ok(!urlArgv.includes("videotoolbox"));
	assert.ok(!urlArgv.includes("-hwaccel"));
	assert.ok(urlArgv.includes("tcp://127.0.0.1:9503"));
	// The recorder copies the relay with zero backend-dependent flags: the
	// darwin build must be byte-for-byte the same command.
	const darwinArgv = buildFfmpegArgs(
		{ name: "front_left", source: { url: "rtsp://cam/l" } },
		CFG,
		resolveHal({ platform: "darwin" }),
	);
	assert.deepEqual(urlArgv, darwinArgv);
	const synthArgv = buildFfmpegArgs(
		{ name: "soak-1", source: { synthetic: { size: "640x360", fps: 12 } } },
		CFG,
		hal,
	);
	assert.deepEqual(
		synthArgv.slice(synthArgv.indexOf("-c:v"), synthArgv.indexOf("-c:v") + 2),
		["-c:v", "libx264"],
	);
	assert.deepEqual(
		synthArgv.slice(synthArgv.indexOf("-pix_fmt"), synthArgv.indexOf("-pix_fmt") + 2),
		["-pix_fmt", "yuv420p"],
	);
});

test("portability: hal defaults shape only the synthetic encode branch (darwin: videotoolbox)", () => {
	if (process.platform !== "darwin") return;
	const synthArgv = buildFfmpegArgs({ name: "soak-1", source: { synthetic: { fps: 12 } } }, CFG);
	assert.ok(synthArgv.includes("-c:v") && synthArgv[synthArgv.indexOf("-c:v") + 1] === "h264_videotoolbox");
	// And a url camera on the default hal still carries no decode argv.
	const urlArgv = buildFfmpegArgs({ name: "front_left", source: { url: "rtsp://cam/l" } }, CFG);
	assert.ok(!urlArgv.includes("videotoolbox"));
});

test("portability: buildFfmpegCommand threads the hal backend through", () => {
	const linux = buildFfmpegCommand({ name: "soak-1", source: { synthetic: { fps: 12 } } }, CFG, resolveHal({ platform: "linux" }));
	assert.equal(linux.file, "ffmpeg");
	assert.deepEqual(
		linux.args.slice(linux.args.indexOf("-c:v"), linux.args.indexOf("-c:v") + 2),
		["-c:v", "libx264"],
	);
	const darwin = buildFfmpegCommand({ name: "soak-1", source: { synthetic: { fps: 12 } } }, CFG, resolveHal({ platform: "darwin" }));
	assert.deepEqual(
		darwin.args.slice(darwin.args.indexOf("-c:v"), darwin.args.indexOf("-c:v") + 2),
		["-c:v", "h264_videotoolbox"],
	);
});
