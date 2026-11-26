/**
 * Mobile composer bottom sheet — state laws (PORCH-144).
 *
 * Pure half of the unified compose surface's mobile sheet: the collapse
 * law, the publish-eligibility law, the destination targeting law, the
 * staged-share mapping, and the create-payload shape — all decision logic
 * in one testable module so the JSX component renders from decisions,
 * never from inline branching. Spec of record: the Porchlight UI unified
 * composer pair (PRD 6b073a54549901c58e055d06 / TS 6b073a54549901c58e055d05).
 * Build contract lives in the directive's "Composer: build contract"
 * section; the mixed create contract rides PORCH-143's shipped server path
 * (POST /api/social/posts with the ordered mediaRefs list — no per-kind
 * fork, the document stores an ordered id list, type=mixed is a read
 * projection).
 */

/**
 * The three sheet states, derived — never stored.
 *   - `empty`    large tiles + resting footer (field unfocused, keyboard
 *                closed, draft empty)
 *   - `typing`   compact footer (focused or keyboard or draft text)
 *   - `attached` compact footer over staged media (draft holds media)
 * The collapse law of record (Section 18 "Mobile states and the collapse
 * law"): compact controls hold while the field is focused OR the keyboard
 * is open OR the draft holds text or media; large tiles return EXACTLY on
 * the three-part reset (unfocused AND keyboard-closed AND draft-empty).
 * The composer never re-renders a large tile over a draft, so any draft
 * text — even whitespace alone — holds the compact controls away from the
 * reset: only the eligibility law decides whether Post enables.
 */
export function sheetMode({ focused = false, keyboardOpen = false, text = "", attachments = [] } = {}) {
  const media = Array.isArray(attachments) ? attachments : [];
  if (media.length) return "attached";
  const holdsText = typeof text === "string" && text.length > 0;
  if (focused || keyboardOpen || holdsText) return "typing";
  return "empty";
}

/** The large same-height media row renders only in the `empty` state. */
export function tilesVisible(mode) {
  return mode === "empty";
}

/**
 * Publish eligibility law (Section 18 "Eligibility"): Post is disabled
 * while the draft holds neither nonblank text nor an attachment;
 * whitespace alone keeps it disabled. Media always enables.
 */
export function postEligible({ text = "", attachments = [] } = {}) {
  const nonblank = typeof text === "string" && text.trim().length > 0;
  const media = Array.isArray(attachments) ? attachments.length : 0;
  return nonblank || media > 0;
}

/**
 * The staged attachment: kind is per reference from the file's mime —
 * media type is a property of each staged media reference (PORCH-143
 * contract), never a fork of the draft.
 */
