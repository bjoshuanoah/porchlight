/**
 * Avatar-face delivery (PORCH-070). Every face on every surface — the
 * post-card header, reply rows, the Who's Here chooser, the console's
 * Members directory, the Profile photo block — renders through ONE code
 * path: a committed rung built from did + kind + sha256, whose bytes are
 * fetched through the authorized call (the connection's identity token,
 * the same class of request media-blob.js already serves) and object-URLed
 * through the identity-keyed blob cache. The auth-relaying rendition
 * worker is not required for avatars: surfaces never render a bare rung
 * URL, so a face works on every hub address, insecure LAN origins
 * included.
 *
 * A metas-less view ({ header, chooser } rungs missing or null) renders no
 * URL at all — the MUI initials fallback stays exactly as it was. Pending
 * (pre-commit) previews never enter the blob cache: they are fetched in
 * the panel directly, once, and revoked with the attempt.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Avatar } from "@mui/material";
import { mediaBlobKey, readMediaBlob, putMediaBlob } from "./media-blob.js";

/** A metas view may arrive as the { kind: rung } map (stored reads, the
 * ingest/commit responses) or a rungs array — one lookup serves both shapes.
 * Exported for the Profile panel's pending-preview read (PORCH-073): the
 * panel must go through this lookup, never a bare array method on the map
 * the hub ships. */
export function rungOf(metas, kind) {
  if (Array.isArray(metas)) return metas.find((rung) => rung?.kind === kind) ?? null;
  if (metas && typeof metas === "object") return metas[kind] ?? null;
  return null;
}

/** Committed rung URL (PORCH-070): content-addressed, cache-friendly. */
export function avatarUrl(origin, did, metas, kind) {
  const rung = rungOf(metas, kind);
  if (!origin || !did || !rung?.sha256) return null;
  const base = String(origin).replace(/\/$/, "");
  return `${base}/api/identity/avatars/${encodeURIComponent(did)}/renditions/${encodeURIComponent(rung.kind)}?v=${encodeURIComponent(rung.sha256)}`;
}

/** The pending (pre-commit) preview URL: same base plus the pending token.
 * Never fetched through the blob cache — the panel authorizes it directly. */
export function pendingAvatarUrl(origin, did, metas, token) {
  const rung = rungOf(metas, "chooser");
  if (!origin || !did || !token || !rung?.sha256) return null;
  const base = String(origin).replace(/\/$/, "");
  return `${base}/api/identity/avatars/${encodeURIComponent(did)}/renditions/${encodeURIComponent(rung.kind)}?v=${encodeURIComponent(rung.sha256)}&pending=${encodeURIComponent(token)}`;
}

/**
 * The own-account face for the Profile photo block: hub metas first, the
 * legacy profile photo (a data URL from pre-PORCH-070 owner setup) second,
 * initials otherwise. Legacy faces keep rendering until the member sets a
 * photo — the new upload replaces it server-side.
 */
export function ownFaceSources(account) {
  const chooser = rungOf(account?.avatar, "chooser");
  if (chooser?.sha256) return { kind: "metas", did: account.did, metas: account.avatar, legacy: null };
  const legacy = typeof account?.profile?.avatar === "string" ? account.profile.avatar : null;
  if (legacy) return { kind: "legacy", did: account?.did ?? null, metas: null, legacy };
  return { kind: "initials", did: account?.did ?? null, metas: null, legacy: null };
}

/**
 * One committed face load, cache-keyed by content identity: an already
 * held face answers from memory (no second network read, no revoke, no
 * face remount across feed cadence renders), otherwise `load` returns the
 * bytes and the object URL enters the blob cache. Returns the cache row
 * ({ url, blob, ... }) or null when the view has no rung to load.
 */
export async function loadAvatarFace({ origin, did, metas, kind, load }) {
  const version = rungOf(metas, kind)?.sha256 ?? null;
  if (!origin || !did || !kind || !version) return null;
  const identity = mediaBlobKey({ origin, mediaId: `avatar:${did}`, kind, version });
  const cached = readMediaBlob(identity);
  if (cached) return cached;
  if (typeof load !== "function") return null;
  const blob = await load({ origin, did, kind, version });
  if (!(blob instanceof Blob)) return null;
  return putMediaBlob(identity, { url: URL.createObjectURL(blob), blob });
}

/** The blob-loader-aware hook behind AvatarFace: one code path above. */
export function useAvatarFaceUrl({ origin, did, metas, kind, load }) {
  const version = useMemo(() => rungOf(metas, kind)?.sha256 ?? null, [metas, kind]);
  const identity = useMemo(
    () => (origin && did && kind && version ? mediaBlobKey({ origin, mediaId: `avatar:${did}`, kind, version }) : null),
    [origin, did, kind, version],
  );
  const [url, setUrl] = useState(() => (identity ? (readMediaBlob(identity)?.url ?? null) : null));
  useEffect(() => {
    if (!identity) { setUrl(null); return undefined; }
    const cached = readMediaBlob(identity);
    if (cached?.url) { setUrl(cached.url); return undefined; }
    let alive = true;
    Promise.resolve()
      .then(() => loadAvatarFace({ origin, did, metas, kind, load }))
      .then((row) => { if (alive) setUrl(row?.url ?? null); })
      .catch(() => { if (alive) setUrl(null); });
    return () => { alive = false; };
  }, [identity, origin, did, metas, kind, load]);
  return url;
}

/**
 * The face component every surface renders: an MUI Avatar whose src is the
 * loader's object URL when a rung exists, the given plain src (the legacy
 * profile data URL) otherwise, and initials (children) when neither — the
 * MUI img-error fallback renders the initials again if bytes fail in flight.
 */
export function AvatarFace({ origin, did, metas, kind, load, src, children, ...props }) {
  const url = useAvatarFaceUrl({ origin, did, metas, kind, load });
  return React.createElement(Avatar, { ...props, src: url ?? src ?? undefined }, children);
}