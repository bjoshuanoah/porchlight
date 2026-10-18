import React, { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import {
  Alert, Avatar, Box, Button, Card, CardContent, Chip, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogTitle, Divider, FormControl, IconButton, InputLabel, List, ListItemButton,
  ListItemText, Menu, MenuItem, Paper, Popover, Popper, Select, Snackbar, Stack, Switch, TextField, Tooltip, Typography,
} from '@mui/material';
// PORCH-095: LanternLoader serves the genuinely empty or blocked surfaces —
// group reads, conversation reads, member-candidate reads, picker chunk
// loads, post submission. The media frame machinery and its stamp fallback
// (below) are untouched content-surface machinery, per the hierarchy rule.
import { LanternLoader } from './lantern.jsx';
import {
  AddReactionOutlined, ArrowDownwardOutlined, ArrowUpwardOutlined, ChevronLeft, ChevronRight,
  FullscreenOutlined, MoreHorizOutlined, MoreVertOutlined, PauseOutlined, PlayArrowOutlined, ReplayOutlined,
  ReplyOutlined, VolumeOffOutlined, VolumeUpOutlined,
} from '@mui/icons-material';
import { MediaOverlay, PhotoViewer } from './photo-viewer.jsx';
import { cssVars } from './theme.js';
import { adaptiveTrackHeight, carouselIndex, photoFirst } from './photo-first.js';
import {
  renditionSrc, renditionSrcset, timelineImageSizes, detailImageSizes,
  playableVideoUrl, posterUrl, rungKindForViewport, stampedAspect, mediaFileName,
} from './media-rung.js';
import { mentionAnchor, mentionDraft, applyMention, mentionSegments } from './mentions.js';
import { mediaBlobKey, readMediaBlob, putMediaBlob } from './media-blob.js';
// PORCH-070: faces (post header, reply rows) ride the one avatar-face code
// path — authorized rung fetch through the identity-keyed blob cache,
// initials stay the metas-less fallback.
import { AvatarFace, useAvatarFaceUrl } from './avatar-face.js';
import { LampMark } from './brand.jsx';
import { reactionRowsOf, ownEmojiRows, reflectReaction, optimisticToggle, reactionChips, revealMachine } from './reactions.js';
import { groupRows, groupMemberRows, canManageGroup, addableCandidates, composableGroups, composePresetLocationId, isGroupMember, groupVisibility, canJoinGroup, blockedRows } from './groups.js';
import {
  groupMenuRows, groupToggleLine, resolvedGroupNotification,
  GROUP_COLOR_ROWS, GROUP_NO_COLOR, GROUP_PRIVACY_ROWS, groupMemberRemoveCopy,
} from './group-settings.js';
import { dateOf, relativeTime } from './time.js';
import { identityOf, originOf, networkId, originName, visibleAtOrigin, postKey, visibleFeedPosts } from './feed-filter.js';
import { sliceDisplay, expanderCount, reconcileConfirmed, reconcileNestedRows, rootAncestorId, repliesByParent, ruledOrder, pendingReply, conversationOf } from './slice.js';
import { LinkPreviewBlock, LinkedBody } from './link-preview.jsx';
import { firstUrlIn, previewOrigin } from './link-preview.js';
import { sharePost } from './share.js';
import {
  canEditPost, canDeletePost, canEditComment, canDeleteComment, lifecycleMenuItems,
  editLocationRows, currentLocationId, GENERAL_LOCATION_ID, removedTreeIds, rowKeyOf,
} from './lifecycle.js';

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

// MediaItem (PORCH-043/044/045 media treatment + PORCH-082): one media
// element with its reserved frame. `index`/`onExpand` wire the overlay's
// expand control to the photo viewer (the expanding slide's position opens
// the viewer mid-sequence). The overlay reveals on hover (pointer devices)
// or tap (touch: photos toggle it, video reveals it alongside the open
// playback panel) and fades with the media chrome (140–220ms easing).
function MediaItem({ id, post, actions, detail = false, slide = false, index = 0, onExpand = null }) {
  // Rendition delivery (PORCH-044): the hydrated payload carries the
  // rendition set of record (mediaMeta, service-side); once the auth-
  // relaying rendition worker is live, media renders straight from
  // content-addressed rendition URLs — img srcset/sizes pick the rung,
  // video renders its poster + playable rendition, and the browser cache
  // answers repeats. The archive path is now the overlay's "↓ Original"
  // control (PORCH-082) and the viewer's original fetch on zoom — never a
  // text utility under the media.
  const meta = post?.mediaMeta?.[id] ?? null;
  const direct = Boolean(meta && actions?.mediaTransport);
  const [resource, setResource] = useState(null);
  const [loadError, setLoadError] = useState('');
  // Boot-window retry (PORCH-044): the first direct render can race the
  // rendition worker's credential relay (a fresh worker install resets its
  // token state). The worker parks and retries; this is the last-line
  // retry if a request still slips through — one remount after the boot
  // window has settled, the content-addressed URL answering from the
  // worker's cache on the second try. Bounded: exactly one retry per media
  // item — a genuinely broken rendition surfaces its error for real.
  const [attempt, setAttempt] = useState(0);
  const retriedRef = useRef(false);
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
    // Feed reads arrive on a cadence (arrival poll, writes, reconnect), so
    // the identity-keyed blob cache (media-blob.js) answers every repeat
    // request: the SAME object URL re-serves — no second network read, no
    // revoke, no media remount (the page-visible reload churn).
    const kind = meta ? rungKindForViewport(meta, window.innerWidth, window.devicePixelRatio) : 'original';
    const version = kind ? (meta?.renditions?.find((rung) => rung.kind === kind)?.sha256 ?? null) : null;
    const identity = mediaBlobKey({ origin, mediaId: id, kind: kind ?? 'original', version });
    const posterSha = post.type === 'video' ? (meta?.poster?.sha256 ?? null) : null;
    const posterIdentity = posterSha ? mediaBlobKey({ origin, mediaId: id, kind: 'poster', version: posterSha }) : null;
    const cached = readMediaBlob(identity);
    if (cached) {
      setResource({
        blob: cached.blob,
        url: cached.url,
        posterUrl: posterIdentity ? (readMediaBlob(posterIdentity)?.url ?? null) : null,
        ...(cached.shape ?? {}),
      });
      return undefined;
    }
    let active = true;
    setResource(null);
    setLoadError('');
    const posterPromise = posterIdentity ? getMedia(id, 'poster', origin, posterSha).catch(() => null) : null;
    Promise.resolve().then(() => {
      if (typeof getMedia !== 'function') throw new Error('Media is not available here yet.');
      const bytesPromise = getMedia(id, kind ?? 'original', origin, version);
      return Promise.all([bytesPromise, posterPromise]);
    }).then(async ([blob, posterBlob]) => {
      if (!(blob instanceof Blob)) throw new Error('Your hub did not return the media.');
      if (!active) return;
      // PORCH-043 ac-7 decode-before-paint carries: the blob path resolves
      // the shape before the first paint, and the stamped reserved frame
      // (or, legacy, the decoded intrinsic box) is the only waiting
      // surface — a still frame, never a moving placeholder (PORCH-049 ac-2).
      const shape = (meta && meta.width) ? { width: meta.width, height: meta.height } : await mediaShape(blob, post.type);
      const url = URL.createObjectURL(blob);
      const posterUrlObj = posterBlob instanceof Blob ? URL.createObjectURL(posterBlob) : null;
      const row = putMediaBlob(identity, { url, blob, shape });
      if (posterIdentity && posterUrlObj) putMediaBlob(posterIdentity, { url: posterUrlObj, blob: posterBlob });
      setResource({ blob, url: row.url, posterUrl: posterUrlObj ?? null, ...shape });
    }).catch((error) => { if (active) setLoadError(messageOf(error)); });
    return () => { active = false; };
  }, [id, getMedia, origin, direct]);
  // Timeline media treatment (PORCH-043): natural aspect ratio governs; the
  // 85vh object-fit-contain cap is the single exception for extreme images.
  // Media escapes the text rail — edge-to-edge against the viewport on
  // mobile (the post container is already full-width) and against the card
  // interior on desktop (margin: 0 calc(var(--post-pad) * -1)); media never
  // nests inside another padded media frame (PORCH-043 ac-1, ac-6). In the
  // PORCH-045 carousel the slide mode omits the breakout: the track owns it
  // once for every slide, so a slide is exactly the media width and the
  // media rules can never double-apply. The element background is the
  // reserved frame's warm wash (PORCH-049 ac-2): bytes that have not
  // arrived yet show the wash, not a hole.
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
    bgcolor: photoFirst.mediaWash,
  } : {
    display: 'block',
    width: media || post.type === 'audio' ? '100%' : undefined,
    maxHeight: detail ? 720 : undefined,
    borderRadius: detail ? 2 : slide ? 0 : undefined,
    bgcolor: media ? photoFirst.mediaWash : 'background.default',
  };
  // Reserved frame (PORCH-049 ac-2): the stamped geometry — aspect first,
  // dims' ratio as the pre-PORCH-049 fallback — puts the exact final box in
  // place from the first paint, so the element occupies identical geometry
  // before and after load and bytes landing can never reflow the feed. A
  // decoded fallback shape (blob loader) wins once present. Legacy payloads
  // without any stamp state no box: media renders intrinsic sizing on load
  // (decode-before-paint keeps that path corruption-free, PORCH-043 ac-7).
  const reserved = resource?.width && resource?.height ? resource.width / resource.height : stampedAspect(meta);
  const fitSx = media && reserved
    ? { aspectRatio: `${reserved}`, maxHeight: detail ? 720 : photoFirst.extremeCap, objectFit: 'contain' }
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
  // Family-video playback posture (PORCH-049 ac-3, plus the Brian Oct 10
  // user-testing turn): the poster fills the reserved frame and playback
  // begins inline with the sound off — NO panel and no sound exist before
  // the first tap on the media frame. That first tap is the door: sound
  // arrives (the muted element property, not the attribute — autoplay only
  // honors the property) and the playback panel opens with it. After it,
  // the frame tap pauses/resumes and the panel owns mute, restart, and
  // fullscreen. Third-party link-preview embeds keep their own tap-to-play
  // rule under the Link Previews pair; they render nowhere here.
  const [soundOn, setSoundOn] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [playing, setPlaying] = useState(true);
  const videoRef = useRef(null);
  // ac-1 reveal: hover on pointer devices drives it (the CSS-hover path on
  // the media bounds); on touch, a photo tap toggles it and a video's
  // playback-panel tap reveals it. Touch-only detection keeps a desktop
  // click from toggling the chrome its hover already shows.
  const [overlayShown, setOverlayShown] = useState(false);
  // Touch-only detection without a mode read: a fine-pointer click never
  // toggles the chrome its hover already shows.
  const tapTogglesOverlay = typeof navigator === 'object' && navigator.maxTouchPoints > 0;
  const togglePlayback = (element) => {
    if (!element) return;
    if (element.paused) {
      const resume = element.play();
      if (resume?.catch) resume.catch(() => {});
    } else element.pause();
  };
  const tapVideo = (event) => {
    if (!panelOpen) {
      setPanelOpen(true);
      setOverlayShown(true);
      event.currentTarget.muted = false;
      setSoundOn(true);
      return;
    }
    togglePlayback(event.currentTarget);
  };
  // The muted property is re-asserted on every metadata load: React's muted
  // attribute handling does not always survive element remount (the
  // boot-window retry remounts keyed by attempt), and autoplay requires it
  // until the member's first tap.
  const syncMuted = (event) => {
    if (event.currentTarget) event.currentTarget.muted = !soundOn;
    if (!meta.width && event.target) setResource({ width: event.target.videoWidth, height: event.target.videoHeight });
  };
  // Playback panel handlers (Brian, 10/10: pause, restart, un/mute, and
  // full screen built in). Mute rides the element property like the first
  // tap; restart replays from the top; fullscreen takes the standard
  // element API with the iOS webkit fallback (iOS Safari exposes no
  // element requestFullscreen for video).
  const toggleMute = () => {
    const element = videoRef.current;
    if (!element) return;
    element.muted = soundOn;
    setSoundOn(!soundOn);
  };
  const restartVideo = () => {
    const element = videoRef.current;
    if (!element) return;
    element.currentTime = 0;
    togglePlayback(element);
  };
  const fullscreenVideo = () => {
    const element = videoRef.current;
    if (!element) return;
    if (typeof element.requestFullscreen === 'function') element.requestFullscreen().catch(() => {});
    else if (typeof element.webkitEnterFullscreen === 'function') element.webkitEnterFullscreen();
  };
  const watchPlayback = (event) => setPlaying(event.type === 'play');
  // Sharing on media (Brian, 10/10: "sharing should be built in") rides the
  // ··· overflow menu's Share entry (PORCH-078) since the PORCH-082
  // retirement: the per-image download-and-share text link is gone, and the
  // media top-right overlay carries exactly original download and expand
  // (PORCH-082 build contract; the ··· menus keep Share).

  // Rendition elements remount once for the boot-window retry: key=attempt
  // re-issues the same content-addressed request after the window settles.
  const directImg = post.type === 'photo' && direct;
  const directVideo = post.type === 'video' && direct;
  // The playback panel (post-first-tap chrome): a compact paper chip riding
  // the frame's bottom edge — the carousel's arrow treatment — so palette
  // tokens only, no literals (Display Modes token contract). The overlay
  // passes taps through (pointerEvents none; the chip takes its own), so
  // the frame stays the tap surface for pause/resume.
  const playbackPanel = panelOpen && <Box aria-label="Playback panel"
    sx={{ position: 'absolute', inset: 0, pointerEvents: 'none', display: 'flex', alignItems: 'flex-end', p: 1 }}>
    <Stack direction="row" spacing={0.25} sx={{ pointerEvents: 'auto', bgcolor: 'background.paper',
      borderRadius: 9999, border: '1px solid', borderColor: 'divider', px: 0.5, py: 0.25, boxShadow: 2 }}>
      <IconButton aria-label={playing ? 'Pause' : 'Play'} size="small" onClick={() => togglePlayback(videoRef.current)}>
        {playing ? <PauseOutlined fontSize="small" /> : <PlayArrowOutlined fontSize="small" />}
      </IconButton>
      <IconButton aria-label="Restart" size="small" onClick={restartVideo}><ReplayOutlined fontSize="small" /></IconButton>
      <IconButton aria-label={soundOn ? 'Mute' : 'Unmute'} size="small" onClick={toggleMute}>
        {soundOn ? <VolumeUpOutlined fontSize="small" /> : <VolumeOffOutlined fontSize="small" />}
      </IconButton>
      <IconButton aria-label="Full screen" size="small" onClick={fullscreenVideo}><FullscreenOutlined fontSize="small" /></IconButton>
    </Stack>
  </Box>;
  useEffect(() => {
    if ((!directImg && !directVideo) || retriedRef.current) return undefined;
    if (!loadError) return undefined;
    retriedRef.current = true;
    const timer = setTimeout(() => { setLoadError(''); setAttempt((n) => n + 1); }, 1200);
    return () => clearTimeout(timer);
  }, [loadError, directImg, directVideo]);
  return <Box
    onMouseEnter={() => setOverlayShown(true)}
    onMouseLeave={() => setOverlayShown(false)}
    sx={{ position: post.type === 'photo' || post.type === 'video' ? 'relative' : undefined }}>
    {directImg && <Box key={`img-${attempt}`} component="img"
      src={renditionSrc(meta, origin) ?? playableVideoUrl(meta, origin)}
      srcSet={renditionSrcset(meta, origin) || undefined}
      sizes={detail ? detailImageSizes(meta) : timelineImageSizes()}
      alt={post.caption || 'Shared photo'} loading="lazy" decoding="async"
      onClick={(event) => { if (tapTogglesOverlay) setOverlayShown((shown) => !shown); event.stopPropagation(); }}
      onError={() => setLoadError('Your hub did not return the media.')}
      sx={{ ...mediaSx, ...fitSx }} />}
    {post.type === 'photo' && !direct && resource && <Box component="img" src={resource.url} alt={post.caption || 'Shared photo'} loading="lazy"
      onClick={(event) => { if (tapTogglesOverlay) setOverlayShown((shown) => !shown); event.stopPropagation(); }}
      sx={{ ...mediaSx, ...fitSx }} />}
    {directVideo && <Box key={`vid-${attempt}`} sx={{ position: 'relative', ...mediaSx, ...fitSx }}>
      <Box component="video" src={videoPlayable} poster={videoPoster}
        autoPlay muted playsInline preload="metadata" onClick={tapVideo}
        ref={(el) => { videoRef.current = el; if (el) el.muted = true; }}
        onLoadedMetadata={syncMuted} onPlay={watchPlayback} onPause={watchPlayback}
        onError={() => setLoadError('Your hub did not return the media.')}
        sx={{ display: 'block', width: '100%', cursor: 'pointer' }} />
      {playbackPanel}
    </Box>}
    {post.type === 'video' && !direct && resource && <Box sx={{ position: 'relative', ...mediaSx, ...fitSx }}>
      <Box component="video" src={resource.url} poster={resource.posterUrl ?? undefined}
        autoPlay muted playsInline onClick={tapVideo}
        ref={(el) => { videoRef.current = el; if (el) el.muted = true; }}
        onLoadedMetadata={syncMuted} onPlay={watchPlayback} onPause={watchPlayback}
        onError={() => setLoadError('Your hub did not return the media.')}
        sx={{ display: 'block', width: '100%', cursor: 'pointer' }} />
      {playbackPanel}
    </Box>}
    {post.type === 'audio' && <Box component="audio" src={resource?.url} controls preload="none" sx={{ width: '100%' }} />}
    {!resource && !direct && post.type !== 'audio' && !loadError && (reserved)
      ? <Box role="status" aria-label="Loading media" sx={{ ...mediaSx, ...fitSx }} />
      : !resource && !direct && post.type !== 'audio' && !loadError && <CircularProgress size={20} aria-label="Loading media" sx={slideRailSx} />}
    {loadError && <Alert severity="error" sx={slideRailSx}>{loadError}</Alert>}
    {operation.error && <Alert severity="error" sx={slideRailSx}>{operation.error}</Alert>}
    {(post.type === 'photo' || post.type === 'video') && (directImg || directVideo || resource)
      ? <MediaOverlay shown={overlayShown} downloadBusy={operation.busy}
        onDownload={() => operation.run(async () => {
          const blob = resource?.blob ?? await invoke(actions, 'getMedia', id, 'original', origin);
          if (!(blob instanceof Blob)) throw new Error('Your hub did not return the original.');
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = mediaFileName(id, blob);
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        })}
        onExpand={post.type === 'photo' && onExpand ? () => onExpand(index) : undefined} />
      : null}
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
  // The visible window adopts the active slide's height (useAdaptiveTrackHeight):
  // neighboring slides keep their natural height and are clipped here, never
  // cropped — vertical panning stays chained to the page because the track
  // has no scrollable vertical overflow.
  overflowY: 'hidden',
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

