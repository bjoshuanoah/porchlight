import { randomUUID } from "node:crypto";
import { loadConfig, saveConfig } from "@porchlight/shared";

/**
 * PORCH-065 — Address change: owner re-auth at the new URL, server half.
 *
 * Cross-plane composition service (Transport → composition): the identity
 * module owns device grants and DID documents, the social module owns the
 * network row and the audit surface, and the runtime config (config.json,
 * the single source of truth, PORCH-017) owns the hub URL fields of record.
 * The service sequences those published pieces — it performs no domain model
 * work itself and owns no domain collections.
 *
 * The two minting surfaces converge here:
 *  - the owner console's address action (live owner session, device-signed;
 *    the new origin is admitted only through the pre-commit verification),
 *  - the grant-consume trigger on the CLI path (derives the origin from the
 *    serving bind — the origin the consume request arrived on, transport-side;
 *    never owner-typed input), with the machine-local ops token as the CLI's
 *    authentication (the same class the update surface established, PORCH-040).
 *
 * The re-point is one idempotent operation scoped to: config hub.tunnel.url,
 * the network row's recorded hubUrl, and every stored DID document's service
 * entries. Join-link and device-link mint templates derive from the same
 * providers per call, so future grants carry the new address with no extra
 * write. Join-link rows captured under an older address are dead in any
 * state by the move contract (they are member artifacts, not self-references)
 * — the status surface lists them as nothing. No identity is ever created by
 * any path here (PRD hard rule): the grant binds the unchanged owner DID.
 */

export const SELF_REAUTH_PURPOSE = "self-reauth";

/** Plain-language failure shape for the console's pre-commit verification. */
export interface OriginVerification {
  ok: boolean;
  /** The normalized origin the verdict keys on (present when the input parses). */
  origin?: string;
  code?: "E_ORIGIN_UNREACHABLE" | "E_ORIGIN_FOREIGN";
  message?: string;
}

interface ReauthNetworkService {
  get(): Promise<{ _id: string; ownerDid?: string | null; hubUrl?: string | null } | null>;
  recordHubUrl(url: string): Promise<unknown>;
}

interface ReauthDeviceService {
  mintDeviceLink(options: { did: string; purpose?: string | null; now?: () => Date }): Promise<{
    grantId: string;
    token: string;
    expiresAt: string;
  }>;
}

interface ReauthDidService {
  repointAllDocuments(options: { hubUrl: string }): Promise<{ repointed: number; hubUrl: string }>;
  staleServiceEntries(options: { hubUrl: string }): Promise<Array<{ kind: string; ref: string; endpoint: string | null }>>;
}

export interface ReauthDeps {
  /** Hub home root — config.json lives at configPath(root). */
  configDir: string;
  networks: ReauthNetworkService;
  deviceService: ReauthDeviceService;
  didService: ReauthDidService;
  /** The existing audit surface (social): {networkId, did, action, detail}. */
  audit(record: { networkId: string | null; did?: string | null; action: string; detail?: object }): Promise<unknown>;
  /** Live serving origin, re-read per call (never a stale copy). */
  hubUrl: () => string | null;
  log?: ((line: string) => void) | null;
  /** Cross-origin verification seam (tests inject a fake fetch). */
  fetchImpl?: typeof fetch | null;
  /** Verification consult timeout (default 5s; tunnel paths can be slow). */
  verifyTimeoutMs?: number;
  /** Injectable clock (idempotency bookkeeping reads this). */
  now?: () => Date;
}

