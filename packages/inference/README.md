# @porchlight/inference

Inference tiering — the engine's **local ↔ paid routing table** (PORCH-133;
the Porchlight Home Engine initiative, PRD 5 / TS 5: _Inference Tiering: the
`InferenceProvider` protocol_).

## The routing table

Tiers walk **in order** (tier 0 → 1 → 2). The first tier that produces a
description wins — later tiers are never charged. A failed tier escalates to
the next under the same gating. Every skip and every failure is recorded in
the routing outcome with its reason (never-silent law).

| Tier | What | Gate | Where it runs |
| --- | --- | --- | --- |
| **tier 0** | Local facts — the plain-language summary of the detections the always-on Vision/CoreML per-frame plane already produced | always-on (no gate, no knob) | hub, local only |
| **tier 1** | Local LLM/VLM — Ollama on the deployment host (provisioned by the product's own setup; never assumed pre-installed), vision-capable model of the shaping-verified candidates (ornith-1.5:9b / :35b, gemma4:e2b-mlx) | enabled **and** the entity FSM transition is gated | deployment host, local only |
| **tier 2** | Paid, OpenAI-compatible chat-completions provider, **user-supplied keys** | `tier2.optIn === true` **and** the transition is gated | remote — only under explicit user opt-in |

The gated transitions of record are the entity FSM's `arrival`, `departure`,
`loitering` — a closed set; tier config may narrow it, never extend it.

## Privacy: per-provider data boundaries

- **Video never uploads. Not to any provider, not to any cloud.**
- Tier 0 sends nothing anywhere — it is a local function of the bus's own
  detection facts.
- Tier 1 sends the event's facts (camera, moment, class, track, the
  transition fired, the local detections) and **at most one base64 snapshot
  still** to the deployment host's own Ollama endpoint. That traffic never
  leaves the hub's network.
- Tier 2 is the only tier whose requests may leave the hub, and only after
  the user flips `tier2.optIn` with their own key. The same payload bound
  applies: event facts + one still.
- Descriptions are stored **with the event they describe** (append-only JSONL
  keyed by the event's identity `{t, camera, cls, trackId}` with full
  provenance: tier, provider, providerClass, model, at). A description is a
  *likely reading*, never a fact — attribution law.

## Endpoints

Providers receive **pre-resolved endpoints** (the transcript providers' law):
never literal addresses or keys in the config of record — the composition
root resolves `endpointRef`-style references into `{url, key?}`. Both HTTP
providers take `fetch` as an injectable seam.

## Seams

```js
import { createTieringService, createDescriptionStore,
	createFactsProvider, OllamaProvider, OpenAiSpecProvider } from "@porchlight/inference";

const service = createTieringService({
	// config is optional; the default is tier1 on, tier2 OFF
	config: { tier1: { enabled: true, transitions: ["arrival", "departure", "loitering"] }, tier2: { optIn: false } },
	providers: [
		createFactsProvider(),
		new OllamaProvider({ model: "ornith-1.5:9b", endpoint: { url: "http://127.0.0.1:11434" } }),
		new OpenAiSpecProvider({ model: "gpt-6-vision", endpoint: { url: "https://api.example.com/v1", key: secrets("engine/tier2") } }),
	],
	store: createDescriptionStore({ dir: "<root>/config/console/inference/descriptions" }),
	log: console.error,
});

const { outcome, stored } = await service.onEvent({
	event: { t: 1764264000, camera: "front-door", cls: "person", trackId: "7",
		detections: [{ cls: "person", conf: 0.93 }] },
	transition: "arrival",          // the entity FSM transition that fired
	image: snapshotStill,           // optional: one frame, low detail — never video
});

service.forEvent({ t: 1764264000, camera: "front-door" }); // the description(s) stored with the event
service.status();  // never-silent posture per tier for the event-description stage
```

`onEvent` is the gated-event entry point (ac-1/ac-2). `outcome.steps` renders
exactly which tiers ran, skipped, or failed and why; `stored` is the
with-the-event record, `null` when no tier answered (absence is explicit,
never invented).

## Compute posture

The service reports the engine compute posture for the `event-description`
stage (PORCH-152's stages of record): `status()` names every tier's provider,
class, model, enablement, gated set and opt-in state. Tier re-pointing rides
the Models/Compute surface's live-apply seam.
