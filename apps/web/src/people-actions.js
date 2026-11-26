// PORCH-141: the People & Things surfaces' wire half — one `request(connection,
// "recognition/…")` per action, riding the open connection's membership
// session token exactly the way the family's other hub writes do (the
// established request shape). Body and query shapes are the recognition
// plane's contract verbatim: `?homeId=` everywhere, { enabled } for the
// switch of record, { homeId, kind, name, frames, plateText, enrolledFor,
// accountabilityNote } for enrollment, { name?, plateText? } for a rename.
// Every mutation is owner-only hub-side, so a non-owner's 403 is the error
// the screen renders. All screen-testable logic lives in people-model.js.

import { request } from "./api.js";

const enc = encodeURIComponent;

function requireConnection(active) {
  if (!active?.url || !active.token || !active.identity?.id) {
    throw new Error("Connect this device to your family's hub to manage People & Things.");
  }
  return active;
}

const queryString = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value != null) search.set(key, String(value));
  }
  const suffix = search.toString();
  return suffix ? `?${suffix}` : "";
};

const KINDS = ["face", "vehicle"];

/** The contract's kind of record: "face" | "vehicle" — junk never reaches
 * the wire. */
function kindOf(kind) {
  return KINDS.includes(kind) ? kind : undefined;
}

export function createPeopleActions({ active } = {}) {
  const connection = () => requireConnection(active);

  return {
    // The recognition switch of record: the opt-in read and the owner's
    // toggle. enabled=false is the opt-in default; toggling ON resumes
    // without re-enrollment (the hub never clears entries).
    loadRecognitionSettings: (homeId) => request(connection(), `recognition/settings${queryString({ homeId })}`),

    saveRecognitionSettings: (homeId, enabled) => request(
      connection(),
      `recognition/settings${queryString({ homeId })}`,
      { method: "PUT", body: JSON.stringify({ enabled: enabled === true }) },
    ),

    // The registry: the list answers while recognition is OFF too (registry
    // rendering is reading, not recognition). One list for both kinds; the
    // screen sections filter by kind. The kind filter rides ?kind= when the
    // caller names one.
    loadEntries: (homeId, kind) => request(connection(), `recognition/entries${queryString({ homeId, kind: kindOf(kind) })}`),

    loadEntry: (entryId, homeId) => request(connection(), `recognition/entries/${enc(entryId)}${queryString({ homeId })}`),

    // Enrollment: faces ride uploaded JPEG frames (base64 in JSON); vehicles
    // may ride a plate read instead. Visit enrollment REQUIRES the enrolling
    // member's accountability note — the plane refuses 422 without it, and
    // the screen refuses first with the same plain language.
    enrollEntry: ({ homeId, kind, name, frames, plateText, enrolledFor, accountabilityNote } = {}) => request(
      connection(),
      "recognition/entries",
      {
        method: "POST",
        body: JSON.stringify({
          homeId,
          kind: kindOf(kind),
          name: String(name ?? "").trim(),
          ...(Array.isArray(frames) && frames.length > 0 ? { frames } : {}),
          ...(plateText != null && String(plateText).trim() !== "" ? { plateText: String(plateText).trim() } : {}),
          ...(enrolledFor === "visit" || enrolledFor === "household" ? { enrolledFor } : {}),
          ...(accountabilityNote != null && String(accountabilityNote).trim() !== ""
            ? { accountabilityNote: String(accountabilityNote).trim() }
            : {}),
        }),
      },
    ),

    // Rename (retitle) an entry — annotations reference entryIds, so history
    // renames without a rewrite.
    renameEntry: (entryId, homeId, patch = {}) => request(
      connection(),
      `recognition/entries/${enc(entryId)}${queryString({ homeId })}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          ...(patch.name != null ? { name: String(patch.name).trim() } : {}),
          ...(patch.plateText != null ? { plateText: String(patch.plateText).trim() } : {}),
        }),
      },
    ),

    // THE DELETION PURGE: descriptors, plate reads, sighting history, and the
    // identity annotations go with the entry (the purged counts return for
    // the receipt). Confirm-then-refetch is the screen's discipline.
    deleteEntry: (entryId, homeId) => request(connection(), `recognition/entries/${enc(entryId)}${queryString({ homeId })}`, { method: "DELETE" }),

    // The household's own export (the biometric privacy law: the household
    // owns its data, and the registry leaves the hub only through this
    // explicit owner read).
    exportRegistry: (homeId) => request(connection(), `recognition/export${queryString({ homeId })}`),

    // By-reference annotations for the event and overwatch decorations.
    loadAnnotations: (homeId) => request(connection(), `recognition/annotations${queryString({ homeId })}`),

    // The zero-computation audit counters (ac-4).
    loadMetrics: (homeId) => request(connection(), `recognition/metrics${queryString({ homeId })}`),
  };
}
