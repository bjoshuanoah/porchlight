// PORCH-119: the first-paint dusk boot uses the display-sized static
// Porchlight icon (Brian, Oct 22 reference feedback). The mark fades in
// once loaded, above every lighting layer; breathing modulates ambient light.
// The static pre-JS canvas in index.html is adopted by
// LanternBoot and shares the fallback's scene geometry. Readiness, status,
// failure, and cleanup keep the PORCH-095 boot machinery. LanternLoader
// remains the small animated webp in reserved in-app loading space.
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
  BOOT_FAILURE_LINE, BOOT_RETRY_LABEL, STATUS_FADE_MS,
  bootStatusLine,
} from "./loader-assets.js";
import { getAppReady, onAppReady } from "./appready.js";

// The boot's mode-invariant brand palette rides the theme token layer
// (--porch-boot-* custom properties). No literal color appears here
// (PORCH-042); the amber lighting literals below are scene paint (the
// brand amber family), not surface tokens.
const V = {
  bg: "var(--porch-boot-bg)", ink: "var(--porch-boot-ink)", status: "var(--porch-boot-status-ink)",
};

// Lighting, firefly orbits, and status crossfades are CSS. The boot mark
// itself is a still image above the effects, not an animated webp.
const CSS = `
@keyframes porch95-fade { from { opacity: 1; } to { opacity: 0; } }
.porch118-webp { display: block; }
.porch118-webp-still { display: none; }
.porch-dusk-scene { position: relative; isolation: isolate; width: 300px; height: 340px; display: flex; align-items: center; justify-content: center; }
.porch-dusk-mark { position: relative; z-index: 3; opacity: 0; display: block; transition: opacity 300ms ease-out; }
.porch-dusk-mark-loaded { opacity: 1; }
.porch-dusk-halo {
  position: absolute; left: 50%; top: 50%; width: 320px; height: 330px; z-index: 0;
  transform: translate(-50%, -50%); border-radius: 50%;
  background: var(--porch-boot-dusk-halo);
  animation: porch-dusk-breathe 4.8s ease-in-out infinite;
}
.porch-dusk-glow {
  position: absolute; left: 50%; top: 292px; width: 440px; height: 130px; z-index: 0;
  transform: translate(-50%, -50%) scaleY(.42); border-radius: 50%;
  background: var(--porch-boot-dusk-glow);
  animation: porch-dusk-breathe 4.8s ease-in-out infinite; animation-delay: -2.4s;
}
/* Breathing (ac-4): the light layers only, opacity only — softening and
   brightening, never flashing, never moving the mark. */
@keyframes porch-dusk-breathe { 0%, 100% { opacity: .72; } 50% { opacity: 1; } }
.porch-dusk-particles { position: absolute; inset: 0; z-index: 0; }
/* Brian, Oct 22: the particles orbit the lantern like fireflies. Each mote
   is anchored at the mark's center and circles it on its own slow
   elliptical path — per-mote radius, squash, period, and desynced phase,
   alternating direction — never a uniform swarm. The orbit composes from
   translate waypoints so the mark's own layers stay untouched, and the
   motes stay z-under the mark: passing "behind" the lantern reads as the
   orbit wrapping it. */
.porch-dusk-particle {
  position: absolute; left: 50%; top: 50%; width: 5px; height: 5px; border-radius: 50%; opacity: .9;
  background: var(--porch-boot-dusk-mote);
  box-shadow: var(--porch-boot-dusk-spark-glow);
  animation: porch-dusk-orbit var(--d, 21s) ease-in-out infinite;
}
.porch-dusk-particle:nth-child(even) { animation-direction: reverse; }
/* The elliptical orbit: four eased waypoints around the anchor with a
   gentle rotate wiggle — curved everywhere, never a straight strobe. */
@keyframes porch-dusk-orbit {
  0%   { transform: translate(var(--r, 88px), 0) rotate(-90deg); }
  25%  { transform: translate(calc(var(--r, 88px) * .12), calc(var(--ry, 40px) * -1)) rotate(-180deg); }
  50%  { transform: translate(calc(var(--r, 88px) * -.92), calc(var(--ry, 40px) * -.12)) rotate(-270deg); }
  75%  { transform: translate(calc(var(--r, 88px) * -.06), var(--ry, 40px)) rotate(-360deg); }
  100% { transform: translate(var(--r, 88px), 0) rotate(-450deg); }
}
.porch-dusk-particle:nth-child(1) { --r: 88px;  --ry: 38px; --d: 21s; animation-delay: -4s; }
.porch-dusk-particle:nth-child(2) { --r: 112px; --ry: 52px; --d: 27s; animation-delay: -13s; }
.porch-dusk-particle:nth-child(3) { --r: 74px;  --ry: 30px; --d: 18s; animation-delay: -9s; }
.porch-dusk-particle:nth-child(4) { --r: 128px; --ry: 58px; --d: 30s; animation-delay: -2s; }
.porch-dusk-particle:nth-child(5) { --r: 96px;  --ry: 44px; --d: 23s; animation-delay: -17s; }
.porch-dusk-particle:nth-child(6) { --r: 108px; --ry: 34px; --d: 26s; animation-delay: -21s; }
/* Fixed-height status box (ac-6): crossfading children swap in place, the
   surrounding layout never shifts. */
.porch95-statusbox { position: relative; height: 20px; width: 300px; }
.porch95-status {
  position: absolute; left: 0; right: 0; top: 0; text-align: center; white-space: nowrap;
  opacity: 0; transition: opacity 250ms ease;
  color: var(--porch-boot-status-ink); font-size: 14px;
  font-family: Inter, system-ui, sans-serif;
}
.porch95-status-on { opacity: 1; }
.porch95-wordmark {
  color: var(--porch-boot-ink); font-size: 21px; font-weight: 650;
  letter-spacing: .02em; font-family: Inter, system-ui, sans-serif;
}
/* ac-9: the one polite announcement, invisible on the canvas; every
   decorative layer carries aria-hidden in markup. */
.porch95-announce {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
}
/* ac-11: the earned boot failure holds — clear copy, one plain retry. */
.porch95-fail { display: flex; flex-direction: column; align-items: center; gap: 14px; padding-top: 2px; }
.porch95-fail-copy {
  color: var(--porch-boot-ink); font-size: 15px; font-family: Inter, system-ui, sans-serif;
  text-align: center; max-width: 340px; line-height: 1.5;
}
.porch95-retry {
  appearance: none; background: transparent; border: 1px solid var(--porch-boot-dusk-edge);
  border-radius: 999px; color: var(--porch-boot-ink); cursor: pointer;
  font-family: Inter, system-ui, sans-serif; font-size: 15px; font-weight: 600; padding: 9px 24px;
}
/* The amber attention ring on this non-input focusable is the global
   mechanism from the theme baseline (the PORCH-035 rule layer) — no
   per-screen styling of its own here. */
.porch95-retry:hover { background: var(--porch-boot-dusk-hover); }
/* Only the in-app animated loader swaps to its still frame. */
@media (prefers-reduced-motion: reduce) {
  .porch118-webp { display: none; }
  .porch118-webp-still { display: block; }
}
/* ac-8: the dusk lighting holds static, the particles rest, and status
   swaps are instant (no crossfade). */
@media (prefers-reduced-motion: reduce) {
  .porch-dusk-particle { display: none; }
  .porch-dusk-halo, .porch-dusk-glow { animation: none; opacity: .85; }
  .porch-dusk-mark, .porch95-status { transition: none; }
}
`;

