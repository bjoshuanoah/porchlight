# Overwatch merge-spike harness (PORCH-126)

Measurement tooling for the cross-camera merge spike — not part of the
porchlight runtime and never published. It replays recorded deployment
footage (Frigate NVR segment layout `YYYY-MM-DD/HH/camera/MM.SS.mp4`, hours
in UTC), produces two per-camera `DetectedObject` JSONL streams, merges them
with `packages/overwatch/src/service.js`, and scores merge correctness
against labeled ground truth.

## Pipeline

1. **detect.py** — per-camera detection + tracking on the recordings. Needs a
   Python 3.12 environment with `ultralytics` (YOLO11s) and an ffmpeg with
   videotoolbox available on PATH. Emits `<camera>.jsonl` DetectedObject
   samples (`camera, trackId, cls, conf, bbox [x,y,w,h] 0..1, t (epoch s),
   reid[]`).
2. **run_replay.mjs** — interleaves the camera streams by timestamp and feeds
   `EntityMergeService` with `deployment.porch.json`; writes `chains.json`.
3. **evaluate.py** — scores against `ground_truth.json` (8 labeled
   person sessions): merge correctness, anchored join precision, unanchored
   join count.

## Reproducing the measured numbers

```sh
# per window (hours are UTC); repeat per date/hour group, one --out per window
python3 harness/detect.py --recordings <nvr-rec> --date 2026-11-25 \
  --hours 19 --cameras home_-_front_-_left home_-_front_-_right \
  --only 19:19-19:22 --out <streams>/w14 \
  --model yolo11s.pt --imgsz 1920 --conf 0.2 --tmp <prescale-cache>

node harness/run_replay.mjs harness/deployment.porch.json <streams> chains.json
python3 harness/evaluate.py --chains chains.json --ground-truth harness/ground_truth.json
```

Footage windows and labeled sessions are listed in
`harness/ground_truth.json`; the measurement protocol and results are in
`docs/overwatch-cross-camera-spike.md`.
