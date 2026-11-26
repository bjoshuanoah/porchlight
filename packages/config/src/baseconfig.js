// baseconfig.js — camera registry and base knob configuration (PORCH-135).
//
// Base knobs are the bottom layer of TS 12 layer resolution: the `_default`
// scope holds fleet-wide values, per-camera keys override individual knobs
// (camera > `_default` fallback, knob-level — never wholesale replacement).

import { KNOB_DEFAULTS, assertId, assertObject, validateCameraFields, validateKnobs } from "./types.js";

/** Camera registry stored in cameras.yaml: { cameras: [{id, name, width, height, snapshotUrl}] }. */
export function createCameras({ store }) {
	const cameras = () => store.readDoc("cameras").cameras ?? [];

	return {
		list() {
			return structuredClone(cameras());
		},
		get(id) {
			return structuredClone(cameras().find((c) => c.id === id) ?? null);
		},
		/** Upsert: id-addressed, partial merges over the existing row. */
		upsert(id, patch) {
			assertId(id, "camera id");
			const doc = store.readDoc("cameras");
			const list = doc.cameras ?? [];
			const existing = list.find((c) => c.id === id);
			const source = { ...existing, ...compact(patch ?? {}) };
			const fields = validateCameraFields(source, { forCreate: !existing });
			if (existing) {
				Object.assign(existing, fields);
			} else {
				list.push({ id, ...fields });
			}
			doc.cameras = list;
			store.writeDoc("cameras", doc);
			return structuredClone(list.find((c) => c.id === id));
		},
	};
}

/** Strip undefined keys so partial merges never clobber with undefined. */
function compact(obj) {
	const out = {};
	for (const key of Object.keys(obj)) {
		if (obj[key] !== undefined) out[key] = obj[key];
	}
	return out;
}

/** Base knob config stored in base.yaml: { _default: {knobs}, <cameraId>: {knobs} }. */
export function createBaseService({ store }) {
	return {
		/** Full base doc (`{ _default, <cameraId> }` scopes). */
		getAll() {
			return structuredClone(store.readDoc("base"));
		},
		/** Upsert knob values into one scope (`"_default"` or a cameraId). */
		setScope(scopeKey, knobs) {
			// "_default" is a reserved scope key; camera scopes are safe ids.
			if (scopeKey !== "_default") assertId(scopeKey, "base scope");
			assertObject(knobs ?? {}, `base knobs for "${scopeKey}"`);
			const doc = store.readDoc("base");
			const values = validateKnobs(knobs ?? {}, `base knobs for "${scopeKey}"`);
			doc[scopeKey] = { ...doc[scopeKey], ...values };
			store.writeDoc("base", doc);
			return structuredClone(doc[scopeKey]);
		},
	};
}

/**
 * Resolve one base knob for a camera: camera layer > `_default` layer > built
 * in default. The `base` field of the knob inspector is this resolution.
 */
export function resolveBaseKnob(baseDoc, cameraId, knob) {
	const camValue = cameraId ? baseDoc[cameraId]?.[knob] : undefined;
	if (camValue !== undefined) return camValue;
	const defaultValue = baseDoc._default?.[knob];
	if (defaultValue !== undefined) return defaultValue;
	const fallback = KNOB_DEFAULTS[knob];
	// Fresh copy for array-typed defaults so callers can't mutate them.
	return Array.isArray(fallback) ? [...fallback] : fallback;
}

