import { requireSignedSession, requireSession } from "../util/writes.js";
import { fail } from "./errors.js";
import {
  ACCESS_CLASSES,
  GRANT_SCOPE_RESOURCE_TYPES,
  GRANT_SCOPE_VERBS,
  distributionFor,
  withinEnvelope,
} from "./scopes.js";

/**
 * Grant service (PORCH-138, PRD 1 / TS 1 of the Porchlight Home initiative).
 * The access model's V1 classes of record: owner-membership, the individual
 * visit grant, and the family grant with parent-distributed member scopes.
 * The grant is written from a home's Access surface by the owner, rides the
 * EXISTING Porchlight identity (never minting one), and its expiry
 * (checkout) or early revocation takes effect immediately at the
 * enforcement layer — an already-open session's next read or command is
 * evaluated against current state, so a grantee never outruns their grant.
 *
 * Family grants consume identity-plane family facts ONLY through injected
 * callbacks (identityFacts) — the home module never imports identity, and
 * the identity plane stays the separate platform surface it already is:
 *   resolveIdentity(did)     -> { did, displayName } | null
 *   familyById(familyId)     -> family document | null
 *   familiesForMember(did)   -> [ family documents where did is a member ]
 * Unwired facts fail closed: no grant can be created, no family grant can
 * resolve — grants never ride an unverified identity.
 */
export class GrantService {
  /**
   * @param {import("@porchlight/shared").CollectionLike} grants
   * @param {import("./home.service.js").HomeService} homes
   * @param {object} homeCollections - the home-owned collections scope
   *   validation checks resourceRefs against (devices, scenes, areas).
   * @param {import("./audit.service.js").HomeAuditService} audit
   * @param {{ verifySession, registeredDeviceKey }} identity
   * @param {{ resolveIdentity?: Function, familyById?: Function, familiesForMember?: Function } | null} identityFacts
   * @param {() => string} [now]
   */
  constructor(grants, homes, { devices, scenes, areas }, audit, { verifySession, registeredDeviceKey }, identityFacts = null, now = defaultNow) {
    this.grants = grants;
    this.homes = homes;
    this.devices = devices;
    this.scenes = scenes;
    this.areas = areas;
    this.audit = audit;
    this.verifySession = verifySession;
    this.registeredDeviceKey = registeredDeviceKey;
    this.identityFacts = identityFacts ?? emptyFacts;
    this.now = now;
  }