// PORCH-045 (Brian, Oct 10, 2026 user-testing note, "as the swiping happens
// that the page slides into the right size as different aspect ratios are
// loaded per image"): the active slide owns the visible height. The track's
// height interpolates between the bounding slides' heights from the scroll
// fraction (adaptiveTrackHeight), so it follows the finger through the swipe;
// a ResizeObserver re-measures whenever a slide's box changes because its
// real aspect ratio resolved on load (legacy media without stamped
// geometry). Slides stay top-aligned at their natural photo-first heights:
// only the window height adapts, so nothing is cropped.
function useAdaptiveTrackHeight(trackRef, count) {
  const [adaptiveHeight, setAdaptiveHeight] = useState(null);
  const measure = useCallback(() => {
    const track = trackRef.current;
    if (!track || count < 2 || !(track.clientWidth > 0)) return;
    const heights = Array.from(track.children, (slide) => slide.getBoundingClientRect().height);
    setAdaptiveHeight(adaptiveTrackHeight(heights, track.scrollLeft / track.clientWidth));
  }, [trackRef, count]);
  // Layout effect: the first height lands before paint, so the track never
  // opens at the tallest slide's height and then jumps.
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track || count < 2) return undefined;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    Array.from(track.children).forEach((slide) => observer.observe(slide));
    return () => observer.disconnect();
  }, [trackRef, count, measure]);
  return [adaptiveHeight, measure];
}

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
// PORCH-082: the per-slide overlay's expand control opens the full-screen
// viewer at that slide's position — the expanding slide owns the entry
// index, so the viewer opens exactly where the member is looking.
function MediaCarousel({ ids, post, actions, detail = false, onExpand = null }) {
  const trackRef = useRef(null);
  const [position, setPosition] = useState(0);
  const count = ids.length;
  const [adaptiveHeight, measure] = useAdaptiveTrackHeight(trackRef, count);
  const slideBy = (step) => {
    const track = trackRef.current;
    if (!track) return;
    const next = Math.min(count - 1, Math.max(0, carouselIndex(track.scrollLeft, track.clientWidth, count) + step));
    track.scrollTo({ left: next * track.clientWidth, behavior: 'smooth' });
  };
  return <Box sx={{ mt: detail ? 2 : photoFirst.spacing.captionMedia / 8 }}>
    <Box sx={{ position: 'relative', ...(!detail ? carouselBreakoutSx : {}) }}>
      <Box ref={trackRef} onScroll={(event) => {
        const target = event.currentTarget;
        setPosition(carouselIndex(target.scrollLeft, target.clientWidth, count));
        measure();
      }} style={adaptiveHeight != null ? { height: adaptiveHeight } : undefined} sx={carouselTrackSx}>
        {ids.map((id, index) => (
          <Box key={`${id}-${index}`} aria-roledescription="slide" aria-label={`Image ${index + 1} of ${count}`} sx={carouselSlideSx}>
            <MediaItem id={id} post={post} actions={actions} detail={detail} slide index={index} onExpand={onExpand} />
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
  const count = urls.length;
  const [adaptiveHeight, measure] = useAdaptiveTrackHeight(trackRef, count);
  useEffect(() => {
    const created = (files ?? []).map((file) => URL.createObjectURL(file));
    setUrls(created);
    return () => created.forEach((url) => URL.revokeObjectURL(url));
  }, [files]);
  const slideBy = (step) => {
    const track = trackRef.current;
    if (!track) return;
    const next = Math.min(count - 1, Math.max(0, carouselIndex(track.scrollLeft, track.clientWidth, count) + step));
    track.scrollTo({ left: next * track.clientWidth, behavior: 'smooth' });
  };
  if (!count) return null;
  return <Box sx={{ mt: 1, borderRadius: '10px', overflow: 'hidden' }}>
    <Box sx={{ position: 'relative', borderRadius: '10px' }}>
      <Box ref={trackRef} onScroll={(event) => {
        const target = event.currentTarget;
        setPosition(carouselIndex(target.scrollLeft, target.clientWidth, count));
        measure();
      }} style={adaptiveHeight != null ? { height: adaptiveHeight } : undefined} sx={carouselTrackSx}>
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

// PORCH-082: the post's photo set is the viewer's sequence of record (the
// mediaRefs order); the viewer mounts from here so the carousel's and the
// detail card's overlays share one expand entry point. The viewer is an
// overlay, so closing it returns to the surface exactly as the member left
// it: the carousel keeps its scroll position and the page its scroll
// (nothing under the overlay moves).
function Media({ post, actions, detail = false }) {
  const media = Array.isArray(post?.mediaRefs) ? post.mediaRefs : [];
  const ids = media.map((entry) => typeof entry === 'string' ? entry : entry?.mediaId ?? entry?._id ?? entry?.id).filter(Boolean);
  const [viewerIndex, setViewerIndex] = useState(null);
  const photoView = post.type === 'photo' && ids.length > 0 && viewerIndex != null;
  const onExpand = post.type === 'photo' && ids.length > 0
    ? (index) => setViewerIndex(Math.min(Math.max(index, 0), ids.length - 1))
    : null;
  if (!ids.length) return null;
  // PORCH-045: multi-image posts render as a single swipeable carousel on
  // every breakpoint (Brian, Oct 14, 2026) — the Oct 9 grid treatments and
  // the +3 overlay are superseded and render nowhere. Video stays out of
  // the carousel until asked for, so every other shape keeps the plain
  // multi-item stack.
  const surface = ids.length > 1 && post.type === 'photo'
    ? <MediaCarousel ids={ids} post={post} actions={actions} detail={detail} onExpand={onExpand} />
    : <Stack spacing={0} sx={{ mt: detail ? 2 : photoFirst.spacing.captionMedia / 8 }}>
      {ids.map((id, index) => (
        <MediaItem key={`${id}-${index}`} id={id} post={post} actions={actions} detail={detail} index={index} onExpand={onExpand} />
      ))}
    </Stack>;
  return <>
    {surface}
    {photoView && <PhotoViewer post={post} ids={ids} actions={actions} startIndex={viewerIndex} onClose={() => setViewerIndex(null)} />}
  </>;
}

// The glance popover's one content view (PORCH-090): faces beside family
// display names, the member's own row marked — the served reactor rows in
// the server's order (never a client-guessed roster, never an inspection
// panel, never an engagement surface: names, faces, nothing else). A row the
// hub could not attribute yet (a live arrival served content-only) renders
// the plain member fallback the directory renders, until the next attributed
// read replaces it in place.
export function ReactionReveal({ chip, ownDid, data, post, actions }) {
  return <Stack role="list" aria-label={`Who reacted with ${chip.emoji}`} spacing={0.75} sx={{ minWidth: 150, maxWidth: 260 }}>
    {chip.reactors.map((row) => {
      const isOwn = Boolean(ownDid) && String(row.memberDid ?? '') === ownDid;
      const name = isOwn
        ? (data.identity?.name || 'You')
        : (row.memberName ?? memberName(row.memberDid, data));
      if (!(row.memberDid ?? row._id ?? name)) return null;
      return <Stack key={String(row.memberDid ?? row._id ?? name)} role="listitem" direction="row" spacing={1} alignItems="center" data-testid="reaction-reveal-row">
        <AvatarFace origin={post?.origin ?? originOf(post)} did={row.memberDid ?? null} metas={row.memberAvatar ?? null} kind="header"
          load={actions?.loadAvatarRendition} sx={{ width: 24, height: 24, fontSize: 11 }}>
          {(name || 'Member').trim().charAt(0).toUpperCase()}
        </AvatarFace>
        <Typography variant="caption" color="text.primary" fontWeight={isOwn ? 600 : 400} sx={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {name}{isOwn ? ' (you)' : ''}
        </Typography>
      </Stack>;
    })}
  </Stack>;
}

// Reaction bar (PORCH-036): a visual emoji picker opens from the small
// add-reaction smile control — no step ever asks the member to type, paste,
// or know an emoji string. Only the emoji actually present render, as given;
// per-member rows identify the member's own reaction for the warm highlight
// exclusively. Tapping an emoji the member already reacted with clears it
// and tapping any other adds it: change or clear, never an error (ac-2,
// ac-3). The row reflection lives in the shared reactions module, so the
// timeline card and the post detail reflect the same origin conversation
// through one routine (PORCH-038). Amended PORCH-090 (Brian, Oct 15, 2026 —
// this ruling supersedes the Oct 8 no-counts/no-inspection line for reaction
// chips only): every rendered chip is now a live toggle (click joins,
// clicking again leaves only the member's own row), the PEOPLE count derives
// at render where more than one member holds the emoji, and hover
// (desktop) / long-press (touch) reveals that emoji's reactors — the vote
// surfaces carry nothing new and expander/media quantities stay separate
// rules.
export function PresentReactions({ post, data, actions, reactionState, spacingY = 2, actionBar = null }) {
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
  // Who-reacted reveal (PORCH-090): a rendered chip is a live toggle AND a
  // glance reveal. ONE non-modal Popper per bar, anchored to the chip — a
  // modal Popover's backdrop would force-exit the covered chip and fight
  // the pointer (oscillation), so dismissal rides the machine's grace, the
  // paper's own leave, Escape, and the outside pointerdown below. Rows never
  // change through any reveal path: only chipClick toggles.
  const [reveal, setReveal] = useState(null);
  const paperRef = useRef(null);
  const machineRef = useRef(null);
  if (!machineRef.current) {
    machineRef.current = revealMachine({
      open: ({ emoji, anchor }) => setReveal({ emoji, anchor }),
      close: () => setReveal(null),
      overPopover: () => Boolean(paperRef.current?.matches(':hover')),
    });
  }
  const machine = machineRef.current;
  const closeReveal = () => { machine.silence(); setReveal(null); };
  const chips = reactionChips(rows ?? []);
  const revealChip = reveal ? chips.find((chip) => chip.emoji === reveal.emoji) ?? null : null;
  // Focus-gate (PORCH-090, riding PORCH-035): no per-screen focus styling
  // exists anywhere (the theme layer owns every ring), so keyboard-vs-pointer
  // is decided by the pointer's recency — a chip focused by a tap or click
  // (within the intent window) never opens the reveal; only focus with no
  // fresh pointer (Tab) does. The toggle itself stays the click.
  const lastPointerRef = useRef(0);
  // The reveal lists rows; if the emoji's rows emptied (every reactor left),
  // the chip is gone and the popover has nothing to answer.
  useEffect(() => {
    if (reveal && !revealChip) closeReveal();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rides the open reveal's chip presence
  }, [Boolean(reveal), revealChip]);
  // Escape and the outside pointerdown close the glance reveal only — they
  // never mutate the chip (a closed reveal leaves every row exactly as it
  // was). Re-armed per open reveal; the chip and paper contain their taps.
  useEffect(() => {
    if (!reveal) return undefined;
    const onEscape = (event) => { if (event.key === 'Escape') closeReveal(); };
    const onOutside = (event) => {
      if (reveal.anchor && reveal.anchor.contains(event.target)) return;
      if (paperRef.current && paperRef.current.contains(event.target)) return;
      closeReveal();
    };
    document.addEventListener('keydown', onEscape);
    document.addEventListener('pointerdown', onOutside, true);
    return () => {
      document.removeEventListener('keydown', onEscape);
      document.removeEventListener('pointerdown', onOutside, true);
    };
  }, [Boolean(reveal), reveal?.emoji, reveal?.anchor]);
  // The machine's in-flight windows die with the bar (timers firing after
  // unmount would touch state a member left behind).
  useEffect(() => () => machine.silence(), [machine]);
  const chipClick = (chip) => {
    // A consumed long-press release (the machine says no) is the reveal
    // never toggling (ac-3); anything else is the plain tap toggle (ac-1).
    if (!machine.click()) return;
    toggle(chip.emoji, own.has(chip.emoji));
  };
  const chipList = chips.map((chip) => {
    const ownEmoji = own.has(chip.emoji);
    const peopleCount = chip.reactors.length;
    return <Chip key={chip.emoji} size="small" component="button" type="button"
      label={<>{chip.emoji}{peopleCount > 1 && <Box component="span" sx={{ ml: 0.25, fontSize: 13, fontWeight: 600, lineHeight: 1, color: 'inherit' }}>{peopleCount}</Box>}</>}
      aria-pressed={ownEmoji}
      aria-label={peopleCount > 1 ? `Reaction ${chip.emoji}, ${peopleCount} people` : ownEmoji ? `Your reaction ${chip.emoji}` : `Reaction ${chip.emoji}`}
      aria-haspopup="dialog"
      onClick={() => chipClick(chip)}
      onPointerEnter={(event) => machine.hoverStart(chip.emoji, event.currentTarget, event)}
      onPointerLeave={(event) => { if (event.pointerType === 'mouse') machine.hoverLeave(); }}
      onTouchStart={(event) => machine.pressStart(chip.emoji, event.currentTarget, event)}
      onTouchEnd={() => machine.pressEnd()}
      onTouchCancel={() => machine.pressEnd()}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={() => { lastPointerRef.current = Date.now(); }}
      onFocus={(event) => { if (Date.now() - lastPointerRef.current > 300) machine.hoverStart(chip.emoji, event.currentTarget, undefined); }}
      onBlur={closeReveal}
      sx={{
        minHeight: 40, minWidth: 40, fontSize: 20, cursor: 'pointer',
        userSelect: 'none', WebkitTouchCallout: 'none',
        ...(ownEmoji ? { bgcolor: 'porchlight.amberSoft', border: '1px solid', borderColor: 'porchlight.amber', color: 'text.primary' } : {}),
      }} />;
  });
  return <>
    <Stack direction="row" spacing={actionBar ? 0 : 1} alignItems="center" flexWrap="wrap"
      sx={{ mt: spacingY, ...(actionBar ? { justifyContent: 'flex-start', gap: '8px' } : {}) }}
      aria-label={actionBar ? 'Post actions' : 'Reactions from your family'}>
      {actionBar}
      {!actionBar && chipList}
      <Tooltip title="React"><span><IconButton aria-label={actionBar ? 'React' : 'Add a reaction'}
        aria-haspopup="dialog" disabled={operation.busy || Boolean(data?.offline)}
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={actionBar ? { width: 36, height: 36, p: 0, '&::after': { content: '""', position: 'absolute', inset: -4 } } : { width: 40, height: 40, border: `1px dashed ${cssVars.borderStrong}` }}>
        <AddReactionOutlined fontSize="small" />
      </IconButton></span></Tooltip>
    </Stack>
    {actionBar && chipList.length > 0 && <Stack direction="row" spacing={1} flexWrap="wrap"
      aria-label="Reactions from your family" sx={{ mt: photoFirst.spacing.actionsReactions / 8 }}>{chipList}</Stack>}
    {anchor && <Suspense fallback={<LanternLoader size={20} label="Your reaction picker" />}>
      <EmojiPicker open anchorEl={anchor} onClose={() => setAnchor(null)} own={own} onToggle={toggle} busy={operation.busy} />
    </Suspense>}
    {reveal && revealChip && <Popper open placement="bottom" anchorEl={reveal.anchor}
      modifiers={[{ name: 'offset', options: { offset: [0, 6] } }]} sx={{ zIndex: 1300 }}>
      <Paper elevation={0} ref={paperRef}
        onPointerEnter={() => machine.paperEnter()}
        onPointerLeave={(event) => { if (event.pointerType === 'mouse') closeReveal(); }}
        sx={{ p: 1, px: 1.25, borderRadius: '12px', border: `1px solid ${cssVars.border}`, boxShadow: cssVars.shadowModal, cursor: 'default' }}>
        <ReactionReveal chip={revealChip} ownDid={ownDid} data={data} post={post} actions={actions} />
      </Paper>
    </Popper>}
    {operation.error && <Typography variant="caption" color="error" sx={{ width: '100%' }}>{operation.error}</Typography>}
  </>;
}

export function PostCard({ post, data, actions, navigate, detail = false, onHide, reactionState, groupMenu = null }) {
  const [localHidden, setLocalHidden] = useState(false);
  // Card-level reply (PORCH-038 ac-1): the affordance opens an inline
  // composer riding the same mention handling as the detail composer; the
  // member never navigates to post detail to answer.
  // PORCH-084 (ac-3): no composer renders by default; the Reply action —
  // on the post or on a comment — opens exactly one composer per card at a
  // time. Switching targets closes the open composer in the same render
  // frame, and each target holds its own draft so a displaced draft is
  // never silently lost while the member re-points the composer.
  const [composerFor, setComposerFor] = useState(null); // null | 'post' | comment id
  const [drafts] = useState(() => new Map());
  // One composer per surface (PORCH-094): opening a reply closes any open
  // edit composer in the same frame — and the edit opens close any open
  // reply composer in theirs.
  const openComposer = (target) => { setEditFor(null); setComposerFor(target); };
  const holdDraft = (target, text) => {
    if (text) drafts.set(target, text); else drafts.delete(target);
  };
  // A held draft reads back as the held value; an absent draft reads
  // undefined so every consumer's `?? the-current-content` fallback engages
  // (the edit composer pre-fills from the post exactly as it stands —
  // Brian's user-testing fix, Oct 16, 2026). A draft is never held empty:
  // holdDraft deletes on an empty value.
  const readDraft = (target) => drafts.get(target);
  const operation = useOperation();
  // Conversation slice state (PORCH-046): pending replies (write in flight,
  // rolled back on failure) and acknowledged replies (write confirmed, next
  // read pending) render through sliceDisplay with the server's slice.
  const [localConversation, setLocalConversation] = useState(() => ({ pending: [], confirmed: [] }));
  const replyCountRef = useRef(0);
  const [menuAnchor, setMenuAnchor] = useState(null);
  // Lifecycle affordances (PORCH-094): the ··· menu carries Edit and Delete
  // authority-gated; the confirming member's tombstone drops the card in
  // the same frame, and the comment rows' own overflow carries their
  // lifecycle actions.
  const [tombstoned, setTombstoned] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editFor, setEditFor] = useState(null); // null | 'post'
  const [commentDelete, setCommentDelete] = useState(null); // the comment row awaiting its one confirmation
  // The member's own removed comment rows (and their rendered subtrees):
  // the row leaves the slice live; a failed write removes the id and the
  // exact pre-action rows return.
  const [removedIds, setRemovedIds] = useState(() => new Set());
  // The member's own applied edit fields: the optimistic river merge
  // re-renders the timeline row in place, and this local view override
  // keeps the detail surface's freshly loaded post object rendering the
  // same applied fields (the reload reconciles both).
  const [editedFields, setEditedFields] = useState(null);
  // The view override retires the moment the served row carries the applied
  // fields (the post-confirm reload): the card renders from one source of
  // truth again.
  useEffect(() => {
    if (!editedFields) return undefined;
    if ((post.body ?? null) === (editedFields.body ?? null)
      && (post.caption ?? null) === (editedFields.caption ?? null)
      && String(post.groupId ?? '') === String(editedFields.groupId ?? '')) {
      setEditedFields(null);
    }
    return undefined;
  }, [editedFields, post.body, post.caption, post.groupId]);
  // Remove post (PORCH-089 ac-3): the owner's entry on a group post carries
  // Remove — the group's managing member (or the network owner) — from the
  // group surface's card or the detail card alike. The confirmation names
  // the consequence; cancel mutates nothing.
  const [removeOpen, setRemoveOpen] = useState(false);
  // Share (PORCH-078): the detail surface's share entry reports only the
  // copy-fallback outcome inline — the native dialog reports itself.
  const [shareNote, setShareNote] = useState('');
  const [shareError, setShareError] = useState('');
  // The fallback outcome's immediate, in-view report (PORCH-078): the menu
  // item's copy confirmation rides a Snackbar — visible wherever the member
  // is on the page, never only at the card's foot below the fold.
  const [shareSnackbar, setShareSnackbar] = useState('');
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
  if (localHidden || tombstoned || actions?.isHidden?.(post) || !visibleAtOrigin(post, data)) return null;
  // The applied edit's view override (PORCH-094 ac-2): body, caption, and
  // the location context render from the applied fields until the next
  // served read carries them — no full-card remount, and no stale chip or
  // stale text outlives the reload's reconciliation.
  const row = editedFields
    ? {
      ...post,
      ...(editedFields.body !== undefined ? { body: editedFields.body } : {}),
      ...(editedFields.caption !== undefined ? { caption: editedFields.caption } : {}),
      ...(editedFields.groupId !== undefined ? { groupId: editedFields.groupId, groupName: editedFields.groupName ?? null } : {}),
    }
    : post;
  // Remove post (ac-3): the entry renders only on a group post whose group
  // this viewer manages — the client predicate shapes the menu; the hub
  // re-checks the authority on the write (refusal copies plain language).
  const removesPostGroup = Boolean(post?.groupId)
    && (data?.groups ?? []).some((item) => identityOf(item) === String(post.groupId) && canManageGroup(item, data));
  const openPost = () => navigate?.(`/posts/${encodeURIComponent(identityOf(post))}`);
  // Share (PORCH-078): one handler serves both ··· menus — the timeline card
  // and the detail card. The native dialog (navigator.share) carries the
  // post's canonical deep link (the existing post detail route; the share
  // text carries author and photo count only); the copy fallback reports its
  // outcome with an immediate, in-view Snackbar — the menu was the member's
  // last touchpoint, so the confirmation must be visible where they are
  // looking, not only at the card's foot below the fold.
  const runShare = () => {
    setMenuAnchor(null);
    setShareNote('');
    setShareError('');
    sharePost({
      post,
      ownDid: data.identity ? String(data.identity.id) : null,
      data,
      base: typeof window !== 'undefined' ? window.location.origin : '',
    }).then((result) => {
      if (result.mode === 'copy') {
        if (result.copied) { setShareNote('Link copied.'); setShareSnackbar('Link copied.'); }
        else {
          setShareError('Your browser does not offer sharing or copying here yet. Open the post and copy its link from the address bar.');
          setShareSnackbar('Your browser does not offer sharing or copying here yet.');
        }
      }
    }).catch(() => { setShareError('The share did not go through. Try again.'); setShareSnackbar('The share did not go through. Try again.'); });
  };
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
    if (!parentId) setLocalConversation((current) => ({ ...current, pending: [...current.pending, optimisticRow] }));
    const revert = () => setLocalConversation((current) => ({ ...current, pending: current.pending.filter((row) => row._id !== localId) }));
    return Promise.resolve()
      .then(() => invoke(actions, 'submitReply', post, body, parentId, mentions))
      .then((result) => {
        if (!result?.comment || !identityOf(result.comment)) {
          revert();
          throw new Error('The family server did not confirm this reply. Reload the conversation before trying again.');
        }
        if (!parentId) setLocalConversation((current) => ({
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
  // Lifecycle authority (PORCH-094 ac-1): the author sees Edit and Delete in
  // ···, the network owner sees Delete-only on posts they do not author,
  // and every other member sees neither. Menu-only placement: no top-level
  // lifecycle control renders on the action row, header body, or any card
  // surface.
  const ownsPostEdit = canEditPost(post, data);
  const ownsPostDelete = canDeletePost(post, data);
  const openEdit = () => { setComposerFor(null); setEditFor('post'); };
  const applyEditResult = (fields) => {
    setEditedFields((current) => ({ ...(current ?? {}), ...fields }));
    setEditFor(null);
    holdDraft('edit:post', '');
  };
  // The confirming member's tombstone: the card leaves in the same frame as
  // the confirm (a null-render, never a placeholder) and the exact
  // pre-action card restores with the failure named when the signed write
  // fails. No member-facing undelete exists anywhere (ac-3).
  const deleteThisPostConfirm = () => {
    setDeleteOpen(false);
    setTombstoned(true);
    operation.run(() => invoke(actions, 'deletePost', post), () => {}, () => {
      setTombstoned(false);
    });
  };
  // Comment lifecycle (ac-1/ac-4): one confirmation, then the row (and its
  // loaded subtree) leaves the slice in the same frame; a failed write
  // restores the exact pre-action rows. The edits ride the same
  // optimistic-discipline actions the river merges implement.
  const removeCommentRow = (row) => {
    const id = identityOf(row);
    setRemovedIds((current) => new Set(current).add(id));
    operation.run(
      () => invoke(actions, 'deleteComment', post, id),
      () => {},
      () => {
        setRemovedIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      },
    );
  };
  const editCommentRow = (row) => { setComposerFor(null); setEditFor(identityOf(row)); };
  // Mobile posts stay full-bleed while the feed exposes page background
  // between neighbors. Desktop retains its contained card treatment.
  const cardSx = detail ? undefined : {
    width: '100%',
    borderRadius: { xs: 0, lg: '14px' },
    border: { xs: 'none', lg: `1px solid ${cssVars.border}` },
    boxShadow: { xs: 'none', lg: cssVars.shadowCard },
  };
  const compactIconSx = { width: 36, height: 36, p: 0, '&::after': { content: '""', position: 'absolute', inset: -4 } };
  const voteButton = (direction, label, Icon) => <Tooltip title={label}><span><IconButton
    aria-label={label} disabled={operation.busy || data.offline} sx={compactIconSx}
    onClick={() => operation.run(() => invoke(actions, 'vote', post, direction))}
  ><Icon fontSize="small" /></IconButton></span></Tooltip>;
  // The feed-entry anchor (PORCH-046 ac-1): a stable per-post measurement
  // point for the reading-place compensation during live arrival.
  return <Card sx={cardSx} data-feed-entry={postKey(post) || undefined}>
    <CardContent sx={{ p: detail ? '20px' : { xs: '16px', lg: '20px' }, '&:last-child': { pb: detail ? '20px' : { xs: '16px', lg: '20px' } } }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          {/* Detail card treatment (PORCH-041 spec): 40px avatar header on the detail surface. */}
          {/* PORCH-070: the author's face rides the post's own origin —
              header rung fetched through the avatar-face loader; initials
              stay exactly where no rungs exist. */}
          <AvatarFace origin={post?.origin ?? originOf(post)} did={post.authorId ?? post.authorDid ?? null} kind="header"
            metas={post.authorAvatar ?? null} load={actions?.loadAvatarRendition}
            sx={{ width: detail ? 40 : 36, height: detail ? 40 : 36, fontSize: detail ? 17 : 15 }}>{(post.author?.name ?? post.authorName ?? memberName(post.authorId, data)).trim().charAt(0).toUpperCase()}</AvatarFace>
          <Box>
            {/* Header (PORCH-043 chrome): author 15px/600; 24px outlined
                network chip with thin border and 12px text; date muted; the
                column rides 36px avatars on the timeline surface. */}
            <Typography variant="body2" fontWeight={600} fontSize={15} color="text.primary">{post.author?.name ?? post.authorName ?? memberName(post.authorId, data)}</Typography>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              <Chip label={`From ${originName(post, data)}`} size="small" variant="outlined" sx={{ fontSize: '0.75rem', height: '24px' }} />
              {row.groupName && <Chip label={row.groupName} size="small" sx={{ bgcolor: 'porchlight.amberSoft', color: 'primary.main', fontSize: '0.6875rem', height: '24px' }} data-testid="location-chip" />}
              <Typography variant="caption" color="porchlight.muted">{dateOf(post.createdAt)}</Typography>
            </Stack>
          </Box>
        </Stack>
        <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          {/* The group settings menu (PORCH-089 ac-1) serves the group post's
              detail view too: the detail card carries the same top-right
              options control the group surface ships, beside the card's own
              ··· — one open menu per surface (each is an anchored MUI Menu
              whose backdrop closes the other in the same frame). */}
          {groupMenu}
          <IconButton aria-label="Post options" aria-haspopup="menu" aria-expanded={Boolean(menuAnchor)}
            onClick={(event) => setMenuAnchor(event.currentTarget)}><MoreHorizOutlined /></IconButton>
          <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
            {!detail && <MenuItem onClick={() => { setMenuAnchor(null); openPost(); }}>Open conversation</MenuItem>}
            {ownsPostEdit && <MenuItem data-testid="edit-post" onClick={() => { setMenuAnchor(null); openEdit(); }}>Edit</MenuItem>}
            {ownsPostDelete && <MenuItem data-testid="delete-post" disabled={data.offline} onClick={() => { setMenuAnchor(null); setDeleteOpen(true); }}>Delete</MenuItem>}
            <MenuItem onClick={runShare}>Share</MenuItem>
            <MenuItem disabled={operation.busy} onClick={() => {
              setMenuAnchor(null);
              operation.run(() => invoke(actions, 'hide', post), () => { setLocalHidden(true); onHide?.(post); });
            }}>Hide</MenuItem>
            {removesPostGroup && <MenuItem disabled={operation.busy} data-testid="remove-group-post"
              onClick={() => { setMenuAnchor(null); setRemoveOpen(true); }}>Remove</MenuItem>}
          </Menu>
        </Box>
      </Stack>
      {/* Rhythm (PORCH-043 vertical table): 25–30% tighter post-internal
          spacing; the body line stays 16px/25px on the timeline with the
          readable 68ch length. */}
      {/* Edit mode (PORCH-094 ac-2) is a mode of the ruled composer: the
          text/caption fields render pre-filled in place, media stays
          rendered read-only beneath (no swap, add, or remove affordance
          exists in edit mode — changes ride delete-and-repost), and the
          location control carries the Oct 16 location ruling. */}
      {editFor === 'post' && !data.offline && <PostEditForm
        post={post}
        row={row}
        data={data}
        initial={readDraft('edit:post') ?? { body: row.body ?? '', caption: row.caption ?? '', locationId: currentLocationId(row) }}
        onDraft={(value) => holdDraft('edit:post', value)}
        onSaved={applyEditResult}
        // Cancel (Brian, Oct 16, 2026): the composer closes with the pre-edit
        // card exactly as it stood and the staged draft is dropped — a fresh
        // Edit loads the post's current content again.
        onCancel={() => { setEditFor(null); holdDraft('edit:post', ''); }}
        onSubmit={(fields) => invoke(actions, 'editPost', post, fields)}
      />}
      {editFor !== 'post' && (row.body || row.caption) && <Box sx={{ mt: detail ? 2 : 1 }}>
        {row.body && <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: detail ? 17 : 16, lineHeight: detail ? '27px' : '25px', maxWidth: '68ch' }}><LinkedBody text={row.body} /></Typography>}
        {row.caption && <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: detail ? 17 : 16, lineHeight: detail ? '27px' : '25px', maxWidth: '68ch', ...(row.body ? { mt: 0.5 } : {}) }}><LinkedBody text={row.caption} /></Typography>}
      </Box>}
      {/* Link preview (PORCH-052): the compact embed facade or og:image card
          rides the text rail — inside the 16px padding band, never
          banner-scale (media dominance untouched). The card's image loads
          from this hub only; the embed facade waits for a member tap. */}
      {post.preview && <LinkPreviewBlock preview={post.preview} origin={previewOrigin(post, data)} />}
      <Media post={post} actions={actions} detail={detail} />
      {detail
        ? <Stack direction="row" spacing={1} sx={{ mt: 2 }}>{voteButton('up', 'Lift', ArrowUpwardOutlined)}{voteButton('down', 'Lower', ArrowDownwardOutlined)}</Stack>
        : <PresentReactions post={post} data={data} actions={actions} reactionState={reactionState}
          spacingY={photoFirst.spacing.utilityActions / 8}
          actionBar={<>
            {voteButton('up', 'Lift', ArrowUpwardOutlined)}
            {voteButton('down', 'Lower', ArrowDownwardOutlined)}
            <Tooltip title="Reply"><span><IconButton aria-label="Reply" aria-expanded={composerFor === 'post'}
              disabled={data.offline} sx={compactIconSx} onClick={() => setComposerFor(composerFor === 'post' ? null : 'post')}
            ><ReplyOutlined fontSize="small" /></IconButton></span></Tooltip>
          </>} />}
      {/* PORCH-084 (ac-3/ac-4): the on-demand composer rides the full
          16px text rail (the CardContent box) — nothing shrunken renders. */}
      {!detail && composerFor === 'post' && !data.offline && <ReplyForm
        label="Write a reply"
        replyingTo="this post"
        offline={data.offline}
        post={post}
        actions={actions}
        initialText={readDraft('post')}
        onDraft={(text) => holdDraft('post', text)}
        onDone={() => { setComposerFor(null); holdDraft('post', ''); }}
        onSubmit={(body, mentions) => submitOptimistic(body, null, mentions)}
      />}
      {detail && <PresentReactions post={post} data={data} actions={actions} reactionState={reactionState} />}
      {!detail && <ReplySliceBlock key={identityOf(post)} post={post} slice={displaySlice} data={data}
        actions={actions} offline={data.offline} origin={previewOrigin(post, data)}
        onReply={submitOptimistic} navigate={navigate}
        composerFor={composerFor} onReplyTarget={openComposer} onDraftDone={holdDraft} readDraft={readDraft}
        onComposerClosed={() => setComposerFor(null)}
        removedIds={removedIds} editFor={editFor} onEditTarget={editCommentRow} onDeleteComment={setCommentDelete}
        onCommentDeleted={removeCommentRow} onEditClosed={() => setEditFor(null)} />}
      {shareNote && <Typography color="text.secondary" role="status" sx={{ mt: 1 }}>{shareNote}</Typography>}
      {shareError && <Alert severity="warning" sx={{ mt: 1 }}>{shareError}</Alert>}
      {/* The fallback outcome's in-view confirmation (PORCH-078): the same
          strings the card foot reports, surfaced where the member is. */}
    {/* The confirming member's one delete confirmation (PORCH-094 ac-3):
        the ruled question with the cascade note; cancel mutates nothing. */}
    <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)} fullWidth maxWidth="xs">
      <DialogTitle>Delete this post?</DialogTitle>
      <DialogContent>
        <Typography>Its conversation goes with it — the replies and reactions are removed too. This cannot be undone here.</Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setDeleteOpen(false)}>Cancel</Button>
        <Button color="error" variant="contained" disabled={operation.busy || data.offline} data-testid="confirm-delete-post"
          onClick={deleteThisPostConfirm}>Delete post</Button>
      </DialogActions>
    </Dialog>
    {/* The comment's one delete confirmation on the card slice
        (PORCH-094 ac-3): identical copy and flow to the detail column's. */}
    <Dialog open={Boolean(commentDelete)} onClose={() => setCommentDelete(null)} fullWidth maxWidth="xs">
      <DialogTitle>Delete this comment?</DialogTitle>
      <DialogContent>
        <Typography>This comment and the replies that follow it are removed. This cannot be undone here.</Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setCommentDelete(null)}>Cancel</Button>
        <Button color="error" variant="contained" disabled={operation.busy} data-testid="confirm-delete-comment"
          onClick={() => {
            const row = commentDelete;
            setCommentDelete(null);
            removeCommentRow(row);
          }}>Delete comment</Button>
      </DialogActions>
    </Dialog>
    {/* The removal's in-place confirmation (PORCH-089 ac-3/ac-6): the named
        consequence verbatim, cancel mutates nothing, confirm executes the
        device-signed group post removal (the server's origin cascade). */}
    <Dialog open={removeOpen} onClose={() => setRemoveOpen(false)} fullWidth maxWidth="xs">
      <DialogTitle>Remove this post?</DialogTitle>
      <DialogContent>
        <Typography>This removes the post everywhere it appears — the group's timeline, the main feed that carries it, and its replies and reactions. It cannot be undone.</Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setRemoveOpen(false)}>Cancel</Button>
        <Button color="error" variant="contained" disabled={operation.busy} data-testid="confirm-remove-group-post"
          onClick={() => {
            setRemoveOpen(false);
            operation.run(() => invoke(actions, 'removeGroupPost', post), () => { setLocalHidden(true); onHide?.(post); });
          }}>Remove post</Button>
      </DialogActions>
    </Dialog>
      <Snackbar open={Boolean(shareSnackbar || shareError)} autoHideDuration={8000}
        onClose={() => { setShareSnackbar(''); }}
        message={shareSnackbar || (shareError ? 'The share did not go through. Try again.' : '')} />
      {operation.error && <Alert severity="error" sx={{ mt: 1 }}>{operation.error}</Alert>}
    </CardContent>
  </Card>;
}

function Heading({ title, subtitle }) {
  return <Box sx={{ mb: 3 }}><Typography variant="h1" component="h1" fontWeight={650}>{title}</Typography>{subtitle && <Typography variant="body1" color="text.secondary">{subtitle}</Typography>}</Box>;
}

// Group settings menu (PORCH-089, Brian Oct 15 2026): the group's settings
// consolidate behind the group header's top-right options control — an MUI
// Menu anchored to an IconButton (MoreVert class). Item sets render from
// the group detail read's authority flags (PORCH-088) and the viewer's
// notification state: the managing member (or the network owner, the
// superuser) sees the owner set — avatar, color, members, privacy — and
// every member sees their subset (the members view view-only, plus the
// per-group notifications row). Enforcement is server-side: the menu hides
// entries the role cannot exercise and never pretends to enforce; every
// write re-checks authority at the hub. One open menu per surface at a time
// is MUI's own anchored-menu law (each open menu covers the surface with
// its modal backdrop, so the click that opens another closes the open one
// first); the timeline renders with the menu closed — the anchor row is the
// only render cost, and the menu never gates the timeline render.

// The group's identity block: the served face — avatar-or-fallback. The
// fallback carries the group's color with its initial letter; a group with
// neither renders neutral, exactly as before this block existed. Zero
// reflow: the block is a fixed pixel square, and the avatar bytes arrive in
// a frame already reserved (geometry stamps; the served rungs are square).
function GroupAvatar({ group, actions = {}, origin, size = 56 }) {
  const groupId = group?._id ?? group?.id;
  const did = groupId ? `group:${groupId}` : '';
  const url = useAvatarFaceUrl({
    origin, did, metas: group?.avatar ?? null, kind: 'chooser',
    load: actions?.loadGroupAvatarRendition,
  });
  const color = typeof group?.color === 'string' && group.color ? group.color : null;
  return <Avatar src={url ?? undefined} alt={group?.name ? `${group.name}'s photo` : undefined}
    sx={{ width: size, height: size, fontSize: Math.round(size * 0.4), flexShrink: 0,
      bgcolor: url ? undefined : (color ?? undefined), color: url || !color ? undefined : 'var(--porch-amber-ink)' }}>
    {(group?.name ?? '').trim().charAt(0).toUpperCase() || 'G'}
  </Avatar>;
}

// The squared, compressed first look (ac-2): the group avatar route's set
// write is also its commit, so the preview-before-commit is rendered
// client-side — a center square crop at the chooser rung class, the same
// treatment shape the hub applies before it stores. Browser-only by nature;
// where document is absent (the render sweeps) no preview renders and the
// pick flow still functions.
async function squarePreview(file, size = 144) {
  if (typeof document === 'undefined' || !file) return null;
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(Object.assign(new Error('That image could not be read. Choose another copy.'), { code: 'E_AVATAR_UNDECODABLE' }));
      element.src = url;
    });
    const canvas = document.createElement('canvas');
    const side = Math.min(image.naturalWidth || image.width, image.naturalHeight || image.height);
    if (!side) return null;
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function GroupSettingsMenu({ group, data = {}, actions = {}, onchanged }) {
  const [anchor, setAnchor] = useState(null);
  const [view, setView] = useState('main'); // main | avatar | color | members | privacy
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removeMember, setRemoveMember] = useState(null); // the row pending its named-consequence confirm
  const [privacyPending, setPrivacyPending] = useState(null); // the next state pending its confirm
  const [adding, setAdding] = useState(false);
  const [pendingFile, setPendingFile] = useState(null);
  const [preview, setPreview] = useState(null); // { url } — the squared result before commit
  const fileRef = useRef(null);
  const groupId = group?._id ?? group?.id;
  const menuRows = group ? groupMenuRows(group, data) : [];
  const manage = Boolean(group) && menuRows.includes('photo');
  const notified = resolvedGroupNotification(group);
  const roster = groupMemberRows(group ?? {});
  const blocked = blockedRows(group ?? {});
  const visibility = groupVisibility(group ?? {});
  const colorSet = typeof group?.color === 'string' && group.color ? group.color : null;

  const close = () => { setAnchor(null); setView('main'); setError(''); setPendingFile(null); setPreview(null); };
  const back = () => { setView('main'); setError(''); };
  const write = async (key, ...args) => {
    setBusy(true);
    setError('');
    try {
      await invoke(actions, key, groupId, ...args);
      onchanged?.();
      close();
    } catch (cause) { setError(messageOf(cause)); }
    setBusy(false);
  };
  const setGroupNotify = async (on) => {
    setBusy(true);
    setError('');
    try {
      await invoke(actions, 'setGroupNotification', groupId, on);
      onchanged?.();
    } catch (cause) { setError(messageOf(cause)); }
    setBusy(false);
  };
  const chooseFile = async (file) => {
    setError('');
    setPendingFile(file ?? null);
    setPreview(null);
    if (file) {
      try { setPreview({ url: await squarePreview(file) }); }
      catch (cause) { setError(messageOf(cause)); }
    }
  };

  // The menu never renders without a group: nothing anchors mid-load, and
  // the timeline always renders with the menu closed (the same menu is only
  // ever an anchored layer over the surface).
  if (!group) return null;
  const entryLabels = { photo: 'Group photo', color: 'Color', members: 'Members', privacy: 'Group privacy' };
  const views = { photo: 'avatar', color: 'color', members: 'members', privacy: 'privacy' };
  // Menu children as one keyed array — MUI's Menu clones its direct
  // children (fragments are refused, per MUI's own guidance), so each view
  // builds its rows here.
  const items = [];

  if (view === 'main') {
    for (const row of menuRows) {
      if (row === 'notifications') continue;
      items.push(
        <MenuItem key={row} data-testid={`group-menu-${row}`}
          onClick={() => { setError(''); setView(views[row]); }}>
          <ListItemText primary={entryLabels[row]} />
        </MenuItem>,
      );
    }
    // The member's per-group notifications row (ac-4), PORCH-087's
    // corrected pairing verbatim: ON = receiving, OFF = paused — the
    // row's position never sits opposite its line, and unset resolves
    // ON (the detail read's resolved state is the rendered state).
    items.push(
      <Box key="notifications" sx={{ px: 2, py: 1, mt: 0.5 }} data-testid="group-notification-row">
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ gap: 2 }}>
          <Typography variant="body2">Group notifications
            <Typography variant="caption" component="span" display="block" color="text.secondary">
              {groupToggleLine(notified)}
            </Typography>
          </Typography>
          <Switch checked={notified} disabled={busy} data-testid="group-notification-toggle"
            slotProps={{ input: { 'aria-label': `${group?.name ?? 'This group'} notifications` } }}
            onChange={(event) => void setGroupNotify(event.target.checked)} />
        </Stack>
      </Box>,
    );
  } else if (view === 'avatar' && manage) {
    items.push(<MenuItem disabled key="title" aria-hidden><ListItemText primary="Group photo" /></MenuItem>);
    items.push(
      <Box key="pick" sx={{ px: 2, py: 1, display: 'flex', gap: 2, alignItems: 'center' }}>
        {preview?.url
          ? <Avatar src={preview.url} alt="The squared result from the hub" sx={{ width: 72, height: 72, flexShrink: 0 }} />
          : <GroupAvatar group={group} actions={actions} origin={menuOriginOf(data)} size={72} />}
        <Typography variant="body2" color="text.secondary" sx={{ minWidth: 0 }}>
          {preview?.url
            ? 'A first look at the squared photo. The hub stores this same result when you use it.'
            : 'The group\'s photo shows in its header everywhere the family sees this group.'}
        </Typography>
      </Box>,
    );
    items.push(
      <Box key="actions" sx={{ px: 2, pb: 1, display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'flex-start' }}>
        {preview?.url
          ? <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
              <Button variant="contained" size="small" disabled={busy || !pendingFile} data-testid="group-avatar-commit"
                onClick={() => void write('setGroupAvatar', pendingFile)}>Use this photo</Button>
              <Button size="small" disabled={busy} onClick={() => fileRef.current?.click()}>Try another</Button>
              <Button size="small" disabled={busy} onClick={back}>Cancel</Button>
            </Stack>
          : <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
              <Button variant="contained" size="small" disabled={busy} data-testid="group-avatar-pick"
                onClick={() => fileRef.current?.click()}>Choose a photo</Button>
              <Button size="small" disabled={busy} onClick={back}>Cancel</Button>
            </Stack>}
      </Box>,
    );
    items.push(
      <input hidden key="file" ref={fileRef} type="file" accept="image/*" data-testid="group-avatar-input"
        onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void chooseFile(file); }} />,
    );
  } else if (view === 'color' && manage) {
    items.push(<MenuItem disabled key="title" aria-hidden><ListItemText primary="Color" /></MenuItem>);
    for (const row of GROUP_COLOR_ROWS) {
      items.push(
        <MenuItem key={row.value ?? 'neutral'} data-testid={`group-color-${row.name.toLowerCase()}`}
          disabled={busy} selected={group?.color === row.value}
          onClick={() => void write('setGroupColor', row.value)}>
          <Box component="span" aria-hidden sx={{ width: 18, height: 18, borderRadius: '50%', bgcolor: row.value, mr: 1.5, flexShrink: 0 }} />
          <ListItemText primary={row.name} secondary={group?.color === row.value ? 'Current' : undefined} />
        </MenuItem>,
      );
    }
    items.push(<Divider key="divider" />);
    items.push(
      <MenuItem key="nocolor" data-testid="group-color-nocolor" disabled={busy || !colorSet}
        onClick={() => void write('setGroupColor', GROUP_NO_COLOR)}>
        <ListItemText primary="No color" secondary={colorSet ? 'Returns this group to its neutral look.' : 'Neutral — this group already renders plain.'} />
      </MenuItem>,
    );
    items.push(<MenuItem key="back" onClick={back}>Back</MenuItem>);
  } else if (view === 'members') {
    items.push(
      // No count rides this row: member-count display is out of scope until
      // Brian names it (the directive's scope boundary).
      <MenuItem disabled key="title"><ListItemText primary="Members" /></MenuItem>);
    items.push(
      <Box key="roster" sx={{ maxHeight: 320, overflow: 'auto' }}>
        {roster.map((member) => <Box key={member.did} sx={{ px: 2, py: 1 }} data-testid="group-member-row">
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ gap: 2 }}>
            <Typography variant="body2" sx={{ minWidth: 0 }}>{member.did === data.identity?.id ? 'You' : member.name ?? member.did}</Typography>
            {manage && member.did !== data.identity?.id && <Button size="small" disabled={busy}
              data-testid="remove-group-member" onClick={() => setRemoveMember(member)}>Remove</Button>}
          </Stack>
        </Box>)}
      </Box>,
    );
    // The blocked roster rides the view, off the group's face: removal
    // entered the blocked set atomically (PORCH-068 lifecycle), the
    // unblock lifts it, and the member then rejoins by the visibility's
    // own path (self-serve on public, invite on private).
    if (manage && blocked.length > 0) {
      items.push(
        <Box key="blocked" sx={{ px: 2, py: 1, minWidth: 220 }}>
          <Typography variant="caption" color="text.secondary">Removed — they cannot rejoin unless re-invited, or until you unblock them.</Typography>
          <List dense disablePadding>
            {blocked.map((row) => <ListItemButton key={row.did} disableGutters>
              <ListItemText primary={row.did === data.identity?.id ? 'You' : row.did} />
              <Button size="small" disabled={busy} data-testid="unblock-group-member"
                onClick={() => void write('unblockGroupMember', row.did)}>Unblock</Button>
            </ListItemButton>)}
          </List>
        </Box>,
      );
    }
    if (manage) {
      items.push(<MenuItem key="add" data-testid="add-group-members" onClick={() => setAdding(true)}>Add members</MenuItem>);
    }
    items.push(<MenuItem key="back" onClick={back}>Back</MenuItem>);
  } else if (view === 'privacy' && manage) {
    items.push(<MenuItem disabled key="title" aria-hidden><ListItemText primary="Group privacy" secondary="Who can find and join this group" /></MenuItem>);
    // The labeled states with their consequence lines, verbatim from
    // the ruling; the current state renders marked. Choosing the other
    // state confirms in place with the named consequence, then commits
    // through the shipped visibility change path — cancel mutates
    // nothing.
    for (const row of GROUP_PRIVACY_ROWS) {
      items.push(
        <MenuItem key={row.value} data-testid={`group-privacy-${row.value}`}
          disabled={busy || visibility === row.value} selected={visibility === row.value}
          onClick={() => setPrivacyPending(row)}>
          <ListItemText primary={row.label} secondary={row.line} />
        </MenuItem>,
      );
    }
    items.push(<MenuItem key="back" onClick={back}>Back</MenuItem>);
  }
  return <Box sx={{ flexShrink: 0 }}>
    <IconButton aria-label="Group options" aria-haspopup="menu" aria-expanded={Boolean(anchor)}
      data-testid="group-settings-menu"
      onClick={(event) => setAnchor(event.currentTarget)}><MoreVertOutlined /></IconButton>
    <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={close}
      slotProps={{ paper: { sx: { maxHeight: 440, minWidth: 260 } } }}>
      {items}
      {error && <Box sx={{ px: 2, pb: 1 }}><Alert severity="error">{error}</Alert></Box>}
    </Menu>

    {/* Confirmations, in place, with the named consequence: cancel mutates
        nothing; confirm executes the (server-authority-checked) write. */}
    <Dialog open={Boolean(removeMember)} onClose={() => setRemoveMember(null)} fullWidth maxWidth="xs">
      <DialogTitle>Remove {removeMember?.name ?? 'this member'} from {group?.name}?</DialogTitle>
      <DialogContent>
        <Typography>{groupMemberRemoveCopy(removeMember?.name, group)}</Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setRemoveMember(null)}>Cancel</Button>
        <Button color="error" variant="contained" disabled={busy} data-testid="confirm-remove-group-member"
          onClick={async () => {
            const did = removeMember?.did;
            setRemoveMember(null);
            await write('removeGroupMember', did);
          }}>Remove</Button>
      </DialogActions>
    </Dialog>
    <Dialog open={Boolean(privacyPending)} onClose={() => setPrivacyPending(null)} fullWidth maxWidth="xs">
      <DialogTitle>Make {group?.name} {privacyPending?.value}?</DialogTitle>
      <DialogContent><Typography>{privacyPending?.line} You can change this back any time.</Typography></DialogContent>
      <DialogActions>
        <Button onClick={() => setPrivacyPending(null)}>Cancel</Button>
        <Button variant="contained" disabled={busy} data-testid="confirm-group-privacy"
          onClick={async () => {
            const value = privacyPending?.value;
            setPrivacyPending(null);
            await write('updateGroupVisibility', value);
          }}>Change</Button>
      </DialogActions>
    </Dialog>
    {adding && <AddMembersDialog group={group} actions={actions}
      onClose={() => setAdding(false)} onAdded={() => { setAdding(false); onchanged?.(); }} />}
  </Box>;
}

