// zones.js — zone definitions + the shared CRUD service factory (PORCH-135).
//
// Zones and masks share the same document/CRUD shape; this module owns the
// factory and the zone service. Masks (masks.js) reuse the factory. The
// definition kind ("zone" | "mask") rides on every row so the composition
// resolver can attribute contributors.

import { randomUUID } from "node:crypto";
import { NotFoundError, validateDefinitionFields } from "./types.js";

/**
 * @param {{ store: import("./store.js").Store }} deps
 * @param {{ docName: string, docKey: string, kind: string, idPrefix: string }} spec
 */
export function createDefinitionService({ store }, { docName, docKey, kind, idPrefix }) {
	const defs = () => store.readDoc(docName)[docKey] ?? [];

	const persist = (list) => {
		store.writeDoc(docName, { [docKey]: list });
	};

	return {
		kind,
		/** List definitions for one camera. */
		list(cameraId) {
			return defs().filter((d) => d.cameraId === cameraId).map((d) => structuredClone(d));
		},
		/** Get one definition or null. */
		get(id) {
			const def = defs().find((d) => d.id === id);
			return def ? structuredClone(def) : null;
		},
		/** Create a definition for a camera. */
		create(cameraId, body) {
			const fields = validateDefinitionFields(body, kind, { forCreate: true });
			const def = {
				id: `${idPrefix}-${randomUUID().slice(0, 8)}`,
				cameraId,
				...fields,
				enabled: fields.enabled ?? true,
			};
			persist([...defs(), def]);
			return structuredClone(def);
		},
		/** Partial update (name / polygon / enabled). */
		update(id, patch) {
			const list = defs();
			const def = list.find((d) => d.id === id);
			if (!def) throw new NotFoundError(`no ${kind} with id "${id}"`);
			const fields = validateDefinitionFields(patch ?? {}, kind);
			if (fields.name !== undefined) def.name = fields.name;
			if (fields.polygon !== undefined) def.polygon = fields.polygon;
			if (fields.enabled !== undefined) def.enabled = fields.enabled;
			persist(list);
			return structuredClone(def);
		},
		/** Delete a definition. */
		remove(id) {
			const list = defs();
			const next = list.filter((d) => d.id !== id);
			if (next.length === list.length) throw new NotFoundError(`no ${kind} with id "${id}"`);
			persist(next);
			return true;
		},
	};
}

export function createZones(store) {
	return createDefinitionService({ store }, { docName: "zones", docKey: "zones", kind: "zone", idPrefix: "zone" });
}