  /**
   * POST /homes/:homeId/grants — the owner grants an existing identity
   * selected device/scene/area controls for a visit (individual), or
   * envelopes a family (family grant, distributions assigned by its
   * parents). Signed owner write; audit row type "grant".
   */
  async create({ accessToken, homeId, payload, signature } = {}) {
    const { did, deviceSignature } = await this.#requireOwner({
      accessToken, homeId, payload, signature,
    });
    const scopes = await this.#cleanScopes(homeId, payload?.scopes);
    const expiresAt = cleanExpiry(payload?.expiresAt, this.now());
    const grant = {
      _id: `grant_${crypto.randomUUID()}`,
      homeId,
      scopes,
      expiresAt,
      createdFor: null,
      parentDistributions: [],
      createdBy: did,
      deviceSignature,
      createdAt: this.now(),
      revokedAt: null,
      revokedBy: null,
    };
    if (payload?.familyId) {
      const family = await this.identityFacts.familyById(String(payload.familyId));
      if (!family) {
        return fail("E_FAMILY_NOT_FOUND", "That family isn't registered to this hub — create the family in the family organizer first, then add it to this home.");
      }
      grant.familyRef = family._id;
      grant.createdFor = family.name;
    } else {
      const granteeDid = cleanDid(payload?.granteeDid, "Tell Porchlight who you're granting — their Porchlight identity (DID).");
      const resolved = await this.identityFacts.resolveIdentity?.(granteeDid);
      if (!resolved) {
        return fail("E_GRANTEE_UNKNOWN", "That identity isn't on this hub — grants ride the Porchlight identity a person already has; Porchlight never mints one here.");
      }
      grant.granteeDid = granteeDid;
      grant.createdFor = resolved.displayName ?? granteeDid;
    }
    await this.grants.insertOne(grant);
    await this.audit.record({
      type: "grant",
      homeId,
      actorIdentityRef: did,
      deviceId: null,
      deviceSignature,
      detail: {
        grantId: grant._id,
        accessClass: grant.familyRef ? ACCESS_CLASSES.FAMILY_GRANT : ACCESS_CLASSES.INDIVIDUAL_GRANT,
        ...(grant.granteeDid ? { granteeDid: grant.granteeDid } : {}),
        ...(grant.familyRef ? { familyRef: grant.familyRef } : {}),
        createdFor: grant.createdFor,
        scopes,
        expiresAt,
      },
      outcome: "confirmed",
    });
    return { grant: this.view(grant) };
  }

  /**
   * POST /grants/:grantId/distributions — the ACTING PARENT distributes part
   * of this family's envelope to one member. Fail-closed at write: every
   * scope in the distribution must be within the envelope (⊆ by resource and
   * verbs), and an over-envelope distribution is refused with plain
   * language. Every member reaches exactly their distribution, never the
   * envelope implicitly. Audit row type "family-distribute" with the acting
   * parent as the actor.
   */
  async distribute({ accessToken, grantId, payload, signature } = {}) {
    const grant = await this.#grantOf(grantId);
    if (!grant.familyRef) {
      return fail("E_NOT_PERMITTED", "Distributions belong to family grants — this grant names its visitor directly.");
    }
    // The acting parent: resolved against the family's identity-plane record
    // through the injected facts, never a home-module guess.
    const { did, deviceSignature } = await requireSignedSession({
      accessToken, payload, signature,
      verifySession: this.verifySession,
      registeredDeviceKey: this.registeredDeviceKey,
    });
    const family = await this.identityFacts.familyById?.(grant.familyRef);
    if (!family) {
      return fail("E_FAMILY_NOT_FOUND", "That family isn't registered to this hub anymore, so its members' access has ended.");
    }
    if (!(family.parentIdentityRefs ?? []).includes(did)) {
      return fail("E_NOT_PERMITTED", "Only this family's parents decide what its members reach in the visit.");
    }
    const memberIdentityRef = cleanDid(payload?.memberIdentityRef, "Name the family member this distribution is for.");
    if (!(family.memberIdentityRefs ?? []).includes(memberIdentityRef)) {
      return fail("E_FAMILY_MEMBER_UNKNOWN", "That person isn't a member of this family — add them to the family in the family organizer first.");
    }
    const scopes = await this.#cleanScopes(grant.homeId, payload?.scopes);
    if (!withinEnvelope(grant.scopes, scopes)) {
      return fail("E_ENVELOPE_EXCEEDED", "That's beyond what the host granted this family — hand out only what's inside the visit's envelope.");
    }
    const kept = (grant.parentDistributions ?? []).filter(
      (row) => row.memberIdentityRef !== memberIdentityRef,
    );
    const parentDistributions = [...kept, { memberIdentityRef, scopes }];
    await this.grants.updateOne({ _id: grant._id }, { $set: { parentDistributions } });
    await this.audit.record({
      type: "family-distribute",
      homeId: grant.homeId,
      actorIdentityRef: did,
      deviceId: null,
      deviceSignature,
      detail: {
        grantId: grant._id,
        familyRef: grant.familyRef,
        familyName: family.name,
        memberIdentityRef,
        scopes,
      },
      outcome: "confirmed",
    });
    return { grant: this.view({ ...grant, parentDistributions }) };
  }

  /**
   * POST /grants/:grantId/revoke — early revocation. Takes effect
   * immediately at the enforcement layer (resolveFor evaluates state on
   * every read), so a visitor's next command from an open dashboard is
   * denied. Audit row type "revoke".
   */
  async revoke({ accessToken, grantId, payload, signature } = {}) {
    const grant = await this.#grantOf(grantId);
    const { did, deviceSignature } = await this.#requireOwner({
      accessToken, homeId: grant.homeId, payload, signature,
    });
    if (grant.revokedAt) {
      return fail("E_GRANT_ALREADY_REVOKED", "This grant has already ended — there's nothing left to revoke.");
    }
    const revokedAt = this.now();
    await this.grants.updateOne({ _id: grant._id }, { $set: { revokedAt, revokedBy: did, deviceSignature } });
    await this.audit.record({
      type: "revoke",
      homeId: grant.homeId,
      actorIdentityRef: did,
      deviceId: null,
      deviceSignature,
      detail: {
        grantId: grant._id,
        ...(grant.granteeDid ? { granteeDid: grant.granteeDid } : {}),
        ...(grant.familyRef ? { familyRef: grant.familyRef, familyName: grant.createdFor } : {}),
      },
      outcome: "confirmed",
    });
    return { grant: this.view({ ...grant, revokedAt, revokedBy: did }) };
  }

  /**
   * GET /homes/:homeId/grants — the Access surface of record (owner only):
   * every grant of the home with its live state as of now.
   */
  async list({ accessToken, homeId } = {}) {
    const { did } = await requireSession({ accessToken, verifySession: this.verifySession });
    const authorized = await this.homes.authorizeMember({ did, homeId });
    if (authorized.role !== "owner") {
      return fail("E_NOT_PERMITTED", "Only the home's owner manages this home's access.");
    }
    const rows = await this.grants.find({ homeId: String(homeId) });
    return { grants: rows.sort(byCreatedAtDesc).map((grant) => this.view(grant)) };
  }

  /**
   * The grant-side half of access resolution (HomeService resolves
   * membership first — exactly one of the three classes applies, and
   * membership wins). Two shapes:
   *   { homeId } one home: the ONE live grant access the DID holds there,
   *     or null (the HomeService seam consults this after a membership miss).
   *   { homeId: null } the DID's granted homes (the /homes list for a
   *     visitor): [{ homeId, accessClass, scopes }].
   * Family grants resolve through the identity facts; a member WITHOUT a
   * parent distribution reaches nothing — the envelope never applies
   * implicitly. Expiry and revocation evaluate on every call: mid-session
   * enforcement is this method being the only resolution path.
   */
  async resolveFor({ did, homeId = null } = {}) {
    const now = this.now();
    const rows = (await this.grants.find({}))
      .filter((grant) => homeId == null || grant.homeId === homeId)
      .filter((grant) => !grant.revokedAt && grant.expiresAt > now);
    const accessClassOf = (grant) => (grant.familyRef ? ACCESS_CLASSES.FAMILY_GRANT : ACCESS_CLASSES.INDIVIDUAL_GRANT);

    // The individual-grant class: every live grant to this DID, scope-unioned
    // (the class is one; several grant docs of it grant one merged slice).
    const individual = rows.filter((grant) => grant.granteeDid === did);
    const answers = [];
    const byHome = new Map();
    for (const grant of individual) {
      const merged = byHome.get(grant.homeId);
      if (merged) merged.scopes.push(...(grant.scopes ?? []));
      else {
        const entry = { homeId: grant.homeId, accessClass: accessClassOf(grant), scopes: [...(grant.scopes ?? [])] };
        byHome.set(grant.homeId, entry);
        answers.push(entry);
      }
    }

    // The family-grant class: through the identity facts, a live family
    // grant resolves only for a member holding a parent distribution — the
    // envelope never applies implicitly (fail closed).
    const familyIds = new Set(
      ((await this.identityFacts.familiesForMember?.(did)) ?? []).map((family) => family._id),
    );
    for (const grant of rows.filter((row) => row.familyRef && familyIds.has(row.familyRef))) {
      const distribution = distributionFor(grant, did);
      if (!distribution) continue;
      const merged = byHome.get(grant.homeId);
      if (merged) {
        // Two classes can never merge: membership wins earlier, and a DID's
        // individual grant in the same home outranks any family grant.
        continue;
      }
      const entry = { homeId: grant.homeId, accessClass: ACCESS_CLASSES.FAMILY_GRANT, scopes: [...(distribution.scopes ?? [])] };
      byHome.set(grant.homeId, entry);
      answers.push(entry);
    }

    const resolved = answers.map((entry) => ({ ...entry, scopes: unionScopes(entry.scopes) }));
    if (homeId != null) return resolved.find((entry) => entry.homeId === homeId) ?? null;
    return resolved;
  }

  /** View projection: no signatures ride served payloads; state reads live. */
  view(grant) {
    const now = this.now();
    return {
      _id: grant._id,
      homeId: grant.homeId,
      accessClass: grant.familyRef ? ACCESS_CLASSES.FAMILY_GRANT : ACCESS_CLASSES.INDIVIDUAL_GRANT,
      granteeDid: grant.granteeDid ?? null,
      familyRef: grant.familyRef ?? null,
      createdFor: grant.createdFor ?? null,
      scopes: grant.scopes ?? [],
      parentDistributions: grant.parentDistributions ?? [],
      expiresAt: grant.expiresAt,
      createdBy: grant.createdBy,
      createdAt: grant.createdAt,
      revokedAt: grant.revokedAt ?? null,
      revokedBy: grant.revokedBy ?? null,
      status: grant.revokedAt ? "revoked" : grant.expiresAt <= now ? "expired" : "live",
    };
  }

  /** Signed owner write for both create and revoke. */
  async #requireOwner({ accessToken, homeId, payload, signature }) {
    const session = await requireSignedSession({
      accessToken, payload, signature,
      verifySession: this.verifySession,
      registeredDeviceKey: this.registeredDeviceKey,
    });
    const authorized = await this.homes.authorizeMember({ did: session.did, homeId });
    if (authorized.role !== "owner") {
      return fail("E_NOT_PERMITTED", "Only the home's owner grants and revokes access — everyone else holds what was already granted.");
    }
    return { did: session.did, deviceSignature: session.deviceSignature };
  }

  async #grantOf(grantId) {
    const grant = grantId ? await this.grants.findOne({ _id: grantId }) : null;
    if (!grant) {
      return fail("E_GRANT_NOT_FOUND", "That grant isn't on record anymore — the visit may have already ended.");
    }
    return grant;
  }

  /**
   * Scope validation at write (fail closed): each scope names ONE resource
   * of THIS home with at least one verb. resourceRefs that don't resolve
   * into the home are refused — a grant can never name what isn't there.
   */
  async #cleanScopes(homeId, rawScopes) {
    const rows = Array.isArray(rawScopes) ? rawScopes : null;
    if (!rows?.length) {
      return fail("E_VALIDATION", "A grant carries what the visit may reach — name at least one device, scene, or area with its verbs.");
    }
    const scopes = [];
    for (const row of rows) {
      const resourceType = row?.resourceType;
      const resourceRef = row?.resourceRef;
      const verbs = Array.isArray(row?.verbs) ? [...new Set(row.verbs)] : null;
      if (!GRANT_SCOPE_RESOURCE_TYPES.includes(resourceType)) {
        return fail("E_VALIDATION", "A granted resource is a device, a scene, or an area — nothing else.");
      }
      if (typeof resourceRef !== "string" || !resourceRef) {
        return fail("E_VALIDATION", "Every granted scope names the exact resource it carries.");
      }
      if (!verbs?.length || !verbs.every((verb) => GRANT_SCOPE_VERBS.includes(verb))) {
        return fail("E_VALIDATION", "Every granted scope carries its verbs — see (view) or also control.");
      }
      const home = resourceType === "device" ? this.devices : resourceType === "scene" ? this.scenes : this.areas;
      const resource = await home.findOne({ _id: resourceRef });
      if (!resource || resource.homeId !== homeId) {
        return fail("E_VALIDATION", "A grant can only name resources of the home it grants into.");
      }
      scopes.push({ resourceType, resourceRef, verbs });
    }
    return scopes;
  }
}