function menuOriginOf(data = {}) {
  try { return new URL(data?.server?.url || window.location.origin).origin; }
  catch { return null; }
}

// The group page's header: the identity block (avatar-or-fallback, the
// color as the accent beside the name) with the settings menu at the
// top-right. Fixed pixel geometry — no reflow while bytes arrive.
function GroupHeader({ group, data, actions, onchanged }) {
  const color = typeof group?.color === 'string' && group.color ? group.color : null;
  return <Box sx={{ mb: 3, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2 }}>
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
      <GroupAvatar group={group} actions={actions} origin={menuOriginOf(data)} size={56} />
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="h1" component="h1" fontWeight={650} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
          {group.name}
          {color && <Box component="span" aria-hidden sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: color, flexShrink: 0 }} />}
        </Typography>
        <Typography variant="body1" color="text.secondary">Spaces within your family network</Typography>
      </Box>
    </Box>
    <GroupSettingsMenu group={group} data={data} actions={actions} onchanged={onchanged} />
  </Box>;
}

// The hub decorates four roots and descendant counts. Full history is read
// only when someone expands comments or a response tree; both open on the
// card, preserving the feed's reading position and origin boundary.
// PORCH-084: the block renders no composer by default; the per-row Reply
// action opens the surface's one composer (owned by the parent card), which
// renders full-rail at the block's foot — never a small inline input inside
// an indented row — with the target legible in the composer itself.
// The comment surfaces are named exports for the contract tests (the
// rendered-surface sweep in test/reply-order.test.js); no routing outside
// social.jsx needs them.
// The edit composer (PORCH-094 ac-2): a mode of the ruled composer family —
// pre-filled with the post's current text and caption, full width of its
// rail, one composer at a time per surface. Media renders read-only in
// place on the card it belongs to (this composer never offers a media
// affordance: changes ride delete-and-repost). The location control carries
// the Oct 16 location ruling: pre-set to the post's current target,
// offering the general timeline plus the groups the author belongs to —
// never another network, never a group the author does not belong to. Save
// applies text, caption, and target as ONE write; a failed write holds the
// full draft including the staged target choice.
function PostEditForm({ post, row, data = {}, initial, onDraft = null, onSaved = null, onCancel = null, onSubmit }) {
  const [body, setBody] = useState(initial?.body ?? '');
  const [caption, setCaption] = useState(initial?.caption ?? '');
  const [locationId, setLocationId] = useState(initial?.locationId ?? currentLocationId(post));
  const operation = useOperation();
  const offline = Boolean(data.offline);
  const locationRows = editLocationRows(post, data);
  const stage = { body, caption, locationId };
  const report = (next) => { onDraft?.(next); };
  return <Stack component="form" spacing={1.5} sx={{ my: 1.5 }} onSubmit={(event) => {
    event.preventDefault();
    if (offline || operation.busy || !body.trim()) return;
    operation.run(
      // One write: text, caption, and target ride the same signed edit (the
      // empty caption and the general timeline ride their null values).
      () => onSubmit({ body: body.trim(), caption: caption.trim() ? caption : null, groupId: locationId === GENERAL_LOCATION_ID ? null : locationId }),
      () => onSaved?.(stage),
      () => {}, // the composer stays open; the full draft holds through the failure
    );
  }}>
    <TextField
      fullWidth
      label="Edit your post"
      value={body}
      disabled={offline}
      multiline minRows={2}
      onChange={(event) => { const next = { ...stage, body: event.target.value }; setBody(event.target.value); report(next); }}
      helperText={offline ? 'Editing needs your family server. It is unreachable right now.' : undefined}
    />
    <TextField
      fullWidth
      label="Caption"
      value={caption}
      disabled={offline}
      multiline minRows={1}
      onChange={(event) => { const next = { ...stage, caption: event.target.value }; setCaption(event.target.value); report(next); }}
    />
    <TextField
      fullWidth
      select
      // Location in edit mode (Brian, Oct 16, 2026): the general timeline
      // plus the author's groups only — both directions ride the edit.
      data-testid="edit-location"
      label="Post to"
      value={locationId}
      disabled={offline}
      onChange={(event) => { const next = { ...stage, locationId: event.target.value }; setLocationId(event.target.value); report(next); }}
    >
      {locationRows.map((item) => <MenuItem key={item.id || 'general'} value={item.id}>{item.label}</MenuItem>)}
    </TextField>
    {(row?.mediaRefs ?? row?.mediaIds ?? []).length > 0 && <Typography variant="caption" color="text.secondary">Media is set as posted. To change it, delete this post and post it again.</Typography>}
    {/* Cancel (Brian, Oct 16, 2026, user-testing): hitting Cancel abandons
        the edit — the composer closes, nothing is written, and the staged
        draft is dropped so a fresh Edit loads the post's current content
        again. Disabled mid-write: the save's outcome decides the close. */}
    <Stack direction="row" spacing={1}>
      <Button type="submit" variant="contained" disabled={offline || operation.busy || !body.trim()} sx={{ alignSelf: 'flex-start' }}>
        {operation.busy ? 'Saving…' : 'Save changes'}
      </Button>
      <Button data-testid="cancel-edit-post" disabled={operation.busy} onClick={() => onCancel?.()}>Cancel</Button>
    </Stack>
    {operation.error && <Alert severity="error" data-testid="edit-error">{operation.error}</Alert>}
  </Stack>;
}

