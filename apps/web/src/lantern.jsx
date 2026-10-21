// PORCH-118: the loading experience rides Brian's supplied animated webp
// — the asset of record, committed at build into the SPA's static assets
// (public/loader.webp with public/loader-still.webp as the static first
// frame). LanternBoot (the initial-launch boot surface, variant="boot";
// variant="surface" doubles as the loading state for flows that hold a
// full screen, with the flow's own copy as the status line) and
// LanternLoader (the small in-app mark for genuinely empty or blocked
// surfaces) both render the mark animating from its own webp frames — the
// PORCH-095 drawn vector-twin choreography (facet climb, node glow, one
// pulse) is retired from the loading path by the Oct 21, 2026 ruling.
// Fades, dissolves, and status lines stay CSS; no spinner library, no
// skeleton library, no third-party animation runtime enters the bundle
// (build contract). Copy and timing constants of record:
// src/loader-assets.js; the palette of record: src/theme.js bootTokens
// (--porch-boot-*), one navy canvas in both display modes.
//
// Hierarchy rule: LanternLoader renders only in its own reserved,
// centered space — it is never fixed, never overlays the feed, and never
// replaces visible content; where content already renders, the standing
// machinery (skeletons, reserved media frames) is untouched. Timeout
// honesty rides the call sites: they keep their error/timeout branches,
// so a stuck operation yields to the connection-state/error pattern, never
// an eternal mark.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  BOOT_FADE_MS, BOOT_MARK_H, LOADER_MARK_H,
  LOADER_ANIM_SRC, LOADER_ANIM_W, LOADER_ANIM_H, LOADER_STILL_SRC,
  bootStatusLine,
} from "./loader-assets.js";
import { getAppReady, onAppReady } from "./appready.js";

// The boot's mode-invariant brand palette rides the theme token layer
// (--porch-boot-* custom properties). No literal color appears here
// (PORCH-042).
const V = {
  bg: "var(--porch-boot-bg)", ink: "var(--porch-boot-ink)", status: "var(--porch-boot-status-ink)",
};

// CSS only: the mark animates from its own webp frames; this block carries
// only the reduced-motion swap (the static first frame replaces the
// animated asset on both surfaces) — no animation runtime, no keyframe
// choreography. The dissolve keyframes (porch95-fade) stay live.
const CSS = `
@keyframes porch95-fade { from { opacity: 1; } to { opacity: 0; } }
.porch118-webp { display: block; }
.porch118-webp-still { display: none; }
/* prefers-reduced-motion: both load states render the asset's static
   first frame (the plain fade/dissolve itself stays live). */
@media (prefers-reduced-motion: reduce) {
  .porch118-webp { display: none; }
  .porch118-webp-still { display: block; }
}
`;

/** The loader mark — the animated webp of record, still frame under reduced motion. */
function Mark({ height = BOOT_MARK_H }) {
  const style = { height, width: "auto" };
  return (
    <>
      <img className="porch118-webp" src={LOADER_ANIM_SRC} width={LOADER_ANIM_W} height={LOADER_ANIM_H}
        alt="" aria-hidden="true" focusable="false" style={style} />
      <img className="porch118-webp-still" src={LOADER_STILL_SRC} width={LOADER_ANIM_W} height={LOADER_ANIM_H}
        alt="" aria-hidden="true" focusable="false" style={style} />
    </>
  );
}

// The dissolve class the adopted pre-JS canvas takes on readiness (the
// static layer carries the same keyframes block as the React fallback;
// both ride porch95-fade).
export const BOOT_FADE_CLASS = "porch95-boot-fade";

/**
 * LanternBoot — variant="boot" (default) is the app's first paint. The
 * animated webp itself lives in the static pre-JS canvas (index.html): the
 * boot's only guaranteed window on a cold load is the bundle-download
 * span, and the mark animates there from the first byte. The app's first
 * surface becomes ready in the same commit LanternBoot mounts (readiness
 * is React mount), so the React layer never replays the animation on a
 * healthy load — it *adopts* the static canvas: manages the status lines
 * past the copy threshold (elapsed measured from navigation start — the
 * boot's true start), rides readiness, dissolves the canvas, and removes
 * it. When no static canvas exists (the React layer renders standalone,
 * tests, or a surface flow), it renders its own identical layer.
 * variant="surface" is the boot doubling as the full-screen loading state
 * for flows that hold a page (device-link consume, session open behind
 * WhoIsHere): `status` rides the flow's own copy hook and the parent
 * unmounts it when the flow resolves — the loader never outlives its
 * context.
 */
