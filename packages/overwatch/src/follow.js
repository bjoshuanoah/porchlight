// follow.js — the follow-a-subject-across-cameras service (PORCH-140 ac-1, F12).
//
// A follow subscription engages the camera bump through the compositor seam;
// every engage and release lands an audit row — the bump is an explicit
// audited state change, never silent. Two audit dimensions exist by contract:
// the follow service records the ENTITY dimension (detail { entityId,
// cameraId, actorIdentityRef }); the real compositor, independently, records
// the bump TRANSITION dimension (cameraId detail). When the injected
// compositor already audits its own transitions, wire the factory with
// `auditBumps: false` so the type list does not double-row at integration.
//
// Follow is idempotent per entityId (one subscription; re-follow returns the
// same subscription and changes nothing). exit() hands the bump from the
// camera the entity left to the camera it became active on; unfollow() tears
// the subscription down and releases any engaged bump.

import { isFollowableClass } from "./scope-law.js";
import { liveState } from "./entity-state.js";

/** @typedef {import("./types.js").PropertyEntity} PropertyEntity */

/** Error code thrown when the followed class is not person/vehicle. */
export const E_NOT_FOLLOWABLE = "E_NOT_FOLLOWABLE";

const E_NOT_FOLLOWABLE_MESSAGE = "Only a person or a vehicle can be followed";

/**
 * @param {string} message
 * @param {string} code
 */
function errorWithCode(message, code) {
	const error = new Error(message);
	/** @type {any} */ (error).code = code;
	return error;
}

/**
 * @typedef {object} FollowSubscription
 * @property {string} entityId
 * @property {string} cls
 * @property {string|null} cameraId   camera whose bump is currently engaged
 * @property {boolean} engaged
 * @property {string|null} actorIdentityRef
 * @property {number} since   epoch seconds of the subscription start
 */

/**
 * @param {{audit?: {record: (row: {type: string, actorIdentityRef?: string|null, detail?: Record<string, unknown>}) => unknown} | null, compositor?: {setFollowBump: (cameraId: string, engaged: boolean) => unknown} | null, clipsProvider?: (chain: PropertyEntity) => Array<{cameraId: string, path: string, from: number, to: number}>, resolveState?: (entityId: string, at?: number) => string, chainsProvider?: () => PropertyEntity[], auditBumps?: boolean, now?: () => number}} [options]
 */
export function createFollowService({
	audit,
	compositor,
	clipsProvider,
	resolveState,
	chainsProvider,
	auditBumps = true,
	now = () => Date.now() / 1000,
} = {}) {
	/** @type {Map<string, FollowSubscription>} */
	const subscriptions = new Map();

	/** @param {string} entityId @param {string|undefined} cameraId @param {string|undefined} actorIdentityRef */
	function engage(entityId, cameraId, actorIdentityRef) {
		const sub = subscriptions.get(entityId);
		if (!sub || !cameraId || sub.cameraId === cameraId) return;
		compositor?.setFollowBump(cameraId, true);
		if (audit && auditBumps) {
			audit.record({
				type: "follow-bump-engage",
				actorIdentityRef: actorIdentityRef ?? sub.actorIdentityRef ?? null,
				detail: { entityId, cameraId },
			});
		}
		sub.cameraId = cameraId;
		sub.engaged = true;
	}

	/** @param {string} entityId @param {string|undefined} cameraId @param {string|undefined} actorIdentityRef */
	function release(entityId, cameraId, actorIdentityRef) {
		const sub = subscriptions.get(entityId);
		if (!sub || !cameraId || sub.cameraId !== cameraId) return;
		compositor?.setFollowBump(cameraId, false);
		if (audit && auditBumps) {
			audit.record({
				type: "follow-bump-release",
				actorIdentityRef: actorIdentityRef ?? sub.actorIdentityRef ?? null,
				detail: { entityId, cameraId },
			});
		}
		sub.cameraId = null;
		sub.engaged = false;
	}

	/** @type {{follow(params: {entityId: string, cls: string, activeCameraId?: string, actorIdentityRef?: string}): FollowSubscription, exit(params: {entityId: string, cameraId?: string, nextCameraId?: string, actorIdentityRef?: string}): FollowSubscription|null, unfollow(params: {entityId: string, actorIdentityRef?: string}): boolean, subscriptions(): FollowSubscription[], stream(params: {entityId: string, chain?: PropertyEntity, at?: number}): {entityId: string, state: string|null, clips: Array<{cameraId: string, path: string, from: number, to: number}>}}} */
	const followService = {
		/**
		 * Follow a tracked entity: persons and vehicles only. Idempotent per
		 * entityId — a re-follow returns the same subscription and audits
		 * nothing further.
		 */
		follow({ entityId, cls, activeCameraId, actorIdentityRef }) {
			if (!isFollowableClass(cls)) {
				throw errorWithCode(E_NOT_FOLLOWABLE_MESSAGE, E_NOT_FOLLOWABLE);
			}
			const existing = subscriptions.get(entityId);
			if (existing) return existing;
			/** @type {FollowSubscription} */
			const sub = {
				entityId,
				cls,
				cameraId: null,
				engaged: false,
				actorIdentityRef: actorIdentityRef ?? null,
				since: now(),
			};
			subscriptions.set(entityId, sub);
			if (activeCameraId) engage(entityId, activeCameraId, actorIdentityRef);
			return sub;
		},

		/**
		 * The followed entity left `cameraId` (or flipped to DEPARTED):
		 * release the bump we hold on it. When the entity became active on
		 * `nextCameraId`, engage that bump. Each transition is audited once.
		 */
		exit({ entityId, cameraId, nextCameraId, actorIdentityRef }) {
			const sub = subscriptions.get(entityId);
			if (!sub) return null;
			release(entityId, cameraId, actorIdentityRef);
			if (nextCameraId) engage(entityId, nextCameraId, actorIdentityRef);
			return sub;
		},

		/** Remove the subscription and release any engaged bump (audited once). */
		unfollow({ entityId, actorIdentityRef }) {
			const sub = subscriptions.get(entityId);
			if (!sub) return false;
			release(entityId, sub.cameraId, actorIdentityRef);
			subscriptions.delete(entityId);
			return true;
		},

		/** Live subscription list (defensive copies). */
		subscriptions() {
			return [...subscriptions.values()].map((sub) => ({ ...sub }));
		},

		/**
		 * Current state + ordered contributing clips for one entity. The state
		 * comes from the injected `resolveState(entityId, at)` seam when
		 * present, otherwise from the chain via liveState(). Clips come from
		 * the `clipsProvider(chain)` segment-index seam, ordered by sighting t
		 * (the provider of record owns that order).
		 */
		stream({ entityId, chain, at }) {
			const atSec = at ?? now();
			const resolved = chain
				?? (chainsProvider ? chainsProvider().find((candidate) => candidate.entityId === entityId) ?? null : null);
			const state = resolveState
				? resolveState(entityId, atSec)
				: (resolved ? liveState(resolved, atSec) : null);
			const clips = resolved && clipsProvider ? clipsProvider(resolved) : [];
			return { entityId, state, clips };
		},
	};
	return followService;
}
