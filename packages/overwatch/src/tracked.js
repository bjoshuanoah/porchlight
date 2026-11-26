// tracked.js — the tracked-objects surface (PORCH-140 ac-1).
//
// The property view of the entity layer: tracked-class chains only (the scope
// law in scope-law.js decides what is tracked), each one carrying its live
// FSM state, chronological camera trail, last-seen time and follow flag.
// Ordered by lastSeenAt desc — most recently active first.

import { statesOf } from "./entity-state.js";
import { isTrackedClass } from "./scope-law.js";

/** @typedef {import("./types.js").PropertyEntity} PropertyEntity */
/** @typedef {import("./types.js").EntityStateLabel} EntityStateLabel */
/** @typedef {import("./types.js").EntityLifecycleState} EntityLifecycleState */

/**
 * @typedef {object} TrackedObjectSummary
 * @property {string} entityId
 * @property {string} cls
 * @property {EntityLifecycleState} entityState
 * @property {string[]} cameraIds  chronological, unique
 * @property {number} lastSeenAt   epoch seconds (chain end)
 * @property {boolean} followed    a follow subscription exists
 */

/** @returns {number} epoch seconds on the host clock */
function defaultNow() {
	return Date.now() / 1000;
}

/** @param {PropertyEntity} chain @returns {string[]} chronological unique camera ids */
function cameraIdsOf(chain) {
	const cameraIds = [];
	for (const sighting of [...(chain.sightings ?? [])].sort((a, b) => a.t0 - b.t0)) {
		if (!cameraIds.includes(sighting.camera)) cameraIds.push(sighting.camera);
	}
	return cameraIds;
}

/**
 * @param {{chainsProvider: () => PropertyEntity[], followService?: {subscriptions: () => Array<{entityId: string}>} | null}} options
 */
export function createTrackedObjectsService({ chainsProvider, followService } = {}) {
	/** @type {{list(options: {at?: number}): {tracked: TrackedObjectSummary[]}, get(params: {entityId: string, at?: number}): object|null}} */
	const trackedService = {
		/**
		 * Tracked-class entities ordered by lastSeenAt desc (ties broken by
		 * entityId asc for determinism).
		 *
		 * @param {{at?: number}} [params]
		 * @returns {{tracked: TrackedObjectSummary[]}}
		 */
		list({ at } = {}) {
			const atSec = at ?? defaultNow();
			const followed = new Set(
				(followService?.subscriptions?.() ?? []).map((sub) => sub.entityId),
			);
			/** @type {TrackedObjectSummary[]} */
			const tracked = [];
			for (const chain of chainsProvider?.() ?? []) {
				if (!chain || !isTrackedClass(chain.cls)) continue;
				const { entityState } = statesOf(chain, { now: atSec });
				tracked.push({
					entityId: chain.entityId,
					cls: chain.cls,
					entityState,
					cameraIds: cameraIdsOf(chain),
					lastSeenAt: chain.t1,
					followed: followed.has(chain.entityId),
				});
			}
			tracked.sort(
				(a, b) => (b.lastSeenAt - a.lastSeenAt)
					|| (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0),
			);
			return { tracked };
		},

		/**
		 * Full view for one entity: the chain itself, its per-sighting FSM
		 * labels, and the ordered clips (through the follow service's stream
		 * seam when wired). Unknown entity → null (REST maps to 404).
		 *
		 * @param {{entityId: string, at?: number}} params
		 */
		get({ entityId, at }) {
			const atSec = at ?? defaultNow();
			const chain = (chainsProvider?.() ?? []).find((candidate) => candidate?.entityId === entityId);
			if (!chain) return null;
			const { sightings: states, entityState } = statesOf(chain, { now: atSec });
			const stream = followService?.stream?.({ entityId, chain, at: atSec }) ?? null;
			return {
				entityId,
				cls: chain.cls,
				entityState,
				state: stream?.state ?? entityState,
				states,
				chain,
				clips: stream?.clips ?? [],
				followed: followService?.subscriptions?.().some((sub) => sub.entityId === entityId) ?? false,
			};
		},
	};
	return trackedService;
}
