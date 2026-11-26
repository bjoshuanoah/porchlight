/**
 * Home-owned models (PORCH-137, PRD 1 / TS 1 of the Porchlight Home initiative).
 * These types are owned by the home domain only. identity and social MUST NOT
 * import this file; identity, social, and home share zero models.
 *
 * Property-agnostic law (Brian, Nov 24 2026): one installation manages one
 * home or fifteen. Nothing here is built to a specific property, home count,
 * or device fleet — home count and fleet shape are deployment inputs.
 */
export const homeModels = {
  /**
   * Home. One document per home under one hub installation; orgId is the
   * hub installation's org of record (injected at assembly; null when the
   * hub carries none). Enforcement never keys on it — home scope resolves
   * through home memberships and grants.
   */
  home: {
    type: "object",
    required: ["_id", "name", "createdBy", "createdAt"],
    properties: {
      _id: { type: "string" },
      /** Hub installation org of record; null when unwired. */
      orgId: { type: ["string", "null"] },
      /** Any household-chosen label. */
      name: { type: "string" },
      /** Identity reference (member DID) of the creator. */
      createdBy: { type: "string" },
      deviceSignature: { type: "string" },
      createdAt: { type: "string" },
    },
  },
  /**
   * Home membership. The enforcement base for V1 access: a caller is a home
   * member (owner | member) or they hold a live grant (later access task).
   * Owner is the creator; added members ride exactly their membership.
   */
  homeMember: {
    type: "object",
    required: ["_id", "homeId", "did", "role", "addedBy", "createdAt"],
    properties: {
      _id: { type: "string" },
      homeId: { type: "string" },
      did: { type: "string" },
      role: { type: "string", enum: ["owner", "member"] },
      addedBy: { type: "string" },
      createdAt: { type: "string" },
    },
  },
  /**
   * Area. Rooms and outdoor areas are ONE collection so the family app
   * renders one grouping surface; outdoor areas carry kind "outdoor".
   */
  area: {
    type: "object",
    required: ["_id", "homeId", "kind", "name", "order", "createdAt"],
    properties: {
      _id: { type: "string" },
      homeId: { type: "string" },
      /** room | outdoor. */
      kind: { type: "string", enum: ["room", "outdoor"] },
      /** Driveway, walkway, porch class labels. */
      name: { type: "string" },
      /** Display ordering within the home's grouping surface. */
      order: { type: "integer" },
      createdAt: { type: "string" },
    },
  },
  /**
   * Device. The adapter binding (Matter node id, native adapter reference)
   * resolves through the device adapter seam; the capability list drives
   * the control surface. Read-back from the device is the state of record.
   */
  device: {
    type: "object",
    required: ["_id", "homeId", "areaId", "name", "capabilities", "adapter", "createdAt"],
    properties: {
      _id: { type: "string" },
      homeId: { type: "string" },
      areaId: { type: "string" },
      name: { type: "string" },
      /** capability list drives the control surface: switch | light | thermostat | lock. */
      capabilities: { type: "array", items: { type: "string" } },
      /** { name, binding } — resolves through the device adapter seam. */
      adapter: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          binding: { type: ["string", "object", "null"] },
        },
      },
      /** Last READ-BACK state of record — never an optimistic flip. */
      lastKnownState: { type: ["object", "null"] },
      /** When lastKnownState was confirmed from the device. */
      stateConfirmedAt: { type: ["string", "null"] },
      lastCommandAt: { type: ["string", "null"] },
      /** confirmed | failed — the last command's outcome of record. */
      lastCommandResult: { type: ["string", "null"] },
      /**
       * Unreachable marker { at, reason }: the device's last-known state is
       * stale while set; commands fail fast with the same explanation.
       */
      unreachable: {
        type: ["object", "null"],
        properties: { at: { type: "string" }, reason: { type: "string" } },
      },
      createdBy: { type: "string" },
      createdAt: { type: "string" },
    },
  },
  /**
   * Scene. One home, one ordered action list; run executes each action
   * through the confirmed-state command path (per-action outcomes).
   */
  scene: {
    type: "object",
    required: ["_id", "homeId", "name", "actions", "createdBy", "createdAt"],
    properties: {
      _id: { type: "string" },
      homeId: { type: "string" },
      name: { type: "string" },
      /** [{ deviceId, command }] — devices validated into the same home. */
      actions: { type: "array", items: { type: "object" } },
      createdBy: { type: "string" },
      deviceSignature: { type: "string" },
      createdAt: { type: "string" },
    },
  },
  /**
   * Automation rule. Event-driven (bus subscription), never polling.
   * Conditions resolve from hub-local state; a time window of absolute
   * clock times always evaluates locally, afterDark only when a sunset
   * provider is wired (computed locally, never a WAN call).
   */
  automation: {
    type: "object",
    required: ["_id", "homeId", "name", "trigger", "actions", "enabled", "createdAt"],
    properties: {
      _id: { type: "string" },
      homeId: { type: "string" },
      name: { type: "string" },
      /** { eventClass, areaId?, timeWindow? { afterDark?, from?, to? } } */
      trigger: { type: "object" },
      /** [{ deviceId, command }] — devices validated into the same home. */
      actions: { type: "array", items: { type: "object" } },
      enabled: { type: "boolean" },
      lastFiredAt: { type: ["string", "null"] },
      createdBy: { type: "string" },
      deviceSignature: { type: "string" },
      createdAt: { type: "string" },
    },
  },
  /**
   * Grant (PORCH-138, PRD 1 / TS 1). Live access into one home for an
   * EXISTING Porchlight identity — grants ride the identity and join-link
   * mechanics, never minting a new identity. The Grant variant per the
   * family governance ruling: an individual visit grant carries
   * granteeDid; a family grant carries familyRef + parentDistributions
   * (each distribution always ⊆ the envelope scopes, validated at write,
   * fail closed — an over-envelope distribution is refused plainly).
   * Expiry (checkout) and early revocation take effect immediately at the
   * enforcement layer, so an open session's next command is re-evaluated.
   *
   * The three V1 access classes of record resolve as exactly one of
   * owner-membership | individual-grant | family-grant; there is no fourth
   * class and no parallel mechanism.
   */
  grant: {
    type: "object",
    required: ["_id", "homeId", "scopes", "expiresAt", "createdBy", "createdAt"],
    properties: {
      _id: { type: "string" },
      homeId: { type: "string" },
      /** Individual visit grant: the existing Porchlight identity (DID) granted. */
      granteeDid: { type: ["string", "null"] },
      /** Family grant: the identity-plane family this grant envelops. */
      familyRef: { type: ["string", "null"] },
      /** The grant's human label of record (the identity's name or family name). */
      createdFor: { type: ["string", "null"] },
      /**
       * The granted scopes — the envelope for a family grant. Each scope
       * names a resource of THIS home and its verbs: view | control.
       */
      scopes: {
        type: "array",
        items: {
          type: "object",
          required: ["resourceType", "resourceRef", "verbs"],
          properties: {
            resourceType: { type: "string", enum: ["device", "scene", "area"] },
            resourceRef: { type: "string" },
            verbs: { type: "array", items: { type: "string", enum: ["view", "control"] } },
          },
        },
      },
      /**
       * Family grant only: what each visiting member may reach, assigned
       * by the acting parent. Every distribution is validated ⊆ scopes at
       * write; a member reaches their distribution, never the envelope
       * implicitly.
       */
      parentDistributions: {
        type: "array",
        items: {
          type: "object",
          required: ["memberIdentityRef", "scopes"],
          properties: {
            memberIdentityRef: { type: "string" },
            scopes: { type: "array", items: { type: "object" } },
          },
        },
      },
      /** Checkout: the moment the grant ends, enforced hub-side on every read. */
      expiresAt: { type: "string" },
      createdBy: { type: "string" },
      deviceSignature: { type: "string" },
      createdAt: { type: "string" },
      revokedAt: { type: ["string", "null"] },
      revokedBy: { type: ["string", "null"] },
    },
  },
  /**
   * Home audit. Append-only, one row per mutation: who, which home, which
   * device, when, what outcome. state-source-change rows carry the source
   * (physical | read-back) in detail so "changed by command" is
   * distinguishable from "changed at the switch".
   */
  homeAudit: {
    type: "object",
    required: ["_id", "type", "actorIdentityRef", "homeId", "detail", "outcome", "at"],
    properties: {
      _id: { type: "string" },
      /** command | grant | revoke | family-distribute | automation-fire | state-source-change. */
      type: { type: "string" },
      /** Actor of record: a member DID, or an automation ref for rule-issued actions. */
      actorIdentityRef: { type: ["string", "null"] },
      homeId: { type: "string" },
      deviceId: { type: ["string", "null"] },
      detail: { type: "object" },
      /** confirmed | failed | denied. */
      outcome: { type: "string", enum: ["confirmed", "failed", "denied"] },
      at: { type: "string" },
      /** The member's device signature, present only on member-issued writes. */
      deviceSignature: { type: ["string", "null"] },
    },
  },
  /**
   * Camera (PORCH-139, PRD 2 / TS 2). The home domain's association store:
   * engine camera ↔ home, engine camera ↔ covered area (room or outdoor
   * area) so camera events land in the right home context. Recording,
   * detection, and storage stay the engine's own planes — consumed here,
   * never built. The RTSP binding lives with the engine's onboarding; the
   * family surfaces never carry camera credentials.
   */
  camera: {
    type: "object",
    required: ["_id", "homeId", "engineCameraId", "name", "createdAt"],
    properties: {
      _id: { type: "string" },
      homeId: { type: "string" },
      /** The camera's area of coverage in this home (driveway, porch class). */
      areaId: { type: ["string", "null"] },
      /** The engine's camera id of record (PORCH-I-009). */
      engineCameraId: { type: "string" },
      name: { type: "string" },
      /** Engine-reported frame geometry { width, height } | null. */
      aspect: { type: ["object", "null"] },
      /** Whether the engine carries a per-camera audio feed. */
      audio: { type: "boolean" },
      /** The owner's per-camera recording control. */
      recordingEnabled: { type: "boolean" },
      createdBy: { type: "string" },
      deviceSignature: { type: ["string", "null"] },
      createdAt: { type: "string" },
    },
  },
  /**
   * Camera authorization (PORCH-139, TS 2). THE SEPARATE grant scope class:
   * home membership plus this row reaches camera surfaces; a live visit
   * grant resolves NO camera surface, ever (never bundled with device
   * controls). Owners hold cameras by membership — rows exist for members.
   */
  cameraAccess: {
    type: "object",
    required: ["_id", "homeId", "did", "createdBy", "createdAt"],
    properties: {
      _id: { type: "string" },
      homeId: { type: "string" },
      /** The existing Porchlight identity (DID) holding camera authorization. */
      did: { type: "string" },
      createdBy: { type: "string" },
      deviceSignature: { type: ["string", "null"] },
      createdAt: { type: "string" },
      revokedAt: { type: ["string", "null"] },
      revokedBy: { type: ["string", "null"] },
    },
  },
  /**
   * Home event (PORCH-139, PRD 3 / TS 3). One family event per routine
   * arrival: the dedup key is (home, area, track) under the time window;
   * state open → updated → closed. Observations carry what detection saw
   * (fact); inferences carry what interpretation concluded (conditional);
   * the factual alert never renders an invented claim.
   */
  homeEvent: {
    type: "object",
    required: ["_id", "homeId", "key", "state", "startedAt", "updatedAt"],
    properties: {
      _id: { type: "string" },
      homeId: { type: "string" },
      areaId: { type: ["string", "null"] },
      /** The dedup key of record: home:area:track. */
      key: { type: "string" },
      /** open | updated | closed. */
      state: { type: "string" },
      trackId: { type: "string" },
      cameraRefs: { type: "array", items: { type: "string" } },
      /** What detection saw: [{ label, confidence, cameraId, trackId, at }]. */
      observations: { type: "array", items: { type: "object" } },
      /** What interpretation concluded: [{ text, source, at, gate }] — conditional. */
      inferences: { type: "array", items: { type: "object" } },
      /** [{ kind: segment|clip|still|gap, ref?, path?, reason? }] at event time. */
      evidenceRefs: { type: "array", items: { type: "object" } },
      /** { text (factual), interpretive|null, kind: factual|interpretive, at }. */
      alert: { type: ["object", "null"] },
      /** The user's incorrect-event flag of record. */
      flag: {
        type: ["object", "null"],
        properties: { by: { type: ["string", "null"] }, at: { type: "string" } },
      },
      startedAt: { type: "string" },
      updatedAt: { type: "string" },
      closedAt: { type: ["string", "null"] },
    },
  },
};
