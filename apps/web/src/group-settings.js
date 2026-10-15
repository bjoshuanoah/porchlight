/**
 * Group settings menu helpers (PORCH-089). The pure half of the group
 * surface's settings menu contract: the entry rows each role may exercise,
 * the corrected notifications pairing (PORCH-087's rule), the ruled accent
 * palette for the color view, and the settings-row merge the per-group
 * toggle writes through. Deterministic and unit-testable without a DOM —
 * the same discipline as groups.js; the component only renders what these
 * helpers decide.
 *
 * Enforcement is server-side (PORCH-088): the menu never enforces. The
 * authority flags ride the group detail read (isManagingMember /
 * isNetworkOwner); where a menu renders from an index row without those
 * flags, the client-side canManageGroup predicate stands in — every write
 * re-checks authority at the hub, so a stale client predicate can only
 * render an entry whose write the hub refuses in plain language.
 */

import { canManageGroup } from "./groups.js";

/** The ruled accent palette (PORCH-088's GROUP_COLOR_PALETTE), with the
 * family names the color view's swatch rows render. Values mirror the
 * server's palette token set exactly — the server remains the validator
 * (an off-palette write refuses), and the "No color" swatch writes the
 * null reset. Presentation data only: never a ranking or delivery input. */
export const GROUP_COLOR_ROWS = Object.freeze([
  { value: "#D88A24", name: "Amber" },
  { value: "#C4674B", name: "Terracotta" },
  { value: "#C9A227", name: "Gold" },
  { value: "#7E8F6E", name: "Sage" },
  { value: "#4E8F86", name: "Teal" },
  { value: "#5B7FA6", name: "Blue" },
  { value: "#8E6E95", name: "Plum" },
  { value: "#B0578D", name: "Rose" },
]);

/** The color view's reset row: null restores the neutral default. */
export const GROUP_NO_COLOR = null;

/** Which entries the menu renders for this viewer: the owner set rides the
 * detail read's authority flags (isManagingMember / isNetworkOwner), the
 * notifications row and the members view render for every member. Row keys:
 * photo | color | members | privacy | notifications. */
export function groupMenuRows(group = null, data = {}) {
  const rows = [];
  const manager = group
    && (group.isManagingMember === true
      || group.isNetworkOwner === true
      || (!("isManagingMember" in group) && canManageGroup(group, data)));
  if (manager) rows.push("photo", "color", "members", "privacy");
  else if (group) rows.push("members");
  if (group) rows.push("notifications");
  return rows;
}

// canManageGroup rides the groups.js predicate; every write re-checks
// authority at the hub, so a stale client predicate can only render an
// entry whose write the hub refuses in plain language.

/** The member's per-group notifications row (ac-4), PORCH-087's corrected
 * pairing verbatim: ON = receiving, OFF = paused — never the inverted
 * network-settings pairing. The resolved state rides the group detail
 * read's notifications member; unset resolves ON (no stored preference
 * renders ON, no backfill write exists). */
export function resolvedGroupNotification(group = null) {
  return group?.notifications?.perGroup !== false;
}

export function groupToggleLine(on) {
  return on
    ? "On: you'll get notifications for this group's posts."
    : "Off: this group's notifications are paused.";
}

/** The toggle's write merge: the per-group entry rides the member's
 * persisted settings row under the full-row-replace rules — the map carries
 * every persisted entry plus this group's new value; a write that dropped
 * the persisted map could never exist (an older-client settings write rides
 * the server's null-groups persistence instead). */
export function withGroupPreference(settings, groupId, on) {
  return {
    ...settings,
    groups: { ...(settings?.groups ?? {}), [groupId]: on === true },
  };
}

/** The privacy row's two labeled states, each with its consequence line —
 * the labels and lines verbatim from the ruling (Brian, Oct 15 2026). */
export const GROUP_PRIVACY_ROWS = Object.freeze([
  {
    value: "public",
    label: "Public",
    line: "Public: any member can find it and join.",
  },
  {
    value: "private",
    label: "Private",
    line: "Private: invite-only.",
  },
]);

/** The confirmation copy for a member's removal — the named consequence and
 * the rejoin line verbatim from the ruling. */
export function groupMemberRemoveCopy(name, group = null) {
  return `This removes ${name ?? "this member"} from ${group?.name ?? "this group"}. Their posts stay in place, and they cannot rejoin unless re-invited.`;
}