import { logAuthFailure } from "@porchlight/shared";

/**
 * Bearer token extraction shared by the identity controllers' session guards
 * (PORCH-019).
 *
 * @param {{ headers?: { authorization?: string } }} req
 * @returns {string | null} the Bearer token, or null.
 */
export function bearerToken(req) {
  const header = req?.headers?.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

/**
 * The request's endpoint label for failure capture: method + route path as
 * the client addressed it (originalUrl carries the /api prefix the hub
 * mounted).
 *
 * @param {Record<string, any>} [req]
 */
export function endpointLabel(req) {
  return `${req?.method ?? "UNKNOWN"} ${req?.originalUrl ?? req?.url ?? "unknown"}`;
}

/**
 * The identity session guard (PORCH-019). Verifies the Bearer access token
 * against the identity plane and fails closed with the standing 401 body —
 * byte-identical to the pre-PORCH-019 per-controller copies, so no client
 * contract changes. Every failure writes ONE captured auth-failure line:
 * endpoint, failing step (identity-plane diagnosis), and the session/device
 * identity state (never token material).
 *
 * @param {object} args
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {{ verifyAccessToken: (t: string, now?: () => Date) => Promise<{ did: string, sessionId: unknown } | null>,
 *           diagnoseAccessToken: (t: string, now?: () => Date) => Promise<Record<string, unknown> | null>,
 *           registrationStatusFor: (row: { did: string, deviceId: string }) => Promise<string> }} args.authService
 * @param {((line: string) => void) | null} [log] - capture sink override (tests).
 * @returns {Promise<{ did: string, sessionId: unknown } | null>}
 */
export async function requireSessionOr401({ req, res, authService, log = null }) {
  const token = bearerToken(req);
  const identity = token ? await authService.verifyAccessToken(token) : null;
  if (identity) return identity;
  const diagnosis = (await authService.diagnoseAccessToken(token)) ?? { reason: "unknown_token" };
  logAuthFailure(
    { endpoint: endpointLabel(req), code: "E_SESSION_REQUIRED", ...diagnosis },
    log,
  );
  res.status(401).json({ error: "active session required", code: "E_SESSION_REQUIRED" });
  return null;
}

/**
 * The session-open/refresh failure capture (PORCH-019): the auth surface's
 * 401s name the failing step in the challenge/proof/refresh chain (the code
 * already carries it) with the claimed did/deviceId — claims, NOT resolved
 * session state, since no session could be opened.
 *
 * @param {import("express").Request} req
 * @param {string} code - the typed error code mapped to 401.
 * @param {{ did?: string | null, deviceId?: string | null, detail?: string | null }} [claims]
 * @param {((line: string) => void) | null} [log]
 */
export function logAuthSurfaceFailure(req, code, claims = {}, log = null) {
  logAuthFailure(
    {
      endpoint: endpointLabel(req),
      code,
      reason: code,
      claimedDid: claims.did ?? null,
      claimedDeviceId: claims.deviceId ?? null,
      detail: claims.detail ?? null,
    },
    log,
  );
}

/**
 * The membership/session refresh failure capture (PORCH-019): the client's
 * renewal path — a 401 here is the renewal failing at a specific step.
 *
 * @param {import("express").Request} req
 * @param {Record<string, string | null>} diagnosis
 * @param {((line: string) => void) | null} [log]
 */
export function logSessionRenewalFailure(req, diagnosis, log = null) {
  logAuthFailure({ endpoint: endpointLabel(req), code: "E_SESSION_REQUIRED", ...diagnosis }, log);
}

export default { bearerToken, endpointLabel, requireSessionOr401, logAuthSurfaceFailure, logSessionRenewalFailure };