// The comment's edit composer (PORCH-094 ac-4): text only — comments carry
// no location and no media to edit. Pre-filled, full rail width, one
// composer per surface; a failed write keeps it open with the draft held.
function CommentEditForm({ row, initialText, onDraft = null, onDone = null, onCancel = null, onSubmit }) {
  const [text, setText] = useState(initialText ?? '');
  const operation = useOperation();
  return <Stack component="form" spacing={1} sx={{ my: 1 }} onSubmit={(event) => {
    event.preventDefault();
    if (operation.busy || !text.trim()) return;
    operation.run(
      () => onSubmit(text.trim()),
      () => { setText(''); onDraft?.(''); onDone?.(); },
      () => {}, // keep the composer open, draft held through the failure
    );
  }}>
    <TextField
      fullWidth
      label="Edit your comment"
      value={text}
      multiline minRows={2}
      data-testid="comment-edit-field"
      onChange={(event) => { setText(event.target.value); onDraft?.(event.target.value); }}
    />
    {/* Cancel (Brian, Oct 16, 2026, user-testing): abandons the edit — the
        composer closes, nothing is written, and the staged draft is dropped
        so a fresh Edit loads the comment's current text again. Disabled
        mid-write: the save's outcome decides the close. */}
    <Stack direction="row" spacing={1}>
      <Button type="submit" variant="contained" disabled={operation.busy || !text.trim()} sx={{ alignSelf: 'flex-start' }} data-testid="comment-edit-save">
        {operation.busy ? 'Saving…' : 'Save changes'}
      </Button>
      <Button data-testid="comment-edit-cancel" disabled={operation.busy} onClick={() => onCancel?.()}>Cancel</Button>
    </Stack>
    {operation.error && <Alert severity="error" data-testid="comment-edit-error">{operation.error}</Alert>}
  </Stack>;
}

