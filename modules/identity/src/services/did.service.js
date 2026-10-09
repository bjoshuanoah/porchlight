import { randomUUID, randomBytes } from "node:crypto";

/**
 * W3C DID Core contexts pinned for the `did:porch` method. The jws-2020
 * security suite context licenses the JsonWebKey2020 verification method.
 */
const DID_CONTEXT = [
  "https://www.w3.org/ns/did/v1",
  "https://w3id.org/security/suites/jws-2020/v1",
];

const ACTOR_TYPES = new Set(["human", "agent"]);

export class DidService {
  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} deps.identities
   * @param {import("@porchlight/shared").CollectionLike} deps.didDocuments
   * @param {import("./signing.service.js").HubSigningService} deps.signing
   */
  constructor({ identities, didDocuments, signing }) {
    this.identities = identities;
    this.didDocuments = didDocuments;
    this.signing = signing;
  }

  /**
   * Mint an opaque, hub-independent DID: `did:porch:` + 160 bits of entropy.
   * Minted once at identity birth, never reissued, never derived from a
   * handle — handles are the changeable presentation layer.
   */
  mintDid() {
    return `did:porch:${randomBytes(20).toString("hex")}`;
  }

  /**
   * Create the account record (an identity row) and mint its DID. The row
   * homes here (`homingStatus "home"`) until a migration handoff marks it
   * moved; the presentation-plane handle starts empty unless given.
   */
  async createIdentity({ actorType, displayName, email = null, handle = null, profile = {} }) {
    if (!ACTOR_TYPES.has(actorType)) {
      const error = new Error(`actorType must be "human" or "agent"`);
      error.code = "E_ACTOR_TYPE_INVALID";
      throw error;
    }
    if (!displayName) {
      const error = new Error("displayName is required");
      error.code = "E_DISPLAY_NAME_REQUIRED";
      throw error;
    }
    const row = {
      _id: `ident_${randomUUID()}`,
      did: this.mintDid(),
      actorType,
      displayName,
      email,
      handle,
      profile,
      homingStatus: "home",
      migratedToIssuer: null,
      createdAt: new Date().toISOString(),
    };
    await this.identities.insertOne(row);
    return { ...row };
  }

  /**
   * Build the DID document in the W3C DID Core shape. The verificationMethod
   * references the hub-adjacent operator did-doc key (`signing.didDocKey()`),
   * NEVER member device keys — device keys register per-device and member
   * writes verify by challenge signature, not via the document.
   */
  async buildDocument(did, { hubUrlFn = null } = {}) {
    const { publicKeyJwk } = await this.signing.didDocKey();
    const hubUrl = hubUrlFn ? hubUrlFn() : null;
    return {
      "@context": DID_CONTEXT,
      id: did,
      verificationMethod: [
        {
          id: `${did}#identity-plane-key`,
          type: "JsonWebKey2020",
          controller: did,
          publicKeyJwk,
        },
      ],
      authentication: [`${did}#identity-plane-key`],
      service: [
        { id: `${did}#porchlight-home`, type: "PorchlightHome", serviceEndpoint: hubUrl },
        { id: `${did}#identity-auth`, type: "IdentityAuth", serviceEndpoint: hubUrl },
      ],
    };
  }

  /** Build and upsert the did_documents row for `did` → the fresh document. */
  async putDocument(did, { hubUrlFn = null } = {}) {
    const document = await this.buildDocument(did, { hubUrlFn });
    await this.didDocuments.updateOne(
      { did },
      { $set: { did, document, updatedAt: new Date().toISOString() }, upsert: true },
    );
    return document;
  }

  /** The stored document object, or null when this hub hosts no such DID. */
  async getDocument(did) {
    const row = await this.didDocuments.findOne({ did });
    return row ? row.document : null;
  }

  /**
   * Re-point the document's service entries after a migration (or before the
   * first serve when no document exists yet). The DID and the
   * verificationMethod are structurally untouched — only homing pointers
   * move. `homingStatus`, when given, updates the identity row's homing.
   */
  async repointDocument(did, { hubUrlFn = null, homingStatus = null } = {}) {
    const row = await this.didDocuments.findOne({ did });
    const document = row
      ? structuredClone(row.document)
      : await this.buildDocument(did, { hubUrlFn });
    const hubUrl = hubUrlFn ? hubUrlFn() : null;
    document["@context"] = DID_CONTEXT;
    document.id = did;
    document.service = [
      { id: `${did}#porchlight-home`, type: "PorchlightHome", serviceEndpoint: hubUrl },
      { id: `${did}#identity-auth`, type: "IdentityAuth", serviceEndpoint: hubUrl },
    ];
    await this.didDocuments.updateOne(
      { did },
      { $set: { did, document, updatedAt: new Date().toISOString() }, upsert: true },
    );
    if (homingStatus) {
      await this.identities.updateOne({ did }, { $set: { homingStatus } });
    }
    return document;
  }

  /** Handle → identity row (presentation-plane resolution); null when unset/unknown. */
  async resolveHandle(handle) {
    if (!handle) return null;
    const row = await this.identities.findOne({ handle });
    return row ? { ...row } : null;
  }

  /**
   * Set the changeable presentation-plane handle. Uniqueness is per hub:
   * another identity already holding the handle is rejected; re-setting a
   * handle to its own current value is a no-op success. `handle: null`
   * clears the handle.
   */
  async setHandle({ did, handle }) {
    const row = await this.identities.findOne({ did });
    if (!row) {
      const error = new Error(`no identity for ${did}`);
      error.code = "E_IDENTITY_NOT_FOUND";
      throw error;
    }
    if (handle) {
      if (row.handle === handle) return { ...row };
      const taken = await this.identities.findOne({ handle });
      if (taken && taken._id !== row._id) {
        const error = new Error(`handle "${handle}" is already taken on this hub`);
        error.code = "E_HANDLE_TAKEN";
        throw error;
      }
    }
    await this.identities.updateOne({ did }, { $set: { handle: handle ?? null } });
    return { ...(await this.identities.findOne({ did })) };
  }
}

export default DidService;