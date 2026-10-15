// Photo Viewer (PORCH-082) — the JSX half of the pair (Brian, Oct 15, 2026;
// build contract TS §10 on the Porchlight UI initiative). The fading media
// overlay control (ac-1), the full-screen zoomable paged viewer (ac-2, ac-3,
// ac-5), and the branded end-card (ac-4) live here. Components stay in the
// posts component family's conventions: MUI primitives under the Porchlight
// theme, palette tokens only (the viewer composes over the PORCH-042 dark
// token set — its dark surface of record rides photo-viewer.js), motion on
// the established 140–220ms ease, and no counts and no engagement surface.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, IconButton, Stack, Typography } from '@mui/material';
import { CloseOutlined, OpenInFullOutlined, PhotoLibraryOutlined } from '@mui/icons-material';
import { mediaBlobKey, readMediaBlob, putMediaBlob } from './media-blob.js';
import { carouselIndex } from './photo-first.js';
import { mediaFileName, renditionSrc, rungKindForViewport, stampedAspect } from './media-rung.js';
import { originOf } from './feed-filter.js';
import {
  DEFAULT_ZOOM, DOUBLE_TAP_MS, FADE_MS, POSITION_HOLD_MS, motion, viewerTokens,
  fitDimensions, needsOriginal, panBounds, pinchTo, viewerTotalCount, wheelZoom, zoomTo,
} from './photo-viewer.js';

// Reduced motion rides CSS, not a JS mode read: the fade class carries the
// reduced-motion override in its own sx block — screen files carry no
// device-preference reads (the PORCH-042 screen-file audit).
function fade() {
  return {
    transition: `opacity ${FADE_MS}ms ${motion.ease}`,
    '@media (prefers-reduced-motion: reduce)': { transition: 'opacity 0ms linear' },
  };
}

const settleSx = {
  transition: `transform ${FADE_MS}ms ${motion.ease}`,
  '@media (prefers-reduced-motion: reduce)': { transition: 'transform 0ms linear' },
};

// ac-1: the fading overlay control. One instance per media element, top-
// right, inside the media bounds: a translucent dark scrim behind a
// glass-strength blur carrying exactly two actions — "↓ Original" and the
// expand icon. Revealed by hover (pointer devices) or tap (touch), it fades
// with the media chrome on the established easing, and while faded its hit
// area is disabled (pointer-events: none) so swipes and page gestures pass
// through untouched. Share is absent by contract: it rides the ··· menus.
export function MediaOverlay({ shown, onDownload, onExpand, downloadBusy = false }) {
  return <Stack
    aria-label="Media overlay"
    onClick={(event) => event.stopPropagation()}
    onTouchStart={(event) => event.stopPropagation()}
    onPointerDown={(event) => event.stopPropagation()}
    direction="row" spacing={0.25} alignItems="center"
    sx={{
      position: 'absolute', top: 8, right: 8, zIndex: 2,
      bgcolor: viewerTokens.scrim, backdropFilter: viewerTokens.backdropBlur, WebkitBackdropFilter: viewerTokens.backdropBlur,
      borderRadius: 9999, px: 0.75, py: 0.25,
      opacity: shown ? 1 : 0, pointerEvents: shown ? 'auto' : 'none',
      ...fade(),
    }}>
    <Button size="small" disabled={downloadBusy} onClick={onDownload}
      sx={{ px: 0.75, minWidth: 0, fontSize: 14, fontWeight: 600, color: viewerTokens.text }}>↓ Original</Button>
    {onExpand && <IconButton size="small" aria-label="View full screen" onClick={onExpand}
      sx={{ color: viewerTokens.text }}><OpenInFullOutlined fontSize="small" /></IconButton>}
  </Stack>;
}

