# Overwatch cross-camera merge spike — report (PORCH-126)

Spike deliverable for PORCH-126 (Porchlight Home — Overwatch & Recognition,
PORCH-I-010 PRD 1 / TS 1): prototype the entity layer — correlated
cross-camera person appearances merged into a single PropertyEntity chain with
zone handoffs — and measure merge correctness on recorded footage from the
deployment.

## What was built

1. **`packages/overwatch` — the prototype entity service** (TypeScript-grade
   plain-JS ESM, `node --test` suite).
   - `src/types.js` — the spike's `DetectedObject` contract (camera, trackId,
     cls, conf, bbox, t, optional reid descriptor) and the emitted
     `PropertyEntity` / `EntitySighting` / `ZoneHandoff` shapes. The
     production DetectedObject contract is PORCH-I-009 TS 3; the spike
     consumes the minimum fields that contract guarantees, with field mapping
     notes for the engine integration.
   - `src/correlation.js` — pure scoring: correlation of an exiting track in
     one camera with an entering track in an adjacent camera using
     (a) the **zone handoff matrix** (authored adjacency; only adjacent
     cameras may join), (b) **travel-time priors** per pair (authored,
     defaulted), (c) **spatial side hints** (which frame edge the shared
     overlap touches), and (d) **ReID appearance** — cosine similarity over a
     compact appearance descriptor. Appearance can veto a join
     (`appearanceVetoFloor`); below the join threshold nothing merges (the
     ambiguity law: weak evidence keeps sightings separate).
   - `src/service.js` — `EntityMergeService`: consumes the per-camera
     DetectedObject streams, assembles per-camera tracks (idle-closed,
     recycled detector ids = new occurrences), correlates closing/opening
     tracks against adjacent cameras in both directions (the person may be
     visible in two overlapping views simultaneously), one-exit-per-entry
     greedy pairing, union-find chains, and emits `PropertyEntity` chains
     with zone-handoff evidence (exit/entry object, gap seconds, score).
   - Tests cover: one walk across two cameras → ONE entity with the correct
     handoff; overlapping visitors pair by appearance and stay separate;
     beyond-prior gaps stay separate; appearance veto; no-ReID operation on
     timing + geometry; recycled track ids; simultaneous-overlap merges;
     contract validation.

2. **`packages/overwatch/harness` — the measurement harness** (not runtime):
   - `detect.py` — replays recorded deployment footage (Frigate NVR segment
     layout `YYYY-MM-DD/HH/camera/MM.SS.mp4`, hours in UTC), frame-level YOLO
     detection, a per-camera IoU/center/appearance tracker, and writes
     per-camera DetectedObject JSONL streams (the two streams the merge
     service consumes). HSV-histogram + shape descriptor per crop stands in
     for the production vision-encoder ReID embedding.
   - `run_replay.mjs` — interleaves the two camera streams by timestamp and
     feeds `EntityMergeService`; writes `chains.json`.
   - `evaluate.py` — measures merge correctness, join precision, and
     cross-camera pair recall against labeled ground truth.
   - `deployment.porch.json` — the deployment-authored correlation config for
     the prototype (adjacency, priors) exactly as the eventual coverage-zone
     surface (PORCH-140) will write it.

## Deployment input

The prototype runs on the deployment's real recorded footage: the host's
Frigate NVR with two overlapping-coverage front cameras
(`home_-_front_-_left`, `home_-_front_-_right`, Reolink dual-lens 8K
panoramic). Overlapping-coverage person crossings were located from the NVR's
own person-event trail (48 left↔right candidate pairs over Nov 23–25, 2026) —
the deployment's event DB supplied the candidate windows; ground-truth session
labels were then verified frame-by-frame from the recordings (zoomed crops of
each detected track, checked for clothing/identity continuity).

## Measurement protocol

- Windows replayed: 12 candidate crossing sessions across three days.
- Detections: YOLO11s (local, on-device), 8 fps replay, imgsz 1920 — the
  spike stands in for the engine's detection stream; detection quality on the
  distant-camera footage is the harness's known bound (see below).
- Ground truth: one session = one real-world person's appearances across the
  two cameras in the window, labeled from the verified track crops.
- Metrics: **merge correctness** = sessions whose sightings all land in ONE
  emitted entity; **join precision** = emitted cross-camera joins inside the
  labeled windows that join same-session sightings; **pair recall** = session
  camera-pairs merged into one entity. Separate sightings must stay separate
  (overlapping-visitor windows are labeled as distinct sessions and split
  chains score as correct separations, not failures).

## Results

Replay set: six deduplicated footage windows across three days
(Nov 23–25, 2026) on the two overlapping-coverage front cameras; 67.6k
(left) + 21.1k (right) DetectedObject samples produced by the replay
harness (YOLO11s, 8 fps, imgsz 1920, on-device MPS), merged by
`EntityMergeService` with the authored deployment config
(`harness/deployment.porch.json`: one adjacent pair, travel prior
{min 0, max 10}s + 2s slack, no side hints, 15s track-idle bound).