export function attachmentKind(file) {
  const mime = String(file?.type ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "photo";
  if (mime.startsWith("video/")) return "video";
  return null;
}

/**
 * Staged-share mapping (PORCH-105, unified surface): the one staged
 * payload opens the ONE sheet draft. Shared text rides the draft's text
 * either way (a photo share's caption text is the staged post text), the
 * photos/videos stage as attachments regardless of the staged type, and
 * audio stages nothing — audio capture is out of the unified compose
 * surfaces this round (the 11/25 amendment: no recording affordance, no
 * audio staging), so an audio share keeps the text and names what was
 * left out (never a silent drop). Unsupported kinds already ride
 * `staged.dropped` → the caller renders `staged.notice`.
 */
export function stagedShareDraft(staged = {}) {
  const text = String(staged.caption ?? "") || String(staged.body ?? "");
  const files = Array.isArray(staged.files) ? staged.files : [];
  const attachments = [];
  for (const file of files) {
    const kind = attachmentKind(file);
    if (kind) attachments.push({ file, kind });
  }
  let notice = typeof staged.notice === "string" ? staged.notice : null;
  if (staged.type === "audio" && !notice) {
    const names = files.map((file) => file?.name).filter(Boolean).join(", ");
    notice = `Porchlight can add photos and videos from here. The audio file cannot be added${names ? `: ${names}` : ""}. You can still write your post here.`;
  }
  return { text, attachments, notice };
}

/**
 * Destination rows (Oct 16 targeting law): the general timeline plus the
 * groups the author belongs to — never another network, never a group the
 * author does not hold. `composableGroups`/`groupRows` carry the existing
 * gate; this shapes them into picker rows.
 */
export function destinationRows(composable = []) {
  const rows = [{ value: "", label: "Main timeline" }];
  for (const group of composable ?? []) {
    const id = String(group?._id ?? group?.id ?? "");
    if (!id) continue;
    rows.push({ value: id, label: String(group?.name ?? id) });
  }
  return rows;
}

/** The footer control's label: "Main timeline" or the group's render. */
export function destinationLabel(composable = [], pickedId = "") {
  if (!pickedId) return "Main timeline";
  const match = (composable ?? []).find((group) => String(group?._id ?? group?.id ?? "") === String(pickedId));
  return match ? String(match?.name ?? pickedId) : "Main timeline";
}

/**
 * Unavailable-destination resolution: the staged destination is checked
 * against the author's live reach at publish time — a group the author
 * no longer belongs to (member removal or the group's network changed)
 * is stale, the general timeline never is. A stale destination never
 * silently retargets: the publish refuses, the sheet names the change,
 * and the next send requires an explicit new selection.
 */
export function destinationUnavailable(pickedId, composable = [], networkId = null) {
  if (!pickedId) return false;
  const sameNetwork = (composable ?? []).filter((group) =>
    !networkId || !group?.networkId || String(group.networkId) === String(networkId));
  return !sameNetwork.some((group) => String(group?._id ?? group?.id ?? "") === String(pickedId));
}

/** Plain-language copy for the stale-destination state (named, never silent). */
export function destinationUnavailableCopy(label) {
  return `${label || "This group"} is no longer a destination you can post to. Your draft stays here — pick a destination below, then post.`;
}

/**
 * The create payload (PORCH-143's ordered mediaRefs contract). Text and
 * media publish as ONE post, never two writes: with media, the draft's
 * text rides the caption and the stored type is the first attachment's
 * kind (type=mixed is the server's read projection; the document keeps
 * the ordered id list). Without media, the text rides the body as a
 * text post. mediaRefs arrive in staged attachment order (position =
 * array order); an empty list with text is the text shape.
 */
export function publishPayload({ text = "", attachments = [], mediaRefs = [], groupId = "", previewId = null } = {}) {
  const bodyText = typeof text === "string" ? text.trim() : "";
  const media = Array.isArray(mediaRefs) ? mediaRefs.filter((ref) => typeof ref === "string" && ref) : [];
  const hasMedia = media.length > 0;
  const kindOf = (index) => attachments?.[index]?.kind ?? "photo";
  return hasMedia
    ? {
        type: kindOf(0),
        body: null,
        caption: bodyText ? bodyText : null,
        mediaRefs: media,
        groupId: groupId || null,
        previewId: null,
      }
    : {
        type: "text",
        body: bodyText,
        caption: null,
        mediaRefs: [],
        groupId: groupId || null,
        previewId: previewId ?? null,
      };
}

/** 2200ms → "0:02"; the sheet's video thumbs render duration bottom-right. */
export function formatDuration(milliseconds) {
  const total = Math.max(0, Math.round((Number(milliseconds) || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The compose field's available height floor (Brian, 11/26/2026: at least
 * 5 lines of available text-area height on desktop, 3 on mobile). The
 * field's line-height is the 24px class; the floor is lines × line-height
 * so the member always sees the ruled block of writing room, empty draft
 * or full.
 */
export const FIELD_LINE_HEIGHT = 24;

export function fieldMinHeight(presentation = "mobile") {
  const lines = presentation === "desktop" ? 5 : 3;
  return lines * FIELD_LINE_HEIGHT;
}

/**
 * Keyboard geometry for the flush-to-bottom sheet (Section 18 footer law:
 * flush above the safe area when the keyboard is closed, above the
 * keyboard when risen). Pure so the visual-viewport assertion is unit
 * testable — the component applies the returned offset as the sheet
 * root's `bottom` pixel. `offsetTop` is the visual viewport's page
 * offset; the sheet never floats above the layout viewport bottom.
 */
// PORCH-144: the keyboard lifts the sheet's bottom edge by the layout
// viewport line the risen keyboard occupies — layout height minus the top
// of the visible window, clipped into [0, layout height] defensively.
//
// Returns {number} pixels to lift the sheet's bottom edge; 0 when the keyboard is not risen.
export function sheetKeyboardBottom({ windowHeight, viewportHeight, offsetTop } = {}) {
  const window_ = Number(windowHeight) || 0;
  const view = Number(viewportHeight) || 0;
  const offset = Number(offsetTop) || 0;
  if (!(window_ > 0) || !(view > 0)) return 0;
  const hidden = window_ - (offset + view);
  return Math.round(Math.max(0, Math.min(hidden, window_)));
}

/**
 * A visual- viewport shrink that counts as a risen keyboard — the same
 * threshold the emoji keyboard contract (PORCH-120) pins: browser chrome
 * resizes are far smaller than any software keyboard.
 */
export const KEYBOARD_MIN = 120;
export const MOBILE_CLASS_MAX = 899.95;

export function keyboardRaised({ windowHeight, viewportHeight } = {}) {
  const window_ = Number(windowHeight) || 0;
  const view = Number(viewportHeight) || 0;
  if (!(window_ > 0) || !(view > 0)) return false;
  return window_ - view >= KEYBOARD_MIN;
}
