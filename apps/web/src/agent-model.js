// PORCH-150: the Agent tab's pure half — copy and shape helpers only.
// Every profile rule of record (provider classes, endpointRef law,
// memberSelectable availability, the assignment targets) is enforced
// hub-side in @porchlight/agent's own services; this model NEVER
// re-enforces it ("no parallel enforcement, ever"). Its job is honest
// presentation: label the three compute classes, shape the wire payloads
// exactly as the routes carry them, and name the member-facing states the
// hub already resolved — the never-silent law rendered, not enforced.

/** The engine's three compute classes (PORCH-I-009 TS 1 family). */
export const PROVIDER_CLASSES = ["native-mlx", "openai-spec", "local-server"];

export function providerClassLabel(providerClass) {
  const labels = {
    "native-mlx": "Native on-device (MLX)",
    "openai-spec": "OpenAI-spec endpoint",
    "local-server": "Local server (Ollama-class)",
  };
  return labels[providerClass] ?? String(providerClass ?? "Unknown class");
}

/**
 * Create-form gating: field presence only — a submit button disables until
 * the fields the route requires carry text. Whether an endpointRef is legal
 * is the server's law (a REFERENCE into the server's secrets handling, never
 * an address; native classes carry none); the form just hides the field for
 * native classes and the server's own refusal renders verbatim. The field
 * itself stays optional — adding a requirement here would be a second,
 * client-side enforcement of the hub's law.
 */
export function profileFormReady(draft) {
  const name = String(draft?.name ?? "").trim().length > 0;
  const modelId = String(draft?.modelId ?? "").trim().length > 0;
  return name && modelId && PROVIDER_CLASSES.includes(draft?.providerClass);
}

/**
 * The assignment payload exactly as POST /agent/assignments carries it:
 * exactly one target — an agent type or a member. The hub refuses anything
 * else (E_ASSIGNMENT_TARGET_INVALID); this only shapes the wire.
 */
export function assignmentPayload(target, profileId) {
  if (target?.agentType) return { target: { agentType: String(target.agentType) }, profileId };
  if (target?.memberId) return { target: { memberId: String(target.memberId) }, profileId };
  return { target: {}, profileId };
}

export function assignmentTargetLabel(target) {
  if (target?.agentType) return `Agent type · ${target.agentType}`;
  if (target?.memberId) return `Member · ${target.memberId}`;
  return "Unknown target";
}

/**
 * The member-facing card copy per the hub's own resolution state
 * (memberModelView): the running model and its class named, every earned
 * state (degraded, unassigned, parental-blocked, unavailable) named with
 * the hub's own reason — never a silent fallback.
 */
export function memberStateCopy(view) {
  const v = view ?? {};
  const state = v.state ?? "unavailable";
  if (state === "running") {
    return {
      tone: "success",
      line: `Running ${v.model?.modelId} — ${providerClassLabel(v.model?.providerClass)}`,
      reason: null,
    };
  }
  if (state === "degraded") {
    return {
      tone: "warning",
      line: v.model?.modelId
        ? `Degraded — ${providerClassLabel(v.model?.providerClass)} could not answer`
        : "Degraded — the assigned profile's provider could not answer",
      reason: v.reason ?? null,
    };
  }
  if (state === "parental-blocked") {
    return {
      tone: "info",
      line: "Family settings choose this agent's model",
      reason: v.reason ?? "Your family settings do not include this model profile.",
    };
  }
  if (state === "unassigned") {
    return {
      tone: "info",
      line: "No model assigned yet",
      reason: v.reason ?? "No model profile is assigned — there is no silent default model.",
    };
  }
  return {
    tone: "warning",
    line: "This agent's model is not available right now",
    reason: v.reason ?? null,
  };
}

/**
 * The narrowing dialog's options ARE the parent's available set: the rows
 * the hub's member-facing list already serves (memberSelectable enforced
 * server-side — a withheld profile is not in the list by construction, and
 * this model never re-adds one). Narrowing payload: ids among those rows
 * only, in list order, no duplicates — wire shaping, not enforcement.
 */
export function narrowingPayload(profiles, picks) {
  const allowed = new Set((Array.isArray(profiles) ? profiles : []).map((p) => String(p?.profileId)));
  const picked = new Set((Array.isArray(picks) ? picks : []).map(String));
  return (Array.isArray(profiles) ? profiles : []).map((p) => String(p?.profileId)).filter((id) => allowed.has(id) && picked.has(id));
}
