import { Router } from "express";
import { logAuthFailure } from "@porchlight/shared";

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
  /** PORCH-053: one grant row (any lifecycle state, no hash) — the revoke's network-scope check. */
  getGrant(options: { grantId: string }): Promise<{ _id: string; did: string } | null>;
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
    /** PORCH-019: failing-step diagnosis for the 401 capture. */
    diagnoseAccessToken?(token: string, options?: { networkId?: string | null }): Promise<Record<string, unknown> | null>;
    /** PORCH-053: the ONE capability table (owner + delegate ladder). */
    capabilitiesFor?(role: string): string[];
  };
  audit(record: { networkId: string | null; did?: string | null; action: string; detail?: object }): Promise<unknown>;
  /** Identity account + device services (identity birth, continuity). */
  accountService: FrontDoorAccountService;
  deviceService: FrontDoorDeviceService;
  hubUrl: () => string | null;
  /** PORCH-019: auth-failure capture sink; defaults to console.log. */
  log?: ((line: string) => void) | null;
}

/** Owner console's current-network row shape (network service view). */
type NetworkRow = { _id: string; name?: string | null; hubUrl?: string | null } | null;

export function createFrontDoorRouter({ invites, networks, membership, audit, accountService, deviceService, hubUrl, log }: FrontDoorDeps): Router {
  const router = Router();

  const networkOf = async (): Promise<NetworkRow> =>
    (await networks.get()) as { _id: string; name?: string | null; hubUrl?: string | null } | null;

  /**
   * Perimeter pass sharing the social console's verification: Bearer token
   * verified against THIS network only — 401 with plain member language and
   * the PORCH-019 capture on any failure. Role/capability decisions ride
   * the guards on top of it (requireOwner, requireDeviceCapability).
   */
  async function verifyPerimeter(
    req: { headers: { authorization?: string }; method?: string; originalUrl?: string; url?: string },
    res: { status(n: number): { json(b: object): unknown } },
  ): Promise<{ membership: Record<string, unknown> } | null> {
    const header = req.headers.authorization ?? "";
    const accessToken = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    const network = await networkOf();
    const perimeter =
      accessToken && network
        ? await membership.verifyAccessToken(accessToken, { networkId: network._id })
        : null;
    if (!perimeter) {
      // PORCH-019: captured with the failing step (membership-plane
      // diagnosis) and the session/device identity state — never tokens.
      const diagnosis =
        (await membership.diagnoseAccessToken?.(accessToken ?? "", { networkId: network?._id ?? null })) ??
        { reason: accessToken ? "unknown_token" : "missing_token" };
      logAuthFailure(
        {
          endpoint: `${req.method ?? "UNKNOWN"} ${req.originalUrl ?? req.url ?? "unknown"}`,
          code: "E_SESSION_REQUIRED",
          ...diagnosis,
        },
        log ?? undefined,
      );
      res.status(401).json({ error: "Open your membership before using the owner actions.", code: "E_SESSION_REQUIRED" });
      return null;
    }
    return perimeter;
  }

  /** Owner perimeter, shaped identically to the social console's guard. */
  async function requireOwner(
    req: { headers: { authorization?: string }; method?: string; originalUrl?: string; url?: string },
    res: { status(n: number): { json(b: object): unknown } },
  ): Promise<{ membership: Record<string, unknown> } | null> {
    const perimeter = await verifyPerimeter(req, res);
    if (!perimeter) return null;
    if (perimeter.membership.role !== "owner") {
      res.status(403).json({ error: "The owner console belongs to the network owner.", code: "E_FORBIDDEN" });
      return null;
    }
    return perimeter;
  }

  /** Family-language 403 copy for the delegate-ladder device-link capabilities. */
  const DEVICE_CAPABILITY_COPY: Record<string, string> = {
    device_links_read: "Device links belong to the network's owner and delegates.",
    device_link_issue: "Device links belong to the network's owner and delegates.",
    device_link_revoke: "Withdrawing device links belongs to the network's owner and delegates.",
  };

  /**
   * Device-link capability guard (PORCH-053): the device-link console
   * surfaces authorize through the ONE capability table — the owner or a
   * delegate passes; a plain member is 403. Origin containment is unchanged:
   * the perimeter already verifies against THIS network only.
   */
  async function requireDeviceCapability(
    req: { headers: { authorization?: string }; method?: string; originalUrl?: string; url?: string },
    res: { status(n: number): { json(b: object): unknown } },
    capability: string,
  ): Promise<{ membership: Record<string, unknown> } | null> {
    const perimeter = await verifyPerimeter(req, res);
    if (!perimeter) return null;
    if (!membership.capabilitiesFor?.(perimeter.membership.role as string)?.includes(capability)) {
      res.status(403).json({
        error: DEVICE_CAPABILITY_COPY[capability] ?? "Device links belong to the network's owner and delegates.",
        code: "E_FORBIDDEN",
      });
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

  /** GET /social/console/device-links — device-link states for THIS network's members. */
  router.get("/social/console/device-links", (req, res) => {
    void (async () => {
      if (!(await requireDeviceCapability(req, res, "device_links_read"))) return;
      const network = await networkOf();
      // Origin containment (PORCH-053 ac-6): the list is scoped to members
      // of THIS network — a did with no active membership here renders as
      // nobody's link.
      const rows = network ? await deviceService.listDeviceLinks() : [];
      const scoped: Array<{ _id: string; did: string; status: string; createdAt: string; expiresAt: string }> = [];
      for (const row of rows) {
        const member = network
          ? await membership.activeMembership({ networkId: String(network._id), did: row.did })
          : null;
        if (member) scoped.push(row);
      }
      res.json({ deviceLinks: scoped });
    })();
  });

  /**
   * POST /social/console/device-links {did} — mint the one-time, 24-hour,
   * identity-scoped device link for an ACTIVE member of THIS network and
   * return its shareable link (URL embeds the token, like join links).
   * Rides the capability ladder: the owner OR a delegate (network-scope
   * authorization) issues it; the audit records the actor.
   */
  router.post("/social/console/device-links", (req, res) => {
    void (async () => {
      const actor = await requireDeviceCapability(req, res, "device_link_issue");
      if (!actor) return;
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
        did: actor.membership.did as string | null,
        action: "device_link_issue",
        detail: { grantId: link.grantId, targetDid: did },
      }).catch(() => null);
      const base = (network?.hubUrl as string | undefined) ?? hubUrl() ?? "";
      const linkUrl = base ? `${base.replace(/\/+$/, "")}/device-link/${link.token}` : `/device-link/${link.token}`;
      return res.status(201).json({ did, grantId: link.grantId, token: link.token, expiresAt: link.expiresAt, linkUrl });
    })();
  });

  /**
   * POST /social/console/device-links/revoke {grantId} — instant revocation,
   * scoped to THIS network: the grant's member must hold an active membership
   * here. Rides the capability ladder (the owner or a delegate); the audit
   * records the actor.
   */
  router.post("/social/console/device-links/revoke", (req, res) => {
    void (async () => {
      const actor = await requireDeviceCapability(req, res, "device_link_revoke");
      if (!actor) return;
      const network = await networkOf();
      try {
        const grant = await deviceService.getGrant({ grantId: req.body?.grantId });
        if (!grant) {
          return res.status(404).json({ error: `no device link ${req.body?.grantId ?? ""}`, code: "E_DEVICE_LINK_UNKNOWN" });
        }
        // Origin containment (ac-6): a grant whose member is not live on
        // THIS network is unreachable here — no cross-network revoke, and
        // the unknown-grant answer is identical.
        const member = network ? await membership.activeMembership({ networkId: String(network._id), did: grant.did }) : null;
        if (!member) {
          return res.status(404).json({ error: "That device link is not on this network.", code: "E_DEVICE_LINK_UNKNOWN" });
        }
        const result = await deviceService.revokeDeviceLink({ grantId: req.body?.grantId });
        await audit({
          networkId: String(network?._id),
          did: actor.membership.did as string | null,
          action: "device_link_revoke",
          detail: { grantId: req.body?.grantId, targetDid: grant.did },
        }).catch(() => null);
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