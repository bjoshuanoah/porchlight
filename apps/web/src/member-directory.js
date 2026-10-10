/**
 * Member directory view helpers (PORCH-029). Pure mapping between the hub's
 * console payloads (membership rows + join-link rows) and the directory's
 * render rows, so the members view stays deterministic and unit-testable
 * without a DOM.
 */

/** Whether the viewer is the network's owner (PORCH-029 gating; reused for the
 * owner-console navigation entry, PORCH-040 user-testing follow-up). The
 * console members response is owner-only at the hub, so the viewer seeing
 * themselves listed there as owner IS the owner — the SPA holds no other
 * owner signal, and a non-owner's failed console read falls back to empty. */
export function viewerIsOwner(data) {
  return (data?.members || []).some(
    (entry) => entry?.did === data?.identity?.id && entry?.role === "owner",
  );
}

/** Directory rows: owner first, then everyone by admission, ids breaking ties. */
export function directoryRows(members = [], identityDid = null) {
  return [...(members || [])]
    .filter((member) => member && (member._id || member.id || member.did))
    .map((member) => ({
      id: idOf(member),
      name: member?.name || member?.displayName || "Member",
      role: member?.role === "owner" ? "Owner" : "Member",
      // Join status straight from the membership row: active or removed.
      status: member?.state === "active" ? "Active" : "Removed",
      joined: member?.admittedAt || null,
      isSelf: Boolean(identityDid) && member?.did === identityDid,
    }))
    .sort((a, b) => rankByRole(a, b) || timeOrId(a, b));
}

/** Join-link lifecycle rows with the shareable URL resolved against the hub. */
export function inviteRows(invites = [], serverUrl = null) {
  return (invites || [])
    .filter((item) => item && (item._id || item.id || item.token))
    .map((item) => ({
      id: idOf(item),
      url: joinLink(item, serverUrl),
      status: lifecycleStatus(item),
    }));
}

/** Exactly who a new join link is for: a new member, never the owner. */
export function inviteDialogCopy(network = null) {
  const named = network || "the network";
  return `One link, one new member of ${named}. You send it to the family member joining — it is never for you: you became a member when you created the network. Anyone holding the link becomes a member; you can withdraw it at any time.`;
}

/** Copy the resolved link to the OS clipboard (plain-HTTP hub fallback). */
export async function copyLink(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const field = document.createElement("textarea");
      field.value = text;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      const ok = document.execCommand("copy");
      field.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function idOf(item) {
  return item?._id || item?.id || item?.token || "";
}

function joinLink(item, serverUrl) {
  if (item?.joinUrl) {
    try {
      return new URL(item.joinUrl, serverUrl || window.location.origin).href;
    } catch {
      return item.joinUrl;
    }
  }
  // Console list rows carry the token (and the hub they were minted for):
  // rebuild the shareable link the owner can copy without re-issuing.
  if (item?.token) {
    const base = item.hubUrl || serverUrl;
    try {
      return base ? `${String(base).replace(/\/+$/, "")}/join/${item.token}` : `/join/${item.token}`;
    } catch {
      return `/join/${item.token}`;
    }
  }
  return "";
}

function lifecycleStatus(item) {
  // Console list rows carry the derived lifecycle status; a raw issue row
  // only knows revocation — unminted uses read as unused.
  if (item?.status) return item.status;
  return item?.revokedAt ? "revoked" : "unused";
}

function rankByRole(a, b) {
  const rank = (row) => Number(row.role !== "Owner");
  return rank(a) - rank(b);
}

function timeOrId(a, b) {
  const aTime = a.joined ? new Date(a.joined).getTime() : Number.POSITIVE_INFINITY;
  const bTime = b.joined ? new Date(b.joined).getTime() : Number.POSITIVE_INFINITY;
  if (aTime !== bTime) return aTime - bTime;
  return (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}