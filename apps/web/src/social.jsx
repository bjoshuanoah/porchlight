import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import {
  Alert, Avatar, Box, Button, Card, CardContent, Chip, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogTitle, Divider, Drawer, FormControl, IconButton, InputLabel, List, ListItemButton,
  ListItemText, MenuItem, Paper, Popover, Select, Stack, TextField, Typography,
} from '@mui/material';
import { AddReactionOutlined, ChevronLeft, ChevronRight, CloseOutlined } from '@mui/icons-material';
import { cssVars } from './theme.js';
import { carouselIndex, photoFirst } from './photo-first.js';
import {
  renditionSrc, renditionSrcset, timelineImageSizes, detailImageSizes,
  playableVideoUrl, posterUrl, rungKindForViewport,
} from './media-rung.js';
import { mentionAnchor, mentionDraft, applyMention, mentionSegments } from './mentions.js';
import { LampMark } from './brand.jsx';
import { reactionRowsOf, ownEmojiRows, reflectReaction, optimisticToggle } from './reactions.js';
import { groupRows, groupMemberRows, canManageGroup, addableCandidates } from './groups.js';
import { dateOf, relativeTime } from './time.js';
import { identityOf, originOf, networkId, originName, visibleAtOrigin, postKey, visibleFeedPosts } from './feed-filter.js';
import { sliceDisplay, expanderCount, reconcileConfirmed, repliesByParent, pendingReply, conversationOf } from './slice.js';
import { useMediaQuery } from '@mui/material';

// The emoji picker is code-split: its Unicode catalog loads only when a
// member first opens a reaction picker (PORCH-036).
const EmojiPicker = lazy(() => import('./emoji-picker.jsx'));

const rows = (value) => Array.isArray(value) ? value : Array.isArray(value?.posts) ? value.posts : [];
const atCurrentOrigin = (post, data) => post.origin ? post : { ...post, origin: data.server?.url, network: data.network?.name };
// Attribution (PORCH-034): the hub resolves each author's family-facing
// name at read time (post.authorName / reply.authorName). This fallback
// covers only a view the hub could not name — self rides the device-held
// identity; any other unresolvable member renders the plain directory
// fallback ("Member"), never a generic placeholder string.
const memberName = (id, data) => id && id === data.identity?.id ? data.identity.name || 'You' : 'Member';
const messageOf = (error) => error?.message || 'That did not work. Please try again.';

function invoke(actions, key, ...args) {
  if (typeof actions?.[key] !== 'function') throw new Error('This action is not available here yet.');
  return actions[key](...args);
}

