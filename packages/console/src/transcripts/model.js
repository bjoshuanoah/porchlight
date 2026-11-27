// Transcription plane model (PORCH-155) — pure data + helpers for the
// Transcripts settings surface, in the same spirit as compute/model.js.
//
// The method classes are the CLOSED enum of record. They mirror
// METHOD_CLASSES in packages/transcript/src/types.js — the same vocabulary,
// deliberately not imported so the console plane stays dependency-light
// (the law packages/config states for its own copy).
export const METHOD_CLASSES = Object.freeze(["whisper-local", "openai-spec", "local-server"]);

/** Human method labels for the scopes card. */
export const METHOD_LABELS = Object.freeze({
  "whisper-local": "Whisper-class local binary",
  "openai-spec": "OpenAI-spec endpoint",
  "local-server": "Local server endpoint",
});

/** Labels for the two source families (rolling windows vs event spans). */
export const SOURCE_LABELS = Object.freeze({
  rolling: "Rolling windows",
  event: "Events",
});

/** Human labels for the resolved source layers (camera > recording type > global). */
export const SOURCE_LAYERS = Object.freeze({
  camera: "Camera override",
  "recording-type": "Recording type",
  global: "Global",
});

/** The empty method doc of record shape (all scopes unset → built-in applies). */
export function emptyMethodDoc() {
  return { global: null, recordingTypes: { rolling: null, event: null }, cameras: {} };
}

/**
 * Normalize any wire/draft method doc into the canonical doc shape:
 * unset or blank scopes become null (never ""), camera ids trim and a
 * camera whose override is blank drops out of the map entirely (it falls
 * through to the recording-type/global layers). The server of record
 * validates the enum; this only fixes shape.
 * @param {{ global?: unknown, recordingTypes?: unknown, cameras?: unknown }} [doc]
 * @returns {{ global: string|null, recordingTypes: { rolling: string|null, event: string|null }, cameras: Record<string, string> }}
 */
export function normalizeMethodForm(doc) {
  const source = doc ?? {};
  const scope = (value) => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed === "" ? null : value.trim();
  };
  const cameras = {};
  for (const [cameraId, method] of Object.entries(source.cameras ?? {})) {
    if (typeof cameraId !== "string" || cameraId.trim() === "") continue;
    const normalized = scope(method);
    if (normalized === null) continue; // blank override = not an override
    cameras[cameraId.trim()] = normalized;
  }
  return {
    global: scope(source.global),
    recordingTypes: {
      rolling: scope(source.recordingTypes?.rolling),
      event: scope(source.recordingTypes?.event),
    },
    cameras,
  };
}

/**
 * Chip mapping for a stored record's explicit state (never-silent law:
 * absence of text is a state, never a missing field):
 *   no-speech → neutral "No speech detected" (stated, not blank)
 *   partial   → warning "Partial — chunk X of Y: <reason>"
 *   text      → neutral "Transcript"
 * Returns { severity, label } — severity is one of "neutral" | "warning" |
 * "error" | "muted", mapped to MUI colors by the screen.
 */
export function stateChipFor(record) {
  const partial = record?.partial ?? {};
  switch (record?.state) {
    case "no-speech":
      return { severity: "neutral", label: "No speech detected" };
    case "partial":
      return {
        severity: "warning",
        label: typeof partial.reason === "string" && partial.reason.trim() !== ""
          ? `Partial — chunk ${partial.completedChunks} of ${partial.totalChunks}: ${partial.reason}`
          : `Partial — chunk ${partial.completedChunks} of ${partial.totalChunks}`,
      };
    case "text":
      return { severity: "neutral", label: "Transcript" };
    default:
      return { severity: "muted", label: record?.state ? `unknown record state "${record.state}"` : "record carries no state" };
  }
}
