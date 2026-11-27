// types.js — shared JSDoc types for the recorder package (PORCH-127).

/**
 * @typedef {Object} CameraSource
 * @property {string} [url] Camera/file source URL. PORCH-154: this URL is the
 *   stream manager's upstream — only packages/stream opens it; the recorder
 *   ingests the manager's localhost relay instead.
 * @property {boolean} [loop] For file sources: loop indefinitely (soak fixtures).
 * @property {{
 *   size?: string, fps?: number, encoder?: string, bitrate?: string,
 *   audio?: boolean, audioFreq?: number, audioSampleRate?: number,
 * }} [synthetic] Soak-only lavfi test source (PCM audio + VideoToolbox-encoded video).
 */

/**
 * @typedef {Object} CameraConfig
 * @property {string} name Safe identifier ([A-Za-z0-9._-]+), the path component.
 * @property {CameraSource} source
 * @property {"transcode"|"copy"} [audioMode] Default "transcode": PCM → AAC/16 kHz.
 * @property {"continuous"|"event"} [recordingMode] Writer-layer mode (TS 10,
 *   ac-3). Default "continuous". "event" keeps a bounded staging ingest and
 *   writes store segments only while an event window is open.
 * @property {number} [preRollSeconds] Event-mode pre-roll (default 10) —
 *   honored at segment granularity: the settled staging segments covering
 *   the pre-roll window are promoted with the event.
 * @property {number} [postRollSeconds] Event-mode post-roll (default 30):
 *   the event window stays open this long after the last trigger.
 */

/**
 * @typedef {Object} RetentionRule
 * @property {string} [cameraId] Scope to one camera when set.
 * @property {string} [eventClass] Scope to one detection class when set.
 * @property {string} [zoneId] Scope to one zone when set (refinement: the
 *   rule is stored and rendered; evaluation binds on camera/class today).
 * @property {number} keepDays Minimum days the matching event footage stays.
 */

/**
 * @typedef {Object} RecorderConfig
 * @property {string} storageRoot Absolute path; the segment store root.
 * @property {CameraConfig[]} cameras May be empty (fresh deployment boots idle; PORCH-134).
 * @property {number} [segmentSeconds] Default 600.
 * @property {number} [retentionDays] Rolling buffer window (default 7).
 * @property {string} [coldRoot] Optional cold-archive root (moves instead of deleting).
 * @property {number} [highWaterFraction] Disk-usage watchdog threshold (default 0.9).
 * @property {string} [failoverRoot] Optional failover storage location (ac-2): the
 *   degraded-write target when the primary fails. Failback is always manual.
 * @property {number} [eventRetentionDays] Event-footage window (default 30).
 *   Event segments live in <root>/events — the event retention class, never
 *   the rolling buffer (two-class law, PRD 10).
 * @property {RetentionRule[]} [retentionRules] Keep rules evaluated over the
 *   event tier (TS 10); protected manual segments ignore every rule.
 * @property {string} [busUrl] Optional MQTT bus (the engine's event bus, ac-4):
 *   storage state publishes on porchlight/engine/storage/state and detection
 *   events drive event-mode recording from porchlight/engine/detections/+.
 * @property {number} [healthProbeMs] Drive-health probe cadence (default 30000).
 * @property {number} [port] Health port (default 8971, bound to 127.0.0.1).
 * @property {{ base?: number }} [streams] PORCH-154: the stream manager's ONE
 *   config knob — its base port (optional integer >= 1024, default 8972).
 *   Relay listeners sit at `base + 1 + sortedIndex(cameraName)`; the recorder
 *   re-derives the identical formula at spawn time (args.js relayPortFor).
 *   validateConfig checks it; resolveDefaults leaves it untouched.
 * @property {string} [statePath] Supervisor state file (default <root>/recorder-state.json). Note: written beside the store; when the store is
 *   unavailable this write fails and the state names it (ac-2).
 * @property {string} [ffmpegPath] Default "ffmpeg".
 * @property {string} [ffprobePath] Default "ffprobe".
 */
