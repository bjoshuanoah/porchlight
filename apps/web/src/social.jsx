import React, { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import {
  Alert, Avatar, Box, Button, Card, CardContent, Chip, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogTitle, Divider, FormControl, IconButton, InputLabel, List, ListItemButton,
  ListItemText, Menu, MenuItem, Paper, Popover, Select, Snackbar, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import {
  AddReactionOutlined, ArrowDownwardOutlined, ArrowUpwardOutlined, ChevronLeft, ChevronRight,
  FullscreenOutlined, MoreHorizOutlined, PauseOutlined, PlayArrowOutlined, ReplayOutlined,
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
import { AvatarFace } from './avatar-face.js';
import { LampMark } from './brand.jsx';
import { reactionRowsOf, ownEmojiRows, reflectReaction, optimisticToggle } from './reactions.js';
import { groupRows, groupMemberRows, canManageGroup, addableCandidates, composableGroups, groupVisibility, canJoinGroup, blockedRows } from './groups.js';
import { dateOf, relativeTime } from './time.js';
import { identityOf, originOf, networkId, originName, visibleAtOrigin, postKey, visibleFeedPosts } from './feed-filter.js';
import { sliceDisplay, expanderCount, reconcileConfirmed, repliesByParent, pendingReply, conversationOf } from './slice.js';
import { LinkPreviewBlock, LinkedBody } from './link-preview.jsx';
import { firstUrlIn, previewOrigin } from './link-preview.js';
import { sharePost } from './share.js';

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

// Reaction bar (PORCH-036): a visual emoji picker opens from the small
// add-reaction smile control — no step ever asks the member to type, paste,
// or know an emoji string. Only the emoji actually present render, with no
// counts and no who-reacted inspection surface; per-member rows identify
// the member's own reaction for the warm highlight exclusively. Tapping an
// emoji the member already reacted with clears it and tapping any other
// adds it: change or clear, never an error (ac-2, ac-3). The row reflection
// lives in the shared reactions module, so the timeline card and the post
// detail reflect the same origin conversation through one routine (PORCH-038).
function PresentReactions({ post, data, actions, reactionState, spacingY = 2, actionBar = null }) {
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
  const emojis = [...new Set((rows ?? []).map((row) => row.emoji))].map((emoji) => {
    const ownEmoji = own.has(emoji);
    return <Chip key={emoji} label={emoji} size="small" aria-pressed={ownEmoji}
      aria-label={ownEmoji ? `Your reaction ${emoji}` : `Reaction ${emoji}`}
      sx={{
        minHeight: 40, minWidth: 40, fontSize: 20,
        ...(ownEmoji ? { bgcolor: 'porchlight.amberSoft', border: '1px solid', borderColor: 'porchlight.amber', color: 'text.primary' } : {}),
      }} />;
  });
  return <>
    <Stack direction="row" spacing={actionBar ? 0 : 1} alignItems="center" flexWrap="wrap"
      sx={{ mt: spacingY, ...(actionBar ? { justifyContent: 'flex-start', gap: '8px' } : {}) }}
      aria-label={actionBar ? 'Post actions' : 'Reactions from your family'}>
      {actionBar}
      {!actionBar && emojis}
      <Tooltip title="React"><span><IconButton aria-label={actionBar ? 'React' : 'Add a reaction'}
        aria-haspopup="dialog" disabled={operation.busy || Boolean(data?.offline)}
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={actionBar ? { width: 36, height: 36, p: 0, '&::after': { content: '""', position: 'absolute', inset: -4 } } : { width: 40, height: 40, border: `1px dashed ${cssVars.borderStrong}` }}>
        <AddReactionOutlined fontSize="small" />
      </IconButton></span></Tooltip>
    </Stack>
    {actionBar && emojis.length > 0 && <Stack direction="row" spacing={1} flexWrap="wrap"
      aria-label="Reactions from your family" sx={{ mt: photoFirst.spacing.actionsReactions / 8 }}>{emojis}</Stack>}
    {anchor && <Suspense fallback={<CircularProgress size={20} />}>
      <EmojiPicker open anchorEl={anchor} onClose={() => setAnchor(null)} own={own} onToggle={toggle} busy={operation.busy} />
    </Suspense>}
    {operation.error && <Typography variant="caption" color="error" sx={{ width: '100%' }}>{operation.error}</Typography>}
  </>;
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
  const [menuAnchor, setMenuAnchor] = useState(null);
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
  if (localHidden || actions?.isHidden?.(post) || !visibleAtOrigin(post, data)) return null;
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
              {post.groupName && <Chip label={post.groupName} size="small" sx={{ bgcolor: 'porchlight.amberSoft', color: 'primary.main', fontSize: '0.6875rem', height: '24px' }} />}
              <Typography variant="caption" color="porchlight.muted">{dateOf(post.createdAt)}</Typography>
            </Stack>
          </Box>
        </Stack>
        <Box>
          <IconButton aria-label="Post options" aria-haspopup="menu" aria-expanded={Boolean(menuAnchor)}
            onClick={(event) => setMenuAnchor(event.currentTarget)}><MoreHorizOutlined /></IconButton>
          <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
            {!detail && <MenuItem onClick={() => { setMenuAnchor(null); openPost(); }}>Open conversation</MenuItem>}
            <MenuItem onClick={runShare}>Share</MenuItem>
            <MenuItem disabled={operation.busy} onClick={() => {
              setMenuAnchor(null);
              operation.run(() => invoke(actions, 'hide', post), () => { setLocalHidden(true); onHide?.(post); });
            }}>Hide</MenuItem>
          </Menu>
        </Box>
      </Stack>
      {/* Rhythm (PORCH-043 vertical table): 25–30% tighter post-internal
          spacing; the body line stays 16px/25px on the timeline with the
          readable 68ch length. */}
      {(post.body || post.caption) && <Box sx={{ mt: detail ? 2 : 1 }}>
        {post.body && <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: detail ? 17 : 16, lineHeight: detail ? '27px' : '25px', maxWidth: '68ch' }}><LinkedBody text={post.body} /></Typography>}
        {post.caption && <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: detail ? 17 : 16, lineHeight: detail ? '27px' : '25px', maxWidth: '68ch', ...(post.body ? { mt: 0.5 } : {}) }}><LinkedBody text={post.caption} /></Typography>}
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
            <Tooltip title="Reply"><span><IconButton aria-label="Reply" aria-expanded={replying}
              disabled={data.offline} sx={compactIconSx} onClick={() => setReplying(!replying)}
            ><ReplyOutlined fontSize="small" /></IconButton></span></Tooltip>
          </>} />}
      {!detail && replying && !data.offline && <ReplyForm
        label="Write a reply"
        offline={data.offline}
        post={post}
        actions={actions}
        onSubmit={(body, mentions) => submitOptimistic(body, null, mentions)}
      />}
      {detail && <PresentReactions post={post} data={data} actions={actions} reactionState={reactionState} />}
      {!detail && <ReplySliceBlock key={identityOf(post)} post={post} slice={displaySlice} data={data}
        actions={actions} offline={data.offline} origin={previewOrigin(post, data)}
        onReply={submitOptimistic} navigate={navigate} />}
      {shareNote && <Typography color="text.secondary" role="status" sx={{ mt: 1 }}>{shareNote}</Typography>}
      {shareError && <Alert severity="warning" sx={{ mt: 1 }}>{shareError}</Alert>}
      {/* The fallback outcome's in-view confirmation (PORCH-078): the same
          strings the card foot reports, surfaced where the member is. */}
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