function useOperation() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(callback, onSuccess, onFailure) {
    setError('');
    setBusy(true);
    try {
      if (typeof callback !== 'function') throw new Error('This action is not available here yet.');
      const result = await callback();
      await onSuccess?.(result);
      return result;
    } catch (failure) {
      setError(messageOf(failure));
      onFailure?.(failure);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

function MediaItem({ id, post, actions, detail = false, slide = false }) {
  // Rendition delivery (PORCH-044): the hydrated payload carries the
  // rendition set of record (mediaMeta, service-side); once the auth-
  // relaying rendition worker is live, media renders straight from
  // content-addressed rendition URLs — img srcset/sizes pick the rung,
  // video renders its poster + playable rendition, and the browser cache
  // answers repeats. "Get original" stays the only path to archive bytes.
  const meta = post?.mediaMeta?.[id] ?? null;
  const direct = Boolean(meta && actions?.mediaTransport);
  const [resource, setResource] = useState(null);
  const [loadError, setLoadError] = useState('');
  const operation = useOperation();
  const getMedia = actions?.getMedia;
  const origin = post?.origin ?? originOf(post);
  useEffect(() => {
    if (direct) return undefined;
    // Loader fallback: insecure origins (no service worker) fetch the
    // rendition bytes through the authorized call; a payload without the
    // hydrated mediaMeta (a stale pre-PORCH-044 timeline or hub) keeps the
    // pre-PORCH-044 behavior — its renditions are not decodable, so the
    // bytes that render at all are the explicit original.
    let active = true;
    let url;
    let posterUrlObj;
    setResource(null);
    setLoadError('');
    const kind = meta ? rungKindForViewport(meta, window.innerWidth, window.devicePixelRatio) : 'original';
    Promise.resolve().then(() => {
      if (typeof getMedia !== 'function') throw new Error('Media is not available here yet.');
      const version = kind ? meta?.renditions?.find((rung) => rung.kind === kind)?.sha256 : null;
      const bytesPromise = getMedia(id, kind ?? 'original', origin, version);
      if (post.type === 'video' && meta?.poster?.sha256) {
        // The poster rides the video post's own rendition set in fallback
        // mode too: poster + playable, fetched through the authorized call.
        return Promise.all([bytesPromise, getMedia(id, 'poster', origin, meta.poster.sha256).catch(() => null)]);
      }
      return Promise.all([bytesPromise, Promise.resolve(null)]);
    }).then(async ([blob, posterBlob]) => {
      if (!(blob instanceof Blob)) throw new Error('Your hub did not return the media.');
      if (!active) return;
      // PORCH-043 ac-7: decode before the first paint, then reserve layout
      // space through CSS aspect-ratio in the same render that shows the
      // media — dimensions resolving can never relayout the feed, and the
      // only placeholder is this spinner (no shimmer anywhere).
      const shape = (meta && meta.width) ? { width: meta.width, height: meta.height } : await mediaShape(blob, post.type);
      if (active) {
        url = URL.createObjectURL(blob);
        if (posterBlob instanceof Blob) posterUrlObj = URL.createObjectURL(posterBlob);
        setResource({ blob, url, posterUrl: posterUrlObj ?? null, ...shape });
      }
    }).catch((error) => { if (active) setLoadError(messageOf(error)); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); if (posterUrlObj) URL.revokeObjectURL(posterUrlObj); };
  }, [id, getMedia, origin, direct]);
  // Timeline media treatment (PORCH-043): natural aspect ratio governs; the
  // 85vh object-fit-contain cap is the single exception for extreme images.
  // Media escapes the text rail — edge-to-edge against the viewport on
  // mobile (the post container is already full-width) and against the card
  // interior on desktop (margin: 0 calc(var(--post-pad) * -1)); media never
  // nests inside another padded media frame (PORCH-043 ac-1, ac-6). In the
  // PORCH-045 carousel the slide mode omits the breakout: the track owns it
  // once for every slide, so a slide is exactly the media width and the
  // media rules can never double-apply.
  const media = post.type === 'photo' || post.type === 'video';
  const breakout = !detail && media && !slide;
  const mediaSx = breakout ? {
    // img/video are replaced elements: the breakout needs both the negative
    // rail margins and the matching width so the element spans the full
    // post-container width (100% + both rail paddings).
    width: { xs: `calc(100% + ${2 * photoFirst.rail}px)`, lg: `calc(100% + ${2 * photoFirst.postPad}px)` },
    mx: { xs: -photoFirst.rail / 8, lg: -(photoFirst.postPad / 8) },
    borderRadius: { xs: '0px', lg: `${photoFirst.desktopMediaRadius}px` },
    overflow: 'hidden',
    display: 'block',
    bgcolor: 'background.default',
  } : {
    display: 'block',
    width: media || post.type === 'audio' ? '100%' : undefined,
    maxHeight: detail ? 720 : undefined,
    borderRadius: detail ? 2 : slide ? 0 : undefined,
    bgcolor: 'background.default',
  };
  // Layout reservation (ac-7): CSS aspect-ratio in place from the first
  // paint; the 85vh cap only letterboxes (object-fit contain), never crops.
  // The rendition payload carries the display dims, so the reservation is
  // exact before the first byte arrives; the decoded blob path (fallback)
  // resolves the same way after the blob decodes.
  const fitSx = media && (resource?.width ?? meta?.width ?? 0) && (resource?.height ?? meta?.height ?? 0)
    ? { aspectRatio: `${resource?.width ?? meta.width} / ${resource?.height ?? meta.height}`, maxHeight: detail ? 720 : photoFirst.extremeCap, objectFit: 'contain' }
    : {};
  // Slide mode (PORCH-045): the media spans the full slide width above, so
  // the textual lines below it ride the 16px mobile rail and the card
  // padding on desktop, exactly as media-owning posts line them up.
  const slideRailSx = slide
    ? {
        pl: { xs: `${photoFirst.rail}px`, lg: `${photoFirst.postPad}px` },
        pr: { xs: `${photoFirst.rail}px`, lg: `${photoFirst.postPad}px` },
      }
    : {};
  // Posters fill the media width (timeline build contract): the poster rung
  // rides video width 100% with no letterboxing, and the playable
  // rendition loads behind it.
  const videoPoster = meta ? posterUrl(meta, origin) : null;
  const videoPlayable = meta ? playableVideoUrl(meta, origin) : null;
  return <Box>
    {post.type === 'photo' && direct && <Box component="img"
      src={renditionSrc(meta, origin) ?? playableVideoUrl(meta, origin)}
      srcSet={renditionSrcset(meta, origin) || undefined}
      sizes={detail ? detailImageSizes(meta) : timelineImageSizes()}
      alt={post.caption || 'Shared photo'} loading="lazy" decoding="async"
      onError={() => setLoadError('Your hub did not return the media.')}
      sx={{ ...mediaSx, ...fitSx }} />}
    {post.type === 'photo' && !direct && resource && <Box component="img" src={resource.url} alt={post.caption || 'Shared photo'} loading="lazy"
      sx={{ ...mediaSx, ...fitSx }} />}
    {post.type === 'video' && direct && <Box component="video" src={videoPlayable} poster={videoPoster} controls preload="metadata"
      onLoadedMetadata={(event) => { if (!meta.width && event.target) setResource({ width: event.target.videoWidth, height: event.target.videoHeight }); }}
      onError={() => setLoadError('Your hub did not return the media.')}
      sx={{ ...mediaSx, ...fitSx }} />}
    {post.type === 'video' && !direct && resource && <Box component="video" src={resource.url} poster={resource.posterUrl ?? undefined} controls preload="metadata"
      sx={{ ...mediaSx, ...fitSx }} />}
    {post.type === 'audio' && <Box component="audio" src={resource?.url} controls preload="none" sx={{ width: '100%' }} />}
    {!resource && !direct && post.type !== 'audio' && !loadError && <CircularProgress size={20} aria-label="Loading media" sx={slideRailSx} />}
    {loadError && <Alert severity="error" sx={slideRailSx}>{loadError}</Alert>}
    <Button size="small" disabled={operation.busy} onClick={() => operation.run(async () => {
      const blob = resource?.blob ?? await invoke(actions, 'getMedia', id, 'original', origin);
      if (!(blob instanceof Blob)) throw new Error('Your hub did not return the original.');
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${id}`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    })} sx={{ ...(slide ? slideRailSx : {}), mt: 1, px: 0, fontSize: 14, fontWeight: 600, justifyContent: 'flex-start' }}>Get original</Button>
    {operation.error && <Alert severity="error" sx={slideRailSx}>{operation.error}</Alert>}
  </Box>;
}

// PORCH-043 ac-7: natural dimensions resolve before the media's first paint,
// so the aspect-ratio reservation is in place from the moment the media
// renders. Photos decode through createImageBitmap; videos read their
// intrinsic ratio from metadata.
async function mediaShape(blob, type) {
  if (type === 'photo') {
    const bitmap = await createImageBitmap(blob);
    const shape = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return shape;
  }
  if (type === 'video') {
    return new Promise((resolve, reject) => {
      const element = document.createElement('video');
      element.preload = 'metadata';
      const done = (value) => { element.src = ''; resolve(value); };
      element.onloadedmetadata = () => done({ width: element.videoWidth, height: element.videoHeight });
      element.onerror = () => reject(new Error('Your hub did not return playable video.'));
      element.src = URL.createObjectURL(blob);
    });
  }
  return {};
}

// Shared snap-track treatment (PORCH-045): one component shape for the
// post carousel and the composer preview. Palette and photo-first tokens
// only — no literal colors in screen code (Display Modes token contract).
const carouselTrackSx = {
  display: 'flex',
  overflowX: 'auto',
  scrollSnapType: 'x mandatory',
  // One slide per horizontal gesture (ac-2): scroll-snap-stop always halts
  // momentum at the adjacent slide and release snaps to the nearest one.
  // The track pan is touch-scrollable in both axes: horizontal drags swipe
  // the native overflow-x track, and near-vertical drags chain to the
  // timeline because the track itself has no vertical overflow. Any
  // touch-action restricting the horizontal pan (e.g. pan-y alone) starves
  // the swipe gesture entirely.
  touchAction: 'pan-x pan-y',
  overscrollBehaviorX: 'contain',
  alignItems: 'flex-start',
  scrollbarWidth: 'none',
  '&::-webkit-scrollbar': { display: 'none' },
};
const carouselSlideSx = {
  flex: '0 0 100%',
  width: '100%',
  minWidth: 0,
  scrollSnapAlign: 'start',
  scrollSnapStop: 'always',
};
// The track (or its wrapper) owns the photo-first breakout once for the
// whole series: edge-to-edge on mobile, full card-interior width on desktop
// (PORCH-043). Slides render inside it without their own breakout, so media
// never nests inside a padded frame.
const carouselBreakoutSx = {
  width: { xs: `calc(100% + ${2 * photoFirst.rail}px)`, lg: `calc(100% + ${2 * photoFirst.postPad}px)` },
  mx: { xs: -photoFirst.rail / 8, lg: -photoFirst.postPad / 8 },
  borderRadius: { xs: 0, lg: `${photoFirst.desktopMediaRadius}px` },
  overflow: 'hidden',
};

// Desktop arrow affordances (ac-2): quiet controls riding the media edges.
// Mobile hides them — swipe is the gesture there.
function CarouselArrows({ atStart, atEnd, onPrev, onNext }) {
  const base = {
    position: 'absolute',
    top: '50%',
    transform: 'translateY(-50%)',
    display: { xs: 'none', lg: 'inline-flex' },
    width: 44,
    height: 48,
    color: 'text.primary',
    bgcolor: 'background.paper',
    border: '1px solid',
    borderColor: 'divider',
    '&:hover': { bgcolor: 'action.hover' },
  };
  return <>
    <IconButton aria-label="Previous image" disabled={atStart} onClick={onPrev} sx={{ ...base, left: 12 }}><ChevronLeft /></IconButton>
    <IconButton aria-label="Next image" disabled={atEnd} onClick={onNext} sx={{ ...base, right: 12 }}><ChevronRight /></IconButton>
  </>;
}

// PORCH-045 (Brian, Oct 14, 2026): a multi-image post renders as a single
// swipeable carousel, one image at a time, on every breakpoint — superseding
// the Oct 9 multi-image grid treatments and the "+3" overlay. The position
// indicator carries media quantity only ("2/5"; quantity-versus-engagement
// boundary) and the slide position is presentation-only state: reactions,
// votes, and replies stay bound to the post in PostCard and this component
// calls no interaction action (ac-5).
function MediaCarousel({ ids, post, actions, detail = false }) {
  const trackRef = useRef(null);
  const [position, setPosition] = useState(0);
  const count = ids.length;
  const slideBy = (step) => {
    const track = trackRef.current;
    if (!track) return;
    const next = Math.min(count - 1, Math.max(0, carouselIndex(track.scrollLeft, track.clientWidth, count) + step));
    track.scrollTo({ left: next * track.clientWidth, behavior: 'smooth' });
  };
  return <Box sx={{ mt: detail ? 2 : photoFirst.spacing.captionMedia / 8 }}>
    <Box sx={{ position: 'relative', ...(!detail ? carouselBreakoutSx : {}) }}>
      <Box ref={trackRef} onScroll={(event) => setPosition(carouselIndex(event.currentTarget.scrollLeft, event.currentTarget.clientWidth, count))} sx={carouselTrackSx}>
        {ids.map((id, index) => (
          <Box key={`${id}-${index}`} aria-roledescription="slide" aria-label={`Image ${index + 1} of ${count}`} sx={carouselSlideSx}>
            <MediaItem id={id} post={post} actions={actions} detail={detail} slide />
          </Box>
        ))}
      </Box>
      <CarouselArrows atStart={position === 0} atEnd={position === count - 1} onPrev={() => slideBy(-1)} onNext={() => slideBy(1)} />
    </Box>
    <Typography component="div" aria-label={`Image ${position + 1} of ${count}`} sx={{ mt: 0.5, px: 0, fontSize: 12, lineHeight: '17px', color: 'porchlight.muted' }}>{position + 1}/{count}</Typography>
  </Box>;
}

// PORCH-045: upload previews in the composer render the same carousel
// preview shape — one attached photo at a time on the same snap track with
// the same quantity indicator, before any upload starts.
function ComposerPreviewCarousel({ files }) {
  const trackRef = useRef(null);
  const [position, setPosition] = useState(0);
  const [urls, setUrls] = useState([]);
  useEffect(() => {
    const created = (files ?? []).map((file) => URL.createObjectURL(file));
    setUrls(created);
    return () => created.forEach((url) => URL.revokeObjectURL(url));
  }, [files]);
  const count = urls.length;
  const slideBy = (step) => {
    const track = trackRef.current;
    if (!track) return;
    const next = Math.min(count - 1, Math.max(0, carouselIndex(track.scrollLeft, track.clientWidth, count) + step));
    track.scrollTo({ left: next * track.clientWidth, behavior: 'smooth' });
  };
  if (!count) return null;
  return <Box sx={{ mt: 1, borderRadius: '10px', overflow: 'hidden' }}>
    <Box sx={{ position: 'relative', borderRadius: '10px' }}>
      <Box ref={trackRef} onScroll={(event) => setPosition(carouselIndex(event.currentTarget.scrollLeft, event.currentTarget.clientWidth, count))} sx={carouselTrackSx}>
        {urls.map((url, index) => (
          <Box key={url} aria-roledescription="slide" aria-label={`Attached photo ${index + 1} of ${count}`} sx={carouselSlideSx}>
            <Box component="img" src={url} alt={files[index]?.name ?? 'Attached photo'} sx={{ display: 'block', width: '100%', maxHeight: 320, objectFit: 'contain', bgcolor: 'porchlight.subtle' }} />
          </Box>
        ))}
      </Box>
      {count > 1 && <CarouselArrows atStart={position === 0} atEnd={position === count - 1} onPrev={() => slideBy(-1)} onNext={() => slideBy(1)} />}
    </Box>
    {count > 1 && <Typography component="div" aria-label={`Attached photo ${position + 1} of ${count}`} sx={{ mt: 0.5, fontSize: 12, color: 'porchlight.muted' }}>{position + 1}/{count}</Typography>}
  </Box>;
}

function Media({ post, actions, detail = false }) {
  const media = Array.isArray(post?.mediaRefs) ? post.mediaRefs : [];
  const ids = media.map((entry) => typeof entry === 'string' ? entry : entry?.mediaId ?? entry?._id ?? entry?.id).filter(Boolean);
  if (!ids.length) return null;
  // PORCH-045: multi-image posts render as a single swipeable carousel on
  // every breakpoint (Brian, Oct 14, 2026) — the Oct 9 grid treatments and
  // the +3 overlay are superseded and render nowhere. Video stays out of
  // the carousel until asked for, so every other shape keeps the plain
  // multi-item stack.
  if (ids.length > 1 && post.type === 'photo') {
    return <MediaCarousel ids={ids} post={post} actions={actions} detail={detail} />;
  }
  return <Stack spacing={0} sx={{ mt: detail ? 2 : photoFirst.spacing.captionMedia / 8 }}>
    {ids.map((id, index) => (
      <MediaItem key={`${id}-${index}`} id={id} post={post} actions={actions} detail={detail} />
    ))}
  </Stack>;
}

// Reaction bar (PORCH-036): a visual emoji picker opens from the small
// add-reaction smile control — no step ever asks the member to type, paste,
// or know an emoji string. Only the emoji actually present render, with no
// counts and no who-reacted inspection surface; per-member rows identify
// the member's own reaction for the warm highlight exclusively. Tapping an
// emoji the member already reacted with clears it and tapping any other
// adds it: change or clear, never an error (ac-2, ac-3). The row reflection
// lives in the shared reactions module, so the timeline card and the post
// detail reflect the same origin conversation through one routine (PORCH-038).
function PresentReactions({ post, data, actions, reactionState, spacingY = 2 }) {
  // Controlled mode (PORCH-041 ac-4): the detail card and the conversation
  // column reflect ONE origin conversation — when reactionState is provided
  // both bars render the PostDetail owner's rows and every toggle lands in
  // both columns from the same routine.
  const [internalRows, setInternalRows] = useState(() =>
    // Decorated cards seed synchronously from the feed read (first paint
    // carries arriving reactions; no loader fetch rides them). The
    // controlled detail surface stays null until its own load runs.
    reactionState ? null : reactionRowsOf(post?.reactionRows));
  const rows = reactionState?.rows ?? internalRows;
  const setRows = reactionState?.setRows ?? setInternalRows;
  const [anchor, setAnchor] = useState(null);
  const operation = useOperation();
  const ownDid = data.identity ? String(data.identity.id) : '';

  // In-place reflection (PORCH-046 ac-2): a card's rows seed straight from
  // the feed read's decoration (no per-card fetch), and a read whose rows
  // changed — another member's reaction arriving — replaces the rows in
  // place while no own write is in flight. A row the own optimistic toggle
  // already reflected keeps its local copy until the read that includes it
  // (the optimistic row is idempotent, never a duplicate).
  const serverRows = reactionRowsOf(post?.reactionRows);
  const serverSignature = serverRows.map((row) => `${row.emoji}:${row.memberDid ?? ''}:${row._id ?? ''}`).join('|');
  const lastServerRef = useRef(null);
  useEffect(() => {
    if (!Object.prototype.hasOwnProperty.call(post ?? {}, 'reactionRows')) return;
    if (lastServerRef.current === serverSignature) return;
    lastServerRef.current = serverSignature;
    setRows(serverRows);
    // The payload's decorated rows are the seed and every later reflection;
    // no loader fetch rides a decorated surface.
  }, [serverSignature]);

  useEffect(() => {
    // Undecorated surfaces (the post detail read) keep the PORCH-036 loader.
    if (Object.prototype.hasOwnProperty.call(post ?? {}, 'reactionRows')) return undefined;
    let current = true;
    setRows(null);
    Promise.resolve().then(() => invoke(actions, 'loadReactions', post))
      .then((value) => { if (current) setRows(reactionRowsOf(value)); })
      .catch(() => { if (current) setRows([]); });
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one load per surfaced post
  }, [identityOf(post)]);
  const own = ownEmojiRows(rows, ownDid);
  const toggle = (emoji, isOwn) => {
    setAnchor(null);
    if (!ownDid || operation.busy) return;
    // Optimistic first (ac-2): the row renders immediately, in the one pure
    // step both surfaces share; the failure path rolls back to the exact
    // prior rows; success swaps the local copy for the confirmed row.
    const before = rows;
    setRows(optimisticToggle(rows ?? [], { emoji, ownDid, isOwn }));
    operation.run(
      () => invoke(actions, isOwn ? 'unreact' : 'react', post, emoji),
      (result) => {
        if (result?.reaction && !isOwn) {
          setRows((current) => reflectReaction(current ?? [], {
            emoji, ownDid, isOwn: false, reaction: result.reaction,
          }));
        }
      },
      // Rollback (ac-2): a failed write never leaves a phantom reaction.
      () => setRows(before),
    );
  };
  return <Stack
    direction="row"
    spacing={1}
    alignItems="center"
    flexWrap="wrap"
    sx={{ mt: spacingY }}
    aria-label="Reactions from your family"
  >
    {[...new Set((rows ?? []).map((row) => row.emoji))].map((emoji) => {
      const ownEmoji = own.has(emoji);
      return <Chip
        key={emoji}
        label={emoji}
        size="small"
        aria-pressed={ownEmoji}
        aria-label={ownEmoji ? `Your reaction ${emoji}` : `Reaction ${emoji}`}
        sx={{
          minHeight: 40,
          minWidth: 40,
          fontSize: 20,
          ...(ownEmoji ? {
            bgcolor: 'porchlight.amberSoft',
            border: '1px solid',
            borderColor: 'porchlight.amber',
            color: 'text.primary',
          } : {}),
        }}
      />;
    })}
    <IconButton
      size="medium"
      aria-label="Add a reaction"
      aria-haspopup="dialog"
      disabled={operation.busy || Boolean(data?.offline)}
      onClick={(event) => setAnchor(event.currentTarget)}
      sx={{ width: 40, height: 40, border: `1px dashed ${cssVars.borderStrong}` }}
    >
      <AddReactionOutlined fontSize="small" />
    </IconButton>
    {anchor && <Suspense fallback={<CircularProgress size={20} />}>
      <EmojiPicker open anchorEl={anchor} onClose={() => setAnchor(null)} own={own} onToggle={toggle} busy={operation.busy} />
    </Suspense>}
    {operation.error && <Typography variant="caption" color="error" sx={{ width: '100%' }}>{operation.error}</Typography>}
  </Stack>;
}

function PostCard({ post, data, actions, navigate, detail = false, onHide, reactionState }) {
  const [localHidden, setLocalHidden] = useState(false);
  // Card-level reply (PORCH-038 ac-1): the affordance opens an inline
  // composer riding the same mention handling as the detail composer; the
  // member never navigates to post detail to answer.
  const [replying, setReplying] = useState(false);
  const operation = useOperation();
  // Conversation slice state (PORCH-046): pending replies (write in flight,
  // rolled back on failure) and acknowledged replies (write confirmed, next
  // read pending) render through sliceDisplay with the server's slice.
  const [localConversation, setLocalConversation] = useState(() => ({ pending: [], confirmed: [] }));
  const replyCountRef = useRef(0);
  const [conversationOpen, setConversationOpen] = useState(false);
  const sliceIdentity = post
    ? `${identityOf(post)}:${Array.isArray(post.replySlice) ? post.replySlice.map((reply) => reply._id).join('|') : ''}:${Number.isFinite(post.replyTotal) ? post.replyTotal : ''}`
    : '';
  useEffect(() => {
    // Reconcile (ac-2): an acknowledged reply retires the moment a feed read
    // can hold it — never rendered twice, never dropped before its write
    // landed in a read's quantity.
    setLocalConversation((current) => ({
      ...current,
      confirmed: reconcileConfirmed(current.confirmed, post ? conversationOf(post).total : null),
    }));
    // The slice identity rides the post's read, not the object identity: a
    // poll that changes nothing reconciles nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reconcile rides the server slice signature
  }, [sliceIdentity]);
  if (localHidden || actions?.isHidden?.(post) || !visibleAtOrigin(post, data)) return null;
  const openPost = () => navigate?.(`/posts/${encodeURIComponent(identityOf(post))}`);
  // Card-level optimistic reply (PORCH-046 ac-2): the row renders in the
  // slice immediately; a confirmed write joins the acknowledged list (it
  // keeps rendering until a read counts it); a failure rolls back cleanly.
  const submitOptimistic = (body, parentId, mentions) => {
    const localId = `local:reply-${Date.now()}-${(replyCountRef.current += 1)}`;
    const optimisticRow = pendingReply(post, body, {
      did: data.identity ? String(data.identity.id) : null,
      name: data.identity?.name ?? 'You',
      localId,
    });
    setLocalConversation((current) => ({ ...current, pending: [...current.pending, optimisticRow] }));
    const revert = () => setLocalConversation((current) => ({ ...current, pending: current.pending.filter((row) => row._id !== localId) }));
    return Promise.resolve()
      .then(() => invoke(actions, 'submitReply', post, body, parentId, mentions))
      .then((result) => {
        if (!result?.comment || !identityOf(result.comment)) {
          revert();
          throw new Error('The family server did not confirm this reply. Reload the conversation before trying again.');
        }
        setLocalConversation((current) => ({
          pending: current.pending.filter((row) => row._id !== localId),
          confirmed: [...current.confirmed, {
            reply: { ...result.comment, postId: result.comment.postId ?? identityOf(post) },
            basis: conversationOf(post).total,
          }],
        }));
        return result;
      }, (failure) => { revert(); throw failure; });
  };
  const displaySlice = detail ? null : sliceDisplay(post, localConversation);
  // PORCH-043 mobile post container (below 900px): width 100%, no radius,
  // no side borders, no shadow — the Feed's 1px warm-neutral divider
  // provides post separation (continuous album, no card gap mode). Desktop
  // keeps the Oct 9 contained card (ac-5, ac-6).
  const cardSx = detail ? undefined : {
    width: '100%',
    borderRadius: { xs: 0, lg: '14px' },
    border: { xs: 'none', lg: `1px solid ${cssVars.border}` },
    boxShadow: { xs: 'none', lg: cssVars.shadowCard },
  };
  // PORCH-043 timeline actions (mobile chrome ruling): 14px/600 amber text,
  // no backgrounds or borders, ≥44px touch targets, distributed evenly. The
  // detail surface keeps PORCH-041's own treatment (supersession is scoped
  // to the timeline rebuild).
  const actionSx = detail
    ? undefined
    : { fontSize: 14, fontWeight: 600, justifyContent: 'center' };
  // The feed-entry anchor (PORCH-046 ac-1): a stable per-post measurement
  // point for the reading-place compensation during live arrival.
  return <Card sx={cardSx} data-feed-entry={postKey(post) || undefined}>
    <CardContent sx={{ p: detail ? '20px' : { xs: '16px', lg: '20px' }, '&:last-child': { pb: detail ? '20px' : { xs: '16px', lg: '20px' } } }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          {/* Detail card treatment (PORCH-041 spec): 40px avatar header on the detail surface. */}
          <Avatar sx={{ width: detail ? 40 : 36, height: detail ? 40 : 36, fontSize: detail ? 17 : 15 }}>{(post.author?.name ?? post.authorName ?? memberName(post.authorId, data)).trim().charAt(0).toUpperCase()}</Avatar>
          <Box>
            {/* Header (PORCH-043 chrome): author 15px/600; 24px outlined
                network chip with thin border and 12px text; date muted; the
                column rides 36px avatars on the timeline surface. */}
            <Typography variant="body2" fontWeight={600} fontSize={15} color="text.primary">{post.author?.name ?? post.authorName ?? memberName(post.authorId, data)}</Typography>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              <Chip label={`From ${originName(post, data)}`} size="small" variant="outlined" sx={{ fontSize: '0.75rem', height: '24px' }} />
              {post.groupName && <Chip label={post.groupName} size="small" sx={{ bgcolor: 'porchlight.amberSoft', color: 'primary.main', fontSize: '0.6875rem', height: '24px' }} />}
              <Typography variant="caption" color="porchlight.muted">{dateOf(post.createdAt)}</Typography>
            </Stack>
          </Box>
        </Stack>
        <Button size="small" disabled={operation.busy} onClick={() => operation.run(() => invoke(actions, 'hide', post), () => { setLocalHidden(true); onHide?.(post); })}>Hide</Button>
      </Stack>
      {/* Rhythm (PORCH-043 vertical table): 25–30% tighter post-internal
          spacing; the body line stays 16px/25px on the timeline with the
          readable 68ch length. */}
      {(post.body || post.caption) && <Box sx={{ mt: detail ? 2 : 1 }}>
        {post.body && <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: detail ? 17 : 16, lineHeight: detail ? '27px' : '25px', maxWidth: '68ch' }}>{post.body}</Typography>}
        {post.caption && <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: detail ? 17 : 16, lineHeight: detail ? '27px' : '25px', maxWidth: '68ch', ...(post.body ? { mt: 0.5 } : {}) }}>{post.caption}</Typography>}
      </Box>}
      <Media post={post} actions={actions} detail={detail} />
      <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 2, ...(detail ? {} : { justifyContent: 'space-between' }) }}>
        <Button disabled={operation.busy || data.offline} sx={actionSx} onClick={() => operation.run(() => invoke(actions, 'vote', post, 'up'))}>Lift</Button>
        <Button disabled={operation.busy || data.offline} sx={actionSx} onClick={() => operation.run(() => invoke(actions, 'vote', post, 'down'))}>Lower</Button>
        {/* Card affordances (PORCH-038): quiet react and reply controls per
            the product intent. The detail surface stays the full conversation
            view; Open conversation remains available but is no longer the
            only door. No engagement counts render on any surface. */}
        {!detail && <Button aria-expanded={replying} disabled={data.offline} sx={actionSx} onClick={() => setReplying(!replying)}>Reply</Button>}
        {!detail && <Button sx={actionSx} onClick={openPost}>Open conversation</Button>}
      </Stack>
      {!detail && replying && !data.offline && <ReplyForm
        label="Write a reply"
        offline={data.offline}
        post={post}
        actions={actions}
        onSubmit={(body, mentions) => submitOptimistic(body, null, mentions)}
      />}
      <PresentReactions post={post} data={data} actions={actions} reactionState={reactionState} spacingY={detail ? 2 : photoFirst.spacing.actionsReactions / 8} />
      {/* Conversation preview (PORCH-046 ac-5): the latest five replies,
          readable and joinable without opening the post; the expander opens
          the conversation in place (ac-6), quantity only. */}
      {!detail && <ReplySliceBlock slice={displaySlice} data={data} actions={actions} onOpenConversation={() => setConversationOpen(true)} offline={data.offline} />}
      {operation.error && <Alert severity="error" sx={{ mt: 1 }}>{operation.error}</Alert>}
      {/* The in-place conversation surface: no navigation, so the feed's
          reading place survives open and dismissal untouched (ac-3, ac-6).
          The route surface (/posts/:id) remains the standalone full-history
          view (PORCH-041). */}
      {!detail && <ConversationOverlay open={conversationOpen} onClose={() => setConversationOpen(false)} postId={identityOf(post)} seed={post} data={data} actions={actions} navigate={navigate} />}
    </CardContent>
  </Card>;
}

function Heading({ title, subtitle }) {
  return <Box sx={{ mb: 3 }}><Typography variant="h1" component="h1" fontWeight={650}>{title}</Typography>{subtitle && <Typography variant="body1" color="text.secondary">{subtitle}</Typography>}</Box>;
}

// Conversation preview slice (PORCH-046 ac-5, build contract): the card's
// five most-recent replies in reading direction between the reaction row
// and the post divider, each riding the ReplyItem treatment (30px avatar,
// name, relative time, text). The expander is the quiet amber text action
// "(and N more)" and carries the conversation-length quantity only — never
// an engagement count (quantity-versus-engagement boundary).
function ReplySliceBlock({ slice, data, actions, onOpenConversation, offline }) {
  const more = expanderCount(slice.total);
  if (!slice.replies.length && more === 0) return null;
  return <Stack spacing={1} sx={{ mt: photoFirst.spacing.reactionsSlice / 8 }}>
    {slice.replies.map((reply) => (
      <Stack key={identityOf(reply)} direction="row" spacing={1} alignItems="flex-start">
        <Avatar sx={{ width: 30, height: 30, fontSize: 13 }}>{(reply.author?.name ?? reply.authorName ?? memberName(reply.authorDid, data)).trim().charAt(0).toUpperCase()}</Avatar>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="caption" color="porchlight.muted">
            {reply.authorName ?? memberName(reply.authorDid, data)} · {relativeTime(reply.createdAt)}
          </Typography>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{renderReplyBody(reply, data)}</Typography>
        </Box>
      </Stack>
    ))}
    {more > 0 && <Button
      size="small"
      onClick={offline ? undefined : onOpenConversation}
      aria-label={`Open the conversation — ${more} more replies`}
      sx={{ alignSelf: 'flex-start', px: 0, minWidth: 0, fontSize: 14, fontWeight: 600, color: 'secondary.main' }}
    >{`(and ${more} more)`}</Button>}
  </Stack>;
}

// The in-place conversation surface (PORCH-046 ac-6): mobile bottom sheet
// (24px top corners), desktop side panel — one component, two responsive
// forms, never a navigation. Dismissal restores the feed where it was (no
// scroll was touched, so the reading place survives open AND dismissal).
// The thread loads only on open; the same loadPost/loadComments path the
// detail route rides keeps one conversation source.
function ConversationOverlay({ open, onClose, postId, seed, data, actions, navigate }) {
  const isWide = useMediaQuery('@media (min-width: 900px)');
  const [thread, setThread] = useState(null);
  const [pending, setPending] = useState([]);
  const [reactionRows, setReactionRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const replyCountRef = useRef(0);
  useEffect(() => {
    if (!open || !postId) return undefined;
    let current = true;
    setLoading(true);
    setThread(null);
    setPending([]);
    setReactionRows(null);
    setLoadError('');
    Promise.resolve().then(async () => {
      const postResult = await invoke(actions, 'loadPost', postId);
      if (!postResult?.post || identityOf(postResult.post) !== String(postId)) throw new Error('The family server did not return this post.');
      const commentsResult = await invoke(actions, 'loadComments', postResult.post);
      if (!Array.isArray(commentsResult?.comments)) throw new Error('The family server did not return this conversation.');
      return { post: postResult.post, comments: commentsResult.comments };
    }).then((result) => {
      if (current) { setThread(result); if (result.post?.reactionRows) setReactionRows(reactionRowsOf(result.post.reactionRows)); setLoading(false); }
    }).catch((error) => {
      if (current) { setLoadError(messageOf(error)); setLoading(false); }
    });
    return () => { current = false; };
  }, [open, postId]);
  const post = thread?.post ?? (open ? seed : null);
  const comments = thread?.comments ?? [];
  // The rendered thread carries the load's rows plus the member's
  // optimistic replies; confirmed rows swap for the server's copies.
  const rowIds = new Set(comments.map((reply) => identityOf(reply)));
  const rendered = [...comments, ...pending.filter((reply) => !rowIds.has(identityOf(reply)))];
  const submit = async (body, parentId, mentions) => {
    if (!thread) throw new Error('The conversation is still loading. Try again once it opens.');
    const localId = `local:reply-${Date.now()}-${(replyCountRef.current += 1)}`;
    const optimisticRow = pendingReply(thread.post, body, {
      did: data.identity ? String(data.identity.id) : null,
      name: data.identity?.name ?? 'You',
      localId,
    });
    // The optimistic row joins the thread in place (ac-2); nesting under its
    // parent renders with the same Reply treatment.
    setPending((current) => [...current, { ...optimisticRow, parentId: parentId ?? null }]);
    const revert = () => setPending((current) => current.filter((row) => row._id !== localId));
    try {
      const result = await invoke(actions, 'submitReply', thread.post, body, parentId, mentions);
      if (!result?.comment || !identityOf(result.comment) || result.comment.postId !== identityOf(thread.post)) {
        throw new Error('The family server did not confirm this reply. Reload the conversation before trying again.');
      }
      // The confirmed server copy retires the optimistic row under its own
      // _id: one copy renders in the thread, exactly once.
      setPending((current) => current.filter((row) => row._id !== localId));
      setThread((current) => current ? { ...current, comments: [...current.comments, result.comment] } : current);
      return result;
    } catch (failure) {
      revert();
      throw failure;
    }
  };
  const filtered = rendered.filter((reply) => (!reply.postId || reply.postId === identityOf(post)) && (!reply.networkId || !post || !originOf(post) || String(reply.networkId) === String(originOf(post))));
  return <Drawer
    open={Boolean(open)}
    onClose={onClose}
    anchor={isWide ? 'right' : 'bottom'}
    aria-label="Conversation"
    slotProps={{ paper: {
      sx: {
        ...(isWide
          ? { width: 480, borderTopLeftRadius: '18px', borderBottomLeftRadius: '18px' }
          : { borderTopLeftRadius: '24px', borderTopRightRadius: '24px', maxHeight: '85vh' }),
        display: 'flex',
        flexDirection: 'column',
      },
    } }}
  >
    <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ px: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
      <Typography variant="h3" component="h2" fontWeight={650}>Replies</Typography>
      <IconButton aria-label="Close conversation" onClick={onClose}><CloseOutlined fontSize="small" /></IconButton>
    </Stack>
    <Box sx={{ overflowY: 'auto', flex: 1, p: 2 }}>
      {loading && <CircularProgress aria-label="Loading conversation" size={24} />}
      {loadError && <Alert severity="error">{loadError}</Alert>}
      {post && !loadError && <Stack spacing={2}>
        <PostCard post={post} data={data} actions={actions} navigate={navigate} detail
          reactionState={{ rows: reactionRows, setRows: setReactionRows }} />
        <PresentReactions post={post} data={data} actions={actions} reactionState={{ rows: reactionRows, setRows: setReactionRows }} />
        <Typography variant="h6">Replies</Typography>
        {thread && (rendered.length ? <ReplyThread comments={filtered} post={post} data={data} actions={actions} navigate={navigate} offline={data.offline} onReply={submit} /> : <Typography color="text.secondary">Be the first to reply.</Typography>)}
      </Stack>}
    </Box>
  </Drawer>;
}

// The pending copy swaps for the confirmed server row by id: the confirm
// response carries the real _id, so the local row retires and the confirmed
// one renders exactly once under the same conversation.

// The nested reply tree (PORCH-046/PORCH-041): one structure shared by the
// post detail route and the in-place conversation surface.
function ReplyThread({ comments, post, data, actions, navigate, offline, onReply }) {
  const byParent = repliesByParent(comments);
  const render = (parentId = '', depth = 0, seen = new Set()) => (byParent.get(parentId) || [])
    .filter((reply) => !seen.has(identityOf(reply)))
    .map((reply, index) => {
      const nextSeen = new Set(seen);
      nextSeen.add(identityOf(reply));
      return <Reply key={identityOf(reply) || index} reply={reply} depth={depth} offline={offline} data={data} post={post} actions={actions} navigate={navigate} onReply={onReply}>{render(identityOf(reply), depth + 1, nextSeen)}</Reply>;
    });
  return <>{render()}</>;
}

// PORCH-043: the mobile feed breaks out of the page gutter so posts span
// the full viewport (ac-1) and post separation is the 1px warm-neutral
// divider — continuous-album mode, no card gap (ac-5). Desktop keeps the
// contained 16px-gap card river (ac-6). Breakout values match the shell's
// page padding (theme tokens: 16px mobile, 20px desktop — main.jsx).
const feedBreakout = { mx: { xs: -2, lg: 0 } };
const albumDivider = <Box sx={{ height: '1px', flexShrink: 0, width: '100%', bgcolor: photoFirst.dividerColor, display: { xs: 'block', lg: 'none' } }} aria-hidden="true" />;

function Feed({ posts, data, actions, navigate, empty, hidden, onHide }) {
  // The one privacy filter every render rides (PORCH-046 ac-4): loaded
  // feed, live arrival, and cached timeline all drop hidden and
  // foreign-origin posts here, never downstream.
  const visible = visibleFeedPosts(rows(posts), data, hidden).filter((post) => !actions?.isHidden?.(post));
  return visible.length
    ? <Box sx={feedBreakout}><Stack spacing={{ xs: 0, lg: 2 }} divider={albumDivider}>{visible.map((post, index) => <PostCard key={postKey(post) || index} post={post} data={data} actions={actions} navigate={navigate} onHide={onHide} />)}</Stack></Box>
    : <Alert severity="info">{empty}</Alert>;
}

// Empty timeline (tokens): encouraging, never marketing — the porch-at-dusk
// glow is CSS, and the CTA opens compose without navigating away.
function EmptyTimeline({ navigate }) {
  return <Paper elevation={0} sx={{ textAlign: 'center', py: 8, px: 3, borderRadius: '14px', border: `1px solid ${cssVars.border}`, background: 'transparent' }}>
    {/* Brand surface (PORCH-032): the porch-at-dusk glow carries the new lamp mark. */}
    <Box aria-hidden="true" sx={{ mx: 'auto', mb: 3, width: 88, height: 88, borderRadius: '50%', display: 'grid', placeItems: 'center', background: `radial-gradient(circle at 50% 30%, ${cssVars.amberGlow}, ${cssVars.amberSoft})` }}>
      <LampMark size={48} />
    </Box>
    <Typography variant="h3" component="p" sx={{ mb: 1 }}>It's quiet here.</Typography>
    <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>Share the first moment with your family.</Typography>
    <Button variant="contained" sx={{ height: 48 }} onClick={() => navigate?.('/compose')}>Create a post</Button>
  </Paper>;
}

export function Timeline({ data = {}, actions = {}, navigate }) {
  const posts = rows(data.posts);
  const ranked = rows(data.ranked);
  const [hidden, setHidden] = useState(() => new Set());
  const onHide = (post) => setHidden((current) => new Set(current).add(postKey(post)));
  // Timeline shell (tokens): 760–820px river inside the shell, H1 heading,
  // single chronological feed, honest ranked section below.
  return <Box sx={{ maxWidth: 780 }}>
    <Heading title="Shared moments" subtitle="The latest moments from your connected families" />
    {data.offline && <Alert severity="warning" sx={{ mb: 2 }}>A family server is unreachable. Saved moments may be out of date; new activity is not available until you reconnect.</Alert>}
    <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mb: 3 }}><Button variant="contained" onClick={() => navigate?.('/compose')}>Create a post</Button><Button variant="outlined" onClick={() => navigate?.('/search')}>Search moments</Button><Button variant="outlined" onClick={() => navigate?.('/albums')}>Albums</Button></Stack>
    <Typography variant="h6" sx={{ mb: 1 }}>Latest activity</Typography>
    {!data.offline && !posts.length ? <EmptyTimeline navigate={navigate} /> : <Feed posts={posts} data={data} actions={actions} navigate={navigate} hidden={hidden} onHide={onHide} empty={data.offline ? 'No saved moments are available.' : 'Nothing here yet. Start the conversation.'} />}
    <Divider sx={{ my: 4 }} />
    <Typography variant="h6" sx={{ mb: 1 }}>Family highlights</Typography>
    <Feed posts={ranked} data={data} actions={actions} navigate={navigate} hidden={hidden} onHide={onHide} empty={data.offline ? 'Highlights are unavailable while a family server is unreachable.' : 'No highlighted posts yet.'} />
  </Box>;
}

// Group management (PORCH-030, Oct 14 2026 follow-up — the owner's "fix
// groups in the UI" note): the Groups page is member-plane. Creating a
// group is open to every member; the member who created a group manages its
// membership from its Members view; origin containment is unchanged (a
// group belongs to exactly one network). The pure mappings ride groups.js;
// this component only renders and forwards actions.
export function Groups({ data = {}, actions = {}, navigate, id, routeId }) {
  const selectedId = id ?? routeId;
  const groups = groupRows(data.groups, data.network?.id);
  const [loaded, setLoaded] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [creating, setCreating] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!selectedId || data.offline) return undefined;
    if (!actions.loadGroup) { setLoadError('This group timeline cannot be loaded from your family server yet.'); return undefined; }
    let current = true;
    setLoaded(null);
    setLoading(true);
    setLoadError('');
    Promise.resolve().then(() => actions.loadGroup(selectedId))
      .then((result) => {
        if (!result?.group || !Array.isArray(result.posts)) throw new Error('The family server did not return this group timeline.');
        if (current) { setLoaded({ ...result, id: selectedId }); setLoading(false); }
      })
      .catch((error) => { if (current) { setLoadError(messageOf(error)); setLoading(false); } });
    return () => { current = false; };
  }, [selectedId, data.offline, actions.loadGroup, revision]);
  const current = loaded?.id === selectedId ? loaded : null;
  const group = current?.group ?? groups.find((item) => identityOf(item) === String(selectedId));
  const posts = current ? rows(current.posts).map((post) => atCurrentOrigin(post, data)) : rows(data.posts).filter((post) => String(post.groupId ?? '') === String(selectedId) && (!group?.networkId || String(originOf(post)) === String(group.networkId)));
  const onCreate = async (name) => {
    const result = await invoke(actions, 'createGroup', name);
    setCreating(false);
    if (result?.group?._id) navigate?.(`/groups/${encodeURIComponent(result.group._id)}`);
    return result;
  };
  return <Box>
    <Heading title={group?.name ?? 'Groups'} subtitle="Spaces within your family network" />
    {data.offline && <Alert severity="warning" sx={{ mb: 2 }}>Groups may be out of date while your family server is unreachable.</Alert>}
    {selectedId && <Button sx={{ mb: 2 }} onClick={() => navigate?.('/groups')}>All groups</Button>}
    {loading && <CircularProgress aria-label="Loading group" size={24} />}
    {loadError && <Alert severity="error">{loadError}</Alert>}
    {selectedId && !group && !loading && !loadError && <Alert severity="info">{data.offline ? 'This group is not saved on this device. Reconnect to check it.' : 'This group is not available in your network.'}</Alert>}
    {group && !loading && !loadError && <Stack spacing={2}>
      <Typography color="text.secondary">Posts in {group.name} stay within {data.network?.name ?? 'this family network'}. Each post shows its origin.</Typography>
      <MembersCard group={group} data={data} actions={actions} onchanged={() => setRevision((at) => at + 1)} />
      <Feed posts={posts} data={data} actions={actions} navigate={navigate} empty={data.offline ? 'No saved posts from this group are available.' : 'No posts in this group yet.'} />
    </Stack>}
    {!selectedId && <Stack spacing={2}>
      <Stack direction="row" spacing={1} flexWrap="wrap"><Button variant="contained" onClick={() => setCreating(true)} data-testid="create-group">Create a group</Button></Stack>
      {groups.length ? <Stack spacing={2}>{groups.map((item) => <Card key={identityOf(item)} variant="outlined"><CardContent><Typography variant="h6">{item.name}</Typography><Typography color="text.secondary">Within {data.network?.name ?? 'this family network'} · {(Array.isArray(item.members) ? item.members.length : 0)} member{(item.members?.length ?? 0) === 1 ? '' : 's'}</Typography><Button onClick={() => navigate?.(`/groups/${encodeURIComponent(identityOf(item))}`)}>View group</Button></CardContent></Card>)}</Stack> : <Alert severity="info">{data.offline || data.availability?.groups === false ? 'Groups cannot be loaded from your family server right now.' : 'No groups yet. Create one — every member of the network can.'}</Alert>}
    </Stack>}
    {creating && <CreateGroupDialog data={data} actions={actions} onClose={() => setCreating(false)} onCreate={onCreate} />}
  </Box>;
}

function MembersCard({ group, data, actions, onchanged }) {
  const [adding, setAdding] = useState(false);
  const manage = canManageGroup(group, data);
  const roster = groupMemberRows(group);
  return <Card variant="outlined"><CardContent>
    <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
      <Typography variant="h6">Members</Typography>
      {manage && <Button onClick={() => setAdding(true)} data-testid="add-group-members">Add members</Button>}
    </Stack>
    <Typography color="text.secondary" sx={{ mb: 1 }}>
      {group.createdBy === data.identity?.id ? 'You created this group; you add its members.' : 'Only the group\'s creator (or the network owner) adds members.'}
    </Typography>
    <List dense disablePadding>
      {roster.map((member) => <ListItemButton key={member.did} disableGutters>
        <ListItemText primary={member.name ?? (member.did === data.identity?.id ? 'You' : member.did)}
          secondary={member.did === data.identity?.id && member.name ? 'You' : undefined} />
      </ListItemButton>)}
    </List>
    {adding && <AddMembersDialog group={group} actions={actions} onClose={() => setAdding(false)}
      onAdded={() => { setAdding(false); onchanged?.(); }} />}
  </CardContent></Card>;
}

function CreateGroupDialog({ data, actions, onClose, onCreate }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!name.trim()) { setError('A group needs a name.'); return; }
    setSaving(true);
    setError('');
    try { await onCreate(name); } catch (cause) { setError(messageOf(cause)); setSaving(false); }
  };
  return <Dialog open onClose={onClose} aria-label="Create a group">
    <DialogTitle>Create a group</DialogTitle>
    <DialogContent>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>A space within {data.network?.name ?? 'your family network'}. You create it, you add its members — its posts stay inside the network.</Typography>
      <TextField autoFocus fullWidth label="Group name" value={name} onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') void save(); }} error={Boolean(error)} helperText={error} />
    </DialogContent>
    <DialogActions>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="contained" disabled={saving || !name.trim()} onClick={() => void save()}>Create group</Button>
    </DialogActions>
  </Dialog>;
}

function AddMembersDialog({ group, actions, onClose, onAdded }) {
  const [candidates, setCandidates] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const groupId = group?._id ?? group?.id;
  useEffect(() => {
    let current = true;
    Promise.resolve().then(() => invoke(actions, 'groupMemberCandidates', ''))
      .then((result) => { if (current) setCandidates(addableCandidates(result?.candidates, group)); })
      .catch((cause) => { if (current) setError(messageOf(cause)); });
    return () => { current = false; };
  }, [groupId]); // eslint-disable-line react-hooks/exhaustive-deps -- the roster pick rides one group; actions/group by value at open
  const toggle = (did) => setPicked((current) => {
    const next = new Set(current);
    if (next.has(did)) next.delete(did); else next.add(did);
    return next;
  });
  const add = async () => {
    setSaving(true);
    setError('');
    try { await invoke(actions, 'addGroupMembers', group._id || group.id, [...picked]); onAdded?.(); }
    catch (cause) { setError(messageOf(cause)); setSaving(false); }
  };
  return <Dialog open onClose={onClose} aria-label="Add group members">
    <DialogTitle>Add members to {group.name}</DialogTitle>
    <DialogContent>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>Members of this network only — a group's membership never outgrows the network's.</Typography>
      {!candidates && !error && <CircularProgress size={24} />}
      {error && <Alert severity="error">{error}</Alert>}
      {candidates && (candidates.length
        ? <List dense>{candidates.map((candidate) => <ListItemButton key={candidate.did} onClick={() => toggle(candidate.did)} selected={picked.has(candidate.did)}>
            <ListItemText primary={candidate.name ?? candidate.did} secondary={candidate.role === 'owner' ? 'Owner' : undefined} />
            {picked.has(candidate.did) ? <Chip size="small" label="Adding" /> : null}
          </ListItemButton>)}</List>
        : <Alert severity="info">Every member of this network is already in {group.name}.</Alert>)}
    </DialogContent>
    <DialogActions>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="contained" disabled={saving || picked.size === 0} onClick={() => void add()}>Add</Button>
    </DialogActions>
  </Dialog>;
}

// Mention rendering (PORCH-037): a reply body carries @Name tokens that the
// hub resolved to family-facing names at read time (reply.mentionNames).
// A mention renders in navy on the amber-soft emphasis; a member whose name
// no longer resolves renders as plain body text. No id ever takes part in
// rendering — an identity id lives in the write payload and nowhere on screen.
const mentionSegmentsOf = (reply) => mentionSegments(reply.body, reply.mentionNames);
// Members' surfaces: the family roster (/members) is the network's profile
// directory for the owner; members without the owner gate get emphasis
// without a navigation dead end. V1 has no per-member profile page.
const canSeeDirectory = (data) => Boolean(data?.identity?.id) && (data?.members ?? []).some((entry) => entry?.did === data?.identity?.id && entry?.role === 'owner');

function Mention({ text, data, navigate }) {
  const emphasis = { color: 'primary.main', fontWeight: 650, bgcolor: 'porchlight.amberSoft', borderRadius: '4px', px: 0.4 };
  if (canSeeDirectory(data) && typeof navigate === 'function') {
    return <Typography component="span" onClick={() => navigate('/members')} title="View the family" sx={{ ...emphasis, cursor: 'pointer' }}>{text}</Typography>;
  }
  return <Typography component="span" sx={emphasis}>{text}</Typography>;
}

function renderReplyBody(reply, data, navigate) {
  return mentionSegmentsOf(reply).map((segment, index) => segment.mention
    ? <Mention key={index} text={segment.text} data={data} navigate={navigate} />
    : <React.Fragment key={index}>{segment.text}</React.Fragment>);
}

// Reply composer with mention autocomplete (PORCH-037): typing @ (after
// whitespace or at the start) opens the origin network's roster, listed by
// family-facing name only. The picked name enters the text; the member's id
// stays in memory for the write and never renders. The same composer rides
// the post-detail conversation and card-level replies when they exist.
function ReplyForm({ label, onSubmit, offline, post, actions }) {
  const [text, setText] = useState('');
  const [mention, setMention] = useState(null); // { anchor } under the caret
  const [candidates, setCandidates] = useState([]);
  const [pickedNames, setPickedNames] = useState([]); // autocomplete closure
  const [pickedDids, setPickedDids] = useState([]); // the write payload only
  const inputRef = useRef(null);
  const fieldRef = useRef(null);
  const requestRef = useRef(0);
  const operation = useOperation();
  const queryCandidates = (value, caret) => {
    const anchor = mentionDraft(mentionAnchor(value, caret), pickedNames);
    setMention(anchor ? { anchor } : null);
    const token = ++requestRef.current;
    if (!anchor || typeof actions?.mentionCandidates !== 'function') { setCandidates([]); return; }
    Promise.resolve()
      .then(() => actions.mentionCandidates(post, anchor.query))
      .then((result) => { if (requestRef.current === token) setCandidates((result?.candidates ?? []).filter((row) => row?.name)); })
      .catch(() => { if (requestRef.current === token) setCandidates([]); });
  };
  const onTextChange = (event) => {
    const value = event.target.value;
    setText(value);
    queryCandidates(value, event.target.selectionStart ?? value.length);
  };
  const pick = (candidate) => {
    if (!mention) return;
    const applied = applyMention(text, mention.anchor, candidate.name);
    setText(applied.text);
    if (applied.caret !== null && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.setSelectionRange(applied.caret, applied.caret);
    }
    setPickedNames((current) => [...current, candidate.name]);
    setPickedDids((current) => current.includes(candidate.did) ? current : [...current, candidate.did]);
    setMention(null);
    setCandidates([]);
  };
  const closeMention = () => { setMention(null); setCandidates([]); };
  return <Stack component="form" spacing={1} sx={{ my: 1 }} onSubmit={(event) => {
    event.preventDefault();
    if (text.trim()) operation.run(() => onSubmit(text.trim(), [...pickedDids]), () => {
      setText(''); setMention(null); setCandidates([]); setPickedNames([]); setPickedDids([]);
    });
  }}>
    <Box ref={fieldRef} sx={{ position: 'relative' }}>
      <TextField
        inputRef={(element) => { inputRef.current = element; }}
        label={label}
        value={text}
        onChange={onTextChange}
        onKeyDown={(event) => { if (event.key === 'Escape' && mention) { event.stopPropagation(); closeMention(); } }}
        multiline minRows={2}
        helperText={offline ? undefined : 'Type @ to mention someone by name.'}
      />
      {mention && candidates.length > 0 && <Popover
        open
        anchorEl={fieldRef.current}
        onClose={closeMention}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        // The roster rides the typing: focus stays in the composer while
        // the list is open (the name being typed is the query).
        disableAutoFocus
        disableEnforceFocus
        slotProps={{ paper: { sx: { maxHeight: 280, minWidth: 220 }, elevation: 3 } }}
      >
        <List dense disablePadding>
          {candidates.map((candidate) => (
            <ListItemButton key={candidate.did} onClick={() => pick(candidate)} sx={{ minHeight: 44 }}>
              <ListItemText primary={candidate.name} />
            </ListItemButton>
          ))}
        </List>
      </Popover>}
    </Box>
    <Button type="submit" variant="contained" disabled={offline || operation.busy || !text.trim()} sx={{ alignSelf: 'flex-start' }}>{operation.busy ? 'Sending…' : 'Send reply'}</Button>
    {operation.error && <Alert severity="error">{operation.error}</Alert>}
  </Stack>;
}

function Reply({ reply, depth, children, onReply, offline, data, post, actions, navigate }) {
  const [editing, setEditing] = useState(false);
  return <Box sx={{ ml: { xs: Math.min(depth, 3) * 1.5, sm: Math.min(depth, 4) * 3 }, pl: 2, py: 1.5, borderLeft: '2px solid', borderColor: 'divider' }}>
    <Typography variant="subtitle2">{reply.author?.name ?? reply.authorName ?? memberName(reply.authorDid, data)} <Typography component="span" variant="caption" color="text.secondary">{dateOf(reply.createdAt)}</Typography></Typography>
    <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{renderReplyBody(reply, data, navigate)}</Typography>
    {depth < 8 && <Button size="small" onClick={() => setEditing(!editing)}>Reply</Button>}
    {editing && <ReplyForm label="Your reply" offline={offline} post={post} actions={actions} onSubmit={(body, mentions) => onReply(body, identityOf(reply), mentions)} />}
    {children}
  </Box>;
}

// Post detail layout (PORCH-041, Brian Oct 14): post left, conversation
// right — the layout of record from the UI Implementation Standard. The two
// columns live inside the 1120px detail container with the 24px gap; below
// 1000px the same container stacks vertically (post first, conversation
// follows) with no horizontal scroll. The conversation column IS the page's
// second half: reactions, the full nested reply thread, mentions, and the
// composer all live in it, so no "open conversation" step exists.
export function PostDetail({ data = {}, actions = {}, navigate, id, routeId }) {
  const selectedId = id ?? routeId;
  const [thread, setThread] = useState(null);
  // One row source for both columns (ac-4): the detail card's bar and the
  // conversation column's bar reflect the same origin conversation rows.
  const [reactionRows, setReactionRows] = useState(null);
  const reactionState = { rows: reactionRows, setRows: setReactionRows };
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    if (!selectedId) { setLoading(false); return undefined; }
    if (data.offline) { setLoading(false); return undefined; }
    let current = true;
    setLoading(true);
    setThread(null);
    setLoadError('');
    Promise.resolve().then(async () => {
      const postResult = await invoke(actions, 'loadPost', selectedId);
      if (!postResult?.post || identityOf(postResult.post) !== String(selectedId)) throw new Error('The family server did not return this post.');
      const commentsResult = await invoke(actions, 'loadComments', postResult.post);
      if (!Array.isArray(commentsResult?.comments)) throw new Error('The family server did not return this conversation.');
      return { id: selectedId, post: postResult.post, comments: commentsResult.comments };
    }).then((result) => { if (current) { setThread(result); setLoading(false); } })
      .catch((error) => { if (current) { setLoadError(messageOf(error)); setLoading(false); } });
    return () => { current = false; };
  }, [selectedId, data.offline, actions.loadPost, actions.loadComments]);
  const saved = data.offline ? rows(data.posts).find((item) => identityOf(item) === String(selectedId)) : null;
  const post = thread?.id === selectedId ? thread.post : saved;
  const comments = thread?.id === selectedId ? thread.comments : [];
  const replies = comments.filter((reply) => (!reply.postId || reply.postId === identityOf(post)) && (!reply.networkId || !originOf(post) || String(reply.networkId) === String(originOf(post))));
  const submit = async (body, parentId, mentions) => {
    const result = await invoke(actions, 'submitReply', post, body, parentId, mentions);
    if (!result?.comment || identityOf(result.comment) === '' || result.comment.postId !== identityOf(post)) throw new Error('The family server did not confirm this reply. Reload the conversation before trying again.');
    setThread((current) => current?.id === selectedId ? { ...current, comments: [...current.comments, result.comment] } : current);
    return result;
  };
  return <Box sx={{ maxWidth: 1120, mx: 'auto' }}>
    <Button onClick={() => navigate?.('/timeline')} sx={{ mb: 2 }}>Back to timeline</Button>
    {loading && !data.offline && <CircularProgress aria-label="Loading conversation" />}
    {loadError && <Alert severity="error">{loadError}</Alert>}
    {data.offline && <Alert severity="warning" sx={{ mb: 2 }}>The conversation cannot refresh while your family server is unreachable. Only a saved post, if available, is shown.</Alert>}
    {!loading && !loadError && (!post || !visibleAtOrigin(post, data)) && <Alert severity="info">This post is not available in your network.</Alert>}
    {post && visibleAtOrigin(post, data) && !loadError && <Box sx={{
      display: 'grid',
      gap: '24px',
      gridTemplateColumns: { xs: 'minmax(0, 1fr)' },
      alignItems: 'start',
      '@media (min-width: 1000px)': { gridTemplateColumns: 'minmax(0, 680fr) minmax(0, 420fr)' },
    }}>
      <PostCard post={post} data={data} actions={actions} navigate={navigate} detail reactionState={reactionState} onHide={() => navigate?.('/timeline')} />
      <Box sx={{ minWidth: 0 }}>
        <PresentReactions post={post} data={data} actions={actions} reactionState={reactionState} />
        <Typography variant="h6" sx={{ mt: 2, mb: 1 }}>Replies</Typography>
        {!data.offline && (replies.length ? <ReplyThread comments={replies} post={post} data={data} actions={actions} navigate={navigate} offline={data.offline} onReply={submit} /> : <Typography color="text.secondary">Be the first to reply.</Typography>)}
        {!data.offline && <ReplyForm label="Write a reply" post={post} actions={actions} onSubmit={(body, mentions) => submit(body, null, mentions)} />}
      </Box>
    </Box>}
  </Box>;
}

function mediaIds(result) {
  const values = Array.isArray(result) ? result : Array.isArray(result?.mediaRefs) ? result.mediaRefs : Array.isArray(result?.media) ? result.media : result?.mediaId || result?._id ? [result] : [];
  return values.map((entry) => typeof entry === 'string' ? entry : entry?.mediaId ?? entry?._id ?? entry?.id).filter(Boolean);
}

export function Compose({ open, onClose, data = {}, actions = {} }) {
  const [type, setType] = useState('text');
  const [body, setBody] = useState('');
  const [caption, setCaption] = useState('');
  const [groupId, setGroupId] = useState('');
  const [files, setFiles] = useState([]);
  const operation = useOperation();
  const reset = () => { setBody(''); setCaption(''); setFiles([]); setGroupId(''); setType('text'); };
  const mediaType = type !== 'text';
  const groups = groupRows(data.groups, data.network?.id);
  return <Dialog open={Boolean(open)} onClose={operation.busy ? undefined : onClose} fullWidth maxWidth="sm" aria-labelledby="compose-title">
    <DialogTitle id="compose-title">Create a post</DialogTitle>
    <Box component="form" onSubmit={(event) => {
      event.preventDefault();
      if (data.offline || (!mediaType && !body.trim()) || (mediaType && !files.length)) return;
      operation.run(async () => {
        let mediaRefs = [];
        if (mediaType) {
          mediaRefs = mediaIds(await invoke(actions, 'upload', files));
          if (mediaRefs.length !== files.length || new Set(mediaRefs).size !== files.length) throw new Error('Could not attach every original. Check your uploads before trying again.');
        }
        const result = await invoke(actions, 'submitPost', { type, body: mediaType ? null : body.trim(), caption: mediaType ? caption.trim() || null : null, mediaRefs, groupId: groupId || null });
        if (!result?.post || !identityOf(result.post)) throw new Error('The family server did not confirm this post. Refresh your timeline before trying again.');
        return result;
      }, () => { reset(); onClose?.(); });
    }}>
      <DialogContent><Stack spacing={2}>
        {data.offline && <Alert severity="warning">Posting is unavailable while your family server is unreachable. Your draft stays here.</Alert>}
        <FormControl fullWidth><InputLabel id="post-type-label">Post type</InputLabel><Select labelId="post-type-label" label="Post type" value={type} onChange={(event) => { setType(event.target.value); setFiles([]); }}><MenuItem value="text">Text</MenuItem><MenuItem value="photo">Photo</MenuItem><MenuItem value="video">Video</MenuItem><MenuItem value="audio">Audio</MenuItem></Select></FormControl>
        {groups.length > 0 && <FormControl fullWidth><InputLabel id="post-group-label">Group (optional)</InputLabel><Select labelId="post-group-label" label="Group (optional)" value={groupId} onChange={(event) => setGroupId(event.target.value)}><MenuItem value="">Entire network</MenuItem>{groups.map((group) => <MenuItem key={identityOf(group)} value={identityOf(group)}>{group.name}</MenuItem>)}</Select></FormControl>}
        {mediaType ? <><Button variant="outlined" component="label">Choose {type}<input hidden type="file" accept={type === 'photo' ? 'image/*' : `${type}/*`} multiple={type === 'photo'} onChange={(event) => { setFiles(Array.from(event.target.files || [])); event.target.value = ''; }} /></Button><Typography variant="body2" color="text.secondary">{files.length ? files.map((file) => file.name).join(', ') : 'Choose an original file to upload before publishing.'}</Typography>
        {type === 'photo' && <ComposerPreviewCarousel files={files} />}
        <TextField label="Caption (optional)" multiline minRows={2} value={caption} onChange={(event) => setCaption(event.target.value)} /></> : <TextField autoFocus label="Your post" multiline minRows={4} value={body} onChange={(event) => setBody(event.target.value)} />}
        {operation.error && <Alert severity="error">{operation.error}</Alert>}
      </Stack></DialogContent>
      <DialogActions><Button disabled={operation.busy} onClick={onClose}>Cancel</Button><Button variant="contained" type="submit" disabled={operation.busy || data.offline || (mediaType ? !files.length : !body.trim())}>{operation.busy ? <CircularProgress size={20} color="inherit" /> : 'Publish'}</Button></DialogActions>
    </Box>
  </Dialog>;
}

export function Albums({ navigate }) {
  return <Box>
    <Heading title="Albums" subtitle="Find moments by their album name" />
    <Alert severity="info">This family server can search album names, but does not provide a direct album browsing or organization action yet. Nothing here has been created or changed.</Alert>
    <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 2 }}>
      <Button variant="contained" onClick={() => navigate?.('/search')}>Search albums</Button>
      <Button variant="outlined" onClick={() => navigate?.('/uploads')}>Upload originals</Button>
    </Stack>
  </Box>;
}

export function Uploads({ data = {}, navigate, actions = {} }) {
  const [files, setFiles] = useState([]);
  const [complete, setComplete] = useState(false);
  const operation = useOperation();
  return <Box>
    <Heading title="Uploads" subtitle="Add original photos, videos, or audio to your family server" />
    <Alert severity="info" sx={{ mb: 2 }}>Uploading stores originals; it does not publish a post or add anything to an album. Create a post to share a moment.</Alert>
    {data.offline && <Alert severity="warning" sx={{ mb: 2 }}>A family server is unreachable. Reconnect before uploading.</Alert>}
    <Stack spacing={2}>
      <Button component="label" variant="outlined" sx={{ alignSelf: 'flex-start' }}>Choose files<input hidden multiple type="file" accept="image/*,video/*,audio/*" onChange={(event) => { setFiles(Array.from(event.target.files || [])); setComplete(false); event.target.value = ''; }} /></Button>
      {files.length > 0 && <Typography>{files.map((file) => file.name).join(', ')}</Typography>}
      <Button variant="contained" disabled={!files.length || operation.busy || data.offline} sx={{ alignSelf: 'flex-start' }} onClick={() => operation.run(() => invoke(actions, 'upload', files), (result) => {
        const ids = mediaIds(result);
        if (ids.length !== files.length || new Set(ids).size !== files.length) throw new Error('The family server did not confirm every original. Check your uploads before trying again.');
        setComplete(true);
        setFiles([]);
      })}>{operation.busy ? 'Uploading…' : 'Upload originals'}</Button>
      {complete && <Alert severity="success">Your family server confirmed the original files. They have not been published as a post.</Alert>}
      {operation.error && <Alert severity="error">{operation.error}</Alert>}
      <Button sx={{ alignSelf: 'flex-start' }} onClick={() => navigate?.('/compose')}>Create a post</Button>
    </Stack>
  </Box>;
}

export function Search({ data = {}, actions = {}, navigate }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);
  const operation = useOperation();
  return <Box>
    <Heading title="Search" subtitle="Find captions, people tags, and album names within your family network" />
    {data.offline && <Alert severity="warning" sx={{ mb: 2 }}>Search needs a reachable family server. Saved moments remain on your timeline.</Alert>}
    <Stack component="form" direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 3 }} onSubmit={(event) => {
      event.preventDefault();
      const text = query.trim();
      if (text && !data.offline) operation.run(() => invoke(actions, 'search', text), (response) => {
        if (!Array.isArray(response?.posts)) throw new Error('The family server did not return search results.');
        setResult({ query: text, posts: response.posts.map((post) => atCurrentOrigin(post, data)) });
      });
    }}>
      <TextField fullWidth label="Search moments" value={query} onChange={(event) => setQuery(event.target.value)} />
      <Button variant="contained" type="submit" disabled={!query.trim() || operation.busy || data.offline}>{operation.busy ? 'Searching…' : 'Search'}</Button>
    </Stack>
    {operation.error && <Alert severity="error" sx={{ mb: 2 }}>{operation.error}</Alert>}
    {result && <><Typography variant="h6" sx={{ mb: 2 }}>Results for “{result.query}”</Typography><Feed posts={result.posts} data={data} actions={actions} navigate={navigate} empty="No moments matched that search at this family server." /></>}
  </Box>;
}
