// masks.js — exclusion mask definitions (PORCH-135).
//
// Masks share the zone CRUD shape (percent polygons); at composition time a
// point is effectively excluded if inside ANY enabled mask — a union of
// exclusions, never a silent override.

import { createDefinitionService } from "./zones.js";

export function createMasks(store) {
	return createDefinitionService({ store }, { docName: "masks", docKey: "masks", kind: "mask", idPrefix: "mask" });
}
