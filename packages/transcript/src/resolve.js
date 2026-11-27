// resolve.js — transcription method resolution (PORCH-155; TS 13
// "Method resolution (scopes and precedence)").
//
// The method config of record: { global method, per-recording-type methods
// (rolling | event), per-camera overrides }. Resolution of record
// [Assumed, confirm at build — implemented per directive precedence]:
// camera override → recording type → global. The resolver returns BOTH the
// effective method and its SOURCE LAYER — the same layer-visibility pattern
// as Profiles (PRD 12) — so the UI's inspection always shows which layer
// wins. One UI surface (the admin console) owns all three scopes with
// stipulations carried as overrides.

import { METHOD_CLASSES, ValidationError } from "./types.js";

/**
 * Validate one method value.
 * @param {unknown} value
 * @param {string} label
 */
function assertMethod(value, label) {
	if (typeof value !== "string" || !METHOD_CLASSES.includes(value)) {
		throw new ValidationError(`${label}: must be one of ${METHOD_CLASSES.join(", ")}`);
	}
	return value;
}

/**
 * Validate the method doc of record; returns a normalized copy. Unset
 * scopes stay null (they resolve through the lower layer), so partial docs
 * compose with the built-in default instead of overriding it.
 *
 * @param {unknown} value
 * @param {string} [label]
 * @returns {{
 *   global: string|null,
 *   recordingTypes: { rolling: string|null, event: string|null },
 *   cameras: Record<string, string>,
 * }}
 */
export function validateMethodDoc(value, label = "transcription method doc") {
	if (value === null || value === undefined) {
		return { global: null, recordingTypes: { rolling: null, event: null }, cameras: {} };
	}
	if (typeof value !== "object") throw new ValidationError(`${label}: must be an object`);
	const doc = /** @type {any} */ (value);
	if (doc.global !== undefined && doc.global !== null) assertMethod(doc.global, `${label}.global`);
	if (doc.recordingTypes !== undefined && doc.recordingTypes !== null) {
		if (typeof doc.recordingTypes !== "object") throw new ValidationError(`${label}.recordingTypes: must be an object`);
		for (const t of ["rolling", "event"]) {
			const v = doc.recordingTypes[t];
			if (v !== undefined && v !== null) assertMethod(v, `${label}.recordingTypes.${t}`);
		}
	}
	if (doc.cameras !== undefined && doc.cameras !== null) {
		if (typeof doc.cameras !== "object") throw new ValidationError(`${label}.cameras: must be an object of per-camera overrides`);
		for (const cam of Object.keys(doc.cameras)) {
			if (cam.trim() === "") throw new ValidationError(`${label}.cameras: camera ids must be non-empty`);
			assertMethod(doc.cameras[cam], `${label}.cameras.${cam}`);
		}
	}
	return {
		global: typeof doc.global === "string" ? doc.global : null,
		recordingTypes: {
			rolling: typeof doc.recordingTypes?.rolling === "string" ? doc.recordingTypes.rolling : null,
			event: typeof doc.recordingTypes?.event === "string" ? doc.recordingTypes.event : null,
		},
		cameras: doc.cameras && typeof doc.cameras === "object" ? { ...doc.cameras } : {},
	};
}

/** The built-in method floor: whisper-class local first (privacy posture —
 * analysis is local only; endpoint classes are deliberate re-pointings). */
export const BUILTIN_METHOD = "whisper-local";

/**
 * Resolve the effective method for one camera and recording type.
 *
 * @param {ReturnType<typeof validateMethodDoc>} doc the method doc of record
 * @param {string} cameraId
 * @param {"rolling"|"event"} sourceType
 * @returns {{ method: string, source: "camera"|"recording-type"|"global" }}
 */
export function resolveTranscriptionMethod(doc, cameraId, sourceType) {
	const cam = doc.cameras[cameraId];
	if (cam) return { method: cam, source: "camera" };
	const byType = doc.recordingTypes[sourceType];
	if (byType) return { method: byType, source: "recording-type" };
	if (doc.global) return { method: doc.global, source: "global" };
	return { method: BUILTIN_METHOD, source: "global" };
}
