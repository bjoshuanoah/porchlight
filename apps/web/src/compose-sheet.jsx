/**
 * Mobile composer bottom sheet (PORCH-144) — the compose surface of record
 * below 900px.
 *
 * Three states, derived from one multiline field and the staged media
 * (spec of record: the Porchlight UI unified composer pair PRD
 * 6b073a54549901c58e055d06 / TS 6b073a54549901c58e055d05, "Mobile sheet
 * anatomy" + "Mobile states and the collapse law" + "Publish path"):
 *
 *   Empty    drag handle, "New post" header + circular close, the
 *            same-height media row (Photo two-thirds with the amber
 *            outline, Video one-third subdued), borderless multiline
 *            field, thin divider, destination control left and muted
 *            disabled Post right.
 *   Typing   the tiles collapse the moment the field takes focus; the
 *            compact footer takes over with Add photo / Add video left of
 *            the destination control; the footer rides above the risen
 *            keyboard (visual-viewport anchoring, the emoji-picker
 *            pattern).
 *   Attached staged media renders above the field — one attachment fills
 *            the preview width; two or more ride the horizontal swipe
 *            carousel (PORCH-045 mechanics: release snapping, a peek at
 *            the next slide, a quantity position indicator) with per-item
 *            remove at the attachment's upper-right. Video thumbs carry
 *            play and duration.
 *
 * The collapse law, the eligibility law, the destination targeting law,
 * and the create payload shape all live in ./compose-sheet.js (pure,
 * unit-tested); this component renders from those decisions. The mixed
 * create rides PORCH-143's shipped POST /api/social/posts contract (one
 * write, ordered mediaRefs, the draft's text rides the caption under
 * media) — no new server surface.
 *
 * The desktop composer (≥900px) is the same unified composer in the
 * existing centered modal presentation (Brian, 11/26/2026: the unified
 * composer is not mobile-only — only the bottom-sheet presentation is):
 * same empty-state media row, one multiline field, collapse law, carousel
 * staging, eligibility law, publish lock, and destination control; no
 * drag handle, nothing flush to the bottom edge, no safe-area
 * choreography, no keyboard state machine.
 */
import React, { useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Chip, Dialog, IconButton, InputBase, Menu, MenuItem, Stack, Typography } from "@mui/material";
import CloseOutlinedIcon from "@mui/icons-material/CloseOutlined";
import HomeOutlinedIcon from "@mui/icons-material/HomeOutlined";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import PhotoOutlinedIcon from "@mui/icons-material/PhotoOutlined";
import PlayArrowOutlinedIcon from "@mui/icons-material/PlayArrowOutlined";
import VideocamOutlinedIcon from "@mui/icons-material/VideocamOutlined";
import { photoFirst, carouselIndex } from "./photo-first.js";
import { cssVars } from "./theme.js";
import { composableGroups, composePresetLocationId, groupRows } from "./groups.js";
import { firstUrlIn } from "./link-preview.js";
import { identityOf } from "./feed-filter.js";
import { invoke, useOperation } from "./social.jsx";
import {
  FIELD_LINE_HEIGHT,
  attachmentKind,
  destinationLabel,
  destinationRows,
  destinationUnavailable,
  destinationUnavailableCopy,
  fieldMinHeight,
  formatDuration,
  keyboardRaised,
  postEligible,
  publishPayload,
  sheetKeyboardBottom,
  sheetMode,
  stagedShareDraft,
  tilesVisible,
} from "./compose-sheet.js";

// One horizontal padding class across header, media, field, and footer
// (the 16px token class of the mobile sheet anatomy).
const SHEET_PAD = `${photoFirst.rail}px`;
// Rounded top corners (24px token) — the flush-to-bottom sheet surface.
const SHEET_RADIUS = "24px 24px 0 0";
// The peek: a carousel slide is narrower than the sheet so the next slide
// shows at the leading edge (the "2/5" carousel contract).
const SLIDE_BASIS = "82%";
const SLIDE_GAP = 8;
// The Empty state's same-height media row (the 2:1 row, excluding the gap).
const TILE_ROW_HEIGHT = 108;