Ground truth: 8 person sessions — one real-world person's crossing of the
shared-coverage strip — each labeled from the deployment's own person-event
trail plus visually verified crops (identity confirmed frame-by-frame from
the original-resolution recordings). 29 per-camera track fragments total.

- **Merge correctness: 8/8 sessions = 100%** (bar: ≥80%). Every session's
  fragments landed in ONE emitted `PropertyEntity` chain with the zone
  handoff evidence attached (entry camera's sighting carries
  `{fromCamera, toCamera, exitObject, entryObject, gapSec, score}`), and no
  fragment was left unmatched.
- **Join precision on labeled anchors: 22/22 = 100%.** Every emitted
  cross-camera person join whose two sides are ground-truth-anchored joined
  sightings of the same session; no session bled into another (8 sessions →
  8 distinct entities among 21 emitted entities, the rest being car chains
  and unanchored fragments outside labeled evidence).
- **Sighting recall on labeled fragments: 29/29 = 100%** (every labeled
  fragment matched an emitted sighting at ≥50% temporal overlap).
- Unanchored joins: 19 cross-camera person joins involved at least one
  sighting outside labeled identity evidence (same-strip wanderer
  continuations whose person identity could not be confirmed or denied
  frame-by-frame); they are excluded from precision rather than asserted
  correct. The overlapping-visitor separation behavior is covered by unit
  tests (appearance pairing, appearance veto, recycled ids).

Numbers were produced by the committed harness: `harness/detect.py` →
`harness/run_replay.mjs` → `harness/evaluate.py` against
`harness/ground_truth.json`.

## Known bounds

- The replay detector (YOLO11s at imgsz 1920 on 8 fps 8K frames) misses
  distant frames at the far edges of the cameras — Frigate's own per-camera
  trails on the same footage are more complete, and windows where either
  camera produced no replay-supported track (three session candidates) could
  not be labeled and are excluded. Session sighting windows in ground truth
  come from the verified track support, so measured merge correctness gates
  on the merge layer's behavior given the streams it was fed.
- Identity labeling is anchored on the deployment's per-camera person-event
  trail plus frame-by-frame crop verification; sessions where the shared
  strip hosted one continuous wanderer are labeled as single-person sessions
  (the rural single-residence property makes concurrent visitors rare, but
  the beard-man window proved they do happen, so the two distinct-visitor
  windows are labeled from the clothing-verified crops).
- The ReID feature is a 38-dim HSV/shape histogram, not the production
  vision-encoder embedding; appearance-driven pairings (overlapping visitors)
  scale with the real embedding's discriminability.

## Recommendation for the production algorithm

The measured behavior supports shipping the spike's correlation shape into
the Overwatch entity service, with four production upgrades:

1. **Appearance features.** Replace the spike's HSV-and-shape histogram with
   the vision-encoder embedding the setup provisions (PORCH-I-010 TS 1
   entity layer) and calibrate `appearanceVetoFloor` /
   `appearanceOverrideFloor` on real deployment footage like the People &
   Things threshold discipline (fail toward uncertainty). The histogram
   worked on this footage but gives no guarantee for clothing-uniform
   visitors.
2. **Authored zone geometry.** The deployment config here set the shared
   strip's side hints to "any" (no spatial gate). With the coverage-zone
   authoring surface (PORCH-140) the handoff matrix, adjacency, and
   travel-time priors become owner-authored data keyed on engine camera
   ids — the correlation code consumes them unchanged (they are already
   config-driven), and the spatial gate becomes evidence instead of unused.
3. **Track-id contract.** The spike learned the hard way that the merge
   layer must mirror the engine's track-id lifecycle: an engine track id is
   stable for an object's lifetime and recycled only after a long absence —
   the service's `trackIdleSec` (15s in the deployment config) encodes that
   contract and must match the engine's recycling behavior when the
   PORCH-I-009 engine feeds real streams. Fragments inside the bound are one
   object; longer absences are a new object.
4. **Multi-fragment entities.** Simultaneous overlapping views legitimately
   produce several fragments of one person in both cameras; the spike's
   claim-plus-appearance-override rule (a claimed track may extend its join
   only when both sides' appearance confirms the same person) is the
   production rule: it keeps overlapping visitors separate (claims) while
   letting one person's fragments unify (appearance), and every such
   extended join is recorded in `joins[]` for audit.

Carry over unchanged: weak-evidence separations (below-threshold and
beyond-prior candidates never merge), one entity per sighting group with
chronologically ordered sightings, and per-sighting handoff evidence — the
surfaces the visit model and tracked-objects surface consume.