const emptyFacts = Object.freeze({});

function cleanExpiry(value, now) {
  if (typeof value !== "string" || !value.trim()) {
    return fail("E_VALIDATION", "Set when the visit ends — every grant carries its checkout time.");
  }
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) {
    return fail("E_VALIDATION", "That checkout time can't be read — use a date-time the hub understands.");
  }
  if (at.toISOString() <= new Date(now).toISOString()) {
    return fail("E_VALIDATION", "The checkout has to be in the future — a visit grant that already ended grants nothing.");
  }
  return at.toISOString();
}

function cleanDid(value, message) {
  const did = typeof value === "string" ? value.trim() : "";
  if (!did) return fail("E_VALIDATION", message);
  return did;
}

function byCreatedAtDesc(a, b) {
  return String(b.createdAt).localeCompare(String(a.createdAt));
}

/**
 * Merge several live grants' scopes into one slice: same resource unions
 * its verbs (the class is one; separate grant docs of a class grant one
 * merged slice — never a second mechanism).
 */
function unionScopes(scopes) {
  const merged = [];
  for (const scope of scopes ?? []) {
    const existing = merged.find(
      (row) => row.resourceType === scope?.resourceType && row.resourceRef === scope?.resourceRef,
    );
    if (existing) existing.verbs = [...new Set([...existing.verbs, ...(scope?.verbs ?? [])])];
    else merged.push({ resourceType: scope.resourceType, resourceRef: scope.resourceRef, verbs: [...(scope.verbs ?? [])] });
  }
  return merged;
}

function defaultNow() {
  return new Date().toISOString();
}

export default GrantService;
