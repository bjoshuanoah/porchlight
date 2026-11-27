# @porchlight/detection

Porchlight engine detection service (PORCH-128): the pluggable
`InferenceProvider` seam (the central seam per PORCH-I-009 TS 5), with two
initial providers and normalized `DetectedObject` MQTT publishing.

## InferenceProvider protocol

A provider is a plain object (`src/types.js`):

```js
{
  name: "coreml",
  detect: async (frame) => [{ cls, conf, bbox /* [x,y,w,h] in [0,1] */, t }],
  status: () => ({
    engine: "coreml",
    providerClass: "native-mlx" /* | "openai-spec" | "local-server" */,
    model: "/models/yolo11n.onnx",
    executionTarget: "gpu/ane" /* or "cpu" */,
    state: "native" /* or "cpu" | "degraded" | "failed" */,
    reason: null /* a degradation always states itself */,
  }),
  close: async () => {},
}
```

Registering a new provider (e.g. a future Linux CUDA or OpenVINO backend)
is one call — the detection core never changes:

```js
import { ProviderRegistry } from "@porchlight/detection";
const registry = new ProviderRegistry();
registry.register("cuda", (opts) => new CudaProvider(opts));
const provider = registry.create("cuda", { modelPath: "/models/yolo.onnx" });
```

New providers must respect the never-silent law: any capability degradation
(a CPU fallback, a reduced model) is explicit in `status()` and logged.

## Pipeline

`DetectionService` wires one provider, per-camera ByteTrack-style trackers
(`src/tracker.js`: two-stage IoU association, tentative → confirmed → lost →
deleted lifecycle, constant-velocity prediction), and a `DetectionSink`:

frame → `provider.detect` → trackers → `sink.publish` (per-detection MQTT
topics `porchlight/engine/detections/<camera>/<cls>` — the two-segment topic
family of record, PORCH-152). Frames are `{camera, w, h,
t, format: "rgb"|"rgba"|"jpeg", data}`.

The bus transport itself is owned by the PORCH-129 vetting decision; the
service depends only on the `DetectionSink` interface, so the transport can
re-point without core changes.

## Compute status & re-pointing (PORCH-152)

`DetectionService.status()` is the never-silent compute posture:
`{ stage: "detection", provider: <provider status>, sink: <sink status>,
frames, published, generation }`. Every provider reports all five of
engine / providerClass / model / executionTarget / state — a degradation
(CPU fallback, forced CPU, helper respawn) always carries a `reason`, a
native run reports `reason: null`. A provider that cannot say is a defect,
not a blank.

`service.repoint(provider)` swaps the live provider at runtime: it validates
the `InferenceProvider` protocol, closes the old provider (close errors are
logged, never fatal), increments `generation`, and keeps trackers and sink
untouched — subsequent publishes carry the new provider's `name`, and the
publish contract continues unchanged. The sink is never silent either: an
offline MQTT bus reports `state: "degraded"` with a reason naming the
buffered count.

## Providers

- **CoreML EP** (`src/provider.coreml.js`): `onnxruntime-node` with the
  CoreML Execution Provider — ONNX models (e.g. a YOLO export) run natively
  on Apple Silicon GPU/ANE. The default execution-provider order comes from
  the platform HAL (`@porchlight/hal`). If the accelerated EPs cannot build
  — or a cpu-only session is forced — the provider lands on CPU and says so:
  `status()` reports `state: "cpu"` with the exact logged fallback reason,
  never silent.
- **Vision helper** (`src/provider.vision.js`): Apple Vision primitives
  (person/animal) via a compiled Swift subprocess owned by the platform HAL
  (`packages/hal/swift/VisionHelper.swift` — all OS-framework code lives in
  the HAL) and speaking a framed stdin/stdout protocol (see
  `packages/hal/swift/README.md`). Helper crashes respawn with capped
  backoff and status() names the respawn count (never silent). Compile once:
  `swiftc -O packages/hal/swift/VisionHelper.swift -o vision-helper`.

## CPU harness

`soak/run-detect.mjs` runs the real pipeline (real model required) against N
synthetic-fleet cameras and prints a JSON summary with process CPU% — the
local measurement slice for the ac-1 CPU budget. The full-fleet 24h number
gates on the joint benchmark run (M4 Pro host of record).

```sh
node soak/run-detect.mjs --model /models/yolo11n.onnx --classes person,dog \
     --cameras 3 --fps 5 --duration-ms 30000 --mqtt-url mqtt://127.0.0.1:1883
```

## Tests

- `npm test` — deterministic unit suite (`node --test`); the MQTT tests use
  an embedded aedes broker (dev dependency). No network, no model, no Swift.
- `PORCHLIGHT_E2E=1 npm test` adds real-hardware e2e: Swift helper compile +
  run, and with `PORCHLIGHT_DETECT_MODEL=<path to YOLO-class onnx>` real
  CoreML inference plus the end-to-end 1-second detection budget check
  (ac-2).
