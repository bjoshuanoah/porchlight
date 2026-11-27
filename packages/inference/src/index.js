// index.js — public surface of @porchlight/inference (PORCH-133).
//
// The engine's inference tiering scaffolding: the tier routing table (PRD 5
// / TS 5) with tier 0 always-on local facts, tier 1 local Ollama gated by
// entity FSM transitions, tier 2 paid OpenAI-compatible off by default
// until explicitly opted in; descriptions stored with their event.

export { TIERS, GATED_TRANSITIONS, DEFAULT_TIER_CONFIG } from "./types.js";
export { validateTierConfig, gatedTransitionsFor } from "./config.js";
export { createTierRouter } from "./router.js";
export { createFactsProvider, factsLineOf } from "./provider.facts.js";
export { OllamaProvider, promptOf } from "./provider.ollama.js";
export { OpenAiSpecProvider } from "./provider.openai.js";
export { createDescriptionStore } from "./store.js";
export { createTieringService } from "./service.js";