/** The sheet's visual-viewport while open (the footer rides the keyboard). */
function useKeyboardSheet(open) {
  const [keyboard, setKeyboard] = useState({ raised: false, bottom: 0 });
  useEffect(() => {
    if (!open) { setKeyboard({ raised: false, bottom: 0 }); return undefined; }
    const view = window.visualViewport;
    if (!view) return undefined;
    const measure = () => {
      const raised = keyboardRaised({ windowHeight: window.innerHeight, viewportHeight: view.height });
      setKeyboard({
        raised,
        bottom: raised ? sheetKeyboardBottom({ windowHeight: window.innerHeight, viewportHeight: view.height, offsetTop: view.offsetTop }) : 0,
      });
    };
    view.addEventListener("resize", measure);
    view.addEventListener("scroll", measure);
    measure();
    return () => { view.removeEventListener("resize", measure); view.removeEventListener("scroll", measure); };
  }, [open]);
  return keyboard;
}

function makeAttachment(file, kind) {
  const row = { file, kind };
  try { if (typeof URL?.createObjectURL === "function") row.url = URL.createObjectURL(file); } catch { /* no blob url — the preview degrades to the wash */ }
  return row;
}

/** One staged attachment's preview. Videos carry play + duration bottom-right. */
function ComposePreview({ attachment, onDuration, removeLabel, onRemove }) {
  const { file, kind, url, durationMs } = attachment;
  return <Box sx={{ position: "relative", borderRadius: "16px", overflow: "hidden", bgcolor: "porchlight.subtle", width: "100%" }}>
    {/* Box component="video": a raw video element is no MUI system component, so its sx prop drops — which rendered the preview at its full intrinsic size and pushed the header, Close, and per-item remove out of reach (the staged-video report of 11/26/2026). */}
    {kind === "video"
      ? <Box component="video" src={url} muted playsInline preload="metadata" data-testid="attachment-video"
          onLoadedMetadata={(event) => {
            const ms = Math.round((event.currentTarget.duration || 0) * 1000);
            if (ms > 0) onDuration?.(attachment, ms);
          }}
          sx={{ display: "block", width: "100%", maxHeight: 264, objectFit: "contain", bgcolor: "porchlight.subtle" }} />
      : <Box component="img" src={url} alt={file?.name ?? "Attached photo"}
          sx={{ display: "block", width: "100%", maxHeight: 264, objectFit: "contain", bgcolor: "porchlight.subtle" }} />}
    {kind === "video" && <>
      <PlayArrowOutlinedIcon sx={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", fontSize: 40, color: "var(--porch-media-overlay-ink)", pointerEvents: "none" }} />
      {durationMs != null && <Typography component="span" sx={{ position: "absolute", right: 8, bottom: 6, px: 1, borderRadius: 2, fontSize: 12, lineHeight: "17px", color: "var(--porch-media-overlay-ink)", bgcolor: "var(--porch-media-overlay)" }}>{formatDuration(durationMs)}</Typography>}
    </>}
    {removeLabel != null && <IconButton
      aria-label={removeLabel}
      data-testid="attachment-remove"
      onClick={() => onRemove?.(attachment)}
      sx={{ position: "absolute", top: 6, right: 6, bgcolor: "var(--porch-media-overlay)", color: "var(--porch-media-overlay-ink)", "&:hover": { bgcolor: "var(--porch-media-overlay-hover)" }, "& .MuiSvgIcon-root": { fontSize: 20 } }} />}
  </Box>;
}

/** The mobile bottom sheet: the flush-to-bottom unified composer below 900px. */
export function ComposeSheet({ open, onClose, data = {}, actions = {}, target = null, staged = null }) {
  const keyboard = useKeyboardSheet(open);
  return <Composer open={open} onClose={onClose} data={data} actions={actions} target={target} staged={staged} presentation="mobile" keyboard={keyboard} />;
}

/**
 * The desktop composer (≥900px): the SAME unified composer in the existing
 * centered modal presentation (Section 18 "Desktop modal: build contract",
 * Brian's unified-treatment ruling + the 11/26/2026 direction) — never a
 * bottom sheet: no drag handle, nothing flush to the bottom edge, no
 * safe-area choreography, and no keyboard state machine (the collapse law
 * resolves on focus + draft alone: compact while focused or drafted, tiles
 * return exactly on unfocused AND draft-empty).
 */
export function Compose({ open, onClose, data = {}, actions = {}, target = null, staged = null }) {
  return <Composer open={open} onClose={onClose} data={data} actions={actions} target={target} staged={staged} presentation="desktop" />;
}

/** One composer: every state, law, and write shared; presentation differs. */
function Composer({ open, onClose, data = {}, actions = {}, target = null, staged = null, presentation = "mobile", keyboard = null }) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [groupId, setGroupId] = useState("");
  const [focused, setFocused] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewAttached, setPreviewAttached] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [staleDestination, setStaleDestination] = useState(false);
  const [anchorEl, setAnchorEl] = useState(null);
  const [destinationForce, setDestinationForce] = useState(false);
  const [trackPosition, setTrackPosition] = useState(0);
  const photoInputRef = useRef(null);
  const videoInputRef = useRef(null);
  const destinationRef = useRef(null);
  const trackRef = useRef(null);
  const lastResolvedRef = useRef(null);
  const operation = useOperation();

  // The destination option law (PORCH-068 ac-4): the author's groups in the
  // open network only — never another network, never a non-member group.
  const groups = composableGroups(groupRows(data.groups, data.network?.id), data.identity?.id);
  const label = destinationLabel(groups, groupId);
  const eligible = postEligible({ text, attachments });
  const mode = sheetMode({ focused, keyboardOpen: keyboard?.raised ?? false, text, attachments });
  const publishing = operation.busy;

  const addFiles = (kind) => (files) => {
    const incoming = Array.from(files || [])
      .map((file) => ({ file, resolved: attachmentKind(file) ?? kind }))
      .filter((row) => row.resolved)
      .map((row) => makeAttachment(row.file, row.resolved));
    if (incoming.length) setAttachments((current) => [...current, ...incoming]);
  };
  const openPicker = (ref) => ref.current?.click();
  const removeAttachment = (attachment) => {
    if (attachment.url) { try { URL.revokeObjectURL(attachment.url); } catch { /* already gone */ } }
    setAttachments((current) => current.filter((row) => row !== attachment));
  };
  const setDuration = (attachment, durationMs) => {
    setAttachments((current) => current.map((row) => (row === attachment ? { ...row, durationMs } : row)));
  };

  // PORCH-096 pre-population + PORCH-105 staged mapping on the open
  // transition — adjusted DURING render (React's render-phase state
  // adjustment), so the open never paints a stale frame and the server
  // render carries the same preselect. Never mid-open, never racing.
  const presetRef = useRef(composePresetLocationId(target, groups, data.identity?.id));
  presetRef.current = composePresetLocationId(target, groups, data.identity?.id);
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  const lastOpenRef = useRef(false);
  if (open !== lastOpenRef.current) {
    lastOpenRef.current = open;
    if (open) {
      const share = stagedRef.current;
      const draft = share
        ? stagedShareDraft(share)
        : { text: "", attachments: [] };
      setGroupId(presetRef.current);
      setText(draft.text);
      setAttachments(draft.attachments.map((row) => makeAttachment(row.file, row.kind)));
      setFocused(false);
      setStaleDestination(false);
      setPreview(null);
      setPreviewAttached(true);
      setPreviewLoading(false);
      lastResolvedRef.current = null;
      setTrackPosition(0);
      setDestinationForce(false);
    } else {
      setAnchorEl(null);
      setDestinationForce(false);
    }
  }

  // PORCH-052 link preview: the text-only publish keeps the compose-time
  // chip (bounded hub resolve, removable, never blocking submit). With
  // media staged the mixed create carries text + refs — no preview write.
  useEffect(() => {
    if (attachments.length) { setPreview(null); lastResolvedRef.current = null; return undefined; }
    const url = firstUrlIn(text);
    if (!url) { setPreview(null); setPreviewAttached(true); lastResolvedRef.current = null; setPreviewLoading(false); return undefined; }
    if (lastResolvedRef.current === url) return undefined;
    let cancelled = false;
    setPreviewAttached(true);
    setPreviewLoading(true);
    const timer = setTimeout(() => {
      lastResolvedRef.current = url;
      Promise.resolve()
        .then(() => invoke(actions, 'resolvePreview', url))
        .then((result) => { if (!cancelled) setPreview(result?.preview ?? null); })
        .catch(() => { if (!cancelled) setPreview(null); })
        .finally(() => { if (!cancelled) setPreviewLoading(false); });
    }, 700);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [text, attachments.length, actions]);

  // Publish: one operation = every upload plus the ONE create write — the
  // dup-submission lock (Post reads disabled while this runs; a second
  // submit never creates a second post). The ref guard covers two taps
  // landing inside one render frame (the disabled attribute alone cannot);
  // a failure keeps the full draft: text, attachments, destination, and
  // the compact controls stay so the member retries without restaging.
  const publishingRef = useRef(false);
  const publish = () => {
    if (!eligible || publishingRef.current) return;
    // Unavailable-destination resolution: the staged destination is
    // re-checked against the author's LIVE reach at send time. A stale
    // group never silently retargets — the send refuses, the sheet names
    // the change, and only an explicit new selection re-arms Post.
    if (destinationUnavailable(groupId, groups, data.network?.id)) {
      setStaleDestination(true);
      return;
    }
    publishingRef.current = true;
    Promise.resolve(operation.run(async () => {
      const mediaRefs = [];
      if (attachments.length) {
        const ids = await invoke(actions, 'upload', attachments.map((row) => row.file));
        const resolved = (Array.isArray(ids) ? ids
          : Array.isArray(ids?.mediaRefs) ? ids.mediaRefs
          : Array.isArray(ids?.media) ? ids.media
          : ids && (ids.mediaId || ids._id) ? [ids] : [])
          .map((entry) => typeof entry === "string" ? entry : entry?.mediaId ?? entry?._id ?? entry?.id)
          .filter(Boolean);
        if (resolved.length !== attachments.length || new Set(resolved).size !== attachments.length) {
          throw new Error("Could not attach every original. Check your uploads before trying again.");
        }
        mediaRefs.push(...resolved);
      }
      const payload = publishPayload({
        text,
        attachments,
        mediaRefs,
        groupId,
        previewId: !attachments.length && preview && previewAttached && preview.id ? preview.id : null,
      });
      const result = await invoke(actions, 'submitPost', payload);
      if (!result?.post || !identityOf(result.post)) {
        throw new Error("The family server did not confirm this post. Refresh your timeline before trying again.");
      }
      return result;
    }, () => {
      setText("");
      setAttachments([]);
      setGroupId("");
      setFocused(false);
      setStaleDestination(false);
      setPreview(null);
      setPreviewAttached(true);
      setPreviewLoading(false);
      lastResolvedRef.current = null;
      setTrackPosition(0);
      onClose?.();
    })).finally(() => { publishingRef.current = false; });
  };

  if (!open) return null;
  const rows = destinationRows(groups);
  const carousel = attachments.length > 1;
  const previewText = (preview && previewAttached) || previewLoading;

  const body = <>
    {presentation !== "desktop" && <Box sx={{ pt: 1, display: "flex", justifyContent: "center" }}>
      <Box sx={{ width: 40, height: 4, borderRadius: 2, bgcolor: "porchlight.borderStrong" }} />
    </Box>}
    {/* Header: "New post" left, circular close right (Icon 20px, 44px
        target, accessible name "Close"). */}
    <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: SHEET_PAD, pt: 0.5 }}>
      <Typography component="h2" id="compose-modal-title" sx={{ fontWeight: 650, fontSize: "1.0625rem", lineHeight: "27px", color: "text.primary" }}>New post</Typography>
      <IconButton
        aria-label="Close"
        data-testid="sheet-close"
        disabled={publishing}
        onClick={() => onClose?.()}
        sx={{ border: "1px solid", borderColor: "divider", borderRadius: "50%" }}>
        <CloseOutlinedIcon sx={{ fontSize: 20 }} />
      </IconButton>
    </Stack>

    <Stack spacing={1} sx={{ px: SHEET_PAD, pt: 1, pb: 0 }}>
      {data.offline && <Alert severity="warning">Posting is unavailable while your family server is unreachable. Your draft stays here.</Alert>}
      {staged?.notice && <Alert severity="info">{staged.notice}</Alert>}
      {staleDestination && <Alert severity="warning" data-testid="destination-unavailable">{destinationUnavailableCopy(label)}</Alert>}
      {operation.error && <Alert severity="error" data-testid="sheet-error">{operation.error}</Alert>}
    </Stack>

    <Box component="form" onSubmit={(event) => { event.preventDefault(); publish(); }}>
      {/* Empty state: the same-height media row, Photo two-thirds amber,
          Video one-third subdued. Rendered ONLY per the collapse law —
          the composer never re-renders a large tile over a draft. */}
      {tilesVisible(mode) && <Stack direction="row" spacing={1.5} sx={{ px: SHEET_PAD, pt: 1.5, height: TILE_ROW_HEIGHT }}>
        <PhotoTile onClick={() => openPicker(photoInputRef)} />
        <VideoTile onClick={() => openPicker(videoInputRef)} />
      </Stack>}

      {/* Attached: one attachment fills the preview width; two or more ride
          the horizontal swipe carousel with the peek and the "2/5"-class
          position indicator (media quantity, the quantity-versus-engagement
          boundary). Remove sits at the attachment's upper-right. */}
      {attachments.length > 0 && <Box sx={{ px: SHEET_PAD, pt: 1.5 }}>
        {carousel
          ? <Box>
              <Box
                ref={trackRef}
                data-testid="sheet-carousel"
                onScroll={(event) => {
                  const track = event.currentTarget;
                  const slide = track?.firstElementChild;
                  if (!slide) return;
                  const stride = slide.getBoundingClientRect().width + SLIDE_GAP;
                  setTrackPosition(carouselIndex(track.scrollLeft, stride, attachments.length));
                }}
                sx={{
                  display: "flex", gap: `${SLIDE_GAP}px`, overflowX: "auto", scrollSnapType: "x mandatory",
                  touchAction: "pan-x pan-y", overscrollBehaviorX: "contain",
                  scrollbarWidth: "none", "&::-webkit-scrollbar": { display: "none" },
                }}>
                {attachments.map((attachment, index) => (
                  <Box
                    key={attachment.file?.name ? `${attachment.file.name}-${index}` : `attachment-${index}`}
                    aria-roledescription="slide"
                    aria-label={`${attachment.kind === "video" ? "Attached video" : "Attached photo"} ${index + 1} of ${attachments.length}`}
                    sx={{ flex: `0 0 ${SLIDE_BASIS}`, scrollSnapAlign: "start", scrollSnapStop: "always", minWidth: 0 }}>
                    <ComposePreview
                      attachment={attachment}
                      onDuration={setDuration}
                      removeLabel={`Remove ${attachment.kind === "video" ? "video" : "photo"}`}
                      onRemove={removeAttachment} />
                  </Box>
                ))}
              </Box>
              <Typography
                component="div"
                aria-label={`${trackPosition + 1} of ${attachments.length}`}
                data-testid="sheet-carousel-position"
                sx={{ mt: 0.5, fontSize: 12, lineHeight: "17px", color: "porchlight.muted" }}>
                {trackPosition + 1}/{attachments.length}
              </Typography>
            </Box>
          : <ComposePreview
              attachment={attachments[0]}
              onDuration={setDuration}
              removeLabel={attachments[0].kind === "video" ? "Remove video" : "Remove photo"}
              onRemove={removeAttachment} />}
      </Box>}

      {/* The one borderless multiline field — computed ≥16px so focus never
          triggers iOS auto-zoom (the theme's input floor carries it). */}
      <Stack sx={{ px: SHEET_PAD, pt: 1.5, pb: 1 }}>
        <InputBase
          multiline
          fullWidth
          data-testid="sheet-field"
          placeholder="Write something…"
          value={text}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => setText(event.target.value)}
          sx={{
            fontSize: "1rem", lineHeight: `${FIELD_LINE_HEIGHT}px`, color: "text.primary", px: 0,
            // The available writing room never collapses below the line
            // floor per presentation (5 lines desktop, 3 mobile).
            "& textarea": { p: 0, border: "none", minHeight: `${fieldMinHeight(presentation)}px` },
          }}
        />
        {previewText && <Stack direction="row" spacing={1} alignItems="center" sx={{ pt: 0.5 }}>
          {preview && previewAttached && <Chip
            size="small"
            label={preview.kind === "embed" ? `${preview.provider ?? "link"}: tap-to-play link attached` : "Link preview attached"}
            onDelete={() => setPreviewAttached(false)}
            sx={{ alignSelf: "flex-start", maxWidth: "100%" }} />}
          {previewLoading && <Typography variant="caption" color="porchlight.muted">Resolving the link preview…</Typography>}
        </Stack>}
      </Stack>

      {/* Thin divider: the field above, the footer below. */}
      <Box sx={{ borderTop: "1px solid", borderColor: "divider" }} />

      {/* Footer: destination control left, Post right. The compact state
          (typing or attached) holds Add photo / Add video at the left of
          the destination control. Flush above the safe area with the
          keyboard closed; above the keyboard when risen. */}
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: SHEET_PAD, py: 1, pb: presentation === "desktop" ? 1 : "calc(8px + env(safe-area-inset-bottom))" }}>
        <Stack direction="row" alignItems="center" spacing={0.5}>
          {mode !== "empty" && <>
            <IconButton aria-label="Add photo" data-testid="sheet-add-photo" onClick={() => openPicker(photoInputRef)}>
              <PhotoOutlinedIcon sx={{ fontSize: 22 }} />
            </IconButton>
            <IconButton aria-label="Add video" data-testid="sheet-add-video" onClick={() => openPicker(videoInputRef)}>
              <VideocamOutlinedIcon sx={{ fontSize: 22 }} />
            </IconButton>
          </>}
          <Button
            data-testid="sheet-destination"
            aria-haspopup="menu"
            ref={destinationRef}
            onClick={(event) => { setDestinationForce(false); setAnchorEl(event.currentTarget); }}
            startIcon={<HomeOutlinedIcon sx={{ fontSize: 20 }} />}
            endIcon={<KeyboardArrowDownIcon sx={{ fontSize: 20 }} />}
            sx={{
              minHeight: 44, px: 1, textTransform: "none", fontWeight: 600,
              color: staleDestination ? "warning.main" : "text.secondary",
              "& .MuiButton-startIcon": { mr: 0.5, color: staleDestination ? "warning.main" : "text.secondary" },
            }}>
            {staleDestination ? "Pick a destination" : label}
          </Button>
          <Menu
            anchorEl={anchorEl ?? (destinationForce ? destinationRef.current : null)}
            open={Boolean(anchorEl) || destinationForce}
            onClose={() => { setAnchorEl(null); setDestinationForce(false); }}
            anchorOrigin={{ vertical: "top", horizontal: "left" }}
            transformOrigin={{ vertical: "bottom", horizontal: "left" }}
            slotProps={{ paper: { "data-testid": "sheet-destination-menu", sx: { mb: 1 } } }}>
            {/* Dismissal never changes the selection: only a picked row
                commits the destination (one destination per post). */}
            {rows.map((row) => (
              <MenuItem
                key={row.value || "main"}
                data-testid={row.value ? `destination-${row.value}` : "destination-main"}
                selected={row.value === groupId}
                onClick={() => { setGroupId(row.value); setAnchorEl(null); setDestinationForce(false); setStaleDestination(false); }}>
                {row.value ? row.label : "Main timeline"}
              </MenuItem>
            ))}
          </Menu>
        </Stack>
        <Button
          variant="contained"
          color="secondary"
          type="submit"
          data-testid="sheet-post"
          disabled={!eligible || publishing || data.offline || staleDestination}
          sx={{ minHeight: 44, px: 2.5, borderRadius: "50px" }}>
          {publishing ? "Posting…" : "Post"}
        </Button>
      </Stack>
    </Box>

    {/* Hidden pickers: photos (multiple) and one video — originals only,
        one tap from the matching tile or compact control. */}
    <input hidden ref={photoInputRef} type="file" accept="image/*" multiple onChange={(event) => { addFiles("photo")(event.target.files); event.target.value = ""; }} />
    <input hidden ref={videoInputRef} type="file" accept="video/*" onChange={(event) => { addFiles("video")(event.target.files); event.target.value = ""; }} />
  </>;

  if (presentation === "desktop") {
    // The modal presentation: 720px class, max height calc(100vh − 80px),
    // 18px radius (the MuiDialog style override), warm surface fill per
    // display mode, backdrop scrim + ≤4px blur from the token set. The
    // publish lock holds the open surface: while a write is in flight the
    // backdrop, Escape, and the Close control dismiss nothing.
    return <Dialog
      open
      onClose={publishing ? undefined : () => onClose?.()}
      aria-labelledby="compose-modal-title"
      slotProps={{
        paper: {
          "data-testid": "compose-modal",
          sx: { width: "100%", maxWidth: 720, bgcolor: "porchlight.warm", maxHeight: "calc(100vh - 80px)", overflowY: "auto" },
        },
        backdrop: {
          sx: { backgroundColor: cssVars.composeBackdrop, backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)" },
        },
      }}>
      {body}
    </Dialog>;
  }

  return <Box
    data-testid="compose-sheet"
    role="dialog"
    aria-modal="true"
    aria-label="New post"
    sx={{
      position: "fixed", left: 0, right: 0, bottom: keyboard?.raised ? `${keyboard.bottom}px` : 0, zIndex: 1200,
      bgcolor: "porchlight.warm", borderTopLeftRadius: SHEET_RADIUS, borderTopRightRadius: SHEET_RADIUS,
      boxShadow: "var(--porch-shadow-sheet)", display: "flex", flexDirection: "column",
      transition: (theme) => theme.transitions.create("bottom", { duration: 180, easing: theme.transitions.easing.easeInOut }),
    }}>
    {body}
  </Box>;
}

