// PORCH-056: the owner console reads every capacity figure in human units.
// The hub keeps speaking bytes and MB on the wire (no API change); this
// module is the display face only. Units scale GB ↔ TB at the conventional
// threshold and carry at most one decimal place, with the boundary rounding
// chosen so a figure never lands exactly on 1024.0 GB next to 1.0 TB.

const ONE_GB = 1024 ** 3;
const ONE_TB = 1024 ** 4;

function oneDecimal(value) {
  return Math.round(value * 10) / 10;
}

/** Raw byte figure → "1.5 GB" / "2 TB". Returns null for anything the hub
 * did not supply as a finite non-negative number; callers render fallbacks. */
export function formatStorage(bytes) {
  if (typeof bytes !== 'number') return null;
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  const gb = oneDecimal(bytes / ONE_GB);
  // The unit flips when the *rounded* GB figure reaches 1024, so a value a
  // hair under 1 TB never renders as "1024.0 GB"; it renders as "1 TB".
  if (gb >= 1024) return `${oneDecimal(bytes / ONE_TB)} TB`;
  return `${gb} GB`;
}

/** A capacity figure the hub carries in MB (the storage ceiling's wire unit)
 * → the same human string. Returns null when unset or malformed. */
export function formatStorageMb(mb) {
  const numeric = Number(mb);
  if (mb == null || mb === '' || !Number.isFinite(numeric) || numeric < 0) return null;
  return formatStorage(numeric * 1024 ** 2);
}

/** MB wire value → the editable console input in GB (round-trip stable:
 * formatStorageMb and this share the one-decimal rounding). */
export function ceilingMbToGb(mb) {
  if (mb == null || mb === '') return '';
  const numeric = Number(mb);
  if (!Number.isFinite(numeric) || numeric < 0) return '';
  return String(Math.round((numeric / 1024) * 10) / 10);
}

/** GB input from the console form → the MB wire value the API expects. */
export function ceilingGbToMb(gb) {
  if (gb == null || gb === '') return null;
  const numeric = Number(gb);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric * 1024);
}