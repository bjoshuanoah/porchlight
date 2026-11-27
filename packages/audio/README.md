# @porchlight/audio

Audio event detection — the engine's second detection plane (PORCH-153; the
Porchlight Home Engine initiative, PRD 8 / TS 8: _Audio Event Detection:
Local Analysis Pipeline_).

- **Contract.** `AudioEvent` — `{camera, timestamp, class, confidence,
  clipStart, clipEnd}` (:+ optional `provider`) — publishes on the engine's
  event bus in the SAME family as `DetectedObject`: the two-segment
  `porchlight/engine/detections/<camera>/<class>` topic of record. Clip
  references resolve through the segment index; the timeline opens audio
  events on the SAME evidence path as visual detection events.
- **Seams.** `AudioProvider` is the classification seam (window → hits);
  `AudioSink` the transport seam. Re-pointing rides the compute seam the
  PORCH-152 Models/Compute surface drives (stage `audio-classification`).
- **Enablement.** Per camera, OFF by default (the TS 12
  `audioDetectionEnabled` knob). A disabled camera runs NO analysis and
  retains NO frames for analysis — the chunks are refused at the gate.
- **Stream-manager law.** The plane consumes the decoded audio track the
  re-streaming service delivers; it never opens a camera connection (one
  upstream connection per camera).
- **Degradation.** Losing audio analysis (consumer stop, provider failure,
  bus outage) degrades audio events only; recording and visual detection
  continue. Every degradation renders as an explained state — the stopped
  consumer's status reason names what degraded and what still works.
- **Privacy.** Analysis is local; audio events leave the hub only under the
  explicit Tier-2 policy (off by default).
