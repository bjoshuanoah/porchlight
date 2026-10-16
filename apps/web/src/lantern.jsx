// PORCH-095: the loading experience — LanternBoot (the initial-launch boot
// surface, variant="boot"; variant="surface" doubles as the loading state
// for flows that hold a full screen, with the flow's own copy as the status
// line) and LanternLoader (the small in-app mark for genuinely empty or
// blocked surfaces). This is a sanctioned bespoke component family: the
// surfaces are deliberately mode-invariant (one navy canvas, both display
// modes) outside the MUI theme's surface system, and the animation composes
// from the mark's node geometry (src/lantern-geometry.js) with CSS
// transitions — no spinner library, no skeleton library, no third-party
// loader enters the bundle (build contract, Brian Oct 16, 2026).
//
// Hierarchy rule: LanternLoader renders only in its own reserved,
// centered space — it is never fixed, never overlays the feed, and never
// replaces visible content; where content already renders, the standing
// machinery (skeletons, reserved media frames) is untouched.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  BOOT_MARK_SIZE, LOADER_MARK_SIZE,
  BOOT_FADE_MS, FACETS, FACET_RAMP_MS, NODES,
  NODE_LEVEL_DELAY, NODE_GLOW_OFFSET_MS, NODE_GLOW_SETTLE_MS, PULSE_DELAY_MS,
  PULSE_MS, MARK_VIEWBOX, bootStatusLine, GLOW_LOOP_PATH,
  GLOW_LOOP_MS,
} from "./lantern-geometry.js";
import { getAppReady, onAppReady } from "./appready.js";

// The boot's mode-invariant brand palette rides the theme token layer
// (src/theme.js bootTokens → --porch-boot-* custom properties, one navy
// canvas in both display modes). No literal color appears here (PORCH-042):
// the ramp, glow, and pulse compose from those properties.
const V = {
  bg: "var(--porch-boot-bg)", ink: "var(--porch-boot-ink)", status: "var(--porch-boot-status-ink)",
  frame: "var(--porch-boot-frame)", frameDim: "var(--porch-boot-frame-dim)",
  facet: "var(--porch-boot-facet)", core: "var(--porch-boot-core)", node: "var(--porch-boot-node)",
  glowDim: "var(--porch-boot-glow-dim)", glowBloom: "var(--porch-boot-glow-bloom)",
  glowRest: "var(--porch-boot-glow-rest)", glowHalo: "var(--porch-boot-glow-halo)",
};