/**
 * A comment row's lifecycle overflow (PORCH-094 ac-1): Edit and Delete in
 * the row's own affordance, authority-gated — the author's own rows carry
 * both; the network owner sees Delete-only on other members' rows; members
 * with no authority see no overflow control at all. Menu-only placement:
 * no top-level lifecycle control renders anywhere.
 */
function CommentOverflow({ row, data = {}, offline = false, onEdit = null, onDelete = null }) {
  const [anchor, setAnchor] = useState(null);
  const items = lifecycleMenuItems({ edit: canEditComment(row, data), remove: canDeleteComment(row, data) });
  if (!items.length) return null;
  return <>
    <IconButton aria-label="Comment options" aria-haspopup="menu" aria-expanded={Boolean(anchor)}
      data-testid="comment-options"
      sx={{ width: 32, height: 32, p: 0, color: 'text.secondary', '&::after': { content: '""', position: 'absolute', inset: -4 } }}
      onClick={(event) => setAnchor(event.currentTarget)}><MoreHorizOutlined sx={{ fontSize: 18 }} /></IconButton>
    <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
      {canEditComment(row, data) && <MenuItem data-testid="edit-comment" disabled={offline}
        onClick={() => { setAnchor(null); onEdit?.(row); }}>Edit</MenuItem>}
      {canDeleteComment(row, data) && <MenuItem data-testid="delete-comment" disabled={offline}
        onClick={() => { setAnchor(null); onDelete?.(row); }}>Delete</MenuItem>}
    </Menu>
  </>;
}

