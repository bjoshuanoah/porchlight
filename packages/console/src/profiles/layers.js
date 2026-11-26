// Layer inspection model (PORCH-135).
//
// Maps the `/api/config/knobs?cameraId=` payload plus the profiles list
// into the per-camera inspection table: one row per whitelisted knob, with
// the Base layer, the Active-profile layer, and the Effective value with
// its source layer. Pure data mapping — no DOM, no fetch — so node --test
// exercises it directly.
//
// Domain law this model renders: effective = base → active profile →
// resolved, with the resolution never a wholesale replacement — each knob
// falls back independently, and a camera-scoped profile covers only its
// camera (other cameras read the base layer for every knob).

import { KNOB_WHITELIST, KNOB_DEFAULTS } from "./knobs.js";

/**
 * Builds the layer table for one camera.
 *
 * @param {object} input
 * @param {string} input.cameraId
 * @param {object} [input.knobs] - `/api/config/knobs?cameraId=` payload:
 *   `{ cameraId, knobs: { [knob]: { base, value, source, profileId? } } }`.
 * @param {Array} [input.profiles] - `/api/profiles` payload.
 * @param {object|null} [input.active] - `/api/config/active` payload:
 *   `{ profileId, name, source }` or `{ profileId: null, source: null }`.
 * @returns {Array<{ knob, base: {value, set}, profile: {value, set, applied,
 *   profileId?, name?}, effective, source, profileId? }>}
 */
export function buildLayerTable({ cameraId, knobs, profiles, active }) {
  const entries = knobs?.knobs ?? {};
  const profileList = profiles ?? [];
  const activeProfile = active?.profileId
    ? profileList.find((profile) => profile.id === active.profileId) ?? null
    : null;
  // A camera-scoped profile covers only its camera; a global profile covers
  // every camera.
  const coversCamera = Boolean(
    activeProfile && (activeProfile.scope === "global" || activeProfile.cameraId === cameraId),
  );

  return KNOB_WHITELIST.map((knob) => {
    const entry = entries[knob] ?? {};
    const baseSet = entry.base !== undefined;
    const baseValue = baseSet ? entry.base : KNOB_DEFAULTS[knob];

    const profileSetsKnob = activeProfile
      && Object.prototype.hasOwnProperty.call(activeProfile.knobs ?? {}, knob);
    const profileValue = profileSetsKnob ? activeProfile.knobs[knob] : undefined;
    const applied = coversCamera && profileValue !== undefined;

    const fromProfile = applied;
    const effective = fromProfile
      ? profileValue
      : entry.value !== undefined
        ? entry.value
        : baseValue;
    const source = fromProfile ? "profile" : entry.source ?? "base";
    const profileId = fromProfile
      ? activeProfile.id
      : entry.profileId;

    return {
      knob,
      base: { value: baseValue, set: baseSet },
      profile: {
        value: profileSetsKnob ? profileValue : undefined,
        set: Boolean(profileSetsKnob),
        applied,
        profileId: activeProfile?.id,
        name: activeProfile?.name,
      },
      effective,
      source,
      ...(profileId !== undefined ? { profileId } : {}),
    };
  });
}