// The hub decorates four roots and descendant counts. Full history is read
// only when someone expands comments or a response tree; both open on the
// card, preserving the feed's reading position and origin boundary.
function ReplySliceBlock({ post, slice, data, actions, offline, origin, onReply, navigate }) {
  const [loaded, setLoaded] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [expandedRoots, setExpandedRoots] = useState(() => new Set());
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
      if (active && Array.isArray(result?.comments)) setLoaded(scoped(result.comments));
    }).catch(() => {});
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a changed decorated slice refreshes an open thread
  }, [signature]);
  const byParent = repliesByParent(loaded ?? []);
  const roots = showAll && loaded
    ? repliesByParent([...loaded, ...slice.replies.filter((row) => !loaded.some((item) => identityOf(item) === identityOf(row)))]).get('') ?? []
    : slice.replies;
  const more = showAll ? 0 : expanderCount(slice.total);
  if (!roots.length && !more) return null;
  const expand = async (id) => {
    if (offline || busy) return;
    if (!await load()) return;
    if (id) setExpandedRoots((current) => new Set(current).add(id));
    else setShowAll(true);
  };
  const submitNested = async (body, parentId, mentions) => {
    const result = await onReply(body, parentId, mentions);
    if (result?.comment && scoped([result.comment]).length) {
      setLoaded((current) => current ? [...current, result.comment] : current);
    }
    return result;
  };
  const renderRow = (reply, depth = 0, seen = new Set(), rootId = identityOf(reply)) => {
    const id = identityOf(reply);
    if (!id || seen.has(id)) return null;
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
          {!offline && depth < 8 && <Button size="small" onClick={() => setEditingId(editingId === id ? null : id)}
            sx={{ px: 0, minWidth: 0 }}>Reply</Button>}
          {editingId === id && <ReplyForm label="Your reply" offline={offline} post={post} actions={actions}
            onSubmit={(body, mentions) => submitNested(body, id, mentions)} />}
          {!open && count > 0 && <Button size="small" disabled={offline || busy}
            onClick={() => expand(id)} sx={{ display: 'block', px: 0, minWidth: 0, color: 'secondary.main' }}>
            {`View ${count} more responses`}
          </Button>}
        </Box>
      </Stack>
      {open && children.map((child) => renderRow(child, depth + 1, nextSeen, rootId))}
    </Box>;
  };
  return <Box sx={{ mt: photoFirst.spacing.reactionsSlice / 8, borderTop: '1px solid', borderColor: photoFirst.dividerColor, pt: 1.25 }}>
    <Stack spacing={1}>{roots.map((reply) => renderRow(reply))}</Stack>
    {more > 0 && <Button size="small" disabled={offline || busy} onClick={() => expand(null)}
      sx={{ mt: 1, px: 0, minWidth: 0, fontSize: 14, fontWeight: 600, color: 'secondary.main' }}>
      {`View ${more} more comments`}
    </Button>}
    {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
  </Box>;
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
    <Heading title={group?.name ?? 'Groups'} subtitle="Spaces within your family network" />
    {data.offline && <Alert severity="warning" sx={{ mb: 2 }}>Groups may be out of date while your family server is unreachable.</Alert>}
    {selectedId && <Button sx={{ mb: 2 }} onClick={() => navigate?.('/groups')}>All groups</Button>}
    {loading && <CircularProgress aria-label="Loading group" size={24} />}
    {loadError && <Alert severity="error">{loadError}</Alert>}
    {selectedId && !group && !loading && !loadError && <Alert severity="info">{data.offline ? 'This group is not saved on this device. Reconnect to check it.' : 'This group is not available in your network.'}</Alert>}
    {group && !loading && !loadError && <Stack spacing={2}>
      <Typography color="text.secondary">Posts in {group.name} stay within {data.network?.name ?? 'this family network'}. Each post shows its origin.</Typography>
      {canJoinGroup(group, data.identity?.id) && <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
        <Button variant="contained" onClick={() => void onJoin()} disabled={joining} data-testid="join-group">Join group</Button>
        <Typography color="text.secondary">Join to see {group.name}'s posts in your own feed.</Typography>
      </Stack>}
      {joinError && <Alert severity="error">{joinError}</Alert>}
      <MembersCard group={group} data={data} actions={actions} onchanged={() => setRevision((at) => at + 1)} />
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

function MembersCard({ group, data, actions, onchanged }) {
  const [adding, setAdding] = useState(false);
  const [visibilityError, setVisibilityError] = useState('');
  const [memberError, setMemberError] = useState('');
  const [acting, setActing] = useState(false);
  const manage = canManageGroup(group, data);
  const roster = groupMemberRows(group);
  const blocked = blockedRows(group);
  // Visibility (PORCH-068 ac-1): the managing member flips the group
  // between private (invite-only) and public (the network views it).
  const flipVisibility = async () => {
    const next = groupVisibility(group) === 'public' ? 'private' : 'public';
    setVisibilityError('');
    try { await invoke(actions, 'updateGroupVisibility', group._id ?? group.id, next); onchanged?.(); }
    catch (cause) { setVisibilityError(messageOf(cause)); }
  };
  // Removal lifecycle (PORCH-068, Brian's Oct 14 rulings): the managing
  // member's removal writes the blocked entry atomically; the unblock act
  // lifts it. The member's own posts stay.
  const actOnMember = async (action, did) => {
    setMemberError('');
    setActing(true);
    try {
      await invoke(actions, action, group._id ?? group.id, did);
      onchanged?.();
    } catch (cause) { setMemberError(messageOf(cause)); }
    setActing(false);
  };
  return <Card variant="outlined"><CardContent>
    <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
      <Typography variant="h6">Members</Typography>
      {manage && <Button onClick={() => setAdding(true)} data-testid="add-group-members">Add members</Button>}
    </Stack>
    <Typography color="text.secondary" sx={{ mb: 1 }}>
      {groupVisibility(group) === 'public' ? 'Public — every member of the network can view this group and its posts.' : 'Private — invite-only; only members see this group and its posts.'}
      {manage ? (group.createdBy === data.identity?.id ? ' You created this group; you add its members.' : ' Only the group\'s creator (or the network owner) adds members.') : ''}
    </Typography>
    {manage && <Button size="small" sx={{ mb: 1 }} onClick={() => void flipVisibility()} data-testid="toggle-group-visibility">
      {groupVisibility(group) === 'public' ? 'Make private' : 'Make public'}
    </Button>}
    {visibilityError && <Alert severity="error">{visibilityError}</Alert>}
    <List dense disablePadding>
      {roster.map((member) => <ListItemButton key={member.did} disableGutters
        secondaryAction={manage && member.did !== data.identity?.id ? (
          <Button size="small" disabled={acting} data-testid="remove-group-member" onClick={() => void actOnMember('removeGroupMember', member.did)}>
            Remove
          </Button>
        ) : undefined}>
        <ListItemText primary={member.name ?? (member.did === data.identity?.id ? 'You' : member.did)}
          secondary={member.did === data.identity?.id && member.name ? 'You' : undefined} />
      </ListItemButton>)}
    </List>
    {manage && memberError && <Alert severity="error">{memberError}</Alert>}
    {manage && blocked.length > 0 && <Stack spacing={1} sx={{ mt: 2 }}>
      <Typography color="text.secondary">Removed — they cannot re-join until you unblock them.</Typography>
      <List dense disablePadding>
        {blocked.map((row) => <ListItemButton key={row.did} disableGutters>
          <ListItemText primary={row.did === data.identity?.id ? 'You' : row.did} />
          <Button size="small" disabled={acting} data-testid="unblock-group-member" onClick={() => void actOnMember('unblockGroupMember', row.did)}>
            Unblock
          </Button>
        </ListItemButton>)}
      </List>
    </Stack>}
    {adding && <AddMembersDialog group={group} actions={actions} onClose={() => setAdding(false)}
      onAdded={() => { setAdding(false); onchanged?.(); }} />}
  </CardContent></Card>;
}

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
    {reply.preview && <LinkPreviewBlock preview={reply.preview} origin={previewOrigin(post, data)} />}
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
        {groups.length > 0 && <FormControl fullWidth><InputLabel id="post-group-label">Group (optional)</InputLabel><Select labelId="post-group-label" label="Group (optional)" value={groupId} onChange={(event) => setGroupId(event.target.value)}><MenuItem value="">Entire network</MenuItem>{groups.map((group) => <MenuItem key={identityOf(group)} value={identityOf(group)}>{group.name}</MenuItem>)}</Select></FormControl>}
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