export function ReplySliceBlock({ post, slice, data, actions, offline, origin, onReply, navigate,
  composerFor = null, onReplyTarget = null, onDraftDone = null, readDraft = null, onComposerClosed = null,
  removedIds = null, editFor = null, onEditTarget = null, onDeleteComment = null,
  onCommentDeleted = null, onEditClosed = null }) {
  const [loaded, setLoaded] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [expandedRoots, setExpandedRoots] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // PORCH-099: the freshly written tree rows — a reply to a comment lands
  // inside ITS parent's tree at the child position in the same frame the
  // write starts (optimistic pending row), swaps for the confirmed server
  // row, and a failed write reverts exactly. A confirmed row keeps
  // rendering inside the tree until a read carries its id (reconciled by
  // the slice reads below — never rendered twice, never remounted).
  const [treeRows, setTreeRows] = useState(() => ({ pending: [], confirmed: [] }));
  const treeCountRef = useRef(0);
  const signature = `${slice.total}:${slice.replies.map((row) => `${identityOf(row)}:${row.responseCount ?? 0}`).join('|')}`;
  const scoped = (comments) => comments.filter((row) =>
    (!row.postId || String(row.postId) === identityOf(post))
    && (!row.networkId || !originOf(post) || String(row.networkId) === String(originOf(post))));
  const load = async () => {
    if (loaded) return loaded;
    setBusy(true);
    setError('');
    try {
      const result = await invoke(actions, 'loadComments', post);
      if (!Array.isArray(result?.comments)) throw new Error('The family server did not return this conversation.');
      const comments = scoped(result.comments);
      setLoaded(comments);
      setTreeRows((current) => reconcileNestedRows(current, comments));
      return comments;
    } catch (failure) {
      setError(messageOf(failure));
      return null;
    } finally {
      setBusy(false);
    }
  };
  // Once expanded, arrivals refresh the open tree without folding it or
  // resetting the member's scroll position.
  useEffect(() => {
    if (!loaded || offline) return undefined;
    let active = true;
    Promise.resolve().then(() => invoke(actions, 'loadComments', post)).then((result) => {
      if (active && Array.isArray(result?.comments)) {
        const comments = scoped(result.comments);
        setLoaded(comments);
        setTreeRows((current) => reconcileNestedRows(current, comments));
      }
    }).catch(() => {});
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a changed decorated slice refreshes an open thread
  }, [signature]);
  // The rendered tree mounts the served rows PLUS the freshly written ones
  // (PORCH-099): the optimistic pending and the confirmed row render at the
  // child position of the row they answer. renderRow's seen-set dedupes by
  // id where a read already carries a confirmed row.
  const freshRows = [...treeRows.confirmed, ...treeRows.pending];
  const byParent = repliesByParent([...(loaded ?? []), ...freshRows]);
  // The member's removed comment rows (and the subtrees hanging under them)
  // leave the slice live: a removed id never renders, in any state (ac-3).
  const isRemoved = (row) => Boolean(removedIds?.has?.(identityOf(row)));
  const roots = showAll && loaded
    ? repliesByParent([...loaded, ...slice.replies.filter((row) => !loaded.some((item) => identityOf(item) === identityOf(row)))]).get('') ?? []
    : slice.replies;
  const visibleRoots = roots.filter((row) => !isRemoved(row));
  const more = showAll ? 0 : expanderCount(slice.total);
  if (!visibleRoots.length && !more) return null;
  const expand = async (id) => {
    if (offline || busy) return;
    if (!await load()) return;
    if (id) setExpandedRoots((current) => new Set(current).add(id));
    else setShowAll(true);
  };
  // A reply to a comment (root or nested) lands inside ITS parent's tree at
  // the child position in the same frame the write starts: the parent's tree
  // opens (keyed by the row's depth-0 ancestor per the render law — never
  // beside unrelated roots), the closed context loads if the render has
  // never read the tree, the optimistic pending row renders, and the
  // confirmed server row keeps rendering in place until a read carries it
  // (reconciled by id). A failed write reverts exactly (PORCH-099).
  const targetRows = () => [...(loaded ?? []), ...freshRows, ...slice.replies];
  const submitNested = async (body, parentId, mentions) => {
    const localId = `local:nested-${Date.now()}-${(treeCountRef.current += 1)}`;
    setExpandedRoots((current) => new Set(current).add(rootAncestorId(String(parentId), targetRows())));
    if (!loaded) void load();
    const optimistic = pendingReply(post, body, {
      did: data.identity ? String(data.identity.id) : null,
      name: data.identity?.name ?? 'You',
      localId,
      parentId,
    });
    setTreeRows((current) => ({ ...current, pending: [...current.pending, optimistic] }));
    const revert = () => setTreeRows((current) => ({
      ...current,
      pending: current.pending.filter((row) => row._id !== localId),
    }));
    return Promise.resolve()
      .then(() => onReply(body, parentId, mentions))
      .then((result) => {
        if (!result?.comment || !identityOf(result.comment) || !scoped([result.comment]).length) {
          revert();
          throw new Error('The family server did not confirm this reply. Reload the conversation before trying again.');
        }
        setTreeRows((current) => ({
          pending: current.pending.filter((row) => row._id !== localId),
          confirmed: [...current.confirmed.filter((row) => identityOf(row) !== identityOf(result.comment)),
            { ...result.comment, postId: result.comment.postId ?? identityOf(post) }],
        }));
        return result;
      }, (failure) => { revert(); throw failure; });
  };
  // Comment edit (PORCH-094 ac-4): text only, the ruled composer in edit
  // mode — the river merge the action performs re-renders rows served in
  // the slice in place; a nested expanded row swaps in the open tree
  // optimistically and reverts exactly when the write fails.
  const submitCommentEdit = async (row, body) => {
    const id = identityOf(row);
    const snapshot = loaded;
    if (snapshot?.some((item) => identityOf(item) === id)) {
      setLoaded((current) => current
        ? current.map((item) => (identityOf(item) === id ? { ...item, body } : item))
        : current);
    }
    try {
      return await invoke(actions, 'editComment', post, id, body);
    } catch (failure) {
      if (snapshot) setLoaded(snapshot);
      throw failure;
    }
  };
  const renderRow = (reply, depth = 0, seen = new Set(), rootId = identityOf(reply)) => {
    const id = identityOf(reply);
    if (!id || seen.has(id) || isRemoved(reply)) return null;
    const children = byParent.get(id) ?? [];
    const count = reply.responseCount ?? children.length;
    const open = expandedRoots.has(rootId);
    const nextSeen = new Set(seen).add(id);
    return <Box key={id} sx={{ ml: depth ? { xs: Math.min(depth, 2) * 2, lg: Math.min(depth, 3) * 3.5 } : 0,
      ...(depth ? { borderLeft: '1px solid', borderColor: 'divider', pl: 1 } : {}) }}>
      <Stack direction="row" spacing={1} alignItems="flex-start">
        {/* PORCH-070: reply rows carry their author's face (interaction-path
            comment views) on the same loader; name-only rows keep initials. */}
        <AvatarFace origin={origin} did={reply.authorDid ?? reply.authorId ?? null} kind="header"
          metas={reply.authorAvatar ?? null} load={actions?.loadAvatarRendition}
          sx={{ width: 30, height: 30, fontSize: 13 }}>{(reply.author?.name ?? reply.authorName ?? memberName(reply.authorDid, data)).trim().charAt(0).toUpperCase()}</AvatarFace>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="caption" color="porchlight.muted">
            {reply.authorName ?? memberName(reply.authorDid, data)} · {relativeTime(reply.createdAt)}
          </Typography>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{renderReplyBody(reply, data, navigate)}</Typography>
          {reply.preview && <LinkPreviewBlock preview={reply.preview} origin={origin ?? previewOrigin(reply, data)} compact />}
          {!offline && depth < 8 && <Stack direction="row" spacing={0.5} alignItems="center">
            <Button size="small" onClick={() => onReplyTarget?.(id === composerFor ? null : id)}
              sx={{ px: 0, minWidth: 0 }}>Reply</Button>
            <CommentOverflow row={reply} data={data} offline={offline}
              onEdit={(r) => onEditTarget?.(r)} onDelete={(r) => onDeleteComment?.(r)} />
          </Stack>}
          {/* PORCH-099 (Brian, Oct 18): the reply composer mounts in context —
              directly beneath the comment it answers, one rung into that
              comment's tree, never at the bottom of the whole conversation.
              Surface law holds: one composer state per surface, keyed by the
              answered comment id (no remount on the open composer), with the
              draft held per target. */}
          {!offline && composerFor === id && <Box sx={{ ml: { xs: 2, lg: 3.5 }, pl: 1, borderLeft: '1px solid', borderColor: 'divider' }}><ReplyForm
            key={composerTarget}
            label="Your reply"
            replyingTo={reply.author?.name ?? reply.authorName ?? memberName(reply.authorDid, data)}
            offline={offline}
            post={post}
            actions={actions}
            initialText={readDraft?.(composerTarget) ?? ''}
            onDraft={(text) => onDraftDone?.(composerTarget, text)}
            onDone={() => { onComposerClosed?.(); onDraftDone?.(composerTarget, ''); }}
            onSubmit={(body, mentions) => submitNested(body, composerTarget, mentions)}
          /></Box>}
          {!open && count > 0 && <Button size="small" disabled={offline || busy}
            onClick={() => expand(id)} sx={{ display: 'block', px: 0, minWidth: 0, color: 'secondary.main' }}>
            {`View ${count} more responses`}
          </Button>}
        </Box>
      </Stack>
      {open && children.map((child) => renderRow(child, depth + 1, nextSeen, rootId))}
    </Box>;
  };
  const composerTarget = composerFor && composerFor !== 'post' ? composerFor : null;
  const editTarget = editFor && editFor !== 'post' ? editFor : null;
  const editRow = editTarget
    ? (slice?.replies ?? []).find((row) => identityOf(row) === editTarget)
      ?? (loaded ?? []).find((row) => identityOf(row) === editTarget)
    : null;
  return <Box sx={{ mt: photoFirst.spacing.reactionsSlice / 8, borderTop: '1px solid', borderColor: photoFirst.dividerColor, pt: 1.25 }}>
    <Stack spacing={1}>{visibleRoots.map((reply) => renderRow(reply))}</Stack>
    {more > 0 && <Button size="small" disabled={offline || busy} onClick={() => expand(null)}
      sx={{ mt: 1, px: 0, minWidth: 0, fontSize: 14, fontWeight: 600, color: 'secondary.main' }}>
      {`View ${more} more comments`}
    </Button>}
    {editTarget && !offline && <CommentEditForm
      key={`edit:${editTarget}`}
      row={editRow}
      initialText={readDraft?.(`edit:${editTarget}`) ?? editRow?.body ?? ''}
      onDraft={(text) => onDraftDone?.(`edit:${editTarget}`, text)}
      onDone={() => { onEditClosed?.(); onDraftDone?.(`edit:${editTarget}`, ''); }}
      // Cancel (Brian, Oct 16, 2026): the composer closes with the row
      // exactly as it stood and the staged draft is dropped — a fresh Edit
      // loads the comment's current text again.
      onCancel={() => { onEditClosed?.(); onDraftDone?.(`edit:${editTarget}`, ''); }}
      onSubmit={(body) => submitCommentEdit(editRow, body)}
    />}
    {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
  </Box>;
}

// The pending copy swaps for the confirmed server row by id: the confirm
// response carries the real _id, so the local row retires and the confirmed
// one renders exactly once under the same conversation.

// PORCH-084: the nested reply tree renders the ruled read order — roots
// newest-first with threaded roots ahead (ruledOrder), replies chronological
// inside each tree (repliesByParent) — so the detail column and the card
// slice agree with the served order between fetches. The rows carry no
// composer of their own: the column owns the one on-demand composer. Its
// mount rides the answered row (PORCH-099, Brian, Oct 18): composerSlot
// renders the composer beneath the row it answers.
export function ReplyThread({ comments, post, data, actions, navigate, composerFor = null, onReplyTarget = null, rowLifecycle = null, composerSlot = null }) {
  const byParent = repliesByParent(comments);
  // The root's threaded-ness for the ruled sort: the tree the read returned,
  // or the server's decorated count when the tree is not (yet) loaded.
  const responseCount = (reply) => Math.max(
    (byParent.get(identityOf(reply)) ?? []).length,
    Number(reply?.responseCount) || 0,
  );
  const render = (parentId = '', depth = 0, seen = new Set()) => {
    const children = byParent.get(parentId) ?? [];
    const ordered = parentId === '' ? ruledOrder(children, responseCount) : children;
    return ordered
      .filter((reply) => !seen.has(identityOf(reply)))
      .map((reply, index) => {
        const nextSeen = new Set(seen);
        nextSeen.add(identityOf(reply));
        return <Reply key={identityOf(reply) || index} reply={reply} depth={depth} data={data} post={post} actions={actions} navigate={navigate} composerFor={composerFor} onReplyTarget={onReplyTarget} rowLifecycle={rowLifecycle} composerSlot={composerSlot}>{render(identityOf(reply), depth + 1, nextSeen)}</Reply>;
      });
  };
  return <>{render()}</>;
}

// Mobile posts break out of the page gutter; a 14px gap exposes page
// background between them. Desktop keeps its 16px contained-card gap.
const feedBreakout = { mx: { xs: -2, lg: 0 } };

function Feed({ posts, data, actions, navigate, empty, hidden, onHide }) {
  // The one privacy filter every render rides (PORCH-046 ac-4): loaded
  // feed, live arrival, and cached timeline all drop hidden and
  // foreign-origin posts here, never downstream.
  const visible = visibleFeedPosts(rows(posts), data, hidden).filter((post) => !actions?.isHidden?.(post));
  return visible.length
    ? <Box sx={feedBreakout}><Stack spacing={{ xs: '14px', lg: 2 }}>{visible.map((post, index) => <PostCard key={postKey(post) || index} post={post} data={data} actions={actions} navigate={navigate} onHide={onHide} />)}</Stack></Box>
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
  const [hidden, setHidden] = useState(() => new Set());
  const onHide = (post) => setHidden((current) => new Set(current).add(postKey(post)));
  // Timeline shell (tokens): 760–820px river inside the shell, one
  // chronological feed with nothing above it. Porchlight UI, Oct 14 2026
  // (PORCH-072): the "Shared moments" heading block, the header's
  // create-post/search/albums buttons, and the "Family highlights" band
  // (the prominent/ranked section) are all trimmed as redundant; the base
  // chronological river is the feed.
  return <Box sx={{ maxWidth: 780 }}>
    {data.offline && <Alert severity="warning" sx={{ mb: 2 }}>A family server is unreachable. Saved moments may be out of date; new activity is not available until you reconnect.</Alert>}
    {/* PORCH-081 ac-4: the REST catch-up note — a replay older than the hub's retained event window names itself; the member's own resolve, never a returning poll cycle. */}
    {data.behind && !data.offline && <Alert severity="warning" sx={{ mb: 2 }}>Some newer moments could not be replayed from the server while this device was away, so this view may be missing recent activity.
      {actions.refreshFeeds ? <Button size="small" sx={{ ml: 1 }} onClick={() => actions.refreshFeeds()}>Check again</Button> : null}
    </Alert>}
    {!data.offline && !posts.length ? <EmptyTimeline navigate={navigate} /> : <Feed posts={posts} data={data} actions={actions} navigate={navigate} hidden={hidden} onHide={onHide} empty={data.offline ? 'No saved moments are available.' : 'Nothing here yet. Start the conversation.'} />}
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
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState('');
  // Self-serve join (PORCH-068 lifecycle ruling): the member's own act on a
  // public group — no approval flow, no request stage; delivery turns on
  // immediately (the feed predicate is the live roster).
  const onJoin = async () => {
    if (!actions.joinGroup) { setJoinError('Joining is not available from this build yet.'); return; }
    setJoining(true);
    setJoinError('');
    try {
      await invoke(actions, 'joinGroup', selectedId);
      setRevision((at) => at + 1);
    } catch (cause) { setJoinError(messageOf(cause)); }
    setJoining(false);
  };
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
  const onCreate = async (name, visibility) => {
    const result = await invoke(actions, 'createGroup', name, visibility);
    setCreating(false);
    if (result?.group?._id) navigate?.(`/groups/${encodeURIComponent(result.group._id)}`);
    return result;
  };
  return <Box>
    {selectedId && group && !loading && !loadError
      ? <GroupHeader group={group} data={data} actions={actions} onchanged={() => setRevision((at) => at + 1)} />
      : <Heading title={group?.name ?? 'Groups'} subtitle="Spaces within your family network" />}
    {data.offline && <Alert severity="warning" sx={{ mb: 2 }}>Groups may be out of date while your family server is unreachable.</Alert>}
    {selectedId && <Button sx={{ mb: 2 }} onClick={() => navigate?.('/groups')}>All groups</Button>}
    {loading && <LanternLoader label="Reading your group" />}
    {loadError && <Alert severity="error">{loadError}</Alert>}
    {selectedId && !group && !loading && !loadError && <Alert severity="info">{data.offline ? 'This group is not saved on this device. Reconnect to check it.' : 'This group is not available in your network.'}</Alert>}
    {group && !loading && !loadError && <Stack spacing={2}>
      <Typography color="text.secondary">Posts in {group.name} stay within {data.network?.name ?? 'this family network'}. Each post shows its origin.</Typography>
      {/* PORCH-096 (Brian, Oct 16 2026): the group surface's compose entry
          reads "+ New post" and opens the compose card with the location
          control pre-set to this group — visible pre-population, the
          target never implicit. Members only: a non-member's offered
          targets never include this group, so the entry keeps to them. */}
      {isGroupMember(group, data.identity?.id) && <Button variant="contained" sx={{ alignSelf: 'flex-start' }} onClick={() => navigate?.('/compose')} data-testid="group-new-post">+ New post</Button>}
      {canJoinGroup(group, data.identity?.id) && <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
        <Button variant="contained" onClick={() => void onJoin()} disabled={joining} data-testid="join-group">Join group</Button>
        <Typography color="text.secondary">Join to see {group.name}'s posts in your own feed.</Typography>
      </Stack>}
      {joinError && <Alert severity="error">{joinError}</Alert>}
      {/* PORCH-089 (the ruling): the roster lives as a second view inside
          the settings menu — off the group's face. Management (add, remove,
          unblock) rides the menu's Members view; plain members keep the
          view-only roster there too. */}
      {/* PORCH-081 ac-4: the REST catch-up note rides every timeline surface. */}
      {data.behind && !data.offline && <Alert severity="warning">Some newer moments could not be replayed from the server, so this view may be missing recent activity. <Button size="small" sx={{ ml: 1 }} onClick={() => actions.refreshFeeds?.()}>Check again</Button></Alert>}
      <Feed posts={posts} data={data} actions={actions} navigate={navigate} empty={data.offline ? 'No saved posts from this group are available.' : 'No posts in this group yet.'} />
    </Stack>}
    {!selectedId && <Stack spacing={2}>
      <Stack direction="row" spacing={1} flexWrap="wrap"><Button variant="contained" onClick={() => setCreating(true)} data-testid="create-group">Create a group</Button></Stack>
      {groups.length ? <Stack spacing={2}>{groups.map((item) => <Card key={identityOf(item)} variant="outlined"><CardContent><Typography variant="h6">{item.name}</Typography><Typography color="text.secondary">Within {data.network?.name ?? 'this family network'} · {(Array.isArray(item.members) ? item.members.length : 0)} member{(item.members?.length ?? 0) === 1 ? '' : 's'} · {groupVisibility(item) === 'public' ? 'Public — the whole network can view' : 'Private — invite-only'}</Typography><Button onClick={() => navigate?.(`/groups/${encodeURIComponent(identityOf(item))}`)}>View group</Button></CardContent></Card>)}</Stack> : <Alert severity="info">{data.offline || data.availability?.groups === false ? 'Groups cannot be loaded from your family server right now.' : 'No groups yet. Create one — every member of the network can.'}</Alert>}
    </Stack>}
    {creating && <CreateGroupDialog data={data} actions={actions} onClose={() => setCreating(false)} onCreate={onCreate} />}
  </Box>;
}

// PORCH-089: the on-face MembersCard is retired — the roster, per-member
// Remove, the visibility control, and Add members all live as views inside
// the group settings menu (GroupSettingsMenu), off the group's face. The
// AddMembersDialog (below) is the shipped add flow the menu's Members view
// rides unchanged.

function CreateGroupDialog({ data, actions, onClose, onCreate }) {
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState('private');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // New groups default private (PORCH-068 ac-1, the ruling's [Assumed]
  // default); the creator picks public explicitly at creation.
  const save = async () => {
    if (!name.trim()) { setError('A group needs a name.'); return; }
    setSaving(true);
    setError('');
    try { await onCreate(name, visibility); } catch (cause) { setError(messageOf(cause)); setSaving(false); }
  };
  return <Dialog open onClose={onClose} aria-label="Create a group">
    <DialogTitle>Create a group</DialogTitle>
    <DialogContent>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>A space within {data.network?.name ?? 'your family network'}. You create it, you add its members — its posts stay inside the network.</Typography>
      <TextField autoFocus fullWidth label="Group name" value={name} onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') void save(); }} error={Boolean(error)} helperText={error} />
      <FormControl fullWidth sx={{ mt: 2 }}>
        <InputLabel id="group-visibility-label">Who can see it</InputLabel>
        <Select labelId="group-visibility-label" label="Who can see it" value={visibility} onChange={(event) => setVisibility(event.target.value)}>
          <MenuItem value="private">Private — invite-only; only members see its posts</MenuItem>
          <MenuItem value="public">Public — the whole network can view its posts</MenuItem>
        </Select>
      </FormControl>
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
      {!candidates && !error && <LanternLoader label="Reading the roster" />}
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
// PORCH-084: the one on-demand composer per comment surface. The open
// target stays legible — the composer names the comment or post it answers
// (replyingTo caption) — and a displaced draft persists per target through
// the surface-held draft map (initialText/onDraft) so switching targets
// mid-draft never silently loses text.
function ReplyForm({ label, onSubmit, offline, post, actions, replyingTo = null, initialText = '', onDraft = null, onDone = null }) {
  const [text, setText] = useState(initialText);
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
    onDraft?.(value);
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
      onDraft?.('');
      onDone?.();
    });
  }}>
    {replyingTo && <Typography variant="caption" color="text.secondary" data-testid="reply-target">{`Replying to ${replyingTo}`}</Typography>}
    <Box ref={fieldRef} sx={{ position: 'relative' }}>
      <TextField
        fullWidth
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

