import { requireSignedSession, requireSession } from "../util/writes.js";

/**
 * Home service (PORCH-137 TS 1). Homes are created, renamed, listed, and
 * switched by household members; the creator becomes the owner and the
 * owner governs renames. Switching is enforced hub-side: every subsequent
 * read and command resolves scope against the home in view — authorized
 * members read one home's surfaces and nothing else. The model is
 * identical from one home to many (property-agnostic law).
 */
export class HomeService {
  /**
   * @param {import("@porchlight/shared").CollectionLike} homes
   * @param {import("@porchlight/shared").CollectionLike} homeMembers
   * @param {object} deps
   * @param {(token: string | null) => Promise<{ did: string, deviceId?: string } | null>} deps.verifySession
   * @param {((did: string, deviceId: string) => Promise<{ publicKeyJwk: object } | null>) | null} deps.registeredDeviceKey
   * @param {() => string | null} [deps.orgId] - hub installation org of record.
   * @param {() => string} [deps.now]
   * @param {({ did: string, homeId?: string | null }) => Promise<object | null>} [deps.grantResolver]
   *   The grant-side half of access resolution (PORCH-138), set by the
   *   module assembly after the GrantService exists (the resolver needs this
   *   service for its own writes). Membership wins: the resolver is consulted
   *   ONLY when no home membership matches, so exactly one of the three V1
   *   access classes applies. Absent → membership-only (PORCH-137 posture).
   */
  constructor(homes, homeMembers, { verifySession, registeredDeviceKey, orgId = null, now = defaultNow, grantResolver = null } = {}) {
    this.homes = homes;
    this.homeMembers = homeMembers;
    this.verifySession = verifySession;
    this.registeredDeviceKey = registeredDeviceKey;
    this.orgId = orgId ?? (() => null);
    this.now = now;
    this.grantResolver = grantResolver;
    /** Session-free surface-list callables (wired by the assembly; see surfacesForActor). */
    this.surfaceLists = null;
  }

  /**
   * POST /homes — create one home. Any verified identity may create; the
   * creator lands as the owner member of record. Signed member write.
   */
  async create({ accessToken, payload, signature } = {}) {
    const session = await requireSignedSession({
      accessToken, payload, signature,
      verifySession: this.verifySession,
      registeredDeviceKey: this.registeredDeviceKey,
    });
    const name = cleanName(payload?.name);
    const home = {
      _id: `home_${crypto.randomUUID()}`,
      orgId: this.orgId() ?? null,
      name,
      createdBy: session.did,
      deviceSignature: session.deviceSignature,
      createdAt: this.now(),
    };
    await this.homes.insertOne(home);
    await this.homeMembers.insertOne({
      _id: `hm_${crypto.randomUUID()}`,
      homeId: home._id,
      did: session.did,
      role: "owner",
      addedBy: session.did,
      createdAt: this.now(),
    });
    return { home: this.homeView(home, "owner") };
  }

  /**
   * GET /homes — the caller's homes, owner/member role included. Visiting
   * identities (live grants) see exactly the granted homes appended after
   * their memberships — a visitor opens Porchlight normally and switches to
   * the granted home (PORCH-138 ac-1); no granted home is shown without a
   * live grant, and membership-only callers ride the resolution exactly as
   * before.
   */
  async list({ accessToken } = {}) {
    const { did } = await requireSession({ accessToken, verifySession: this.verifySession });
    const rows = await this.homeMembers.find({ did });
    const homes = [];
    for (const row of rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
      const home = await this.homes.findOne({ _id: row.homeId });
      if (home) homes.push({ home: this.homeView(home, row.role), access: ownershipAccess(row.role) });
    }
    if (this.grantResolver) {
      const grants = await this.grantResolver({ did });
      for (const granted of grants ?? []) {
        if (rows.some((row) => row.homeId === granted.homeId)) continue;
        const home = await this.homes.findOne({ _id: granted.homeId });
        if (home) homes.push({ home: this.homeView(home, null), access: grantAccess(granted) });
      }
    }
    return { homes: homes.map((row) => ({ ...row.home, access: row.access })) };
  }

