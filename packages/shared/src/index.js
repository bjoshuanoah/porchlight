/**
 * Shared, domain-agnostic surface. By definition this package contains no
 * domain models — it carries types/helpers used across the module boundary.
 * It does NOT contain identity or social models.
 */

export const DOMAIN = "porchlight";

export function isPresent(value) {
  return value !== undefined && value !== null && value !== "";
}

export default { DOMAIN, isPresent };