/** A rejected re-auth step: typed for the route mapping, plain-language message. */
class ReauthError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function normalizeOrigin(raw: string): string | null {
  const trimmed = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function sameOrigin(a: string | null, b: string): boolean {
  if (!a) return false;
  return normalizeOrigin(a) === normalizeOrigin(b);
}

export interface RepointResult {
  from: string | null;
  to: string;
  at: string;
  surface: string;
  configRepointed: boolean;
  networkRecorded: boolean;
  didDocumentsRepointed: number;
}

export interface ReauthStatus {
  servingOrigin: string | null;
  networkHubUrl: string | null;
  lastRepoint: { origin: string; at: string; surface: string } | null;
  residue: Array<{ kind: string; ref: string; endpoint: string | null }>;
  instanceId: string | null;
}

/** The console address action's committed result: re-point + self-grant + redirect. */
export interface AddressActionResult {
  origin: string;
  redirectUrl: string;
  grantId: string;
  expiresAt: string;
  repoint: RepointResult;
}

/** The CLI path's mint result: the consume URL + its one-time nature. */
export interface CliGrantResult {
  linkUrl: string;
  grantId: string;
  token: string;
  expiresAt: string;
  base: string;
}

export class ReauthService {
  private readonly deps: ReauthDeps;

  constructor(deps: ReauthDeps) {
    this.deps = deps;
  }

  private config() {
    return loadConfig(this.deps.configDir);
  }

  /**
   * The hub's instance identity — minted once (per the config file) at the
   * first consult and persisted in the runtime config; every later read is
   * config-held and stable across restarts. Synchronous: loadConfig /
   * saveConfig are fs-sync, and the health provider rides this (sync).
   */
  instanceId(): string {
    const current = this.config();
    const existing = current?.hub?.instanceId;
    if (typeof existing === "string" && existing) return existing;
    const minted = randomUUID();
    if (current) {
      saveConfig(this.deps.configDir, { ...current, hub: { ...current.hub, instanceId: minted } });
      this.deps.log?.("minted this hub's instance identity (first consult, config-held)");
    }
    return minted;
  }

  /**
   * Pre-commit verification (console path only): the hub itself proves the
   * candidate origin is reachable AND serving this hub's instance identity
   * — the cross-origin consult reads the candidate's unauthenticated health
   * marker and compares instance ids. Unreachable or foreign refuse with
   * plain language and zero mutation — the caller commits nothing on a
   * non-ok verdict.
   */
  async verifyOrigin(raw: string): Promise<OriginVerification> {
    const origin = normalizeOrigin(raw);
    if (!origin) {
      return {
        ok: false,
        code: "E_ORIGIN_UNREACHABLE",
        message: `"${raw}" does not parse as a hub address, so nothing was verified or changed.`,
      };
    }
    const own = this.instanceId();
    const fetchImpl = this.deps.fetchImpl ?? globalThis.fetch;
    const timeoutMs = this.deps.verifyTimeoutMs ?? 5_000;
    let body: { service?: string; instanceId?: string | null };
    try {
      const response = await fetchImpl(`${origin}/api/health`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        return {
          ok: false,
          code: "E_ORIGIN_UNREACHABLE",
          message: `The hub could not read a healthy server at ${origin} (HTTP ${response.status}). Check the DNS record and the tunnel for the new address first, then try again.`,
        };
      }
      body = (await response.json()) as { service?: string; instanceId?: string | null };
    } catch {
      return {
        ok: false,
        code: "E_ORIGIN_UNREACHABLE",
        message: `The hub could not reach ${origin}. Check the DNS record and the tunnel for the new address first, then try again.`,
      };
    }
    if (body.service !== "porchlight-server" || !body.instanceId || body.instanceId !== own) {
      return {
        ok: false,
        origin,
        code: "E_ORIGIN_FOREIGN",
        message: `${origin} is reachable, but it is not served by this hub. The address move stopped without changing anything.`,
      };
    }
    return { ok: true, origin };
  }

