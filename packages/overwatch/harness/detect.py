#!/opt/homebrew/bin/python3.12
"""detect.py — PORCH-126 spike capture harness.

Replays recorded deployment footage (Frigate recordings layout
YYYY-MM-DD/HH/camera/MM.SS.mp4), detects objects frame-by-frame, runs a
simple per-camera IoU tracker, and emits per-camera DetectedObject JSONL
streams consumed by the spike's EntityMergeService.

ReID feature: 36-dim HSV histogram (12 bins x {hue, sat, val} stats over the
person crop) + 2 shape ratios — a stand-in for the production vision-encoder
embedding, evaluated in the report.

Usage:
  python3 detect.py --recordings <dir> --date 2026-11-25 --hours 19 20 \
      --cameras home_-_front_-_left home_-_front_-_right --out <streams-dir>

The harness is measurement tooling only; it is not part of the porchlight
runtime and never ships in a published package.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections import defaultdict

from ultralytics import YOLO

SEG_RE = re.compile(r"^(\d+)\.(\d+)\.mp4$")
TRACK_CLASSES = {0: "person", 2: "car"}


def build_appearance_feature(crop_bgr) -> list[float]:
    import cv2
    import numpy as np

    small = cv2.resize(crop_bgr, (32, 64))
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    feats: list[float] = []
    for channel in range(3):
        hist, _ = np.histogram(hsv[:, :, channel], bins=12, range=(0, 256))
        total = float(hist.sum()) or 1.0
        feats.extend((hist / total).tolist())
    h, w = small.shape[:2]
    feats.append(min(1.0, w / max(1, h)))  # aspect (w over h)
    feats.append(min(1.0, h / 64.0))  # relative height in the crop frame
    return [round(float(f), 4) for f in feats]


def track_iou(a, b) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x1, y1 = max(ax, bx), max(ay, by)
    x2, y2 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def track_cosine(a, b) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(x * x for x in b) ** 0.5
    if na == 0 or nb == 0:
        return 0.0
    return max(0.0, dot / (na * nb))


class Track:
    def __init__(self, track_id: str, cls: str, conf: float, bbox, t: float, reid: list[float]):
        self.track_id = track_id
        self.cls = cls
        self.last_conf = conf
        self.reid_hist = [list(reid)]
        self.objects: list[dict] = []
        self.append(bbox, t, conf, reid)

    def append(self, bbox, t: float, conf: float, reid: list[float]):
        h, w = bbox[3], bbox[2]
        self.objects.append(
            {
                "bbox": [round(c, 4) for c in bbox],
                "t": round(t, 3),
                "conf": round(conf, 3),
                "reid": None,  # filled at close, with running mean
            }
        )
        self.objects[-1]["reid"] = reid
        self.last_conf = max(self.last_conf, conf)
        self.last_t = t
        self.last_bbox = bbox
        self.reid_hist.append(reid)

    def reid_mean(self) -> list[float]:
        import numpy as np

        return [round(float(x), 4) for x in np.mean(np.array(self.reid_hist), axis=0)]

    def emit(self, camera: str) -> list[str]:
        lines: list[str] = []
        mean = self.reid_mean()
        for obj in self.objects:
            lines.append(
                json.dumps(
                    {
                        "camera": camera,
                        "trackId": self.track_id,
                        "cls": self.cls,
                        "conf": obj["conf"],
                        "bbox": obj["bbox"],
                        "t": obj["t"],
                        "reid": mean,
                    }
                )
            )
        return lines


def prescale_segments(recordings_root: str, date: str, hours: list[int], cameras: list[str], tmp_root: str, fps: int, windows=None) -> dict[str, list[tuple[float, str]]]:
    """Decode 8K HEVC once per segment with videotoolbox, output 1280x360@fps mp4.

    Returns camera -> [(segment_start_epoch, pre-scaled path)]
    """
    import datetime as dt

    plan: dict[str, list[tuple[float, str]]] = defaultdict(list)
    for camera in cameras:
        out_dir = os.path.join(tmp_root, camera)
        os.makedirs(out_dir, exist_ok=True)
        for hour in hours:
            hour_dir = os.path.join(recordings_root, date, f"{hour:02d}", camera)
            if not os.path.isdir(hour_dir):
                continue
            for seg in sorted(os.listdir(hour_dir)):
                m = SEG_RE.match(seg)
                if not m:
                    continue
                minute, second = int(m.group(1)), int(m.group(2))
                start = dt.datetime.strptime(f"{date} {hour:02d}:{minute:02d}:{second:02d}", "%Y-%m-%d %H:%M:%S").replace(tzinfo=dt.timezone.utc).timestamp()
                if windows and not any(start < end_w and start + 10.3 > begin_w for begin_w, end_w in windows):
                    continue
                out_path = os.path.join(out_dir, f"{date}_{hour:02d}_{minute:02d}_{second:02d}.mp4")
                if not os.path.exists(out_path):
                    subprocess.run(
                        [
                            "ffmpeg", "-loglevel", "error", "-hwaccel", "videotoolbox",
                            "-i", os.path.join(hour_dir, seg),
                            "-vf", f"scale=1280:-2,fps={fps}",
                            "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                            "-y", out_path,
                        ],
                        check=True,
                    )
                plan[camera].append((start, out_path))
    return plan


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--recordings", required=True)
    ap.add_argument("--date", required=True)
    ap.add_argument("--hours", type=int, nargs="+", required=True)
    ap.add_argument("--cameras", nargs="+", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="yolo11n.pt")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--conf", type=float, default=0.35)
    ap.add_argument("--fps", type=int, default=8, help="replay sample rate")
    ap.add_argument("--iou-match", type=float, default=0.30)
    ap.add_argument("--track-idle", type=float, default=4.0, help="seconds of no frames before a per-camera track closes")
    ap.add_argument("--center-gate", type=float, default=0.15, help="normalized center distance gate for track re-attachment")
    ap.add_argument("--match-min", type=float, default=0.25, help="minimum assignment score")
    ap.add_argument("--tmp", default="/tmp/porch126_prescale")
    ap.add_argument("--device", default="mps", help="inference device (cpu|mps|0)")
    ap.add_argument("--only", nargs="*", default=None, help="HH:MM-HH:MM windows; limits prescale and detection")
    args = ap.parse_args()

    import datetime as dt

    windows = None
    if args.only:
        windows = [(dt.datetime.strptime(f"{args.date} {a}", "%Y-%m-%d %H:%M").replace(tzinfo=dt.timezone.utc).timestamp(),
                    dt.datetime.strptime(f"{args.date} {b}", "%Y-%m-%d %H:%M").replace(tzinfo=dt.timezone.utc).timestamp())
                   for a, b in (w.split("-") for w in args.only)]
    os.makedirs(args.out, exist_ok=True)
    model = YOLO(args.model)
    plan = prescale_segments(args.recordings, args.date, args.hours, args.cameras, args.tmp, args.fps, windows)

    import cv2

    tracks_by_camera: dict[str, dict[int, Track]] = defaultdict(dict)
    last_seen: dict[str, dict[int, float]] = defaultdict(dict)
    next_track_int: dict[str, int] = defaultdict(int)
    frames_out: int = 0

    for camera, segments in plan.items():
        out_path = os.path.join(args.out, f"{camera}.jsonl")
        emit_buf: list[str] = []
        for seg_start, path in sorted(segments):
            cap = cv2.VideoCapture(path)
            if not cap.isOpened():
                print(f"cannot open {path}", file=sys.stderr)
                continue
            fps_src = cap.get(cv2.CAP_PROP_FPS) or args.fps
            frame_idx = 0
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                t = seg_start + frame_idx / fps_src
                frame_idx += 1
                frames_out += 1
                results = model.predict(frame, imgsz=args.imgsz, conf=args.conf, verbose=False, device=args.device)[0]
                # IoU-track the detections of tracked classes only.
                open_tracks = tracks_by_camera[camera]
                for track_id in list(open_tracks):
                    if t - last_seen[camera][track_id] > args.track_idle:
                        emit_buf.extend(open_tracks.pop(track_id).emit(camera))
                boxes = sorted(results.boxes, key=lambda b: float(b.conf), reverse=True)
                kept: list[tuple[str, dict]] = []
                for box in boxes:
                    cls_id = int(box.cls.item())
                    if cls_id not in TRACK_CLASSES:
                        continue
                    x1, y1, x2, y2 = (float(v) for v in box.xyxy.tolist()[0])
                    H, W = frame.shape[:2]
                    bbox = [x1 / W, y1 / H, (x2 - x1) / W, (y2 - y1) / H]
                    crop = frame[max(0, int(y1)) : int(y2), max(0, int(x1)) : int(x2)]
                    if crop.size == 0:
                        continue
                    reid = build_appearance_feature(crop)
                    kept.append((TRACK_CLASSES[cls_id], {"bbox": bbox, "t": t, "conf": float(box.conf.item()), "reid": reid}))
                # Greedy assignment in confidence order: IoU when boxes overlap,
                # else center-distance with an appearance tie-breaker — small
                # distant persons can move through a gap without IoU overlap.
                center_gate = args.center_gate
                for cls, k in kept:
                    kcx, kcy = k["bbox"][0] + k["bbox"][2] / 2, k["bbox"][1] + k["bbox"][3] / 2
                    best_id, best_score = None, 0.0
                    for track_id, tr in open_tracks.items():
                        if tr.cls != cls:
                            continue
                        iou = track_iou(k["bbox"], tr.last_bbox)
                        tcx, tcy = tr.last_bbox[0] + tr.last_bbox[2] / 2, tr.last_bbox[1] + tr.last_bbox[3] / 2
                        dist = ((kcx - tcx) ** 2 + (kcy - tcy) ** 2) ** 0.5
                        score = iou
                        if dist < center_gate and tr.last_bbox[3] > 0:
                            # center-proximity score scaled within the gate
                            prox = 1 - dist / center_gate
                            score = max(score, 0.35 * prox)
                            # appearance tie-breaker for overlapping candidates
                            score += 0.15 * track_cosine(k["reid"], tr.reid_mean())
                        if score > best_score:
                            best_id, best_score = track_id, score
                    if best_id is not None and best_score >= args.match_min:
                        open_tracks[best_id].append(k["bbox"], k["t"], k["conf"], k["reid"])
                        last_seen[camera][best_id] = k["t"]
                    else:
                        track_int = next_track_int[camera]
                        next_track_int[camera] += 1
                        open_tracks[track_int] = Track(f"{cls[0]}{track_int}", cls, k["conf"], k["bbox"], k["t"], k["reid"])
                        last_seen[camera][track_int] = k["t"]
            cap.release()
        # flush remaining
        for track_id in list(tracks_by_camera[camera]):
            emit_buf.extend(tracks_by_camera[camera].pop(track_id).emit(camera))
        with open(out_path, "w") as fh:
            fh.write("\n".join(emit_buf) + ("\n" if emit_buf else ""))
        print(f"{camera}: {len(emit_buf)} detections -> {out_path}")
    print(f"frames processed: {frames_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
