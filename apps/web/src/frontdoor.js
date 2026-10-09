/**
 * Pure front-door helpers (PORCH-010): join-link and device-link parsing and
 * the verify-failure state mapping. No member-facing copy lives here — the
 * screens own the words (copy audit scans the member identity surfaces);
 * these helpers return the failure STATE for the screens to name.
 */

export const FAILURE_STATES = ["invalid", "revoked", "used", "unreachable", "wrongUrl", "generic"];

const stateByInviteCode = {
  E_INVITE_REQUIRED: "invalid",
  E_INVITE_NOT_FOUND: "invalid",
  E_INVITE_REVOKED: "revoked",
  E_INVITE_EXHAUSTED: "used",
};

/** Invite code embedded in a join link path (/join/<code>). */
export function parseJoinCode(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/join/")) return "";
  try {
    return decodeURIComponent(pathname.slice("/join/".length));
  } catch {
    return "";
  }
}

/**
 * Invite code riding the query string of a landing URL (PORCH-023): the
 * network being joined is implied by the visited origin (Brian, Oct 14,
 * 2026), so an invited member can land on /join?invite=… or /?invite=…
 * without ever being asked, and the front door skips entry entirely.
 */
export function readJoinQuery(search) {
  if (typeof search !== "string" || search.length === 0) return "";
  const params = new URLSearchParams(search);
  return params.get("invite") ?? params.get("code") ?? "";
}

/** Device grant embedded in an owner-sent device link path (/device-link/<grant>). */
export function parseDeviceGrant(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/device-link/")) return "";
  try {
    return decodeURIComponent(pathname.slice("/device-link/".length));
  } catch {
    return "";
  }
}

/**
 * A pasted join link carries the hub URL AND the embedded code; splitting it
 * fills both fields of the front door. The code may ride the path
 * (/join/<code>) or the query string (/join?invite=<code>, PORCH-023).
 * Returns { url, code } or null.
 */
export function splitJoinLink(input) {
  if (typeof input !== "string") return null;
  try {
    const parsed = new URL(input.trim());
    if (!parsed.protocol.startsWith("http")) return null;
    const isJoinPath = parsed.pathname === "/" || parsed.pathname === "/join" || parsed.pathname.startsWith("/join/");
    if (!isJoinPath) return null;
    const code = parseJoinCode(parsed.pathname) || readJoinQuery(parsed.search);
    if (!code) return null;
    return { url: parsed.origin, code };
  } catch {
    return null;
  }
}

/**
 * The hub mismatch (PORCH-023): an invite that names a hub other than the
 * origin serving the page. The named address comes from verify's joinUrl
 * (absolute only when the invite recorded its hub URL); a relative joinUrl
 * or any unusable input names nothing, so this reports no mismatch.
 */
export function joinLinkMismatch(joinUrl, visitedOrigin) {
  if (typeof joinUrl !== "string" || joinUrl.length === 0 || typeof visitedOrigin !== "string" || visitedOrigin.length === 0) return null;
  try {
    const named = new URL(joinUrl, visitedOrigin);
    if (named.origin === visitedOrigin) return null;
    return { named: named.origin, visited: visitedOrigin, joinUrl: named.href };
  } catch {
    return null;
  }
}

/** Hub origin from a server URL field; throws on any malformed address. */
export function hubOrigin(url) {
  const parsed = new URL(String(url ?? "").trim());
  if (!/^https?:$/.test(parsed.protocol) || !parsed.host) {
    throw new TypeError("bad hub address");
  }
  return parsed.origin;
}

/**
 * Failure state from a failed verification. The verify route itself answers
 * valid:false with a code; any other non-JSON or 404 answer means the
 * address is not the family hub.
 */
export function verifyFailure(cause) {
  if (cause?.body && typeof cause.body === "object" && ("valid" in cause.body || "code" in cause.body)) {
    return stateByInviteCode[cause.body.code] ?? "invalid";
  }
  if (cause?.status === 404) return "wrongUrl";
  if (cause instanceof TypeError || cause?.name === "TypeError") return "unreachable";
  return stateByInviteCode[cause?.code] ?? "wrongUrl";
}