  /**
   * The one idempotent self-reference re-point (both surfaces). Every
   * reference converges: config hub.tunnel.url, the network row's hubUrl,
   * every homed identity's DID-document service entries — each write skips
   * when the recorded value already matches, so a second re-point never
   * double-applies a mutation. The op record (config lastRepoint + audit
   * line) moves on every run — status surfaces the LAST re-point, whichever
   * surface ran it.
   */
  async repoint({ newOrigin, surface, actorDid = null, actorKind = null }: {
    newOrigin: string;
    surface: string;
    actorDid?: string | null;
    actorKind?: string | null;
  }): Promise<RepointResult> {
    const to = normalizeOrigin(newOrigin);
    if (!to) {
      throw new ReauthError("E_ORIGIN_MALFORMED", "the re-point origin does not parse as a hub address");
    }
    const network = await this.deps.networks.get();
    if (!network) {
      throw new ReauthError("E_NETWORK_NOT_FOUND", "no network exists on this hub yet — run the hub's bootstrap first");
    }
    const current = this.config();
    if (!current) {
      throw new ReauthError("E_CONFIG_UNREADABLE", "the hub runtime config could not be re-read for the address re-point");
    }
    const from = current.hub.tunnel.url ?? null;
    const at = (this.deps.now ?? (() => new Date()))().toISOString();
    let configRepointed = false;
    if (!sameOrigin(current.hub.tunnel.url ?? null, to)) {
      saveConfig(this.deps.configDir, {
        ...current,
        hub: { ...current.hub, tunnel: { ...current.hub.tunnel, url: to } },
      });
      configRepointed = true;
    }
    let networkRecorded = false;
    if (!sameOrigin(network.hubUrl ?? null, to)) {
      await this.deps.networks.recordHubUrl(to);
      networkRecorded = true;
    }
    const didDocs = await this.deps.didService.repointAllDocuments({ hubUrl: to });
    // The op record moves on every run (the self-references above never
    // double-apply) — status surfaces the last re-point and which surface
    // ran it, regardless of path.
    const after = this.config() ?? current;
    saveConfig(this.deps.configDir, {
      ...after,
      hub: { ...after.hub, lastRepoint: { origin: to, at, surface } },
    });
    await this.deps
      .audit({
        networkId: String(network._id),
        did: actorDid ?? null,
        action: "address_repoint",
        detail: { from, to, surface, actorKind, at, didDocuments: didDocs.repointed },
      })
      .catch(() => null);
    return {
      from,
      to,
      at,
      surface,
      configRepointed,
      networkRecorded,
      didDocumentsRepointed: didDocs.repointed,
    };
  }

  /**
   * Mint the self-targeted owner device grant (the grant class is the
   * unchanged device-link document: single-use, TTL expiry, instantly
   * revocable). Refuses when the network row carries no recorded owner DID
   * — nothing auto-creates an identity (PRD hard rule).
   */
  async mintOwnerSelfGrant({ surface }: { surface: string }): Promise<{
    grantId: string;
    token: string;
    expiresAt: string;
    consumeUrl: string;
    targetDid: string;
  }> {
    const network = await this.deps.networks.get();
    if (!network) {
      throw new ReauthError("E_NETWORK_NOT_FOUND", "the hub has no network yet — nothing to re-auth against");
    }
    if (!network.ownerDid) {
      throw new ReauthError(
        "E_OWNER_DID_MISSING",
        "the network row carries no recorded owner identity (the pre-founder-binding shape, PORCH-018) — the unlock cannot resolve who to re-bind. Nothing was minted.",
      );
    }
    const mint = await this.deps.deviceService.mintDeviceLink({ did: network.ownerDid, purpose: SELF_REAUTH_PURPOSE });
    const base = this.deps.hubUrl();
    const consumeUrl = base ? `${base.replace(/\/+$/, "")}/device-link/${mint.token}` : `/device-link/${mint.token}`;
    await this.deps
      .audit({
        networkId: String(network._id),
        did: null,
        action: "reauth_grant_mint",
        detail: { grantId: mint.grantId, targetDid: network.ownerDid, surface },
      })
      .catch(() => null);
    return { grantId: mint.grantId, token: mint.token, expiresAt: mint.expiresAt, consumeUrl, targetDid: network.ownerDid };
  }

