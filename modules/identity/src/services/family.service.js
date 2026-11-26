/**
 * Family service (PORCH-138, the family governance ruling). Families are
 * first-class units in the access model: a parent creates the family and
 * designates its parents — the governing authority of the members' access
 * in every domain that consumes family facts (home grants, later
 * agent/profile narrowing per PORCH-I-011). The home module resolves these
 * facts ONLY through the injected server-wired callbacks (familyById,
 * familiesForMember); it never imports this file (identity/social/home
 * share zero models, and identity owns this one).
 */
export class FamilyService {
  /**
   * @param {import("@porchlight/shared").CollectionLike} families
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} deps.identities
   *   The identity-plane rows every parent/member ref is validated against —
   *   a family is a relation between EXISTING identities, never a mint.
   * @param {() => string} [now]
   */
  constructor(families, { identities }, now = defaultNow) {
    this.families = families;
    this.identities = identities;
    this.now = now;
  }

  /**
   * POST /families — a parent creates the family and designates its
   * parents. The creator is a parent of record; every named ref must
   * resolve to an existing identity. Members and parents stay disjoint:
   * parents govern, members are governed.
   */
  async create({ actorDid, name, parentIdentityRefs = [], memberIdentityRefs = [] } = {}) {
    const actor = await this.#identityOf(actorDid, "Sign in to create a family.");
    const parents = await this.#cleanRefs(
      [actor.did, ...parentIdentityRefs],
      "Every parent is a real identity — check the DIDs and try again.",
    );
    const members = await this.#cleanRefs(
      memberIdentityRefs,
      "Every family member is a real identity — check the DIDs and try again.",
    );
    const clean = cleanFamilyName(name);
    const overlap = members.filter((did) => parents.includes(did));
    if (overlap.length > 0) {
      return fail("E_FAMILY_ROLE_OVERLAP", "Parents govern this family and members are governed by them — keep the two lists apart.");
    }
    const family = {
      _id: `fam_${crypto.randomUUID()}`,
      name: clean,
      parentIdentityRefs: parents,
      memberIdentityRefs: members,
      createdBy: actor.did,
      createdAt: this.now(),
    };
    await this.families.insertOne(family);
    return { family: this.familyView(family) };
  }

  /** GET /families — the caller's families: the ones they govern or belong to. */
  async list({ actorDid } = {}) {
    const actor = await this.#identityOf(actorDid, "Sign in to see your families.");
    const rows = await this.families.find({});
    const mine = rows.filter(
      (family) => (family.parentIdentityRefs ?? []).includes(actor.did)
        || (family.memberIdentityRefs ?? []).includes(actor.did),
    );
    return { families: mine.map((family) => this.familyView(family)) };
  }

  /** POST /families/:familyId/members {did} — a parent adds a member. */
  async addMember({ actorDid, familyId, did } = {}) {
    return this.#mutate({ actorDid, familyId }, (family) => this.#extendList(family, did, "member"));
  }

  /** POST /families/:familyId/members/remove {did} — a parent removes a member. */
  async removeMember({ actorDid, familyId, did } = {}) {
    return this.#mutate({ actorDid, familyId }, async (family) => {
      if (!(family.memberIdentityRefs ?? []).includes(did)) {
        return fail("E_NOT_A_MEMBER", "That person isn't a member of this family.");
      }
      return {
        parentIdentityRefs: family.parentIdentityRefs,
        memberIdentityRefs: family.memberIdentityRefs.filter((row) => row !== did),
      };
    });
  }

  /**
   * POST /families/:familyId/parents {did} — a parent designates another
   * parent (governing authority grows only by a parent's decision). A
   * promoted member leaves the governed member list — one role per person
   * per family.
   */
  async addParent({ actorDid, familyId, did } = {}) {
    return this.#mutate({ actorDid, familyId }, (family) => this.#extendList(family, did, "parent"));
  }

  /** POST /families/:familyId/parents/remove {did} — a family keeps at least one parent. */
  async removeParent({ actorDid, familyId, did } = {}) {
    return this.#mutate({ actorDid, familyId }, async (family) => {
      if (!(family.parentIdentityRefs ?? []).includes(did)) {
        return fail("E_NOT_A_PARENT", "That person isn't a parent of this family.");
      }
      if (family.parentIdentityRefs.length === 1) {
        return fail("E_LAST_PARENT", "A family keeps at least one parent — designate another parent before stepping down.");
      }
      return {
        parentIdentityRefs: family.parentIdentityRefs.filter((row) => row !== did),
        memberIdentityRefs: family.memberIdentityRefs,
      };
    });
  }

  // ---- The cross-module fact resolution surfaces (server-wired callbacks) ----

  /** One family by id, or null (the home module's familyRef resolve). */
  async familyById(familyId) {
    if (typeof familyId !== "string" || !familyId) return null;
    return this.families.findOne({ _id: familyId });
  }

  /** The families where the DID is a governed member (the family-grant resolve). */
  async familiesForMember(did) {
    if (typeof did !== "string" || !did) return [];
    const rows = await this.families.find({});
    return rows.filter((family) => (family.memberIdentityRefs ?? []).includes(did));
  }

  // ---- internals ----

  async #mutate({ actorDid, familyId }, mutate) {
    const actor = await this.#identityOf(actorDid, "Sign in to manage your families.");
    const family = familyId ? await this.families.findOne({ _id: familyId }) : null;
    if (!family) return fail("E_FAMILY_NOT_FOUND", "That family isn't registered on this hub anymore.");
    if (!(family.parentIdentityRefs ?? []).includes(actor.did)) {
      return fail("E_FORBIDDEN", "Only this family's parents govern its membership.");
    }
    const next = await mutate(family); // an updated ref list, or a typed plain-language refusal
    await this.families.updateOne({ _id: family._id }, { $set: next });
    return { family: this.familyView({ ...family, ...next }) };
  }

  /**
   * Add a DID to the parents or members (role-validated, deduped,
   * identity-checked): a promoted member leaves the governed list.
   */
  async #extendList(family, did, role) {
    const clean = typeof did === "string" ? did.trim() : "";
    if (!clean) return fail("E_VALIDATION", "Name the person by their Porchlight identity (DID).");
    await this.#identityOf(clean, "Every parent and member is an existing Porchlight identity — check that DID and try again.");
    const parents = family.parentIdentityRefs ?? [];
    const members = family.memberIdentityRefs ?? [];
    if (role === "parent") {
      if (parents.includes(clean)) {
        return fail("E_ALREADY_IN_ROLE", "That person is already a parent of this family.");
      }
      return { parentIdentityRefs: [...parents, clean], memberIdentityRefs: members.filter((row) => row !== clean) };
    }
    if (members.includes(clean)) {
      return fail("E_ALREADY_IN_ROLE", "That person is already an official member of this family.");
    }
    if (parents.includes(clean)) {
      return fail("E_ALREADY_IN_ROLE", "That person governs this family — parents aren't governed members of it.");
    }
    return { parentIdentityRefs: parents, memberIdentityRefs: [...members, clean] };
  }

  async #cleanRefs(refs, message) {
    const wanted = [...new Set((Array.isArray(refs) ? refs : [])
      .map((did) => (typeof did === "string" ? did.trim() : ""))
      .filter(Boolean))];
    for (const did of wanted) {
      await this.#identityOf(did, message);
    }
    return wanted;
  }

  async #identityOf(did, message) {
    if (typeof did !== "string" || !did.trim()) return fail("E_IDENTITY_REQUIRED", message);
    const row = await this.identities.findOne({ did: did.trim() });
    if (!row) return fail("E_IDENTITY_NOT_FOUND", message);
    return row;
  }

  familyView(family) {
    return {
      _id: family._id,
      name: family.name,
      parentIdentityRefs: family.parentIdentityRefs ?? [],
      memberIdentityRefs: family.memberIdentityRefs ?? [],
      createdBy: family.createdBy,
      createdAt: family.createdAt,
    };
  }
}

function cleanFamilyName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return fail("E_NAME_REQUIRED", "Give this family a name — any household label works.");
  if (name.length > 120) return fail("E_NAME_TOO_LONG", "That name is too long — 120 characters or fewer, please.");
  return name;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function defaultNow() {
  return new Date().toISOString();
}

export default FamilyService;
