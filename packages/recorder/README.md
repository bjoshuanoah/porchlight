# @porchlight/recorder — segment recorders + endurance soak (PORCH-127)

Per-camera **Recorder daemons** (Node child-process managers over native
ffmpeg — fMP4 segment writing, atomic finalize-on-crash, gap audit tooling,
rolling retention, headless launchd autostart, and the 7-day deployment soak
harness). Hardware codec decisions stay with the platform HAL
(`@porchlight/hal`): hardware encode shapes the synthetic soak branch, and
hardware decode lives on the stream manager's upstream ffmpeg (PORCH-154).
Engine initiative:
Porchlight Home — Engine (recording, detection, inference). Camera count is
a deployment input; nothing here builds to a specific fleet.

## Layout of record

```
<storageRoot>/<YYYY-MM-DD>/<HH>/<camera>/<HHMMSS>.mp4   (UTC names, Frigate-shaped)
                     .part                              (in-progress; finalize = atomic rename)
```

ffmpeg runs with `TZ=UTC` and `-strftime 1`, so each segment's name is its
UTC start. A segment spans from its start to the next segment's start — the
coverage model the gap audit uses.

## Recorder daemon (one per camera)

- ffmpeg holds one long-lived ingest per camera — and for url cameras that
  input is **the stream manager's localhost relay, never the camera itself**
  (the PORCH-154 single-upstream law): `-i tcp://127.0.0.1:<port>` where
  `<port>` is `streams.base + 1 + <the camera's position in the name-sorted
  fleet>` (plain codepoint `Array.prototype.sort()`, not localeCompare — the
  exact formula `@porchlight/stream` uses for its relay listeners, pinned by
  the PORCH-154 shared contract). The recorder carries no camera argv at all
  (no hardware decode, no `-rtsp_transport`): `camera.source.url` never
  appears in a recorder ffmpeg command; only packages/stream opens the
  camera, and its copy lane rides the relay to this writer. Consumers
  (detection, live grid, transcription) ride the same manager — nobody but
  the stream package opens camera connections.
- fMP4 segments: `-f segment` with `movflags=+frag_keyframe+empty_moov+default_base_moof`
  (proven shaping pattern; MSE-safe).
- **Finalize-on-crash**: segments are written as `<HHMMSS>.part`; once the
  muxer opens a newer segment (or the process exits) the daemon renames the
  settled one to `.mp4` — atomic on the same volume. After a crash the orphan
  `.part` is probed: playable fragments are finalized (empty_moov keeps moof
  fragments readable), unrecoverable fragments are deleted — they become a
  **gap the audit reports**, never a corrupt file a player chokes on.
- Restart with capped backoff (1s→60s, reset after 5 stable minutes); a
  stalled writer (input hangs without exiting) is killed and respawned.
- Audio: default `-c:a aac -ar 16000` — **PCM ingest (8 kHz-class vendor
  adapters) is transcoded to AAC/16 kHz at ingest** for browser MSE
  compatibility. `audioMode: "copy"` is the opt-out for known-AAC cameras.
- Synthetic soak cameras stay local: the lavfi branch builds its own test
  signal inside the recorder daemon — a local test signal is not a camera
  connection (documented per the PORCH-154 shared contract, not hidden).

## Supervision

`RecorderSupervisor` runs all camera daemons, writes
`<storageRoot>/recorder-state.json` every 2s, sweeps rolling retention every
10 minutes (prune → optional cold archive move → disk-usage watchdog with a
`storage.high-water` event — never a silent stall), and serves
`GET http://127.0.0.1:8971/health` (per-camera state, restarts, events).

## CLI

```sh
node bin/recorder.js supervise --config recorder.yaml   # headless entrypoint (launchd)
node bin/recorder.js audit --config recorder.yaml --probe [--since ISO --until ISO]
node bin/recorder.js prune --config recorder.yaml
node bin/recorder.js launchd --config recorder.yaml [--out FILE]
```

`audit` exits nonzero when gaps exist (or, with `--probe`, when any final
segment is unreadable or has an implausible duration). The audit treats a
segment start-diff up to `segmentSeconds + tolerance` as coverage (keyframe
alignment makes real segments a little longer than the nominal window).

## Headless autostart (ac-2)

`launchd` prints a LaunchAgent plist with `RunAtLoad` (auto-start at boot or
login, headless-safe) + `KeepAlive` (relaunch when the process dies — power
loss, crash). Install on the deployment Mac:

```sh
node bin/recorder.js launchd --config recorder.yaml --out ~/Library/LaunchAgents/com.porchlight.recorder.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.porchlight.recorder.plist
```

## Endurance soak (ac-1)

The soak runs the **full production stack** (supervisor + real ffmpeg
daemons) against a synthetic fleet (lavfi test sources, VideoToolbox-encoded
video, PCM sine audio feeding the same AAC/16 kHz transcode branch a vendor
adapter's PCM ingest takes):

```sh
node soak/run-soak.mjs --root ~/porchlight-soak/store \
  --cameras soakhawk-1,soak-cam-2,soak-cam-3 \
  --segment-seconds 600 --retention-days 2 --audit-interval-ms 1800000
```

Default duration is **unbounded** (the real 7-day wall-clock run under
launchd supervision; audit summaries land in the log every interval). A
bounded `--duration-ms` run exits nonzero if the final audit finds gaps or
corrupt files. Verifying the soak window:

```sh
node bin/recorder.js audit --config <config> --probe --since <soak-start ISO> --until <now ISO>
```

Camera count is a deployment input (`--cameras a,b,c`); the synthetic fleet
is a stand-in for the deployment's cameras, exercising every recorder path
short of RTSP itself.

## Config

JSON or YAML (the platform config store keeps it versioned; restarts replay
the same document). Required: `storageRoot`, `cameras[]` (`name`, `source.url`
or `source.synthetic`, optional `audioMode`). Optional: `segmentSeconds`
(600), `retentionDays` (7), `coldRoot`, `highWaterFraction` (0.9), `port`
(8971), `ffmpegPath`/`ffprobePath`, `statePath`, `streams.base` (8972 — the
stream manager's base port; its relay listeners sit at
`base + 1 + sortedIndex(cameraName)` per the PORCH-154 shared contract, and
the recorder re-derives the identical number for each url camera's `-i`).

## Tests

```sh
npm test                      # deterministic unit matrix (no ffmpeg needed)
PORCHLIGHT_E2E=1 npm test     # + real ffmpeg: accelerated soak, crash
                              #   recovery, PCM→AAC/16k + AAC-copy ingest
```