/** The boot uses the display-sized static app icon, preloaded in index.html. */
function BootMark() {
  return <img className="porch-dusk-mark" src="/icon-192.png" fetchPriority="high" width={192} height={192}
    alt="" aria-hidden="true" focusable="false" style={{ height: BOOT_MARK_H, width: BOOT_MARK_H }}
    onLoad={(event) => {
      const mark = event.currentTarget;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (mark.isConnected) mark.classList.add("porch-dusk-mark-loaded");
      }));
    }} />;
}

/** The loader mark — the animated webp of record, still frame under reduced motion. */
function Mark({ height = LOADER_MARK_H }) {
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
 * Crossfade the boot status line (ac-6): the outgoing line fades out while
 * the incoming line fades in, inside the fixed-height status box so the
 * surrounding layout never shifts. Pure DOM: both the adopted static
 * canvas and the React fallback's own status box ride this one path.
 * Reduced motion turns the transition off in CSS — instant swaps (ac-8).
 */
export function swapStatusLine(box, text) {
  if (!box) return;
  const current = box.querySelector(".porch95-status-on");
  if (current && current.textContent === text) return;
  for (const node of [...box.querySelectorAll(".porch95-status-out")]) node.remove();
  if (current) {
    current.classList.replace("porch95-status-on", "porch95-status-out");
  }
  const incoming = document.createElement("span");
  incoming.className = "porch95-status";
  incoming.textContent = text;
  box.appendChild(incoming);
  requestAnimationFrame(() => incoming.classList.add("porch95-status-on"));
}

/**
 * LanternBoot — variant="boot" (default) is the app's first paint. The
 * still icon and dusk scene live in the static pre-JS canvas (index.html).
 * React adopts it during startup and renders the same scene as a fallback.
 * It manages the status lines
 * past the copy threshold (elapsed measured from navigation start — the
 * boot's true start), rides readiness, dissolves the canvas, and removes
 * it. When no static canvas exists (the React layer renders standalone,
 * tests, or a surface flow), it renders its own identical layer.
 * variant="surface" is the boot doubling as the full-screen loading state
 * for flows that hold a page (device-link consume, session open behind
 * WhoIsHere): `status` rides the flow's own copy hook and the parent
 * unmounts it when the flow resolves — the loader never outlives its
 * context.
 *
 * PORCH-119 ac-11: `failure` is the boot's earned failure state. The
 * rotation stops, the cycling line clears, the failure copy and one retry
 * action hold on the live surface until resolved or retried — never a
 * flash-then-vanish banner. `onRetry` restarts initialization (the boot
 * sequence re-runs in main.jsx); on success the normal readiness dissolve
 * follows, on another failure the state holds again.
 */
export function LanternBoot({
  variant = "boot",
  status = null,
  failure = false,
  onRetry = null,
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
  const boxRef = useRef(null);
  const failCleanupRef = useRef(null);

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
      if (!fadingRef.current && !failure && bootedAtRef.current != null) {
        setLine(bootStatusLine(now() - bootedAtRef.current));
      }
    };
    tick();
    const iv = setInterval(tick, 250);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- status ticks run the boot's lifetime
  }, [variant, status, failure]);

  // Status line onto whichever canvas is live: the adopted static layer
  // carries it in the fixed-height box beneath the wordmark; the rendered
  // layer states it declaratively (SSR) and drives the crossfade on commit.
  useEffect(() => {
    if (variant !== "boot" || status != null) return undefined;
    const staticBoot = document.getElementById("porch-boot");
    const box = staticBoot
      ? staticBoot.querySelector(".porch95-statusbox")
      : boxRef.current;
    if (!box) return undefined;
    if (failure || line == null) { box.replaceChildren(); return undefined; }
    swapStatusLine(box, line);
  }, [line, variant, status, failure]);

  // ac-11 on the adopted canvas: hold the failure state — stop the cycle,
  // clear the status line, and carry the failure copy plus the retry
  // action on the live surface (pointer events on for the action only).
  useEffect(() => {
    if (variant !== "boot" || !failure) return undefined;
    const staticBoot = document.getElementById("porch-boot");
    if (!staticBoot) return undefined;
    staticBoot.style.pointerEvents = "auto";
    const fail = document.createElement("div");
    fail.className = "porch95-fail";
    fail.setAttribute("role", "alert");
    const copy = document.createElement("div");
    copy.className = "porch95-fail-copy";
    copy.textContent = BOOT_FAILURE_LINE;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "porch95-retry";
    retry.textContent = BOOT_RETRY_LABEL;
    retry.addEventListener("click", () => onRetry?.());
    fail.append(copy, retry);
    staticBoot.appendChild(fail);
    failCleanupRef.current = () => {
      fail.remove();
      staticBoot.style.pointerEvents = "";
    };
    return () => {
      failCleanupRef.current?.();
      failCleanupRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- retry binding is the failure's lifetime
  }, [variant, failure]);

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
    // layer is purely a readiness/status/failure manager.
    return null;
  }
  if (gone) return null;
  const surface = variant === "surface";
  return (
    <div style={{
      position: "fixed", top: 0, right: 0, bottom: 0, left: 0,
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      gap: 16, background: V.bg, zIndex: surface ? 2147483100 : 2147483000,
      overflow: "hidden",
      // The boot is never an interaction wall: the app beneath stays
      // interactive the frame the fade completes (and passes clicks through
      // even earlier). The earned failure state is the one interactive
      // exception — the retry action must be reachable.
      ...(failure ? { pointerEvents: "auto" } : { pointerEvents: "none" }),
      ...(fading ? { animation: `porch95-fade ${fadeMs}ms ease-out forwards` } : null),
    }}
      className="porch95-bootlayer" role="status">
      <style>{CSS}</style>
      <span className="porch95-announce">Porchlight is loading</span>
      <div className="porch-dusk-scene" aria-hidden="true">
        <div className="porch-dusk-halo"></div>
        <div className="porch-dusk-glow"></div>
        <div className="porch-dusk-particles">
          {[...Array(6)].map((_, i) => <span key={i} className="porch-dusk-particle"></span>)}
        </div>
        <BootMark />
      </div>
      <div className="porch95-wordmark" aria-hidden="true">porchlight</div>
      {surface
        ? (line != null && <div className="porch95-statusbox"><span className="porch95-status porch95-status-on">{line}</span></div>)
        : <div className="porch95-statusbox" aria-hidden="true" ref={boxRef}></div>}
      {variant === "boot" && failure && (
        <div className="porch95-fail" role="alert">
          <div className="porch95-fail-copy">{BOOT_FAILURE_LINE}</div>
          <button type="button" className="porch95-retry" onClick={onRetry}>{BOOT_RETRY_LABEL}</button>
        </div>
      )}
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
 * resolves to the error pattern, never an eternal mark. In-app copy and
 * scope are unchanged by the dusk-boot ruling (boot path only).
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