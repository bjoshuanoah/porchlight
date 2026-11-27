# @porchlight/stream — Porchlight engine stream serving (PORCH-154)

One upstream connection per camera, demuxed into the four lanes of record,
then served to every consumer. The stream manager is the ONLY engine plane
that opens camera connections; the recorder records from the relay URL, and
detection / audio / live view ride in-process subscriptions or localhost
listeners — a camera drop heals itself (capped backoff, recorder-style stable
reset) with `up`/`down` events on the engine bus, and consumer-count changes
add ZERO upstream camera load.

## The subscriber-mechanism build decision (and its evidence)

The task offered consumer-feeding shapes ranging from per-consumer ffmpeg
decodes (an extra camera connection per viewer — refused by the hard law) to
a full media server. Landed middle path, three mechanisms, all localhost:

1. **In-process pub/sub** — `subscribeFrames` / `subscribeAudio` /
   `subscribeImages` deliver rgb24 frames, `AudioChunk`-shaped PCM, and jpeg
   frames to every consumer in the manager's own process (detection, audio
   analysis, the live-grid feed). Zero serialization, zero extra sockets, and
   the delivery loop is error-isolated per subscriber: a throwing consumer
   never blocks the pipeline.
2. **Per-camera localhost TCP relay** (`127.0.0.1:<base + 1 + sortedIndex(name)>`,
   plain codepoint sort) fans the mpegts copy lane byte-for-byte to any
   number of socket consumers (the recorder of record is consumer #1).
   Backpressure is normal traffic, not failure: a consumer is disconnected —
   alone, with the explained reason in the log — only when its queued bytes
   persist past the stall window (`relayStallMs`, default 500 ms) with no
   drain event, or exceed the absolute memory cap (`relayBufferMax`,
   4 MiB default). A healthy consumer with momentary backpressure survives
   (a drain clears the stall clock); a stalled consumer can never
   back-pressure the camera lane or another consumer.
3. **Localhost MJPEG live view** (`GET /live/:name`, multipart/x-mixed-replace)
   serves the latest jpeg frame with true latest-frame semantics: while the
   response is busy, newer frames REPLACE the pending one, so a slow viewer
   sees the newest picture instead of a growing backlog.

Evidence: the e2e matrix (`test/e2e.stream.test.js`) runs over real
`node:net` with ffmpeg excluded via the injected factory — the connection
count law (camera saw EXACTLY ONE connection with five consumers attached),
the power-cycle law (up→down→up on the bus, subscribers re-fed without
manual action), and load parity (byte-identical camera output between a
recorder-only and a five-consumer run).

## Consumers of record

| consumer | mechanism | surface |
| --- | --- | --- |
| @porchlight/recorder | relay TCP (mpegts) | `tcp://127.0.0.1:<relayPort>` — the relay URL replaces `-i <source.url>` in buildFfmpegArgs |
| @porchlight/detection | in-process frames | `subscribeFrames(name, fn)` |
| @porchlight/audio | in-process audio | `subscribeAudio(name, fn)` — chunk shape equals AudioChunk `{camera, t, sampleRate: 16000, data: Float32Array}` |
| live grid / console | in-process images + MJPEG | `subscribeImages(name, fn)`, `GET /live/:name` |

## The mpegts lane audio decision (contract amendment)

The relay lane is `-map 0:v:0 -c:v copy` plus `-map 0:a:0? -c:a aac -ar 16000
-b:a 96k` in the single `-f mpegts pipe:1` output: mpegts cannot carry raw PCM
demuxably (it surfaces as `bin_data` downstream — verified on-host by the
recorder slice's e2e), so audio is transcoded ONCE, here at the single
upstream. A vendor PCM ingest still meets the browser MSE contract: the
manager emits AAC/16 kHz, and the recorder's transcode branch re-encodes
AAC→AAC/16 kHz — one extra generational loss, accepted at build. Mid-stream
joins must see parameter sets, so the single upstream repeats SPS/PPS before
every keyframe (`-bsf:v dump_extra` on the relay lane). The standalone
f32le 16 kHz PCM lane (`pipe:5`) stays exactly as contracted for the audio
analysis consumers.

## Control HTTP (127.0.0.1:<streams.base>, default 8972)

- `GET /health` — aggregate state + per-camera rows (`opening|live|down`,
  reason, at, relayPort, consumers).
- `POST /api/cameras/apply` — `{cameras}` live-apply; 200 with the diff and
  health rows, 422 with the plain-language reason.
- `GET /cameras/:id` — one health row or 404.
- `GET /live/:name` — MJPEG; 404 unknown camera, 503 non-live with reason.

Relay ports derive from ONE knob of record (`streams.base`, default 8972):
`base + 1 + sortedIndex(name)` over the codepoint-sorted fleet — the same
formula on both sides, never a second copy.

## Bus events

`porchlight/engine/streams/<camera>/up|down`, payload
`{camera, state, reason, at}` on every source connect/disconnect
(MqttStreamHealthPublisher; NullStreamHealthBus when no `busUrl` is
configured — green-field law).

## Files

- `src/args.js` — pure upstream argv builder + dimension resolution.
- `src/source.js` — CameraSource: one demux handle per camera, lane parsers,
  capped-backoff reconnect with the 5-stable-minute reset.
- `src/manager.js` — StreamManager: fleet diff, relay listeners, control
  HTTP, MJPEG, subscriptions, health aggregation.
- `src/health-bus.js` — MQTT + Null stream health bus.
- `src/config.js` — platform doc load/validate, `resolveStreamBase`.
- `bin/stream.js` — `stream supervise --config FILE` (launchd entrypoint).

## Sourcing law + benchmark gating

`source.url` is read ONLY here (plus the config plane's registration of
record) — enforced by `test/audit.test.js` across every engine package.

Live-view latency classes and concurrent-viewer behavior are
**benchmark-gated**: the joint PORCH-154 benchmark run owns those numbers and
none are invented in this package. What is proven deterministically here is
structural: one upstream connection, bounded per-consumer buffering, and
latest-frame MJPEG semantics.