function Reply({ reply, depth, children, data, post, navigate, composerFor = null, onReplyTarget = null, rowLifecycle = null, composerSlot = null }) {
  const id = identityOf(reply);
  const composer = composerSlot?.(id) ?? null;
  return <Box sx={{ ml: { xs: Math.min(depth, 3) * 1.5, sm: Math.min(depth, 4) * 3 }, pl: 2, py: 1.5, borderLeft: '2px solid', borderColor: 'divider' }}>
    <Typography variant="subtitle2">{reply.author?.name ?? reply.authorName ?? memberName(reply.authorDid, data)} <Typography component="span" variant="caption" color="text.secondary">{dateOf(reply.createdAt)}</Typography></Typography>
    <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{renderReplyBody(reply, data, navigate)}</Typography>
    {reply.preview && <LinkPreviewBlock preview={reply.preview} origin={previewOrigin(post, data)} />}
    {/* PORCH-084: the row's Reply action points the column's one composer at
        this comment. PORCH-099 (Brian, Oct 18): that one composer mounts in
        context — beneath the row it answers, one rung into this row's tree
        — never at the bottom of the conversation.
        PORCH-094: the row's own overflow carries its lifecycle affordances,
        authority-gated exactly as the card slice renders them. */}
    {depth < 8 && <Stack direction="row" spacing={0.5} alignItems="center">
      <Button size="small" onClick={() => onReplyTarget?.(id === composerFor ? null : id)}>Reply</Button>
      {rowLifecycle && <CommentOverflow row={reply} data={data}
        onEdit={rowLifecycle.onEdit ?? null} onDelete={rowLifecycle.onDelete ?? null} />}
    </Stack>}
    {composer && <Box sx={{ ml: { xs: 1.5, sm: 3 }, pl: 2 }}>{composer}</Box>}
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
  // PORCH-084 (ac-3): the conversation column renders no composer by
  // default; the Reply action — on the post or on any comment row — opens
  // exactly one composer per surface at a time, and each target holds its
  // own draft so switching targets never silently loses text mid-draft.
  const [composerFor, setComposerFor] = useState(null); // null | 'post' | comment id
  const [drafts] = useState(() => new Map());
  // The group settings menu (PORCH-089 ac-1) serves the group post's detail
  // view: the post's group detail read feeds the menu the authority flags
  // and the resolved notification state; a groupless post renders no menu.
  const [detailGroup, setDetailGroup] = useState(null);
  const [groupRevision, setGroupRevision] = useState(0);
  const openComposer = (target) => setComposerFor(target);
  const holdDraft = (target, text) => { if (text) drafts.set(target, text); else drafts.delete(target); };
  const readDraft = (target) => drafts.get(target);
  // Comment lifecycle parity (PORCH-094 ac-4): the detail column rides the
  // same authority gating, the same one-composer edit mode, and the same
  // confirm-then-live-tombstone delete flow as the card slice.
  const [editFor, setEditFor] = useState(null); // null | comment id
  const [commentDelete, setCommentDelete] = useState(null);
  const editThatComment = (row) => { setComposerFor(null); setEditFor(identityOf(row)); };
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
  // The menu's detail read rides the loaded post's group (never a foreign
  // surface's state); a menu write re-reads the group so the rendered rows
  // and presentation agree with hub-served state.
  useEffect(() => {
    const groupId = post?.groupId;
    if (!groupId || data.offline || typeof actions.loadGroupDetail !== 'function') { setDetailGroup(null); return undefined; }
    let current = true;
    Promise.resolve().then(() => actions.loadGroupDetail(groupId))
      .then((result) => { if (current) setDetailGroup(result?.group ?? null); })
      .catch(() => { if (current) setDetailGroup(null); });
    return () => { current = false; };
  }, [post?.groupId, data.offline, actions.loadGroupDetail, groupRevision]);
  const comments = thread?.id === selectedId ? thread.comments : [];
  const replies = comments.filter((reply) => (!reply.postId || reply.postId === identityOf(post)) && (!reply.networkId || !originOf(post) || String(reply.networkId) === String(originOf(post))));
  // The open target stays legible: the composer names the comment it answers.
  const composerTargetReply = composerFor && composerFor !== 'post'
    ? replies.find((reply) => identityOf(reply) === composerFor) : null;
  const composerTargetName = composerTargetReply
    ? composerTargetReply.author?.name ?? composerTargetReply.authorName ?? memberName(composerTargetReply.authorDid, data)
    : 'this comment';
  // PORCH-099 (Brian, Oct 18): a reply to a comment composes in context —
  // the one on-demand composer mounts directly beneath the comment it
  // answers, one rung into that comment's tree (the thread's composerSlot),
  // never at the bottom of the conversation. Surface law holds: one
  // composer state per column, keyed by the answered comment id, drafts
  // per target.
  const composerSlot = (rowId) => composerFor === rowId ? <ReplyForm
    key={composerFor}
    label="Your reply"
    replyingTo={composerTargetName}
    post={post}
    actions={actions}
    initialText={readDraft(composerFor)}
    onDraft={(text) => holdDraft(composerFor, text)}
    onDone={() => { setComposerFor(null); holdDraft(composerFor, ''); }}
    onSubmit={(body, mentions) => submit(body, composerFor, mentions)}
  /> : null;
  const submit = async (body, parentId, mentions) => {
    const result = await invoke(actions, 'submitReply', post, body, parentId, mentions);
    if (!result?.comment || identityOf(result.comment) === '' || result.comment.postId !== identityOf(post)) throw new Error('The family server did not confirm this reply. Reload the conversation before trying again.');
    setThread((current) => current?.id === selectedId ? { ...current, comments: [...current.comments, result.comment] } : current);
    return result;
  };
  // Comment edit (ac-4): text swaps in place optimistically and reverts
  // exactly when the signed write fails; the composer closes on success.
  const submitThatCommentEdit = async (row, body) => {
    const id = identityOf(row);
    const snapshot = thread?.comments;
    setThread((current) => current?.id === selectedId
      ? { ...current, comments: current.comments.map((item) => (identityOf(item) === id ? { ...item, body } : item)) }
      : current);
    try {
      const result = await invoke(actions, 'editComment', post, id, body);
      setThread((current) => current?.id === selectedId
        ? { ...current, comments: current.comments.map((item) => (identityOf(item) === id ? { ...item, body } : item)) }
        : current);
      setEditFor(null);
      holdDraft(`edit:${id}`, '');
      return result;
    } catch (failure) {
      if (snapshot) setThread((current) => current?.id === selectedId ? { ...current, comments: snapshot } : current);
      throw failure;
    }
  };
  // Comment delete (ac-3/ac-4): the row and its loaded subtree leave the
  // column in the same frame as the confirm; a failed write restores the
  // exact pre-action rows. An open composer whose target is deleted closes
  // cleanly with its draft held for reopen (ac-5).
  const removeThatComment = async (row) => {
    const id = identityOf(row);
    const snapshot = thread?.comments;
    const cascade = removedTreeIds(snapshot ?? [], id, []);
    setThread((current) => current?.id === selectedId
      ? { ...current, comments: (current.comments ?? []).filter((item) => !cascade.has(identityOf(item))) }
      : current);
    if (composerFor === id) setComposerFor(null);
    if (editFor === id) setEditFor(null);
    try {
      const result = await invoke(actions, 'deleteComment', post, id);
      return result;
    } catch (failure) {
      if (snapshot) setThread((current) => current?.id === selectedId ? { ...current, comments: snapshot } : current);
      throw failure;
    }
  };
  return <Box sx={{ maxWidth: 1120, mx: 'auto' }}>
    <Button onClick={() => navigate?.('/timeline')} sx={{ mb: 2 }}>Back to timeline</Button>
    {loading && !data.offline && <LanternLoader label="Loading conversation" />}
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
      <PostCard post={post} data={data} actions={actions} navigate={navigate} detail reactionState={reactionState} onHide={() => navigate?.('/timeline')}
        groupMenu={detailGroup ? <GroupSettingsMenu group={detailGroup} data={data} actions={actions}
          onchanged={() => setGroupRevision((at) => at + 1)} /> : null} />
      <Box sx={{ minWidth: 0 }}>
        <PresentReactions post={post} data={data} actions={actions} reactionState={reactionState} />
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 2, mb: 1 }}>
          <Typography variant="h6">Replies</Typography>
          {!data.offline && <Button size="small" data-testid="detail-reply" onClick={() => { setEditFor(null); openComposer('post'); }}>Reply</Button>}
        </Stack>
        {/* PORCH-084 (ac-3/ac-4): the on-demand composer rides the full
            conversation column width — never an always-visible input, and
            nothing shrunken renders anywhere on the surface.
            PORCH-099 (Brian, Oct 18): the post-target composer mounts here,
            beside the post it answers; the comment-target composer mounts
            in the thread beneath the row it answers (composerSlot) — never
            at the conversation's bottom. One composer per surface. */}
        {!data.offline && composerFor === 'post' && <ReplyForm
          key={composerFor}
          label="Write a reply"
          replyingTo="this post"
          post={post}
          actions={actions}
          initialText={readDraft(composerFor)}
          onDraft={(text) => holdDraft(composerFor, text)}
          onDone={() => { setComposerFor(null); holdDraft(composerFor, ''); }}
          onSubmit={(body, mentions) => submit(body, null, mentions)}
        />}
        {!data.offline && (replies.length ? <ReplyThread comments={replies} post={post} data={data} actions={actions} navigate={navigate} composerFor={composerFor} onReplyTarget={openComposer} composerSlot={composerSlot}
          rowLifecycle={{
            onEdit: editThatComment,
            onDelete: (row) => setCommentDelete(row),
          }} /> : <Typography color="text.secondary">Be the first to reply.</Typography>)}
        {/* PORCH-084/PORCH-094: this block is the comment's edit mode — one
            composer per surface. The reply composers mount in context
            (PORCH-099): the post target beside the heading (above), the
            comment targets beneath the rows they answer (composerSlot),
            never at the conversation's bottom. */}
        {editFor && !data.offline && (() => {
          const editRow = replies.find((reply) => identityOf(reply) === editFor);
          return <CommentEditForm
            key={`edit:${editFor}`}
            row={editRow}
            initialText={readDraft(`edit:${editFor}`) ?? editRow?.body ?? ''}
            onDraft={(text) => holdDraft(`edit:${editFor}`, text)}
            onDone={() => setEditFor(null)}
            // Cancel (Brian, Oct 16, 2026): the composer closes with the row
            // exactly as it stood and the staged draft is dropped — a fresh
            // Edit loads the comment's current text again.
            onCancel={() => { setEditFor(null); holdDraft(`edit:${editFor}`, ''); }}
            onSubmit={(body) => submitThatCommentEdit(editRow, body)}
          />;
        })()}
      </Box>
      {/* The comment's one delete confirmation (PORCH-094 ac-3), identical on
          the detail column and the card slice: ruled question, cascade note,
          cancel mutates nothing. */}
      <Dialog open={Boolean(commentDelete)} onClose={() => setCommentDelete(null)} fullWidth maxWidth="xs">
        <DialogTitle>Delete this comment?</DialogTitle>
        <DialogContent>
          <Typography>This comment and the replies that follow it are removed. This cannot be undone here.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCommentDelete(null)}>Cancel</Button>
          <Button color="error" variant="contained" data-testid="confirm-delete-comment"
            onClick={async () => {
              const row = commentDelete;
              setCommentDelete(null);
              try { await removeThatComment(row); } catch { /* handled: exact rows restored */ }
            }}>Delete comment</Button>
        </DialogActions>
      </Dialog>
    </Box>}
  </Box>;
}

