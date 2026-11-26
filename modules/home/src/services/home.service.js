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
   */
  constructor(homes, homeMembers, { verifySession, registeredDeviceKey, orgId = null, now = defaultNow } = {}) {
    this.homes = homes;
    this.homeMembers = homeMembers;
    this.verifySession = verifySession;
    this.registeredDeviceKey = registeredDeviceKey;
    this.orgId = orgId ?? (() => null);
    this.now = now;
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

  /** GET /homes — the caller's homes, owner/member role included. */
  async list({ accessToken } = {}) {
    const { did } = await requireSession({ accessToken, verifySession: this.verifySession });
    const rows = await this.homeMembers.find({ did });
    const homes = [];
    for (const row of rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
      const home = await this.homes.findOne({ _id: row.homeId });
      if (home) homes.push(this.homeView(home, row.role));
    }
    return { homes };
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

  /** Home-scope enforcement for a already-resolved identity. */
  async authorizeMember({ did, homeId } = {}) {
    if (!homeId) return fail("E_VALIDATION", "Choose the home you are reaching first.");
    const membership = await this.homeMembers.findOne({ homeId, did });
    if (!membership) {
      return fail("E_NOT_PERMITTED", "You are not a member of that home, so Porchlight won't show you its surfaces.");
    }
    const home = await this.homes.findOne({ _id: homeId });
    if (!home) return failHomeNotFound(homeId);
    return { did, home, role: membership.role };
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

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function defaultNow() {
  return new Date().toISOString();
}

export default HomeService;