export function LanternBoot({
  variant = "boot",
  status = null,
  fadeMs = BOOT_FADE_MS,
  readiness = { getAppReady, onAppReady },
  now = () => Date.now(),
  onHide,
}) {
  const [fading, setFading] = useState(false);
  const [gone, setGone] = useState(false);
  const [line, setLine] = useState(status);
  const bootedAtRef = useRef(null);
  const fadingRef = useRef(false);

  useLayoutEffect(() => {
    const staticBoot = document.getElementById("porch-boot");
    if (variant === "boot" && staticBoot) {
      // The pre-JS canvas keeps playing; this layer only manages status,
      // readiness, and the dissolve. Boot start = navigation start.
      bootedAtRef.current = now() - (typeof performance !== "undefined" ? performance.now() : 0);
      return;
    }
    // Surface flow or standalone render: the pre-JS canvas stays where it
    // is (identical navy beneath this layer; the boot variant that adopted
    // it dissolves and removes it — nothing here may orphan it, or the
    // adopting layer would fall back to a second full canvas).
    bootedAtRef.current = now();
  }, []);

  useEffect(() => {
    if (variant !== "boot") return undefined;
    if (readiness.getAppReady()) {
      setFading(true);
      return undefined;
    }
    return readiness.onAppReady(() => setFading(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- readiness binding is boot-lifetime
  }, []);

  useEffect(() => {
    if (variant !== "boot" || status != null) return undefined;
    const tick = () => {
      if (!fadingRef.current && bootedAtRef.current != null) {
        setLine(bootStatusLine(now() - bootedAtRef.current));
      }
    };
    tick();
    const iv = setInterval(tick, 250);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- status ticks run the boot's lifetime
  }, [variant, status]);

  // Status line onto whichever canvas is live: the adopted static layer
  // carries it beneath the wordmark, the rendered layer states it inline.
  useEffect(() => {
    const staticBoot = document.getElementById("porch-boot");
    if (variant === "boot" && staticBoot) {
      let node = staticBoot.querySelector(".porch95-statusline");
      if (!line) { node?.remove(); return undefined; }
      if (!node) {
        node = document.createElement("div");
        node.className = "porch95-statusline";
        staticBoot.appendChild(node);
      }
      node.textContent = line;
      node.style.color = V.status;
      node.style.fontSize = "14px";
      node.style.fontFamily = "Inter, system-ui, sans-serif";
      node.style.paddingTop = "4px";
      return undefined;
    }
    return undefined;
  }, [line, variant]);

  // The dissolve: opacity to 0 over fadeMs, then the layer leaves the DOM
  // entirely (adopted canvas or rendered layer alike). A fade that never
  // fires (hidden tabs, instant paths) still ends on the bounded timer —
  // never a stuck layer, never a timer that ends the boot by itself.
  useEffect(() => {
    if (!fading) return undefined;
    fadingRef.current = true;
    onHide?.();
    const staticBoot = document.getElementById("porch-boot");
    if (staticBoot) staticBoot.classList.add(BOOT_FADE_CLASS);
    const done = setTimeout(() => {
      staticBoot?.remove();
      setGone(true);
    }, fadeMs + 80);
    return () => clearTimeout(done);
  }, [fading, fadeMs]);

  const hasDoc = typeof document !== "undefined";
  if (hasDoc && variant === "boot" && document.getElementById("porch-boot") && !gone) {
    // Adopting: the static canvas is the boot. Nothing extra renders — the
    // layer is purely a readiness/status manager.
    return null;
  }
  if (gone) return null;
  return (
    <div style={{
      position: "fixed", top: 0, right: 0, bottom: 0, left: 0,
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      gap: 16, background: V.bg, zIndex: variant === "surface" ? 2147483100 : 2147483000,
      // The boot is never an interaction wall: the app beneath stays
      // interactive the frame the fade completes (and passes clicks through
      // even earlier).
      pointerEvents: "none",
      ...(fading ? { animation: `porch95-fade ${fadeMs}ms ease-out forwards` } : null),
    }}
      className="porch95-bootlayer" role="status">
      <style>{CSS}</style>
      <Mark />
      <div style={{
        color: V.ink, fontSize: 21, fontWeight: 650, letterSpacing: ".02em",
        fontFamily: "Inter, system-ui, sans-serif",
      }}>Porchlight</div>
      {line && <div style={{
        color: V.status, fontSize: 14, fontFamily: "Inter, system-ui, sans-serif",
        paddingTop: 4,
      }}>{line}</div>}
    </div>
  );
}

/**
 * LanternLoader — the small in-app loading mark: the animated webp of
 * record at `size` CSS px tall, centered in its own reserved space. The
 * mark animates from its own frames; prefers-reduced-motion renders the
 * asset's static first frame. Callers pass their own aria label. It never
 * renders fixed, never overlays content, and never outlives its operation:
 * the call sites keep their error/timeout branches, so a stuck write
 * resolves to the error pattern, never an eternal mark.
 */
export function LanternLoader({ size = LOADER_MARK_H, label, style }) {
  const pad = Math.round(size * 0.35);
  return (
    <div role="status" aria-label={label} style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      minWidth: size + pad * 2, minHeight: size + pad * 2,
      ...style,
    }}>
      <style>{CSS}</style>
      <Mark height={size} />
    </div>
  );
}