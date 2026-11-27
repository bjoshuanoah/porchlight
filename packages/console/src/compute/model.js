// Compute posture model (PORCH-152) — pure data + helpers for the
// Models/Compute settings surface, in the same spirit as profiles/knobs.js.
//
// The stage list and provider classes are CLOSED enums of record. They
// mirror `STAGES` and `PROVIDER_CLASSES` in packages/config/src/compute.js,
// which in turn cross-reference @porchlight/agent-runtime's constants.js —
// one vocabulary, several packages, deliberately not imported so the
// console plane stays dependency-light (the same law the config package
// states in its own copy).
export const STAGES = Object.freeze([
  "detection",
  "event-description",
  "audio-classification",
  "transcription",
  "overwatch-evaluation",
  "embedding",
]);

export const PROVIDER_CLASSES = Object.freeze(["native-mlx", "openai-spec", "local-server"]);

/** Endpoint classes require a configured endpointRef; native-mlx refuses one. */
export const ENDPOINT_CLASSES = Object.freeze(["openai-spec", "local-server"]);

/** Human stage labels for the settings surface. */
export const STAGE_LABELS = Object.freeze({
  detection: "Detection",
  "event-description": "Event description",
  "audio-classification": "Audio classification",
  transcription: "Transcription",
  "overwatch-evaluation": "Overwatch evaluation",
  embedding: "Embedding",
});

export function stageLabel(stage) {
  return STAGE_LABELS[stage] ?? stage;
}

/** Source-layer chip labels (admin > setup > built-in). */
const SOURCE_LABELS = Object.freeze({
  admin: "admin",
  setup: "setup",
  "built-in": "built-in",
});

export function sourceLabel(source) {
  return SOURCE_LABELS[source] ?? source;
}

/**
 * Chip mapping for a stage's live status (never-silent law: the reason the
 * stage reported renders verbatim alongside the chip):
 *   native  → neutral chip "native"
 *   cpu     → warning chip "running on CPU" + reason verbatim
 *   degraded/failed → error chip naming the state + reason verbatim
 *   unknown → muted chip "stage is not reporting" + reason verbatim
 * Returns { severity, label, reason } — severity is one of
 * "neutral" | "warning" | "error" | "muted", mapped to MUI colors by the
 * screen. A missing status is itself "unknown", never silent.
 */
export function statusChipFor(status) {
  const reason = status?.reason ?? null;
  switch (status?.state ?? "unknown") {
    case "native":
      return { severity: "neutral", label: "native", reason: null };
    case "cpu":
      return { severity: "warning", label: "running on CPU", reason };
    case "degraded":
    case "failed":
      return { severity: "error", label: status.state, reason };
    case "unknown":
      return { severity: "muted", label: "stage is not reporting", reason };
    default:
      return { severity: "muted", label: "stage is not reporting", reason };
  }
}
