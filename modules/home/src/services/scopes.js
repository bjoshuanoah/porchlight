/**
 * Pure grant-scope resolution (PORCH-138 TS 1). One code path answers every
 * scope question the home domain enforces: what a grantee may see (view),
 * what they may touch (control), and what an envelope covers. Nothing here
 * reads or writes state — the services call these helpers with documents
 * already loaded, and apps/web never needs a copy (the hub filters every
 * served read server-side).
 */
export const GRANT_SCOPE_RESOURCE_TYPES = ["device", "scene", "area"];
export const GRANT_SCOPE_VERBS = ["view", "control"];

/** The three V1 access classes of record (family governance ruling). */
export const ACCESS_CLASSES = {
  OWNERSHIP: "owner-membership",
  INDIVIDUAL_GRANT: "individual-grant",
  FAMILY_GRANT: "family-grant",
};

/**
 * Does one of the grant's scopes cover this exact resource + verb?
 * An area scope with the same verb covers its area itself (view on the
 * grouping surface; control across the area's devices) — see coversDevice.
 */
export function coversResource(scopes, resourceType, resourceRef, verb) {
  return (scopes ?? []).some(
    (scope) => scope?.resourceType === resourceType && scope?.resourceRef === resourceRef
      && (scope?.verbs ?? []).includes(verb),
  );
}

/**
 * Device enforcement: a device is covered when a device scope names it, or
 * when an area scope covers the device's area (granting a porch grants what
 * sits on the porch).
 */
export function coversDevice(scopes, device, verb) {
  return coversResource(scopes, "device", device?._id ?? null, verb)
    || coversResource(scopes, "area", device?.areaId ?? null, verb);
}

/**
 * The area ids a grantee may see: area scopes with view, plus the areas of
 * any device their scopes show (the grouping surface must not strand a
 * granted device under an invisible area).
 */
export function visibleAreaIds(scopes, devices) {
  const ids = new Set();
  for (const scope of scopes ?? []) {
    if (scope?.resourceType === "area" && (scope?.verbs ?? []).includes("view")) {
      ids.add(scope.resourceRef);
    }
  }
  for (const device of devices ?? []) {
    if (coversDevice(scopes, device, "view") && device?.areaId) ids.add(device.areaId);
  }
  return ids;
}

/**
 * Is distribution ⊆ envelope for every scope, verb by verb? The write path
 * fails closed on false; read paths treat it as an invariant (validated at
 * write, so a stored distribution is always within its envelope).
 */
export function withinEnvelope(envelope, distribution) {
  return (distribution ?? []).every((scope) =>
    (envelope ?? []).some((grantScope) =>
      grantScope?.resourceType === scope?.resourceType
      && grantScope?.resourceRef === scope?.resourceRef
      && (scope?.verbs ?? []).every((verb) => (grantScope?.verbs ?? []).includes(verb))),
  );
}

/** The distribution of record for one family member, or null. */
export function distributionFor(grant, memberDid) {
  return (grant?.parentDistributions ?? []).find((row) => row?.memberIdentityRef === memberDid)
    ?? null;
}

export const ACCESS_OWNER_ONLY = "This surface belongs to the home's members — a visit grant carries only the controls it was granted.";
