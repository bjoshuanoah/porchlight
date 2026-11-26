# @porchlight/hal — the platform HAL (PORCH-132)

The thin native integration layer between the pure TypeScript/Node engine
services and each host OS, in one place:

```
service (pure TS/Node — @porchlight/recorder, @porchlight/detection, …)
   ↓ imports the contract only
@porchlight/hal   ← the ONLY package allowed to touch OS frameworks
   ↓
host OS: VideoToolbox / CoreML / Vision / AVFoundation / Metal (macOS); V4L2 / VA-API / NVDEC / OpenVINO (Linux)
```

## The contract

`resolveHal()` (or an injected instance from `createHal({ backend })`) returns
a backend object every service consumes:

- `platform` / `status()` — auditable posture of the host's acceleration
  (never-silent law: what the host really provides, stated, not advertised).
- `videoDecodeArgs()` — hardware-decode argv fragment for system ffmpeg
  (darwin: `-hwaccel videotoolbox`; first-cut linux: none until probes land).
- `videoEncode()` — `{ name, pixFmt }` default for synthetic/soak origins.
- `frameCaptureCommand({ input, out, at })` — single-frame capture argv
  (snapshots for timeline/evidence surfaces).
- `inferenceExecutionProviders()` — ordered onnxruntime execution providers
  (darwin: `["coreml", "cpu"]` — CoreML EP on GPU/ANE first, CPU fallback
  explicit; first-cut linux: `["cpu"]`).
- `visionHelper()` — the Apple Vision primitives subprocess: `{ sourcePath,
  frameworks }` for the macOS one, `{ sourcePath: null, frameworks: [] }`
  where the platform feature does not exist.

Backend implementations: `src/backend.darwin.js` (VideoToolbox/CoreML/Swift
Vision), `src/backend.linux.js` (first-cut CPU-backed descriptors; VA-API/
NVDEC/OpenVINO slots are named for the native follow-on, never silently
claimed).

## Isolation law (PORCH-132 ac-2)

OS-framework usage lives **only** inside this package:

- The Swift helper (`swift/VisionHelper.swift`, importing Foundation/Vision/
  ImageIO/CoreGraphics) is the sole OS-framework source in the monorepo.
- Services import `@porchlight/hal` public entry only — never `src/…`
  internals, never a platform framework, never a native binding.
- `scripts/boundary-check.mjs` fails the build on any OS-framework import
  outside `packages/hal`.

## Tests

`node --test test/` — the default matrix is deterministic (no ffmpeg, no
swiftc, no network). The repo e2e suites (env-gated `PORCHLIGHT_E2E=1`)
exercise the darwin backend against the real hardware seams.
