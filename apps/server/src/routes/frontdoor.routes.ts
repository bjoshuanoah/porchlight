import { Router } from "express";

/**
 * Front-door composition routes (PORCH-010). Transport-level composition
 * ONLY: the identity module mints identities and owns device continuity;
 * the social module owns the invite perimeter and membership. This router
 * sequences their published services and owns no domain logic. Mounted under
 * /api only when BOTH serving domains are enabled — the front door spans
 * them (member join mints an identity and admits a membership).
 *
 * Surfaces:
 *  - POST /bootstrap/join-member — invited member's identity birth: the join
 *    code is verified against the live invite perimeter BEFORE any mint; the
 *    device-held public key binds at birth; the invite is NOT consumed here
 *    (admission's redeem guard stays the only consumer).
 *  - Owner console device surfaces — the identity module refuses cross-
 *    identity reads by design, so these ride the social owner perimeter:
 *    the caller's membership token must verify as the network OWNER, and the
 *    target of a device link must hold an ACTIVE membership on this network.
 */

/** Plain-language invite-verification failures, mapped like admission's own. */
const INVITE_STATUS: Record<string, number> = {
  E_INVITE_REQUIRED: 400,
  E_INVITE_NOT_FOUND: 404,
  E_INVITE_REVOKED: 403,
  E_INVITE_EXHAUSTED: 410,
};

const IDENTITY_STATUS: Record<string, number> = {
  E_FIRST_NAME_REQUIRED: 400,
  E_LAST_NAME_REQUIRED: 400,
  E_DEVICE_KEY_REQUIRED: 400,
  E_PRIVATE_KEY_REJECTED: 403,
  E_KEY_TYPE_REJECTED: 403,
  E_IDENTITY_NOT_FOUND: 404,
  E_DEVICE_LINK_UNKNOWN: 404,
  E_DEVICE_LINK_EXPIRED: 410,
  E_DEVICE_LINK_CONSUMED: 409,
  E_DEVICE_LINK_REVOKED: 403,
  E_REGISTRATION_UNKNOWN: 404,
};

export interface FrontDoorAccountService {
  createMemberAccount(options: { firstName?: string; lastName?: string; device: { deviceId: string; label?: string | null; publicKeyJwk: Record<string, unknown> } | null }): Promise<{
    account: { _id: string; did: string; firstName: string | null; lastName: string | null; displayName: string };
    didDocument: unknown;
    registration: Record<string, unknown>;
  }>;
}

export interface FrontDoorDeviceService {
  mintDeviceLink(options: { did: string; now?: () => Date }): Promise<{ grantId: string; token: string; expiresAt: string }>;
  revokeDeviceLink(options: { grantId: string; now?: () => Date }): Promise<{ revoked: boolean; grantId: string; revokedAt?: string; alreadyDead?: boolean }>;
  listDeviceLinks(options?: { now?: () => Date }): Promise<Array<{ _id: string; did: string; status: string; createdAt: string; expiresAt: string }>>;
  listAllRegistrations(): Promise<Array<Record<string, unknown>>>;
  revokeRegistration(options: { registrationId: string }): Promise<{ revoked: string; supersededSessions: number }>;
}

interface FrontDoorDeps {
  /** Social invite perimeter (verification + network lookups). */
  invites: {
    verify(code: string): Promise<{ valid: boolean; code?: string; message?: string; invite?: Record<string, unknown> }>;
  };
  networks: { get(): Promise<unknown> };
  membership: {
    verifyAccessToken(token: string, options?: { networkId?: string; now?: () => Date }): Promise<{ membership: Record<string, unknown>; session: Record<string, unknown> } | null>;
    activeMembership(options: { networkId: string; did: string }): Promise<Record<string, unknown> | null>;
  };
  audit(record: { networkId: string | null; did?: string | null; action: string; detail?: object }): Promise<unknown>;
  /** Identity account + device services (identity birth, continuity). */
  accountService: FrontDoorAccountService;
  deviceService: FrontDoorDeviceService;
  hubUrl: () => string | null;
}

/** Owner console's current-network row shape (network service view). */
type NetworkRow = { _id: string; name?: string | null; hubUrl?: string | null } | null;

