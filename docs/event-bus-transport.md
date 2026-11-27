# Event bus transport — vetting decision of record (PORCH-129)

**Status:** decided. **Date:** 2026-11-27. **Scope:** the engine's internal event bus
(PORCH-129) and every consumer contract that wires to it.

This document is the vetting record PORCH-129 ac-2 requires: the chosen transport, the
criteria it was judged on, and the statement that no spec, task, or constant elsewhere
treats the transport as pre-decided. Anything wiring to the bus wire contracts only, never
to a broker implementation detail.

## Requirements the transport must satisfy (from the directive)

1. **Green-field law (Brian, Nov 24, 2026).** Nothing is pre-deployed; the bus is
   provisioned and started by the product's own setup on a fresh deployment — never
   assumed to exist.
2. **Normalized wire contract.** Every detection publishes as the `DetectedObject`
   contract of record (`packages/detection/src/types.js`); the HTTP webhook emits the same
   payload. Consumers of record key on the two-segment topic family
   `porchlight/engine/detections/<camera>/<class>` (PORCH-152).
3. **1-second event budget.** Detection → subscriber delivery must sit inside the PRD's
   1-second budget; delivery is fire-and-forget class, not request/response.
4. **Service lifecycle.** All engine services (recorder supervisor, stream manager,
   detection, audio, transcription consumer, the hub's home bridge, Overwatch) connect at
   boot; a service restart reconnects without manual intervention.
5. **Porchlight Home seam (PORCH-I-008 TS 1) — publish-only.** The engine publishes facts;
   consumer automation evaluation is event-driven, never polling; the engine never calls
   Porchlight commands.
6. **Runs where the product runs.** Native macOS Node/TS process (TS 1); no hand-installed
   system service, no container requirement.

## Candidates judged

| Candidate | Green-field provisioning | Delivery semantics | Verdict |
| --- | --- | --- | --- |
| **MQTT** (mqtt.js client) | Broker can be embedded in-process (aedes) and provisioned by the platform runtime; or deployment's own broker via `busUrl` | Topics match the camera/class family of record naturally; QoS 0 fire-and-forget delivers inside the budget; retained state for status rows; auto-reconnect is a client behavior, not bespoke code | **chosen** |
| Plain HTTP poll/webhook only | Webhooks need an always-online receiver and polling breaks the event-driven consumer law (ac-4) | Request/response, not a pub/sub family; per-consumer fan-out would be bespoke | rejected as the sole transport (kept as the webhook *output* per ac-3) |
| socket.io / WebSocket fan-out | Hub-adjacent, but couples consumers to the hub process and its session model | Delivery is per-connected-session; no offline buffering semantics a restarted service can lean on | rejected |
| Redis pub/sub, NATS | Each adds a second daemon binary the setup must supervise and carry | Fine semantically, but heavier green-field provisioning for no consumer benefit at this scale | rejected |

## Decision

- **Transport: MQTT.** Clients: `mqtt.js` everywhere (recorder bus seam
  `packages/recorder/src/bus.mqtt.js`, detection sink `packages/detection/src/sink.mqtt.js`,
  audio sink `packages/audio/src/sink.mqtt.js`, stream health publisher
  `packages/stream/src/health-bus.js`, hub consumer
  `modules/home/src/services/engine.adapter.js`, apps/server re-emitter).
- **Broker: embedded [aedes](https://npmjs.org/package/aedes) in the platform runtime**
  (`packages/bus` — `EventBusBroker`), bound to loopback, provisioned and started by
  `packages/installer/src/runtime.js` before any engine service composes (ac-1). A
  deployment that wants its own broker sets `busUrl` in the config of record; the runtime
  then rides that broker and provisions nothing (the config of record wins, idempotent
  across reinstalls).
- **QoS 0, retain false** for detection facts (budget class, latest-state rows may retain —
  storage state topic retains). Offline publications buffer bounded at the sink (oldest
  dropped, dropped count stated — never silent).
- **Wire contracts of record, unaffected by this decision:**
  - Detections: `porchlight/engine/detections/<camera>/<class>` with the `DetectedObject`
    fields (`packages/detection/src/types.js`); audio events ride the SAME family with the
    `AudioEvent` field set (`packages/audio/src/types.js`, PORCH-153 / TS 8).
  - Storage/health: `STORAGE_STATE_TOPIC` / `STORAGE_EVENTS_TOPIC` (PORCH-136) and the
    stream manager's health events (PORCH-154).
  - The topic family prefix constant `ENGINE_DETECTIONS_PREFIX` is owned by
    `modules/home` — one copy of the contract, engine publishes with it mirrored, consumers
    subscribe through it (PORCH-152's "one copy" rule).
- **Re-point safety:** the vetting is recorded once here; consumer code wires to the topic
  families and payload contracts above, never to a broker implementation detail. The
  DetectionSink / AudioSink / bus seams exist precisely so this decision can be revisited
  without core changes.

## Non-goals carried with the transport

- **No Home Assistant anywhere** (Brian, Nov 24, 2026: "Home assistant goes away"): no HA
  discovery, no HA integration, no HA-facing topic, payload, or code path — swept per ac-5
  (`scripts/no-ha-sweep.mjs`, wired into `npm run test`).
- No Home Assistant compatibility publisher here; that shape, if ever built, is
  PORCH-I-008's optional outward publish-only lane — not the engine's bus.