// One style block carries every animation of the family — CSS only, no
// third-party animation runtime. The one-pulse rule is literal: the boot's
// pulse keyframe runs exactly once (fill both, no infinite); only the
// loader's candlelight circuit loops.
const CSS = `
@keyframes porch95-facet-ramp { from { fill: ${V.frameDim}; opacity: .5; } to { fill: ${V.facet}; opacity: 1; } }
@keyframes porch95-core-ramp { from { fill: ${V.frameDim}; opacity: .5; } to { fill: ${V.core}; opacity: 1; } }
@keyframes porch95-frame-ramp { from { stroke: ${V.frameDim}; } to { stroke: ${V.frame}; } }
@keyframes porch95-node-glow {
  0% { fill: ${V.frameDim}; opacity: .4; filter: none; }
  35% { fill: ${V.node}; opacity: 1; filter: drop-shadow(0 0 6px ${V.glowHalo}); }
  100% { fill: ${V.frame}; opacity: .95; filter: none; }
}
@keyframes porch95-pulse {
  0% { filter: drop-shadow(0 0 4px ${V.glowDim}); }
  45% { filter: drop-shadow(0 0 22px ${V.glowBloom}); }
  100% { filter: drop-shadow(0 0 10px ${V.glowRest}); }
}
@keyframes porch95-circuit {
  0% { offset-distance: 0%; opacity: 0; }
  10% { opacity: .85; }
  90% { opacity: .85; }
  100% { offset-distance: 100%; opacity: 0; }
}
@keyframes porch95-fade { from { opacity: 1; } to { opacity: 0; } }
.porch95-mark { animation: porch95-pulse ${PULSE_MS}ms ease-in-out ${PULSE_DELAY_MS}ms both; }
.porch95-facet-el { animation: porch95-facet-ramp ${FACET_RAMP_MS}ms ease-out both; }
.porch95-core-el { animation: porch95-core-ramp ${FACET_RAMP_MS}ms ease-out both; }
.porch95-frame-el { animation: porch95-frame-ramp ${FACETS[2].delay + FACET_RAMP_MS}ms linear both; }
.porch95-node-el { animation: porch95-node-glow ${NODE_GLOW_SETTLE_MS}ms ease-out both; }
.porch95-circuit-el { offset-path: path('${GLOW_LOOP_PATH}'); offset-rotate: 0deg; animation: porch95-circuit ${GLOW_LOOP_MS}ms linear infinite; }
/* prefers-reduced-motion: the boot renders the static fully-lit mark with
   the plain fade into the app; the loader renders a static small mark. */
@media (prefers-reduced-motion: reduce) {
  .porch95-mark, .porch95-facet-el, .porch95-core-el, .porch95-frame-el, .porch95-node-el, .porch95-circuit-el { animation: none !important; }
  .porch95-facet-el { fill: ${V.facet} !important; opacity: 1 !important; }
  .porch95-core-el { fill: ${V.core} !important; opacity: 1 !important; }
  .porch95-frame-el { stroke: ${V.frame} !important; }
  .porch95-node-el { fill: ${V.frame} !important; opacity: .95 !important; filter: none !important; }
  .porch95-circuit-el { opacity: 0 !important; }
}
`;

function bootLayerStyle(z) {
  return {
    position: "fixed", top: 0, right: 0, bottom: 0, left: 0,
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    gap: 16, background: V.bg, zIndex: z,
    // The boot is never an interaction wall: the app beneath stays
    // interactive the frame the fade completes (and passes clicks through
    // even earlier).
    pointerEvents: "none",
  };
}

/** The lantern mark for the boot climb — dim first paint, staggered warm ramp. */
function BootMark({ size = BOOT_MARK_SIZE }) {
  const height = Math.round(size * 132 / 120);
  return (
    <svg className="porch95-mark" viewBox={MARK_VIEWBOX} width={size} height={height}
      aria-hidden="true" focusable="false" style={{ display: "block" }}>
      <g className="porch95-facet-el" style={{ animationDelay: `${FACETS[0].delay}ms` }}>
        <path d={FACETS[0].path} />
      </g>
      <g className="porch95-facet-el" style={{ animationDelay: `${FACETS[1].delay}ms` }}>
        <path d={FACETS[1].path} />
      </g>
      <g className="porch95-facet-el" style={{ animationDelay: `${FACETS[2].delay}ms` }}>
        <path d={FACETS[2].path} />
      </g>
      <ellipse className="porch95-core-el" cx="60" cy="52" rx="9" ry="12"
        style={{ animationDelay: `${FACETS[1].delay}ms` }} />
      <g className="porch95-frame-el" fill="none" strokeWidth="2.5" strokeLinejoin="round">
        <path d="M40 30 L52 16 L68 16 L80 30" />
        <path d="M46 30 H74 V36 H46" />
        <path d="M48 36 L72 36 L76 58 L44 58" />
        <path d="M44 58 L76 58 L70 88 L50 88" />
        <path d="M50 88 H70 V94 H50" />
        <path d="M52 94 V99 M68 94 V99" />
        <path d="M60 9 V16" />
        <circle cx="60" cy="6" r="3" />
      </g>
      {NODES.map((node) => (
        <circle key={`${node.cx}:${node.cy}`} className="porch95-node-el" cx={node.cx} cy={node.cy} r="2.2"
          style={{ animationDelay: `${NODE_LEVEL_DELAY[node.level] + NODE_GLOW_OFFSET_MS}ms` }} />
      ))}
    </svg>
  );
}

