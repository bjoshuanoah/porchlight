// index.js — public surface of @porchlight/recorder (PORCH-127).

export { buildFfmpegArgs, buildFfmpegCommand, resolveAudioMode, partPathTemplate, AUDIO_TRANSCODE, SEGMENT_MOVFLAGS } from "./args.js";
export { RecorderDaemon } from "./recorder.js";
export { RecorderSupervisor } from "./supervisor.js";
export { finalizePlan, finalizeSegment, finalPathOf, recoverSegment, probeDuration } from "./finalize.js";
export { auditStorage, probeCorrupt } from "./audit.js";
export { pruneRolling, retentionWatchdog, diskUsage, keepFloorMs } from "./retention.js";
export { buildLaunchAgentPlist, launchAgentPath, launchctlCommands } from "./launchd.js";
export { loadConfig, validateConfig, resolveDefaults } from "./config.js";
export {
	partPath,
	segmentDir,
	segmentBaseName,
	dateDirName,
	hourDirName,
	dayStart,
	listSegments,
	listDateDirs,
	parseSegmentRelPath,
	DAY_MS,
} from "./paths.js";
