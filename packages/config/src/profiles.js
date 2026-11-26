// profiles.js — configuration profiles, layer resolution, live apply (PORCH-135).
//
// Laws (TS 12): the knob whitelist is closed; effective = base → active
// profile → resolved with every knob reader returning source layer ("base" |
// "profile") and no wholesale replacement. A switch computes the changed knob
// set per scope and notifies the publisher synchronously.

import { randomUUID } from "node:crypto";
import {
	KNOB_WHITELIST,
	NotFoundError,
	assertObject,
	validateProfileFields,
} from "./types.js";
import { resolveBaseKnob } from "./baseconfig.js";

export function createProfileService({ store, publisher, now = () => new Date() }) {
	const listProfiles = () => structuredClone(store.readDoc("profiles").profiles ?? []);
	const saveProfiles = (list) => {
		store.writeDoc("profiles", { profiles: list });
	};

	const requireProfile = (id) => {
		const profile = listProfiles().find((p) => p.id === id);
		if (!profile) throw new NotFoundError(`no profile with id "${id}"`);
		return profile;
	};

	const readActive = () => store.readDoc("active-profile");
	const writeActive = (doc) => {
		store.writeDoc("active-profile", doc);
	};

	/** Does profile p provide knobs at this scope layer ("_default" | cameraId)? */
	function profileAtLayer(profile, layerKey) {
		if (profile.scope === "global") return true;
		return profile.scope === "camera" && profile.cameraId === layerKey;
	}

	/**
	 * Effective value of one knob at a scope layer ("_default" | cameraId)
	 * before/after a switch — profile layer first, then base (camera >
	 * `_default` fallback for camera layers).
	 */
	function effectiveKnobAtLayer(layerKey, knob, activeDoc) {
		const activeProfile = activeDoc?.profileId ? listProfiles().find((p) => p.id === activeDoc.profileId) ?? null : null;
		if (activeProfile && activeProfile.knobs[knob] !== undefined && profileAtLayer(activeProfile, layerKey)) {
			return { value: activeProfile.knobs[knob], source: "profile", profileId: activeProfile.id };
		}
		const cameraId = layerKey === "_default" ? undefined : layerKey;
		return { value: resolveBaseKnob(store.readDoc("base"), cameraId, knob), source: "base" };
	}

	/** Deep-equality for knob values (arrays like detectionClasses). */
	function sameValue(a, b) {
		return JSON.stringify(a) === JSON.stringify(b);
	}

	return {
		now,
		list() {
			return listProfiles();
		},
		get(id) {
			return listProfiles().find((p) => p.id === id) ?? null;
		},
		create(body) {
			assertObject(body ?? {}, "profile body");
			const fields = validateProfileFields(body);
			const profile = { id: `profile-${randomUUID().slice(0, 8)}`, ...fields };
			const list = listProfiles();
			list.push(profile);
			saveProfiles(list);
			return structuredClone(profile);
		},
		/** Partial update: merge over the existing row, then re-validate fully. */
		update(id, patch) {
			const existing = requireProfile(id);
			assertObject(patch ?? {}, "profile body");
			const merged = { ...existing, ...patch };
			const fields = validateProfileFields(merged);
			const list = listProfiles();
			const idx = list.findIndex((p) => p.id === id);
			list[idx] = { id, ...fields };
			saveProfiles(list);
			return structuredClone(list[idx]);
		},
		/** Delete; deleting the active profile clears the activation. */
		remove(id) {
			requireProfile(id);
			if (readActive().profileId === id) this.deactivate();
			saveProfiles(listProfiles().filter((p) => p.id !== id));
			return true;
		},
		/** Current activation state: { profileId, name, source } or nulls. */
		activeState() {
			const active = readActive();
			if (!active.profileId) return { profileId: null, source: null };
			return { profileId: active.profileId, name: active.name ?? null, source: active.source ?? null };
		},
		/**
		 * Activate a profile (source `"manual"` from the API, `"schedule"` from
		 * the scheduler). Returns { activeProfileId, changed } — changed is
		 * keyed by camera scope (`"_default"` for global profiles, the cameraId
		 * for camera scopes) nested over only the knobs whose effective value
		 * actually changes: { <scope>: { <knob>: { value, source: "profile" } } }.
		 */
		activate(profileId, source = "manual") {
			const profile = requireProfile(profileId);
			const previousActive = readActive();
			const layerKey = profile.scope === "global" ? "_default" : profile.cameraId;
			const changed = { [layerKey]: {} };
			for (const knob of Object.keys(profile.knobs)) {
				const before = effectiveKnobAtLayer(layerKey, knob, previousActive);
				if (!sameValue(before.value, profile.knobs[knob])) {
					changed[layerKey][knob] = { value: structuredClone(profile.knobs[knob]), source: "profile" };
				}
			}
			for (const key of Object.keys(changed)) {
				if (Object.keys(changed[key]).length === 0) delete changed[key];
			}
			writeActive({ profileId: profile.id, name: profile.name, source });
			const event = { activeProfileId: profile.id, changed };
			publisher.publish(event);
			return event;
		},
		/**
		 * Return to home (base): clear activation and publish the knobs that
		 * effectively change back to base values with source "base".
		 */
		deactivate() {
			const active = readActive();
			if (!active.profileId) return { activeProfileId: null, changed: {} };
			const profile = listProfiles().find((p) => p.id === active.profileId) ?? null;
			const changed = {};
			if (profile) {
				const layerKey = profile.scope === "global" ? "_default" : profile.cameraId;
				const scope = {};
				for (const knob of Object.keys(profile.knobs)) {
					const after = effectiveKnobAtLayer(layerKey, knob, null);
					if (!sameValue(after.value, profile.knobs[knob])) {
						scope[knob] = { value: structuredClone(after.value), source: "base" };
					}
				}
				if (Object.keys(scope).length > 0) changed[layerKey] = scope;
			}
			writeActive({});
			const event = { activeProfileId: null, changed };
			publisher.publish(event);
			return event;
		},
		/**
		 * Layer inspection for the console table: for each whitelist knob,
		 * { base (camera > _default > built-in default), value, source,
		 * profileId? } — TS 12 ac: every knob reader returns the effective
		 * value WITH its source layer.
		 */
		inspectKnobs(cameraId) {
			const baseDoc = store.readDoc("base");
			const active = readActive();
			const knobs = {};
			for (const knob of KNOB_WHITELIST) {
				const effective = effectiveKnobAtLayer(cameraId ?? "_default", knob, active);
				knobs[knob] = {
					base: resolveBaseKnob(baseDoc, cameraId, knob),
					value: structuredClone(effective.value),
					source: effective.source,
					...(effective.profileId ? { profileId: effective.profileId } : {}),
				};
			}
			return { cameraId, knobs };
		},
	};
}