export function createFrontDoorRouter({ invites, networks, membership, audit, accountService, deviceService, hubUrl }: FrontDoorDeps): Router {
  const router = Router();

  const networkOf = async (): Promise<NetworkRow> =>
    (await networks.get()) as { _id: string; name?: string | null; hubUrl?: string | null } | null;

  /** Owner perimeter, shaped identically to the social console's guard. */
  async function requireOwner(req: { headers: { authorization?: string } }, res: { status(n: number): { json(b: object): unknown } }): Promise<{ membership: Record<string, unknown> } | null> {
    const header = req.headers.authorization ?? "";
    const accessToken = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    const network = await networkOf();
    const perimeter =
      accessToken && network
        ? await membership.verifyAccessToken(accessToken, { networkId: network._id })
        : null;
    if (!perimeter) {
      res.status(401).json({ error: "Open your membership before using the owner actions.", code: "E_SESSION_REQUIRED" });
      return null;
    }
    if (perimeter.membership.role !== "owner") {
      res.status(403).json({ error: "The owner console belongs to the network owner.", code: "E_FORBIDDEN" });
      return null;
    }
    return perimeter;
  }

  /**
   * POST /bootstrap/join-member {code, firstName, lastName, device{deviceId, label?, publicKeyJwk}}
   * Invited member identity birth: verify the invite FIRST (plain-language
   * failure, nothing stored), then mint the identity bound to the device key.
   * Required names (PORCH-024): a missing first or last name is rejected
   * here, regardless of client state.
   */
  router.post("/bootstrap/join-member", (req, res) => {
    void (async () => {
      const { code, firstName, lastName, device } = req.body ?? {};
      try {
        const verification = await invites.verify(code ?? null);
        if (!verification?.valid) {
          const status = INVITE_STATUS[verification?.code ?? ""] ?? 400;
          return res.status(status).json({ error: verification?.message ?? "This link is not a valid join link.", code: verification?.code ?? "E_INVITE_REQUIRED" });
        }
        const minted = await accountService.createMemberAccount({ firstName, lastName, device });
        const network = await networkOf();
        return res.status(201).json({
          created: true,
          network: network ? { _id: network._id, name: network.name } : null,
          account: minted.account,
          registration: minted.registration,
        });
      } catch (error) {
        const typed = error as { code?: string; message?: string };
        const status = IDENTITY_STATUS[typed.code ?? ""] ?? 500;
        const message = status === 500 ? "Something went wrong on the hub. Try again, or contact the network owner." : typed.message;
        return res.status(status).json({ error: message, code: typed.code ?? "E_INTERNAL" });
      }
    })();
  });

  /** GET /social/console/device-links — owner-visible device-link states. */
  router.get("/social/console/device-links", (req, res) => {
    void (async () => {
      if (!(await requireOwner(req, res))) return;
      res.json({ deviceLinks: await deviceService.listDeviceLinks() });
    })();
  });

  /**
   * POST /social/console/device-links {did} — mint the one-time, 24-hour,
   * identity-scoped device link for an ACTIVE member of THIS network and
   * return its shareable link (URL embeds the token, like join links).
   */
  router.post("/social/console/device-links", (req, res) => {
    void (async () => {
      if (!(await requireOwner(req, res))) return;
      const { did } = req.body ?? {};
      const network = await networkOf();
      if (!did || typeof did !== "string") {
        return res.status(400).json({ error: "did required", code: "E_FIELDS_REQUIRED" });
      }
      const member = network ? await membership.activeMembership({ networkId: network._id, did }) : null;
      if (!member) {
        return res.status(404).json({ error: "That member is not on this network.", code: "E_MEMBER_NOT_FOUND" });
      }
      const link = await deviceService.mintDeviceLink({ did });
      await audit({
        networkId: network ? String(network._id) : null,
        did,
        action: "device_link_issue",
        detail: { grantId: link.grantId },
      }).catch(() => null);
      const base = (network?.hubUrl as string | undefined) ?? hubUrl() ?? "";
      const linkUrl = base ? `${base.replace(/\/+$/, "")}/device-link/${link.token}` : `/device-link/${link.token}`;
      return res.status(201).json({ did, grantId: link.grantId, token: link.token, expiresAt: link.expiresAt, linkUrl });
    })();
  });

  /** POST /social/console/device-links/revoke {grantId} — instant revocation. */
  router.post("/social/console/device-links/revoke", (req, res) => {
    void (async () => {
      if (!(await requireOwner(req, res))) return;
      try {
        const result = await deviceService.revokeDeviceLink({ grantId: req.body?.grantId });
        return res.json(result);
      } catch (error) {
        const typed = error as { code?: string; message?: string };
        const status = IDENTITY_STATUS[typed.code ?? ""] ?? 500;
        return res.status(status).json({ error: typed.message, code: typed.code ?? "E_INTERNAL" });
      }
    })();
  });

  /** GET /social/console/devices — every registration row (owner member view). */
  router.get("/social/console/devices", (req, res) => {
    void (async () => {
      if (!(await requireOwner(req, res))) return;
      res.json({ devices: await deviceService.listAllRegistrations() });
    })();
  });

  /** POST /social/console/devices/revoke {registrationId} — instant revoke, any member's device. */
  router.post("/social/console/devices/revoke", (req, res) => {
    void (async () => {
      if (!(await requireOwner(req, res))) return;
      try {
        const result = await deviceService.revokeRegistration({ registrationId: req.body?.registrationId });
        return res.json(result);
      } catch (error) {
        const typed = error as { code?: string; message?: string };
        const status = IDENTITY_STATUS[typed.code ?? ""] ?? 500;
        return res.status(status).json({ error: typed.message, code: typed.code ?? "E_INTERNAL" });
      }
    })();
  });

  return router;
}