  /**
   * PUT /homes/:homeId — rename (owner only; plain-language refusal for
   * everyone else). Signed member write.
   */
  async rename({ accessToken, homeId, payload, signature } = {}) {
    const { deviceSignature, role } = await this.#authorizeSigned({
      accessToken, homeId, payload, signature,
    });
    if (role !== "owner") {
      return fail("E_NOT_PERMITTED", "Only the home owner can rename this home.");
    }
    const name = cleanName(payload?.name);
    const updated = await this.homes.updateOne({ _id: homeId }, { $set: { name, deviceSignature } });
    if (!updated) return failHomeNotFound(homeId);
    const home = await this.homes.findOne({ _id: homeId });
    return { home: this.homeView(home, "owner") };
  }

  /**
   * GET /homes/:homeId — resolve the home the caller is a member of. The
   * single authorization seam every other service rides (hub-side scope
   * enforcement on every read and command, never a client-side gate).
   */
  async authorize({ accessToken, homeId } = {}) {
    const { did } = await requireSession({ accessToken, verifySession: this.verifySession });
    return this.authorizeMember({ did, homeId });
  }

  /**
   * The member's homes with their access blocks of record, session-free
   * (the did already resolved — the PORCH-149 agent tool registry's
   * authority path). The SAME resolution authorizeMember applies:
   * membership wins and is never re-consulted with the grant side; live
   * grant homes (individual or family-distributed) resolve through the
   * grant resolver. One access class per home, scopes attached for
   * grantees (null scopes = the home's full member surface).
   */
  async homesForActor({ did } = {}) {
    if (!did) return fail("E_VALIDATION", "A Porchlight identity is required.");
    const [allHomes, memberships] = await Promise.all([
      this.homes.find({}),
      this.homeMembers.find({ did }),
    ]);
    const blocks = [];
    for (const membership of memberships) {
      const home = allHomes.find((h) => h._id === membership.homeId);
      if (!home) continue;
      blocks.push({
        homeId: home._id,
        name: home.name,
        accessClass: "owner-membership",
        role: membership.role ?? null,
        scopes: null,
      });
    }
    const granted = this.grantResolver ? await this.grantResolver({ did }) : [];
    for (const grant of granted ?? []) {
      if (blocks.some((b) => b.homeId === grant.homeId)) continue;
      const home = allHomes.find((h) => h._id === grant.homeId);
      if (!home) continue;
      blocks.push({
        homeId: grant.homeId,
        name: home.name,
        accessClass: grant.accessClass,
        role: null,
        scopes: grant.scopes ?? [],
      });
    }
    return blocks;
  }

  /**
   * GET /homes/:homeId's whole payload, session-free (the did already
   * resolved). The surface lists ride injected callables wired at assembly
   * (`surfaceLists`) — the exact list services the controller surfaces()
   * composes, every one re-resolving the member's access live (no cached
   * or copied verdicts).
   */
  async surfacesForActor({ did, homeId } = {}) {
    const { home, role, access } = await this.authorizeMember({ did, homeId });
    if (!this.surfaceLists) {
      return fail("E_SURFACES_UNWIRED", "This hub hasn't connected the home surfaces yet.");
    }
    const [areaList, deviceList, sceneList, automationList] = await Promise.all([
      this.surfaceLists.areas({ did, homeId }),
      this.surfaceLists.devices({ did, homeId }),
      this.surfaceLists.scenes({ did, homeId }),
      this.surfaceLists.automations({ did, homeId }),
    ]);
    return {
      home: { ...this.homeView(home, role), viewerDid: did },
      access: {
        accessClass: access.accessClass,
        role: access.role ?? null,
        scopes: access.scopes ?? null,
      },
      areas: areaList.areas,
      devices: deviceList.devices,
      scenes: sceneList.scenes,
      automations: automationList.automations,
    };
  }

  /**
   * GET /homes/:homeId — everything the home in view serves: home, areas,
   * devices, scenes, automations. Switching homes swaps exactly this
   * payload; every read is member-scoped hub-side. The session path of the
   * controller's surfaces(): the session resolves the did, the verdicts
   * stay in the actor seam.
   */
  async surfaces({ accessToken, homeId } = {}) {
    const { did } = await requireSession({ accessToken, verifySession: this.verifySession });
    return this.surfacesForActor({ did, homeId });
  }

  /** Home-scope enforcement for a already-resolved identity. */
  async authorizeMember({ did, homeId } = {}) {
    if (!homeId) return fail("E_VALIDATION", "Choose the home you are reaching first.");
    const membership = await this.homeMembers.findOne({ homeId, did });
    if (!membership) {
      const granted = this.grantResolver
        ? await this.grantResolver({ did, homeId })
        : null;
      if (!granted) {
        return fail("E_NOT_PERMITTED", "You don't hold access to that home — Porchlight shows members and live visit grants only.");
      }
      const home = await this.homes.findOne({ _id: homeId });
      if (!home) return failHomeNotFound(homeId);
      // A live grant (individual or family-distributed): every consumer of
      // this seam scopes its reads and writes through granted.scopes.
      return { did, home, role: null, access: grantAccess(granted) };
    }
    const home = await this.homes.findOne({ _id: homeId });
    if (!home) return failHomeNotFound(homeId);
    // Membership is the first access class of record and the resolution
    // winner — grants are never consulted for a member (no parallel path).
    return { did, home, role: membership.role, access: ownershipAccess(membership.role) };
  }

  /** View projection: no signatures ride served payloads. */
  homeView(home, role) {
    return {
      _id: home._id,
      orgId: home.orgId ?? null,
      name: home.name,
      role: role ?? null,
      createdAt: home.createdAt,
    };
  }

  /** Internal: the signed rename path needs the membership role beside the session. */
  async #authorizeSigned({ accessToken, homeId, payload, signature }) {
    const session = await requireSignedSession({
      accessToken, payload, signature,
      verifySession: this.verifySession,
      registeredDeviceKey: this.registeredDeviceKey,
    });
    const authorized = await this.authorizeMember({ did: session.did, homeId });
    return { ...session, role: authorized.role };
  }
}

export function cleanName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) {
    return fail("E_NAME_REQUIRED", "Give this home a name — any household-chosen label works.");
  }
  if (name.length > 120) {
    return fail("E_NAME_TOO_LONG", "That name is too long — 120 characters or fewer, please.");
  }
  return name;
}

export function failHomeNotFound(homeId) {
  const error = new Error("That home isn't here anymore — it may have been removed.");
  error.code = "E_HOME_NOT_FOUND";
  error.homeId = homeId ?? null;
  throw error;
}

/**
 * The access block every authorizeMember answer carries (PORCH-138 TS 1):
 * the resolved class of record plus the scopes a grantees' consumer must
 * enforce. Null scopes = membership = the home's full member surface.
 */
export function ownershipAccess(role) {
  return { accessClass: "owner-membership", role, scopes: null };
}

export function grantAccess(granted) {
  return {
    accessClass: granted.accessClass,
    role: null,
    scopes: granted.scopes ?? [],
  };
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function defaultNow() {
  return new Date().toISOString();
}

export default HomeService;