// A viewer slide's photo: renditions render at fit (rendition-default
// ruling, PORCH-044); the blob loader answers the no-worker fallback path
// with the viewport rung from the identity-keyed blob cache. While zoomed
// past rendition resolution the fetched original bytes take the src (the
// audited member action, cached once per photo for the session).
function ViewerSlidePhoto({ post, id, actions, origin, originalUrl, active, zoom, fit }) {
  const meta = post?.mediaMeta?.[id] ?? null;
  const direct = Boolean(meta && actions?.mediaTransport && renditionSrc(meta, origin));
  const [resource, setResource] = useState(null);
  useEffect(() => {
    if (direct) return undefined;
    const kind = meta ? rungKindForViewport(meta, window.innerWidth, window.devicePixelRatio || 1) : 'original';
    const identity = mediaBlobKey({ origin, mediaId: id, kind: kind ?? 'original', version: null });
    const cached = readMediaBlob(identity);
    if (cached) { setResource(cached); return undefined; }
    let live = true;
    Promise.resolve().then(() => (typeof actions?.getMedia === 'function'
      ? actions.getMedia(id, kind ?? 'original', origin, null)
      : Promise.reject(new Error('Media is not available here yet.')))).then(async (blob) => {
      if (!(blob instanceof Blob) || !live) return;
      const url = URL.createObjectURL(blob);
      const row = putMediaBlob(identity, { url, blob, shape: {} });
      setResource(row);
    }).catch(() => { /* the slide shows the reserved frame; the overlay download stays reachable */ });
    return () => { live = false; };
  }, [id, origin, direct]);
  const zoomed = active && zoom.scale > 1;
  const url = originalUrl ?? (direct ? renditionSrc(meta, origin) : resource?.url);
  if (!url) {
    return <Box aria-label="Loading photo" sx={{
      ...(fit ? { width: fit.width, height: fit.height } : {}),
      aspectRatio: stampedAspect(meta) ?? 1.5, maxWidth: '100%', maxHeight: '100%',
      bgcolor: viewerTokens.subtle, borderRadius: 1,
    }} />;
  }
  const transform = active && zoom.scale !== 1
    ? `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})`
    : undefined;
  const box = fit
    ? { width: fit.width, height: fit.height }
    : { maxWidth: '100%', maxHeight: '100%', aspectRatio: stampedAspect(meta) ?? 1.5 };
  return <Box component="img" src={url} alt={post.caption || 'Shared photo'}
    draggable={false}
    sx={{
      display: 'block', objectFit: 'contain', ...box,
      transform, willChange: zoomed ? 'transform' : undefined,
      userSelect: 'none', WebkitUserSelect: 'none',
      // Direct manipulation never interpolates; the settle back to fit does.
      ...(zoomed ? {} : settleSx),
    }} />;
}

function PluralImages(count) {
  return `${count} full-resolution image${count === 1 ? '' : 's'}`;
}

// ac-4: the branded end-card, rendered as the sequence's LAST SLIDE inside
// the paged surface (never a popup): thumbnail-stack icon, heading, the
// quantity line, and the strong amber primary button (48px class). Tapping
// it fetches the set zip via the bulk-original archive route and hands the
// download to the browser; in-flight state is plain language and failures
// name their state with a clean retry on the same button.
function EndCardSlide({ count, onBulk }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setError('');
    setBusy(true);
    try { await onBulk(); }
    catch (failure) { setError(failure?.message || 'That did not work. Please try again.'); }
    finally { setBusy(false); }
  };
  return <Box aria-roledescription="slide" aria-label="Download all originals"
    sx={{ flex: '0 0 100%', width: '100%', minWidth: 0, scrollSnapAlign: 'start', scrollSnapStop: 'always',
      display: 'flex', alignItems: 'center', justifyContent: 'center', p: 3 }}>
    <Stack spacing={2} alignItems="center" sx={{ maxWidth: 420, textAlign: 'center' }}>
      <PhotoLibraryOutlined sx={{ fontSize: 44, color: viewerTokens.amber }} />
      <Typography variant="h3" sx={{ color: viewerTokens.text }}>Download all originals</Typography>
      <Typography variant="body2" sx={{ color: viewerTokens.textSecondary }}>{PluralImages(count)}</Typography>
      <Button variant="contained" disabled={busy} onClick={run}
        sx={{ height: 48, px: 3, borderRadius: 9999, minWidth: 220, bgcolor: viewerTokens.amber,
          '&:hover': { bgcolor: viewerTokens.amberHover }, color: viewerTokens.amberInk }}>
        {busy ? 'Fetching your originals…' : 'Download all originals'}
      </Button>
      {error && <Alert severity="error" sx={{ width: '100%' }}>{error}</Alert>}
    </Stack>
  </Box>;
}

