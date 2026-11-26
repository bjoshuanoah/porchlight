// types.js — shared JSDoc types for the recorder package (PORCH-127).

/**
 * @typedef {Object} CameraSource
 * @property {string} [url] RTSP/HTTP/file URL to ingest ("-hwaccel videotoolbox" branch).
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
 */

/**
 * @typedef {Object} RecorderConfig
 * @property {string} storageRoot Absolute path; the segment store root.
 * @property {CameraConfig[]} cameras May be empty (fresh deployment boots idle; PORCH-134).
 * @property {number} [segmentSeconds] Default 600.
 * @property {number} [retentionDays] Rolling buffer window (default 7).
 * @property {string} [coldRoot] Optional cold-archive root (moves instead of deleting).
 * @property {number} [highWaterFraction] Disk-usage watchdog threshold (default 0.9).
 * @property {number} [port] Health port (default 8971, bound to 127.0.0.1).
 * @property {string} [statePath] Supervisor state file (default <root>/recorder-state.json).
 * @property {string} [ffmpegPath] Default "ffmpeg".
 * @property {string} [ffprobePath] Default "ffprobe".
 */
