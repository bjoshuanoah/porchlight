/**
 * WebFinger-class account-resource resolution: a presentation-plane handle
 * (`acct:<handle>@<host>` or bare `acct:<handle>`) resolves to the identity's
 * stable DID plus the hub's identity links. Handles live on this hub only —
 * uniqueness is per hub, and a handle reassignment keeps the DID.
 */
export class WebfingerService {
  /**
   * @param {object} deps
   * @param {import("./did.service.js").DidService} deps.didService
   * @param {() => string | null} deps.hubUrlFn hub URL provider (integrator-injected)
   */
  constructor({ didService, hubUrlFn }) {
    this.didService = didService;
    this.hubUrlFn = hubUrlFn;
  }

  /**
   * Resolve an acct: resource. Unknown handle or a non-acct resource → null
   * (the caller maps to 404); a missing/empty resource throws
   * E_RESOURCE_REQUIRED (the caller maps to 400).
   *
   * @returns {Promise<null | {subject: string, links: Array<{rel: string, type?: string, href: string}>}>}
   */
  async query(resource) {
    if (resource === null || resource === undefined || String(resource).trim() === "") {
      const error = new Error("resource is required");
      error.code = "E_RESOURCE_REQUIRED";
      throw error;
    }
    const raw = String(resource).trim();
    // Standards-form account resources only; other resource shapes (https URLs
    // for foreign objects) are not ours to resolve → null.
    if (!raw.startsWith("acct:")) return null;
    const localPart = raw.slice("acct:".length).split("@")[0];
    if (!localPart) return null;

    const identity = await this.didService.resolveHandle(localPart);
    if (!identity) return null;

    const hubUrl = this.hubUrlFn ? this.hubUrlFn() : null;
    // Canonical WebFinger normalization: complete a bare acct URI with the
    // hub's own host; a resource that already carries a host passes through.
    let subject = raw;
    if (!raw.includes("@") && hubUrl) {
      try {
        subject = `${raw}@${new URL(hubUrl).host}`;
      } catch {
        subject = raw;
      }
    }

    return {
      subject,
      links: [
        { rel: "self", type: "application/did+json", href: identity.did },
        { rel: "http://openid.net/specs/connect/1.0/issuer", href: hubUrl },
      ],
    };
  }
}

export default WebfingerService;