/** The Empty state's Photo tile: two-thirds, amber outline, icon above label. */
function PhotoTile({ onClick }) {
  return <Button
    onClick={onClick}
    data-testid="sheet-photo-tile"
    sx={{
      flex: "2", minHeight: 44, display: "flex", flexDirection: "column", gap: 0.5, alignItems: "center", justifyContent: "center",
      border: "1.5px solid", borderColor: "secondary.main", borderRadius: "14px", bgcolor: "transparent",
      color: "text.primary", "&:hover": { bgcolor: "porchlight.amberSoft" }, textTransform: "none", fontWeight: 600,
    }}>
    <PhotoOutlinedIcon sx={{ fontSize: 26, color: "secondary.main" }} />
    Photo
  </Button>;
}

/** The Empty state's Video tile: one-third, subdued warm-neutral outline. */
function VideoTile({ onClick }) {
  return <Button
    onClick={onClick}
    data-testid="sheet-video-tile"
    sx={{
      flex: "1", minHeight: 44, display: "flex", flexDirection: "column", gap: 0.5, alignItems: "center", justifyContent: "center",
      border: "1.5px solid", borderColor: "divider", borderRadius: "14px", bgcolor: "transparent",
      color: "text.secondary", "&:hover": { bgcolor: "porchlight.subtle" }, textTransform: "none", fontWeight: 600,
    }}>
    <VideocamOutlinedIcon sx={{ fontSize: 26, color: "text.secondary" }} />
    Video
  </Button>;
}