// The full-screen viewer (ac-2, ac-3, ac-5): a fixed full-viewport overlay
// with a warm dark backdrop from the PORCH-042 dark tokens (never cold
// gray), media centered with object-fit contain on geometry stamps (zero
// reflow at open and page change), pinch/pan/double-tap zoom anchored at
// the gesture point, scroll-wheel and double-click zoom on desktop, native
// scroll-snap paging with the end-card as the last slide, a 4s auto-fading
// position indicator, and a chrome row carrying close and the original
// download. Browser history and Escape both exit it; close returns to the
// surface exactly as the member left it.
export function PhotoViewer({ post, ids, actions, startIndex = 0, onClose }) {
  const photos = (Array.isArray(ids) ? ids : []).filter(Boolean);
  const origin = post?.origin ?? originOf(post);
  const total = viewerTotalCount(photos.length);
  const [position, setPosition] = useState(Math.min(Math.max(startIndex, 0), Math.max(0, photos.length - 1)));
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 });
  const [chromeUp, setChromeUp] = useState(true);
  const [originalUrl, setOriginalUrl] = useState(null);
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const trackRef = useRef(null);
  const chromeTimer = useRef(null);
  const originals = useRef(new Map());
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const onEndCard = photos.length > 0 && position === photos.length;
  const activeId = !onEndCard ? photos[Math.min(position, photos.length - 1)] : null;
  const activeMeta = activeId ? (post?.mediaMeta?.[activeId] ?? null) : null;
  const fit = activeMeta?.width && activeMeta?.height
    ? fitDimensions(activeMeta.width, activeMeta.height, viewport.width, viewport.height)
    : null;
  const fitRef = useRef(fit);
  fitRef.current = fit;
  // Measured fit for media without stamped geometry: the rendered box (its
  // zoom transform divided out) is the contain-fit surface every gesture
  // math anchors against.
  const fitOfTarget = (target) => {
    if (fitRef.current) return fitRef.current;
    try {
      const rect = target?.getBoundingClientRect?.();
      if (!rect || !(rect.width > 0)) return null;
      const scale = zoomRef.current.scale || 1;
      return { width: rect.width / scale, height: rect.height / scale };
    } catch { return null; }
  };

  // Chrome (indicator + close/download row) reveals immediately on open,
  // re-renders on every page change and chrome reveal, then fades after the
  // ruled 3–5s hold. While faded it never intercepts gestures.
  const revealChrome = useCallback(() => {
    setChromeUp(true);
    if (chromeTimer.current) clearTimeout(chromeTimer.current);
    chromeTimer.current = setTimeout(() => setChromeUp(false), POSITION_HOLD_MS);
  }, []);
  useEffect(() => {
    revealChrome();
    return () => { if (chromeTimer.current) clearTimeout(chromeTimer.current); };
  }, [revealChrome]);

  useEffect(() => {
    const measure = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const closeViewer = useCallback(() => {
    if (window.history.state?.porchlightPhotoViewer) window.history.back();
    else closeRef.current?.();
  }, []);

  // ac-5: the viewer pushes one history entry so back exits it; page scroll
  // and the underlying carousel's scroll position are untouched (the overlay
  // owns no page geometry; the lock restores exactly what it held).
  useEffect(() => {
    const root = document.documentElement;
    const prevOverflow = root.style.overflow;
    root.style.overflow = 'hidden';
    window.history.pushState({ porchlightPhotoViewer: true }, '');
    const onPop = () => closeRef.current?.();
    const onKey = (event) => { if (event.key === 'Escape') closeViewer(); };
    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey);
    return () => {
      root.style.overflow = prevOverflow;
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('keydown', onKey);
    };
  }, [closeViewer]);

  // Wheel zoom (desktop): anchored at the cursor; while zoomed the wheel
  // keeps zooming (pan is the drag gesture). Native listeners only: MUI/
  // React wheel handlers are passive and cannot preventDefault.
  useEffect(() => {
    const node = trackRef.current;
    if (!node) return undefined;
    const onWheel = (event) => {
      event.preventDefault();
      const current = fitOfTarget(event.target);
      if (!current) return;
      const ax = event.clientX - viewport.width / 2;
      const ay = event.clientY - viewport.height / 2;
      setZoom((prev) => wheelZoom(prev, event.deltaY, ax, ay, viewport.width, viewport.height, current.width, current.height));
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport]);

  // Double-click zoom (desktop): toggles between fit and the default zoom.
  useEffect(() => {
    const node = trackRef.current;
    if (!node) return undefined;
    const onDoubleClick = (event) => {
      const current = fitOfTarget(event.target);
      if (!current) return;
      event.preventDefault();
      const ax = event.clientX - viewport.width / 2;
      const ay = event.clientY - viewport.height / 2;
      setZoom((prev) => zoomTo(prev, prev.scale > 1 ? 1 : DEFAULT_ZOOM, ax, ay,
        viewport.width, viewport.height, current.width, current.height));
    };
    const onClick = () => revealChrome();
    node.addEventListener('dblclick', onDoubleClick);
    node.addEventListener('click', onClick);
    return () => {
      node.removeEventListener('dblclick', onDoubleClick);
      node.removeEventListener('click', onClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, revealChrome]);

  // Touch gestures on one native layer (the track): two-finger pinch zoom
  // anchored at the gesture midpoint; single-finger pan while zoomed; at
  // fit the single-finger horizontal drag scrolls the native snap track
  // (the PORCH-045 carousel mechanics of record) and a tap reveals chrome.
  // Vertical single-finger drags chain to nothing (the page is locked) but
  // never page: the track has no vertical overflow.
  const pinchRef = useRef(null);
  const panRef = useRef(null);
  const lastTapRef = useRef(null);
  const tapRef = useRef(null);
  useEffect(() => {
    const node = trackRef.current;
    if (!node) return undefined;
    const midpoint = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
    const distance = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const anchor = (x, y) => ({ x: x - viewport.width / 2, y: y - viewport.height / 2 });
    const onTouchStart = (event) => {
      if (event.touches.length === 2) {
        const current = fitOfTarget(event.target);
        if (!current) return;
        const [a, b] = event.touches;
        pinchRef.current = {
          startDistance: distance(a, b),
          startZoom: zoomRef.current,
          mid: midpoint(a, b),
        };
        event.preventDefault();
      } else if (event.touches.length === 1) {
        const touch = event.touches[0];
        tapRef.current = { x: touch.clientX, y: touch.clientY, moved: false };
        if (zoomRef.current.scale > 1) {
          panRef.current = { x: touch.clientX, y: touch.clientY };
          event.preventDefault();
        }
      }
    };
    const onTouchMove = (event) => {
      const current = fitRef.current;
      if (pinchRef.current && event.touches.length >= 2 && current) {
        const [a, b] = event.touches;
        const mid = midpoint(a, b);
        const anchored = anchor(mid.x, mid.y);
        event.preventDefault();
        setZoom(pinchTo(pinchRef.current.startZoom, pinchRef.current.startDistance, distance(a, b),
          anchored.x, anchored.y, viewport.width, viewport.height, current.width, current.height));
      } else if (panRef.current && event.touches.length === 1) {
        const touch = event.touches[0];
        const dx = touch.clientX - panRef.current.x;
        const dy = touch.clientY - panRef.current.y;
        panRef.current = { x: touch.clientX, y: touch.clientY };
        if (tapRef.current) tapRef.current.moved = true;
        event.preventDefault();
        setZoom((prev) => {
          const bounds = panBounds(prev.scale, viewport.width, viewport.height, current?.width ?? Infinity, current?.height ?? Infinity);
          return { ...prev, x: Math.min(bounds.x, Math.max(-bounds.x, prev.x + dx)), y: Math.min(bounds.y, Math.max(-bounds.y, prev.y + dy)) };
        });
      }
    };
    const onTouchEnd = (event) => {
      if (pinchRef.current) {
        pinchRef.current = null;
        setZoom((prev) => {
          if (prev.scale <= 1.05) return { scale: 1, x: 0, y: 0 };
          const current = fitRef.current;
          if (!current) return prev;
          const bounds = panBounds(prev.scale, viewport.width, viewport.height, current.width, current.height);
          return { ...prev, x: Math.min(bounds.x, Math.max(-bounds.x, prev.x)), y: Math.min(bounds.y, Math.max(-bounds.y, prev.y)) };
        });
        return;
      }
      panRef.current = null;
      const touch = event.changedTouches[0];
      const tap = tapRef.current;
      tapRef.current = null;
      if (!tap || tap.moved || !fitOfTarget(event.target)) return;
      const now = performance.now();
      const prior = lastTapRef.current;
      if (prior && now - prior.at <= DOUBLE_TAP_MS && Math.hypot(prior.x - tap.x, prior.y - tap.y) <= 40) {
        lastTapRef.current = null;
        const anchored = anchor(tap.x, tap.y);
        event.preventDefault();
        setZoom((prev) => zoomTo(prev, prev.scale > 1 ? 1 : DEFAULT_ZOOM, anchored.x, anchored.y,
          viewport.width, viewport.height, fitRef.current.width, fitRef.current.height));
        return;
      }
      lastTapRef.current = { at: now, x: tap.x, y: tap.y };
      revealChrome();
    };
    const onTouchCancel = () => { pinchRef.current = null; panRef.current = null; tapRef.current = null; };
    node.addEventListener('touchstart', onTouchStart, { passive: false });
    node.addEventListener('touchmove', onTouchMove, { passive: false });
    node.addEventListener('touchend', onTouchEnd, { passive: false });
    node.addEventListener('touchcancel', onTouchCancel);
    return () => {
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('touchend', onTouchEnd);
      node.removeEventListener('touchcancel', onTouchCancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, revealChrome]);

  // Mouse pan while zoomed: pointer events, captured so the drag runs to
  // the release even past the media frame.
  useEffect(() => {
    const node = trackRef.current;
    if (!node || zoom.scale <= 1) return undefined;
    let dragging = null;
    const onPointerDown = (event) => {
      if (event.pointerType === 'touch') return;
      dragging = { x: event.clientX, y: event.clientY };
      node.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    };
    const onPointerMove = (event) => {
      if (!dragging) return;
      const dx = event.clientX - dragging.x;
      const dy = event.clientY - dragging.y;
      dragging = { x: event.clientX, y: event.clientY };
      const current = fitRef.current;
      if (!current) return;
      setZoom((prev) => {
        const bounds = panBounds(prev.scale, viewport.width, viewport.height, current.width, current.height);
        return { ...prev, x: Math.min(bounds.x, Math.max(-bounds.x, prev.x + dx)), y: Math.min(bounds.y, Math.max(-bounds.y, prev.y + dy)) };
      });
    };
    const onPointerUp = (event) => {
      if (!dragging) return;
      dragging = null;
      node.releasePointerCapture?.(event.pointerId);
    };
    node.addEventListener('pointerdown', onPointerDown);
    node.addEventListener('pointermove', onPointerMove);
    node.addEventListener('pointerup', onPointerUp);
    node.addEventListener('pointercancel', onPointerUp);
    return () => {
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', onPointerUp);
      node.removeEventListener('pointercancel', onPointerUp);
    };
  }, [zoom.scale, viewport]);

  // While zoomed, paging is suspended: the track stops scrolling and swipes
  // pan the media instead; back at fit the native snap track resumes.
  useEffect(() => {
    const track = trackRef.current;
    if (track) track.style.overflowX = zoom.scale > 1 ? 'hidden' : 'auto';
  }, [zoom.scale]);

  // ac-2: the audited original fetch fires only when the zoom's pixel need
  // passes the largest rendition rung; fit browsing triggers none, and the
  // cache keeps it to exactly one fetch per photo.
  useEffect(() => {
    if (!activeId || !fit) return undefined;
    if (!needsOriginal(activeMeta, zoom.scale, viewport.width, window.devicePixelRatio || 1)) return undefined;
    const cached = originals.current.get(activeId);
    if (cached) { setOriginalUrl(cached); return undefined; }
    let live = true;
    (typeof actions?.getMedia === 'function' ? actions.getMedia(activeId, 'original', origin, null) : Promise.reject(new Error('Media is not available here yet.')))
      .then((blob) => {
        if (!(blob instanceof Blob) || !live) return;
        const url = URL.createObjectURL(blob);
        originals.current.set(activeId, url);
        setOriginalUrl(url);
      })
      .catch(() => { /* the zoomed rendition renders on; the fetch stays quiet */ });
    return () => { live = false; };
  }, [activeId, activeMeta, fit, zoom.scale, viewport, actions, origin]);
  const originalFor = onEndCard ? null : (needsOriginal(activeMeta, zoom.scale, viewport.width, window.devicePixelRatio || 1)
    ? (originalUrl ?? (activeId ? originals.current.get(activeId) : null)) : null);

  const handleScroll = (event) => {
    const track = event.currentTarget;
    const next = carouselIndex(track.scrollLeft, track.clientWidth, total);
    if (next !== position) {
      setPosition(next);
      setZoom({ scale: 1, x: 0, y: 0 });
      setOriginalUrl(null);
      revealChrome();
    }
  };

  const [downloadError, setDownloadError] = useState('');
  const downloadOriginal = async () => {
    if (!activeId) return;
    if (typeof actions?.getMedia !== 'function') throw new Error('Media is not available here yet.');
    const blob = await actions.getMedia(activeId, 'original', origin, null);
    if (!(blob instanceof Blob)) throw new Error('Your hub did not return the original.');
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = mediaFileName(activeId, blob);
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const downloadActive = () => {
    setDownloadError('');
    return downloadOriginal().catch((failure) => setDownloadError(failure?.message || 'That did not work. Please try again.'));
  };

  const chips = {
    position: 'absolute', left: '50%', bottom: 'calc(20px + env(safe-area-inset-bottom))',
    transform: 'translateX(-50%)', zIndex: 3, px: 1.5, py: 0.5, borderRadius: 9999,
    bgcolor: viewerTokens.scrim, backdropFilter: viewerTokens.backdropBlur, WebkitBackdropFilter: viewerTokens.backdropBlur,
    opacity: chromeUp ? 1 : 0, pointerEvents: 'none', ...fade(),
  };

  return <Box role="dialog" aria-modal="true" aria-label="Photo viewer"
    sx={{
      position: 'fixed', inset: 0, zIndex: 1300, bgcolor: viewerTokens.page,
      color: viewerTokens.text, userSelect: 'none', WebkitUserSelect: 'none',
    }}>
    <Box ref={trackRef} onScroll={handleScroll} sx={{
      display: 'flex', width: '100%', height: '100%', overflowX: 'auto', overflowY: 'hidden',
      scrollSnapType: 'x mandatory', scrollBehavior: 'auto', overscrollBehaviorX: 'contain',
      touchAction: 'pan-x pan-y', scrollbarWidth: 'none',
      '&::-webkit-scrollbar': { display: 'none' },
    }}>
      {photos.map((id) => (
        <Box key={id} aria-roledescription="slide"
          sx={{ flex: '0 0 100%', width: '100%', minWidth: 0, scrollSnapAlign: 'start', scrollSnapStop: 'always',
            display: 'flex', alignItems: 'center', justifyContent: 'center', p: 0 }}>
          <ViewerSlidePhoto post={post} id={id} actions={actions} origin={origin}
            originalUrl={originalFor} active={!onEndCard} zoom={zoom} fit={fit} />
        </Box>
      ))}
      {photos.length > 0 && <EndCardSlide count={photos.length} onBulk={async () => {
        if (typeof actions?.bulkOriginals !== 'function') throw new Error('Bulk download is not available here yet.');
        await actions.bulkOriginals(post);
      }} />}
    </Box>
    <Stack direction="row" spacing={0.25} alignItems="center" aria-label="Viewer controls"
      sx={{
        position: 'absolute', top: 'calc(8px + env(safe-area-inset-top))', right: 8, zIndex: 3,
        bgcolor: viewerTokens.scrim, backdropFilter: viewerTokens.backdropBlur, WebkitBackdropFilter: viewerTokens.backdropBlur,
        borderRadius: 9999, px: 0.75, py: 0.25, boxShadow: 2,
        opacity: chromeUp ? 1 : 0, pointerEvents: chromeUp ? 'auto' : 'none', ...fade(),
      }}>
      {activeId && <Button size="small" onClick={() => downloadActive()}
        sx={{ px: 0.75, minWidth: 0, fontSize: 14, fontWeight: 600, color: viewerTokens.text }}>↓ Original</Button>}
      <IconButton size="small" aria-label="Close" onClick={closeViewer} sx={{ color: viewerTokens.text }}><CloseOutlined fontSize="small" /></IconButton>
    </Stack>
    {downloadError && <Alert severity="error" sx={{
      position: 'absolute', top: 'calc(48px + env(safe-area-inset-top))', left: '50%', transform: 'translateX(-50%)',
      zIndex: 3, maxWidth: 'min(92vw, 480px)',
    }}>{downloadError}</Alert>}
    <Typography component="div" aria-label={`Image ${Math.min(position + 1, total)} of ${total}`}
      sx={{ ...chips, fontSize: 12, lineHeight: '20px', color: viewerTokens.text }}>
      {position + 1}/{total}
    </Typography>
  </Box>;
}