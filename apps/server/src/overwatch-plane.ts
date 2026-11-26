import { Router } from "express";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createAuditLog, createConfigStore, createDial, createFollowService, createTrackedObjectsService, createVisitService } from "@porchlight/overwatch";
import { createOverwatchHandler } from "@porchlight/overwatch/server";

/**
 * PORCH-140: the hub-side overwatch transport adapter — thin by law. The
 * REST plane's behavior lives in @porchlight/overwatch (packages/overwatch);
 * this adapter only (a) roots the config + audit files under the hub root,
 * (b) supplies the entity/clip/outage seams (empty until the entity pipeline
 * lands — the plane stays honest with empty lists), and (c) translates the
 * hub identity seam into the plane's authorize callback.
 */

/** The identity seam subset the plane uses (the router's own identityAuth). */
export interface OverwatchIdentityAuth {
  verifyAccessToken: (token: string) => Promise<{ did: string; sessionId: unknown } | null>;
}

/** The home seam subset the plane uses (the router's assembled home module). */
export interface OverwatchHomeModule {
  homeService: {
    /** The single authorization seam every home surface rides (PORCH-137). */
    authorize(args: { accessToken: string; homeId: string }): Promise<{ did: string; role: string | null }>;
  };
}

export interface OverwatchPlaneOptions {
  /** The hub root of record; the plane's files ride <root>/config/overwatch/. */
  root: string;
  identityAuth: OverwatchIdentityAuth | null;
  homeModule: OverwatchHomeModule | null;
  /** Entity-layer chains + their clip refs; empty until the engine pipeline serves. */
  chainsProvider?: () => unknown[];
  clipsProvider?: (chain: unknown) => Array<{ cameraId: string; path: string; from: number; to: number }> | undefined;
  /** Known camera outage records for the visit-timeline gap law. */
  outagesProvider?: () => Array<{ cameraId: string; from: number; to: number }>;
  log?: ((line: string) => void) | null;
}

/** A typed refusal the plane's handler maps straight onto the transport. */
function refusal(status: number, code: string, message: string): Error {
  const error = new Error(message) as Error & { status: number; code: string };
  error.status = status;
  error.code = code;
  return error;
}

/** Bearer-token extraction (the hub's home surfaces accept nothing else). */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? null;
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token === "" ? null : token;
}

/**
 * Build the overwatch plane's Express router: it delegates every request to
 * the plain-JS node:http handler, restoring the full path (Express strips
 * prefixes per mount) and handing over the body Express already parsed
 * instead of letting the plane re-read the drained stream.
 */
export function createOverwatchPlaneRouter(options: OverwatchPlaneOptions): Router {
  const configPath = `${options.root}/config/overwatch/config.json`;
  const auditPath = `${options.root}/config/overwatch/audit.jsonl`;
  const store = createConfigStore({ path: configPath });
  const audit = createAuditLog({ path: auditPath });
  const dial = createDial({ store, audit });
  const chainsProvider = options.chainsProvider ?? (() => []);
  const clipsProvider = options.clipsProvider ?? (() => undefined);
  const followService = createFollowService({ audit, chainsProvider, clipsProvider });
  const trackedService = createTrackedObjectsService({ chainsProvider, followService });
  const visitService = createVisitService({ store, chainsProvider, clipsProvider, outagesProvider: options.outagesProvider });

  const { homeModule } = options;
  const homeService = homeModule?.homeService ?? null;

  /**
   * The owner seam: an access token → did → the home module's authorization
   * for the homeId query param. Anonymous or unverifiable tokens refuse 401
   * (the home surfaces' own posture); a resolvable identity authorized for
   * the home passes reads, and owner-membership gates every mutation. Fail
   * closed: no home module or no homeId resolves nothing — deny.
   */
  const authorize = async ({ req, action }: { req: unknown; action: string; resource: string }): Promise<boolean> => {
    const request = req as IncomingMessage;
    const token = bearerToken(request);
    if (!token) {
      throw refusal(401, "E_MUST_SIGN_IN", "Sign in with your Porchlight identity to reach this home.");
    }
    const identity = options.identityAuth ? await options.identityAuth.verifyAccessToken(token) : null;
    if (!identity?.did) {
      throw refusal(401, "E_MUST_SIGN_IN", "Sign in with your Porchlight identity to reach this home.");
    }
    const homeRequest = request as IncomingMessage & { originalUrl?: string };
    const homeId = new URL(homeRequest.originalUrl ?? request.url ?? "/", "http://localhost").searchParams.get("homeId");
    if (!homeService || !homeId) return false;
    // The single authorization seam every home surface rides (PORCH-137);
    // a non-member refusal throws and lands as the plane's 403.
    const authorized = await homeService.authorize({ accessToken: token, homeId });
    if (action !== "read" && authorized.role !== "owner") return false;
    return true;
  };

  const handler = createOverwatchHandler({
    services: { store, dial, audit, trackedService, followService, visitService },
    authorize,
    log: options.log ?? null,
  });

  const plane = Router();
  plane.use((req, res, next) => {
    req.url = req.originalUrl ?? req.url;
    void handler(req as IncomingMessage, res as unknown as ServerResponse, { body: req.body as object | null }).catch(next);
  });
  return plane;
}
