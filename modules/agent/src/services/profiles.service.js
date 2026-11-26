/**
 * Profile service (PORCH-148 ac-1/ac-3). The InferenceProfile store of
 * record: admin definitions with provider class and model named; the
 * admin availability gate (memberSelectable, Brian's ruling) flips here —
 * audited, and published on the module's change seam for live-apply.
 *
 * Privacy law of record (TS 2): members never see endpoints, keys, or
 * tokens in profile surfaces. The member-facing projection carries the
 * model and the provider CLASS, never the address. A withheld profile
 * (memberSelectable false) renders nowhere in member-facing surfaces: not
 * selectable, not listed, not leaked by existence.
 */
import { fail } from "./errors.js";
import { PROVIDER_CLASSES } from "@porchlight/agent-runtime";

/** The one member-facing projection of an InferenceProfile — never the address. */
export function memberProjection(profile) {
  return {
    profileId: profile._id,
    name: profile.name,
    providerClass: profile.providerClass,
    modelId: profile.modelId,
    selectable: Boolean(profile.memberSelectable),
  };
}

export class ProfileService {
  /**
   * @param {import("@porchlight/shared").CollectionLike} profiles
   * @param {import("./audit.service.js").AgentAuditService} audit
   * @param {{ publishChange?: (event: object) => void }} [seam]
   * @param {() => string} [now]
   */
  constructor(profiles, audit, seam = {}, now = defaultNow) {
    this.profiles = profiles;
    this.audit = audit;
    this.publishChange = typeof seam.publishChange === "function" ? seam.publishChange : null;
    this.now = now;
  }

  /**
   * An admin defines a profile: name, model + provider class named, optional
   * endpoint ref (a REFERENCE into the server's existing secrets handling —
   * never a URL with credentials; native classes use the platform's own
   * runtime and carry none), memberSelectable default true.
   */
  async define({ actorDid, isAdmin, name, providerClass, modelId, endpointRef = null, memberSelectable = true, safetyFields = {} } = {}) {
    await requireAdmin({ actorDid, isAdmin, audit: this.audit, action: "profile-define" });
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed) return fail("E_NAME_REQUIRED", "A profile needs a name.");
    if (!PROVIDER_CLASSES.includes(providerClass)) {
      return fail(
        "E_PROVIDER_CLASS_INVALID",
        `The provider class must be one of ${PROVIDER_CLASSES.join(", ")} (the engine's compute classes).`,
      );
    }
    if (typeof modelId !== "string" || !modelId.trim()) {
      return fail("E_MODEL_REQUIRED", "A profile names the model that answers.");
    }
    if (endpointRef !== null && (typeof endpointRef !== "string" || endpointRef.includes("://"))) {
      return fail(
        "E_VALIDATION",
        "endpointRef is a reference into the server's secrets handling, never an address — profiles never carry an address.",
      );
    }
    if (providerClass === "native-mlx" && endpointRef !== null) {
      return fail("E_VALIDATION", "Native classes use the platform's own runtime — no endpoint ref.");
    }
    if (typeof safetyFields !== "object" || safetyFields === null || Array.isArray(safetyFields)) {
      return fail("E_VALIDATION", "safetyFields must be an object.");
    }
    const profile = {
      _id: `iprofile_${crypto.randomUUID()}`,
      name: trimmed,
      providerClass,
      endpointRef,
      modelId: modelId.trim(),
      memberSelectable: Boolean(memberSelectable),
      safetyFields,
      createdAt: this.now(),
      createdBy: actorDid,
    };
    await this.profiles.insertOne(profile);
    await this.audit.record({
      type: "profile-defined",
      actorIdentityRef: actorDid,
      detail: { profileId: profile._id, name: trimmed, providerClass, modelId: profile.modelId, memberSelectable: profile.memberSelectable },
    });
    this.#publish({ type: "profile-changed", profileId: profile._id });
    return profile;
  }

  /** @returns {Promise<object|null>} the profile row or null */
  async get(profileId) {
    if (typeof profileId !== "string" || profileId.length === 0) return null;
    return this.profiles.findOne({ _id: profileId });
  }

  /** The admin surface list: every profile, including withheld ones. */
  async adminList() {
    return (await this.profiles.find({})).map(adminProjection);
  }

  /**
   * The member-selectable list — the availability gate IS this read (the
   * single source of record: memberSelectable of the schema, never a
   * parallel control). Withheld profiles render nowhere: not listed, and
   * their existence never leaks. The projection never carries endpointRef.
   */
  async memberList() {
    return (await this.profiles.find({ memberSelectable: true })).map(memberProjection);
  }

  /**
   * The admin availability flip (Brian's ruling, audited): who flipped what,
   * from what, to what. Withheld profiles may still be used by admin-assigned
   * targets — the gate is on member self-selection and member-facing
   * availability, never on the admin's own assignment power.
   */
  async updateAvailability({ actorDid, isAdmin, profileId, memberSelectable } = {}) {
    await requireAdmin({ actorDid, isAdmin, audit: this.audit, action: "profile-availability" });
    if (typeof memberSelectable !== "boolean") {
      return fail("E_VALIDATION", "memberSelectable must be true or false.");
    }
    const profile = await this.get(profileId);
    if (!profile) return fail("E_PROFILE_NOT_FOUND", "That profile does not exist.");
    const from = profile.memberSelectable;
    if (from === memberSelectable) return adminProjection(profile);
    const updated = { ...profile, memberSelectable };
    await this.profiles.updateOne({ _id: profile._id }, { $set: { memberSelectable } });
    await this.audit.record({
      type: "profile-availability",
      actorIdentityRef: actorDid,
      detail: { profileId: profile._id, name: profile.name, from, to: memberSelectable },
    });
    this.#publish({ type: "profile-changed", profileId: profile._id });
    return adminProjection(updated);
  }
  #publish(event) {
    if (!this.publishChange) return;
    try {
      this.publishChange({ ...event, at: this.now() });
    } catch (error) {
      // Best-effort fan-out: governance writes never fail on publish, but the
      // failure is never silent — it lands on the audit trail.
      void this.audit
        .record({
          type: "profile-change-publish-failed",
          actorIdentityRef: null,
          detail: { event, reason: String(error?.message ?? error) },
        })
        .catch(() => {});
    }
  }
}

/** The admin projection of an InferenceProfile — the admin rides the full record. */
export function adminProjection(profile) {
  return { ...profile };
}

async function requireAdmin({ actorDid, isAdmin, audit, action }) {
  if (!actorDid) {
    if (audit) await audit.record({ type: action, actorIdentityRef: null, detail: { reason: "unsigned" }, outcome: "denied" });
    return fail("E_MUST_SIGN_IN", "Sign in first.");
  }
  if (!isAdmin) {
    if (audit) await audit.record({ type: action, actorIdentityRef: actorDid, detail: { reason: "not the hub admin" }, outcome: "denied" });
    return fail("E_NOT_PERMITTED", "Only the hub admin can manage model profiles.");
  }
  return null;
}

export { requireAdmin };

function defaultNow() {
  return new Date().toISOString();
}