function mediaIds(result) {
  const values = Array.isArray(result) ? result : Array.isArray(result?.mediaRefs) ? result.mediaRefs : Array.isArray(result?.media) ? result.media : result?.mediaId || result?._id ? [result] : [];
  return values.map((entry) => typeof entry === 'string' ? entry : entry?.mediaId ?? entry?._id ?? entry?.id).filter(Boolean);
}

export function Compose({ open, onClose, data = {}, actions = {}, target = null }) {
  const [type, setType] = useState('text');
  const [body, setBody] = useState('');
  const [caption, setCaption] = useState('');
  const [groupId, setGroupId] = useState('');
  const [files, setFiles] = useState([]);
  // Link preview (PORCH-052): compose-time chip. The hub resolves the pasted
  // URL once (bounded fetch, the hub's own call — no member-device third-
  // party request); the chip is removable, and a resolution that fails or
  // degrades renders nothing and never blocks submit (the URL stays in the
  // body as a plain link).
  const [preview, setPreview] = useState(null);
  const [previewAttached, setPreviewAttached] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const lastResolvedRef = useRef(null);
  const operation = useOperation();
  const reset = () => { setBody(''); setCaption(''); setFiles([]); setGroupId(''); setType('text'); setPreview(null); setPreviewAttached(true); setPreviewLoading(false); lastResolvedRef.current = null; };
  const mediaType = type !== 'text';
  // PORCH-068 ac-4: the composer offers only the groups the author belongs
  // to — the write target picker never shows another member's group (the
  // server refuses group-targeted writes from non-members; the gate is
  // server-enforced, this keeps the picker honest).
  const groups = composableGroups(groupRows(data.groups, data.network?.id), data.identity?.id);
  // PORCH-096 (Brian, Oct 16 2026, compose pre-population ruling): the
  // location control pre-populates from context — opening from a group
  // surface pre-sets that group, opening from the main timeline pre-sets
  // the general timeline. Not implicit, not silent: the target is always
  // visible and pre-set the moment the card opens. A context target the
  // author's option law does not hold (a non-member group, a foreign
  // network) falls back to the general timeline rather than pre-setting
  // what the control never offers.
  const presetRef = useRef(composePresetLocationId(target, groups, data.identity?.id));
  presetRef.current = composePresetLocationId(target, groups, data.identity?.id);
  const lastOpenRef = useRef(false);
  useEffect(() => {
    // Only the open transition pre-sets: a staged choice never loses to a
    // roster refresh that re-renders the preset while the card is open.
    if (open && !lastOpenRef.current) setGroupId(presetRef.current);
    lastOpenRef.current = open;
  }, [open]);
  // Debounce-tolerant detection: one resolve per distinct URL once typing
  // settles — mid-typing URL fragments don't fire hub fetches (bounded
  // fetch hygiene); the chip re-arms on URL change and no chip at all when
  // the URL leaves the body.
  useEffect(() => {
    if (mediaType) { setPreview(null); lastResolvedRef.current = null; return undefined; }
    const url = firstUrlIn(body);
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
  }, [body, mediaType, actions]);
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
        const result = await invoke(actions, 'submitPost', { type, body: mediaType ? null : body.trim(), caption: mediaType ? caption.trim() || null : null, mediaRefs, groupId: groupId || null, previewId: !mediaType && preview && previewAttached && preview.id ? preview.id : null });
        if (!result?.post || !identityOf(result.post)) throw new Error('The family server did not confirm this post. Refresh your timeline before trying again.');
        return result;
      }, () => { reset(); onClose?.(); });
    }}>
      <DialogContent><Stack spacing={2}>
        {data.offline && <Alert severity="warning">Posting is unavailable while your family server is unreachable. Your draft stays here.</Alert>}
        <FormControl fullWidth><InputLabel id="post-type-label">Post type</InputLabel><Select labelId="post-type-label" label="Post type" value={type} onChange={(event) => { setType(event.target.value); setFiles([]); }}><MenuItem value="text">Text</MenuItem><MenuItem value="photo">Photo</MenuItem><MenuItem value="video">Video</MenuItem><MenuItem value="audio">Audio</MenuItem></Select></FormControl>
        {/* PORCH-096: the location control — the same control the edit
            composer carries — always renders: the target is visible and
            pre-set before any send, even when the author holds no groups
            (the general timeline is the only row). */}
        <FormControl fullWidth><InputLabel id="post-location-label">Post to</InputLabel><Select labelId="post-location-label" label="Post to" data-testid="compose-location" value={groupId} onChange={(event) => setGroupId(event.target.value)}><MenuItem value="">General timeline</MenuItem>{groups.map((group) => <MenuItem key={identityOf(group)} value={identityOf(group)}>{group.name}</MenuItem>)}</Select></FormControl>
        {mediaType ? <><Button variant="outlined" component="label">Choose {type}<input hidden type="file" accept={type === 'photo' ? 'image/*' : `${type}/*`} multiple={type === 'photo'} onChange={(event) => { setFiles(Array.from(event.target.files || [])); event.target.value = ''; }} /></Button><Typography variant="body2" color="text.secondary">{files.length ? files.map((file) => file.name).join(', ') : 'Choose an original file to upload before publishing.'}</Typography>
        {type === 'photo' && <ComposerPreviewCarousel files={files} />}
        <TextField label="Caption (optional)" multiline minRows={2} value={caption} onChange={(event) => setCaption(event.target.value)} /></> : <>
        <TextField autoFocus label="Your post" multiline minRows={4} value={body} onChange={(event) => setBody(event.target.value)} />
        {preview && previewAttached && <Chip
          label={preview.kind === 'embed' ? `${(preview.provider ?? 'link')}: tap-to-play link attached` : `Link preview attached`}
          onDelete={() => setPreviewAttached(false)}
          sx={{ alignSelf: 'flex-start', maxWidth: '100%' }}
        />}
        {previewLoading && <Typography variant="caption" color="porchlight.muted">Resolving the link preview…</Typography>}
      </>}
        {operation.error && <Alert severity="error">{operation.error}</Alert>}
      </Stack></DialogContent>
      <DialogActions><Button disabled={operation.busy} onClick={onClose}>Cancel</Button><Button variant="contained" type="submit" disabled={operation.busy || data.offline || (mediaType ? !files.length : !body.trim())}>{operation.busy ? <LanternLoader size={20} label="Publishing your moment" glow="var(--porch-boot-core)" style={{ color: 'var(--porch-amber-ink)', minWidth: 28, minHeight: 28 }} /> : 'Publish'}</Button></DialogActions>
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
