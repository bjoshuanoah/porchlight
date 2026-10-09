import { randomUUID } from "node:crypto";

/**
 * Account service (Slice B): bootstrap-period account surface for the
 * identity domain — the owner's first account with its device key binding
 * (ac-1), separately minted agent identities (ac-2), and second-hub adoption
 * of an identity the owner already holds elsewhere (ac-3).
 *
 * Identity rows live in the single `identities` collection (`_id ident_…`),
 * key by key. Adoption NEVER copies the remote identity record, its keys or
 * profile — it stores a reference account pointing at the home hub, and
 * verifying the DID resolves there rides the injectable transport.
 */

function typed(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Default remote transport: global fetch, never following redirects
 * (`redirect: "error"` — a redirect off the pinned hub is an attack signal).
 * Resolves to `{ document }` (bare-document responses are wrapped) or null.
 */
async function defaultTransport(sourceHubUrl, did) {
  try {
    const response = await fetch(
      `${sourceHubUrl}/api/identity/did/${encodeURIComponent(did)}`,
      { redirect: "error" },
    );
    if (!response.ok) return null;
    const body = await response.json();
    return body && typeof body === "object"
      ? { document: body.document ?? body }
      : null;
  } catch {
    return null;
  }
}

/** Key-transport discipline for host-bound device keys (mirrors device.service): public OKP Ed25519 only. */
function validateDeviceKey(publicKeyJwk) {
  if (!publicKeyJwk || typeof publicKeyJwk !== "object") {
    throw typed("E_KEY_TYPE_REJECTED", "device publicKeyJwk is required");
  }
  if ("d" in publicKeyJwk) {
    throw typed(
      "E_PRIVATE_KEY_REJECTED",
      "device keys transport as public OKP JWKs — private key material is never accepted at the hub",
    );
  }
  if (publicKeyJwk.kty !== "OKP" || publicKeyJwk.crv !== "Ed25519") {
    throw typed("E_KEY_TYPE_REJECTED", "device keys must be OKP Ed25519 public JWKs");
  }
  return publicKeyJwk;
}

/**
 * Required human names (PORCH-024, Brian Oct 14, 2026): first and last are
 * required at every identity-creation surface, validated server-side
 * regardless of client state; the family-facing display name is the
 * presentation layer composed from them.
 */
function requireNames(firstName, lastName) {
  const first = typeof firstName === "string" ? firstName.trim() : "";
  const last = typeof lastName === "string" ? lastName.trim() : "";
  if (!first) {
    throw typed("E_FIRST_NAME_REQUIRED", "First name is required — every member joins with a first and last name.");
  }
  if (!last) {
    throw typed("E_LAST_NAME_REQUIRED", "Last name is required — every member joins with a first and last name.");
  }
  return { firstName: first, lastName: last, displayName: `${first} ${last}` };
}

export class AccountService {
  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} deps.identities
   * @param {import("./did.service.js").DidService} deps.didService
   * @param {import("@porchlight/shared").CollectionLike} deps.deviceRegistrations
   * @param {(sourceHubUrl: string, did: string) => Promise<{document: object} | null>} [deps.transport]
   *        Injectable for deterministic tests; defaults to no-redirect fetch.
   * @param {() => string | null} [deps.hubUrlFn] hub URL provider for DID-document endpoints.
   * @param {boolean} [deps.adoptionEnabled] PORCH-026 flag: second-hub identity
   *        adoption is flag-hidden in the current build (default false); a
   *        config flip re-enables the unchanged architecture.
   */
  constructor({ identities, didService, deviceRegistrations, transport = null, hubUrlFn = null, adoptionEnabled = false }) {
    this.identities = identities;
    this.didService = didService;
    this.deviceRegistrations = deviceRegistrations;
    this.transport = transport ?? defaultTransport;
    this.hubUrlFn = hubUrlFn;
    this.adoptionEnabled = adoptionEnabled === true;
  }

  /** Whether any identity exists on this hub (drives the bootstrap offer). */
  async hasAccount() {
    return (await this.identities.findOne({})) !== null;
  }

  /**
   * The account row driving the bootstrap page (first identity or null).
   */
  async get() {
    return this.identities.findOne({});
  }

  /**
   * GET /account bootstrap state (adoption offer, PORCH-026): the offer is a
   * single flag-driven service decision — hidden builds never advertise
   * adoption (`adoptionAvailable: false`, the fresh invite/join path is the
   * only one any setup surface sees); enabling `identity.adoptionEnabled`
   * restores the offer on a hub with no first account yet.
   */
  async bootstrapOffer() {
    const account = await this.get();
    return { account, adoptionAvailable: account === null && this.adoptionEnabled };
  }

  async putDocument(did) {
    return this.didService.putDocument(did, { hubUrlFn: this.hubUrlFn });
  }

  /** Create a first-account registration row directly (same shape as device.service). */
  async bindDevice(did, { deviceId, label = null, publicKeyJwk, createdBy }) {
    validateDeviceKey(publicKeyJwk);
    if (!deviceId) {
      throw typed("E_DEVICE_KEY_REQUIRED", "deviceId and publicKeyJwk are required to bind a device");
    }
    const registration = {
      _id: `reg_${randomUUID()}`,
      did,
      deviceId,
      label,
      publicKeyJwk,
      createdBy,
      status: "active",
      revokedAt: null,
      createdAt: new Date().toISOString(),
    };
    await this.deviceRegistrations.insertOne(registration);
    return { ...registration };
  }

  /**
   * Owner bootstrap (ac-1): mint the identity + DID document and bind the
   * device's own key. Required names (PORCH-024): a missing first or last
   * name → E_FIRST_NAME_REQUIRED / E_LAST_NAME_REQUIRED, before any other
   * check; the display name is composed from the two. The bootstrap gate is
   * one `kind:"owner"` account max —
   * an existing owner is returned with `created:false`. The device key (and
   * only the public half) binds at setup: a missing or incomplete device →
   * E_DEVICE_KEY_REQUIRED; any private (`d`) field → E_PRIVATE_KEY_REJECTED.
   */
  async createFirstAccount({ firstName, lastName, email = null, device = null } = {}) {
    const names = requireNames(firstName, lastName);
    const ownerGate = await this.identities.findOne({ kind: "owner" });
    if (ownerGate) return { created: false, account: { ...ownerGate } };

    if (!device || !device.deviceId || !device.publicKeyJwk) {
      throw typed(
        "E_DEVICE_KEY_REQUIRED",
        "the first account requires a device binding (deviceId and publicKeyJwk)",
      );
    }
    validateDeviceKey(device.publicKeyJwk);

    const identity = await this.didService.createIdentity({
      actorType: "human",
      displayName: names.displayName,
      firstName: names.firstName,
      lastName: names.lastName,
      email,
    });
    await this.identities.updateOne(
      { _id: identity._id },
      { $set: { kind: "owner" } },
    );
    const account = await this.identities.findOne({ _id: identity._id });

    const didDocument = await this.putDocument(identity.did);
    const registration = await this.bindDevice(identity.did, {
      deviceId: device.deviceId,
      label: device.label ?? null,
      publicKeyJwk: device.publicKeyJwk,
      createdBy: "first-account",
    });
    return { created: true, account, didDocument, registration };
  }

  /**
   * Agent identity (ac-2): same account records, `actorType:"agent"` — the
   * host mints its own key and binds it. Agents are separate identities
   * minted freely: no single-owner gate applies.
   */
  async createAgentIdentity({ displayName, device }) {
    if (!displayName) {
      throw typed("E_DISPLAY_NAME_REQUIRED", "displayName is required");
    }
    if (!device || !device.deviceId || !device.publicKeyJwk) {
      throw typed(
        "E_DEVICE_KEY_REQUIRED",
        "an agent identity requires its host-bound device key (deviceId and publicKeyJwk)",
      );
    }
    const identity = await this.didService.createIdentity({ actorType: "agent", displayName });
    const didDocument = await this.putDocument(identity.did);
    const registration = await this.bindDevice(identity.did, {
      deviceId: device.deviceId,
      label: device.label ?? null,
      publicKeyJwk: device.publicKeyJwk,
      createdBy: "agent",
    });
    const account = await this.identities.findOne({ _id: identity._id });
    return { created: true, account, didDocument, registration };
  }

  /**
   * Member identity birth at the front door (PORCH-010): an invited member's
   * first identity is minted by their own device at join time, exactly as the
   * owner's is at bootstrap. The invite is the trust root — its verification
   * and consumption live in the social perimeter (admit), never here; this
   * birth only mints the DID + DID document and binds the device-held public
   * key. No single-owner gate: members are not owners. Required names
   * (PORCH-024): a missing first or last name → E_FIRST_NAME_REQUIRED /
   * E_LAST_NAME_REQUIRED; the display name is composed from the two.
   */
  async createMemberAccount({ firstName, lastName, device = null } = {}) {
    const names = requireNames(firstName, lastName);
    if (!device || !device.deviceId || !device.publicKeyJwk) {
      throw typed(
        "E_DEVICE_KEY_REQUIRED",
        "the member identity requires a device binding (deviceId and publicKeyJwk)",
      );
    }
    validateDeviceKey(device.publicKeyJwk);
    const identity = await this.didService.createIdentity({
      actorType: "human",
      displayName: names.displayName,
      firstName: names.firstName,
      lastName: names.lastName,
    });
    await this.identities.updateOne({ _id: identity._id }, { $set: { kind: "member" } });
    const account = await this.identities.findOne({ _id: identity._id });
    const didDocument = await this.putDocument(identity.did);
    const registration = await this.bindDevice(identity.did, {
      deviceId: device.deviceId,
      label: device.label ?? null,
      publicKeyJwk: device.publicKeyJwk,
      createdBy: "join",
    });
    return { created: true, account, didDocument, registration };
  }

  /**
   * Adopt, onto this second hub, an identity the owner already holds at the
   * home hub (ac-3). Verification rides the transport: the DID must resolve
   * at its home hub (E_REMOTE_IDENTITY_NOT_FOUND when not). The account row
   * stored here is a REFERENCE — the remote identity record, keys and profile
   * are never copied; this hub stores only where the identity lives.
   * Idempotent on (sourceHubUrl, did); one-owner bootstrap gate intact
   * (E_OWNER_ACCOUNT_EXISTS).
   */
  async adoptIdentity({ sourceHubUrl, did, displayName = null } = {}) {
    // PORCH-026 (Oct 14, 2026 ruling): adoption is flag-hidden in V1 — no
    // adoption entry point is visible anywhere and the capability refuses
    // when hidden; identity.adoptionEnabled re-enables the unchanged
    // architecture (a flag flip, never a rebuild).
    if (!this.adoptionEnabled) {
      throw typed(
        "E_ADOPTION_HIDDEN",
        "identity adoption is hidden in this build; setting identity.adoptionEnabled in the runtime config re-enables it",
      );
    }
    if (!sourceHubUrl || !did) {
      throw typed("E_ADOPTION_FIELDS_REQUIRED", "sourceHubUrl and did are required");
    }
    const ownerGate = await this.identities.findOne({ kind: "owner" });
    if (ownerGate) {
      throw typed(
        "E_OWNER_ACCOUNT_EXISTS",
        "an owner account already exists on this hub; adoption applies only before first-account creation",
      );
    }
    const existing = (await this.identities.find({ kind: "adopted" })).find(
      (row) =>
        row.identityRef?.did === did &&
        row.identityRef?.sourceHubUrl === sourceHubUrl,
    );
    if (existing) return { adopted: false, alreadyAdopted: true, account: { ...existing } };

    const remote = await this.transport(sourceHubUrl, did);
    if (!remote || !remote.document) {
      throw typed(
        "E_REMOTE_IDENTITY_NOT_FOUND",
        `the DID ${did} does not resolve at the source hub ${sourceHubUrl}`,
      );
    }

    const row = {
      _id: `ident_${randomUUID()}`,
      did,
      kind: "adopted",
      identityRef: { did, sourceHubUrl: String(sourceHubUrl) },
      adoptedIdentity: { sourceHubUrl: String(sourceHubUrl), did },
      actorType: "human",
      displayName: displayName ?? did,
      email: null,
      handle: null,
      profile: {},
      homingStatus: "home",
      migratedToIssuer: null,
      createdAt: new Date().toISOString(),
    };
    await this.identities.insertOne(row);
    return { adopted: true, alreadyAdopted: false, account: { ...row } };
  }

  /** Thin pass-through for controller wiring (DID stability: handles change, DIDs don't). */
  setHandle(args) {
    return this.didService.setHandle(args);
  }

  /**
   * Family-facing member names by DID (PORCH-029): the member directory shows
   * members by name, so the owner view resolves the membership rows' DIDs
   * against the identity rows. Read-only display fields only — the social
   * module consumes this through the server-wired boundary callback and never
   * reads identity internals (CI boundary).
   */
  async namesFor(dids = []) {
    const wanted = [...new Set((dids ?? []).filter((did) => typeof did === "string" && did.length > 0))];
    if (wanted.length === 0) return [];
    const rows = await this.identities.find({});
    return rows
      .filter((row) => wanted.includes(row.did))
      .map((row) => {
        const composed = [row.firstName, row.lastName]
          .filter((part) => typeof part === "string" && part.length > 0)
          .join(" ");
        const displayName = row.displayName ?? (composed || null);
        return displayName ? { did: row.did, displayName } : null;
      })
      .filter((row) => row !== null);
  }

  /** Update the identity's profile fields (profile data lives on the account row). */
  async recordProfile({ did, displayName = undefined, profile = undefined }) {
    const row = await this.identities.findOne({ did });
    if (!row) {
      throw typed("E_IDENTITY_NOT_FOUND", `no identity for ${did}`);
    }
    const $set = {};
    if (displayName !== undefined) $set.displayName = displayName;
    if (profile !== undefined) $set.profile = profile;
    if (Object.keys($set).length > 0) {
      await this.identities.updateOne({ did }, { $set });
    }
    return (await this.identities.findOne({ did }));
  }
}

export default AccountService;