/** The small in-app mark — the loader's reserved-space instance. */
export function LoaderMark({ size = LOADER_MARK_SIZE, glow = "var(--porch-boot-node)" }) {
  const height = Math.round(size * 132 / 120);
  return (
    <svg viewBox={MARK_VIEWBOX} width={size} height={height}
      aria-hidden="true" focusable="false" style={{ display: "block", color: "currentColor", overflow: "visible" }}>
      <g fill="currentColor">
        <path d="M44 58 L76 58 L70 88 L50 88 Z" opacity=".3" />
        <path d="M48 36 L72 36 L76 58 L44 58 Z" opacity=".45" />
        <path d="M40 30 L52 16 L68 16 L80 30 Z" opacity=".55" />
      </g>
      <ellipse cx="60" cy="52" rx="7.5" ry="10" fill="currentColor" opacity=".92" />
      <g fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round">
        <path d="M40 30 L52 16 L68 16 L80 30" />
        <path d="M46 30 H74 V36 H46" />
        <path d="M48 36 L72 36 L76 58 L44 58" />
        <path d="M44 58 L76 58 L70 88 L50 88" />
        <path d="M50 88 H70 V94 H50" />
        <path d="M52 94 V99 M68 94 V99" />
        <path d="M60 9 V16" />
        <circle cx="60" cy="6" r="3" />
      </g>
      <circle className="porch95-circuit-el" r="2.4" fill={glow}
        style={{ filter: "drop-shadow(0 0 5px var(--porch-boot-facet))" }} />
    </svg>
  );
}

// The dissolve class the adopted pre-JS canvas takes on readiness (the
// static layer carries the same keyframes block as the React fallback;
// both ride porch95-fade).
export const BOOT_FADE_CLASS = "porch95-boot-fade";

/**
 * LanternBoot — variant="boot" (default) is the app's first paint. The
 * climb itself lives in the static pre-JS canvas (index.html): the boot's
 * only guaranteed window on a cold load is the bundle-download span, and
 * the facet ramp, node glows, and pulse animate there from the first byte.
 * The app's first surface becomes ready in the same commit LanternBoot
 * mounts (readiness is React mount), so the React layer never shows its
 * own climb on a healthy load — it *adopts* the static canvas: manages the
 * status lines past the copy threshold (elapsed measured from navigation
 * start — the boot's true start), rides readiness, dissolves the canvas,
 * and removes it. When no static canvas exists (the React layer renders
 * standalone, tests, or a surface flow), it renders its own identical
 * layer. variant="surface" is the boot doubling as the full-screen loading
 * state for flows that hold a page (device-link consume, session open
 * behind WhoIsHere): `status` rides the flow's own copy hook and the
 * parent unmounts it when the flow resolves — the loader never outlives
 * its context.
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
      // The pre-JS canvas keeps climbing; this layer only manages status,
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
      ...bootLayerStyle(variant === "surface" ? 2147483100 : 2147483000),
      ...(fading ? { animation: `porch95-fade ${fadeMs}ms ease-out forwards` } : null),
    }}
      className="porch95-bootlayer" role="status">
      <style>{CSS}</style>
      <BootMark />
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
 * LanternLoader — the small in-app loading mark. Renders centered in its
 * own reserved space with a quiet traveling glow circulating the mark's
 * vertices (amber-glow class, 2s loop). Callers pass their own aria label
 * and a `style` for tone (`color: "var(--porch-amber-ink)"` inside amber
 * fills). It never renders fixed, never overlays content, and never
 * outlives its operation: the call sites keep their error/timeout
 * branches, so a stuck write resolves to the error pattern, never an
 * eternal mark.
 */
export function LanternLoader({ size = LOADER_MARK_SIZE, label, style, glow = "var(--porch-boot-node)" }) {
  const pad = Math.round(size * 0.35);
  return (
    <div role="status" aria-label={label} style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      minWidth: size + pad * 2, minHeight: size + pad * 2,
      color: "var(--porch-amber)", ...style,
    }}>
      <style>{CSS}</style>
      <LoaderMark size={size} glow={glow} />
    </div>
  );
}