  /**
   * The console path's address action: pre-commit verify the owner-supplied
   * address, idempotent re-point, self-grant mint, and the redirect to the
   * new origin's grant-consume route carrying the code. Zero mutation on any
   * refusal. The redirect carries the one-time routing grant only —
   * credentials never ride it; the `?reauth=1` marker bit is the arrival
   * hint for the SPA's auto-consume of the SELF-grant (grants by any other
   * channel keep the normal consume screen).
   */
  async consoleAddressAction({ hostname, actorDid = null, actorDeviceId = null }: {
    hostname: string | null;
    actorDid?: string | null;
    actorDeviceId?: string | null;
  }): Promise<AddressActionResult> {
    const verification = await this.verifyOrigin(hostname ?? "");
    if (!verification.ok) {
      throw new ReauthError(verification.code ?? "E_ORIGIN_UNREACHABLE", verification.message ?? "the address was refused");
    }
    const origin = verification.origin as string;
    const network = await this.deps.networks.get();
    if (!network?.ownerDid) {
      throw new ReauthError(
        "E_OWNER_DID_MISSING",
        "the network row carries no recorded owner identity (the pre-founder-binding shape, PORCH-018) — no re-auth grant can be minted. Nothing was re-pointed or minted.",
      );
    }
    // Commit order (TS 11): re-point first, then the self-grant, then the
    // redirect — the re-point is idempotent, a re-run never double-applies.
    const repoint = await this.repoint({
      newOrigin: origin,
      surface: "console",
      actorDid,
      actorKind: `owner-session${actorDeviceId ? ` device ${actorDeviceId}` : ""}`,
    });
    const grant = await this.mintOwnerSelfGrant({ surface: "console" });
    return {
      origin,
      redirectUrl: `${origin}/device-link/${grant.token}?reauth=1`,
      grantId: grant.grantId,
      expiresAt: grant.expiresAt,
      repoint,
    };
  }

  /**
   * The CLI path's mint (machine-local, zero-session): resolve the network
   * row's recorded owner DID and mint one owner-targeted self-reauth grant.
   * No re-point here — the re-point fires at grant consumption
   * (handleSelfGrantConsumed), so the mint itself touches nothing else.
   */
  async mintCliGrant(): Promise<CliGrantResult> {
    const grant = await this.mintOwnerSelfGrant({ surface: "cli" });
    return { linkUrl: grant.consumeUrl, grantId: grant.grantId, token: grant.token, expiresAt: grant.expiresAt, base: this.deps.hubUrl() ?? "" };
  }

  /**
   * The consumed self-grant event (identity observer): CLI-path re-point.
   * Derives the origin from the serving bind of the consume request
   * (transport-side, never owner-typed input). Non-reauth grants — the
   * member cascade's device links — return null and flow unchanged.
   */
  async handleSelfGrantConsumed({ did, purpose, serveOrigin }: {
    did: string;
    purpose: string | null;
    serveOrigin: string | null;
  }): Promise<{ repointed: boolean } | null> {
    if (purpose !== SELF_REAUTH_PURPOSE || !serveOrigin) return null;
    const network = await this.deps.networks.get();
    if (!network || network.ownerDid !== did) {
      this.deps.log?.(`PORCH-065: consumption of grant purpose ${SELF_REAUTH_PURPOSE} did not resolve to the network's owner — no re-point ran`);
      return null;
    }
    await this.repoint({ newOrigin: serveOrigin, surface: "cli", actorDid: did, actorKind: "self-grant-consume" });
    return { repointed: true };
  }

  /** Both reauth status consumers (CLI and the console panel) read the same shape. */
  async status(): Promise<ReauthStatus> {
    const servingOrigin = this.deps.hubUrl() ?? null;
    const network = await this.deps.networks.get().catch(() => null);
    const lastRepoint = this.config()?.hub?.lastRepoint ?? null;
    const referenceOrigin = servingOrigin ?? this.config()?.hub?.tunnel?.url ?? null;
    const didResidue = referenceOrigin
      ? await this.deps.didService.staleServiceEntries({ hubUrl: referenceOrigin }).catch(() => [])
      : [];
    const residue: Array<{ kind: string; ref: string; endpoint: string | null }> = [...didResidue];
    if (network?.hubUrl && referenceOrigin && !sameOrigin(network.hubUrl, referenceOrigin)) {
      residue.push({ kind: "network_hubUrl", ref: String(network._id), endpoint: network.hubUrl });
    }
    return {
      servingOrigin,
      networkHubUrl: network?.hubUrl ?? null,
      lastRepoint,
      residue,
      instanceId: this.instanceId(),
    };
  }
}

export default ReauthService;