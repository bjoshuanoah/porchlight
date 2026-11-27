# Engine ↔ Overwatch composition seams (PORCH-152)

The mapping of record between this engine's outputs and Overwatch's inputs
(PORCH-I-010 TS 1). Every clause names the code that owns it so the contract
is checkable, not aspirational. The stream manager (PORCH-154) and the
transcription/vector-store consumer (PORCH-155) extend — never redefine —
this document.

## 1. Camera ids: one registry, three mirrors

The **engine camera id of record** is the recorder fleet's camera name —
the platform config of record `<root>/config/config.yaml`
`cameras[].name` (validated by `@porchlight/recorder`'s `CAMERA_NAME_RE`:
a safe path component, letters/digits first).

Three projections exist and must stay 1:1:

| Where | Shape | Writer |
| --- | --- | --- |
| Platform config of record | `cameras[].name` | engine `POST /cameras` (packages/config/src/engine-cameras.js) and the bootstrap config of record |
| Console cameras.yaml | `id` (same value) | `registerStreamCamera` upserts both sides — packages/config/src/baseconfig.js `createCameras` |
| Hub association store | `cameras.engineCameraId` | modules/home camera.service (the value the engine's `POST /cameras` returned as `cameraId`) |

Overwatch keys its per-camera contract (coverage zones, adjacency, travel-
time priors — PORCH-I-010 TS 1) on **these same ids**. Nothing else may mint
a second namespace: `DetectedObject.camera`, event records, and zone
definitions all carry the fleet name. The unit matrix proves the id laws agree
(packages/detection/test/seam.test.js).

## 2. Bus stream: DetectedObject topic family

Producer and consumers share ONE topic family, owned by
modules/home's `ENGINE_DETECTIONS_PREFIX`:

```
porchlight/engine/detections/<camera>/<cls>
```

- Producer of record: packages/detection/src/sink.mqtt.js
  `MqttDetectionSink` publishes the normalized DetectedObject JSON on
  `<topicPrefix>/<camera>/<cls>` (two segments after the prefix).
- Consumers: the recorder's event-mode trigger and the home hub subscribe
  `porchlight/engine/detections/+/+` (the camera segment is `topic.split("/")[3]`),
  and the recognition re-publisher + apps/server use the same shape.
- Payload contract: packages/detection/src/types.js `DetectedObject`
  (camera, trackId, cls, conf, bbox normalized [0,1], t epoch seconds,
  provider, reid?) — field-for-field the shape packages/overwatch/src/types.js
  `DetectedObject` consumes, so the Overwatch entity layer reads the bus
  stream unchanged.

## 3. Composite stream: the evaluation dial's input

The stream manager's composite output (the frame stream the Overwatch
evaluation dial consumes at its cap FPS) is the shape
packages/overwatch/src/compositor.js `stitchComposite`/`evaluate` already
consume:

```
Record<cameraId, { width: number, height: number, data: Uint8Array }>
```

- Keyed by the § 1 camera ids; `data` is raw RGB row-wise (3 bytes/pixel) at
  the tile's source resolution; `layoutVersion` travels alongside per the
  compositor's contract.
- The stream manager (PORCH-154) is the ONLY component allowed to produce it
  for live evaluation; the single-upstream-camera law (one connection per
  camera, every consumer fed) governs where those frames come from.
- The per-camera rgb frame lane is in production: packages/stream
  `StreamManager.subscribeFrames(name, fn)` delivers
  `{ camera, w, h, t, data }` — rgb24 bytes keyed by the § 1 ids, the exact
  shape the compositor's `stitchComposite`/`evaluate` consume (data is the
  row-wise RGB for that camera at its source resolution, `w`×`h`×3 bytes).
- The Overwatch daemon (PORCH-I-010) attaches to the lane via
  `subscribeFrames`. The runtime evaluation wiring (compositing the fleet
  into the dial's input and pacing it at the cap FPS) ships with Overwatch,
  not here — the engine supplies the per-camera lane; nothing in this repo
  calls `evaluate()` yet.

## 4. What Overwatch does NOT get from the engine

Entity chains, coverage-zone authoring, the property map, and follow state
are Overwatch's own (PORCH-I-010). The engine supplies ids, detections, and
frames; it consumes nothing back but the PropertyEntity chains published for
bus consumers.
