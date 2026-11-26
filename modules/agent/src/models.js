/**
 * Agent-owned models (Porchlight Agent initiative, PRD 2 / TS 2 of record —
 * PORCH-148). These types are owned by the agent domain only. identity, social,
 * and home MUST NOT import this file; the domains share zero models.
 *
 * The schemas are the TS 2 configuration architecture of record: profiles are
 * configuration documents the inference routing reads per agent type at
 * session start and at switch time. Every field note below is one element of
 * TS 2 (6b073359549901c58e054c1b) carried verbatim as its schema note.
 */
export const agentModels = {
  /**
   * InferenceProfile — TS 2 Schema of record: {_id, name, providerClass:
   * native-mlx|openai-spec|local-server (one of the engine's compute classes
   * per PORCH-I-009 TS 1), endpointRef (optional; endpoint refs for
   * openai-spec/local-server classes; native classes use the platform's own
   * runtime), modelId, safetyFields (build-defined), memberSelectable:
   * true|false (the availability gate, Brian's ruling; default true,
   * admin-flippable, audited)}.
   */
  inferenceProfile: {
    type: "object",
    required: ["_id", "name", "providerClass", "modelId", "memberSelectable", "createdAt"],
    properties: {
      _id: { type: "string" },
      /** Profile definitions: name. */
      name: { type: "string" },
      /** One of the engine's compute classes per PORCH-I-009 TS 1. */
      providerClass: { type: "string", enum: ["native-mlx", "openai-spec", "local-server"] },
      /**
       * Endpoint refs for openai-spec/local-server classes; native classes
       * use the platform's own runtime (null). A REFERENCE into the server's
       * existing secrets handling — never a URL, never a key, never a token:
       * members never see endpoints, keys, or tokens in profile UIs.
       */
      endpointRef: { type: ["string", "null"] },
      /** Which model answers under this profile. */
      modelId: { type: "string" },
      /**
       * The availability gate (Brian's ruling): default true, admin-flippable,
       * audited. false = withheld: members never select it, never see it
       * listed, and member-facing surfaces never leak its existence; the gate
       * is on member self-selection and member-facing availability, never on
       * the admin's own assignment power.
       */
      memberSelectable: { type: "boolean" },
      /**
       * safetyFields (build-defined): the build's explicit fallback
       * preference rides here — `safetyFields.fallbackProfileRef` names the
       * ONE profile an unreachable primary provider may fall back to, always
       * rendered as a fallback in provenance (no silent fallback beyond this
       * explicit, rendered preference).
       */
      safetyFields: { type: "object" },
      createdAt: { type: "string" },
      /** Actor DID of the admin who defined the profile. */
      createdBy: { type: "string" },
    },
  },

  /**
   * ProfileAssignment — TS 2 Schema of record: {_id, target: {agentType |
   * memberId}, profileRef, assignedBy, assignedAt}. Resolution: member-
   * specific assignment wins over agent-type assignment; unassigned members
   * fall to the agent-type default, and an agent type with no assignment
   * renders an explicit unassigned state in the admin surface (never a silent
   * default model).
   */
  profileAssignment: {
    type: "object",
    required: ["_id", "target", "profileRef", "assignedBy", "assignedAt"],
    properties: {
      _id: { type: "string" },
      /**
       * Exactly one of agentType (type default) or memberId (member-specific)
       * — a target naming both, or neither, is invalid at write.
       */
      target: {
        type: "object",
        properties: {
          agentType: { type: ["string", "null"] },
          memberId: { type: ["string", "null"] },
        },
      },
      /** The InferenceProfile _id this assignment rides. */
      profileRef: { type: "string" },
      /** Actor DID of the admin (or the self-assigning member) who assigned. */
      assignedBy: { type: "string" },
      assignedAt: { type: "string" },
    },
  },

  /**
   * Member profile set — the parental permissive-set narrowing (Brian's
   * session ruling, TS 2 "Parental member profile set"): the family
   * structure comes through identity services (never a model import), and
   * the agent module's assignment path owns the narrowing's enforcement.
   * One narrowing document per member; the permitted set never includes an
   * admin-withheld profile (a parental write attempting to enable one is
   * refused at write with plain language, fail closed).
   */
  memberProfilePermissive: {
    type: "object",
    required: ["_id", "memberId", "familyRef", "permittedProfileRefs", "updatedBy", "updatedAt"],
    properties: {
      _id: { type: "string" },
      /** The governed member (actor DID). */
      memberId: { type: "string" },
      /** The identity-plane family whose parents narrowed the set. */
      familyRef: { type: "string" },
      /** The profiles the parents permit, within the admin's available set. */
      permittedProfileRefs: { type: "array", items: { type: "string" } },
      updatedBy: { type: "string" },
      updatedAt: { type: "string" },
    },
  },

  /**
   * Inference provenance — the admin-visible provenance of record (TS 2):
   * every inference call records the resolved profile's identity — which
   * model answered, under which profile, at which time. Rows never carry
   * endpoint refs, keys, or tokens.
   */
  inferenceProvenance: {
    type: "object",
    required: ["_id", "memberId", "profileRef", "providerName", "providerClass", "modelId", "at"],
    properties: {
      _id: { type: "string" },
      memberId: { type: "string" },
      sessionId: { type: ["string", "null"] },
      /** The resolved InferenceProfile _id the call rode. */
      profileRef: { type: "string" },
      profileName: { type: "string" },
      providerName: { type: "string" },
      providerClass: { type: "string", enum: ["native-mlx", "openai-spec", "local-server"] },
      modelId: { type: ["string", "null"] },
      at: { type: "string" },
      /**
       * Never-silent degradation: null when the call ran; when the profile's
       * provider could not answer, the named reason rides here.
       */
      degraded: { type: ["object", "null"] },
      /**
       * An EXPLICITLY configured fallback only (safetyFields
       * .fallbackProfileRef), always rendered as a fallback — never silent.
       */
      fallback: { type: ["object", "null"] },
    },
  },

  /**
   * Agent audit — the module's audit family of record: profile definitions,
   * availability flips, assignments, self-assignment refusals, and parental
   * narrowing writes (including refused writes) land one append-only row:
   * who, what, when, outcome.
   */
  agentAudit: {
    type: "object",
    required: ["_id", "type", "actorIdentityRef", "detail", "outcome", "at"],
    properties: {
      _id: { type: "string" },
      type: { type: "string" },
      actorIdentityRef: { type: ["string", "null"] },
      detail: { type: "object" },
      /** recorded | denied — refusals are audited rows too. */
      outcome: { type: "string", enum: ["recorded", "denied"] },
      at: { type: "string" },
    },
  },
};

export default agentModels;
