// dial.js — the overwatch composite frame-rate dial (PORCH-140 ac-4).
//
// The dial's rate of record lives in the config store so it survives
// restarts; every actual change lands in the audit log (explicit state
// changes only — an identical set changes nothing and records nothing).
//
// DEFAULT_BENCHMARK_CAP_FPS is the constant of record for the benchmark host
// gate: until a benchmark run completes, the selectable range is capped here.
// `dial.capFps` may raise it only with evidence — not in this task.

/** Benchmark host gate: selectable range is capped at this fps pre-benchmark. */
export const DEFAULT_BENCHMARK_CAP_FPS = 5;

/** Follow-bump delta: an engaged follow bump raises the effective rate by this. */
export const BUMP_DELTA_FPS = 2;

/**
 * @param {unknown} v @returns {v is number}
 */
function isFiniteNumber(v) {
	return typeof v === "number" && Number.isFinite(v);
}

/**
 * @param {{
 *   store: import("./config-store.js").ReturnType<typeof import("./config-store.js").createConfigStore>,
 *   audit: import("./audit.js").AuditLog,
 *   now?: () => Date,
 *   capFps?: number,
 * }} options
 */
export function createDial({
	store,
	audit,
	now: _now = () => new Date(),
	capFps = DEFAULT_BENCHMARK_CAP_FPS,
}) {
	return {
		/** The cap surfaced so the family dial can render the selectable range. */
		get capFps() {
			return capFps;
		},

		/**
		 * Set the composite frame rate. Out-of-range values clamp into
		 * [1, capFps] and the clamped set is audited; an identical value is a
		 * no-op with no audit row. The rate lands synchronously in the store.
		 * @param {{ frameRate: number, actorIdentityRef?: string|null, homeId?: string|null }} input
		 * @returns {{ frameRate: number, clamped: boolean, changed: boolean }}
		 */
		set({ frameRate, actorIdentityRef = null, homeId = null }) {
			if (!isFiniteNumber(frameRate)) {
				throw new TypeError("dial.set requires a numeric frameRate");
			}
			const clamped = frameRate < 1 || frameRate > capFps;
			const applied = Math.min(capFps, Math.max(1, frameRate));
			const current = store.getState().dial.frameRate;
			if (applied === current) {
				return { frameRate: applied, clamped, changed: false };
			}
			store.update((draft) => {
				draft.dial.frameRate = applied;
			});
			audit.record({
				type: "dial-change",
				actorIdentityRef,
				homeId,
				detail: { requested: frameRate, applied, clamped },
			});
			return { frameRate: applied, clamped, changed: true };
		},

		/** @returns {{ frameRate: number, capFps: number }} */
		get() {
			return { frameRate: store.getState().dial.frameRate, capFps };
		},

		/**
		 * Effective per-camera pass rate for the compositor: the plain dial
		 * rate, or the bumped rate when this camera's follow bump is engaged.
		 * @param {string} cameraId
		 * @param {string[]|Set<string>} activeFollowBumps camera ids with an engaged bump
		 * @returns {number} effective fps
		 */
		effectiveFrameRateFor(cameraId, activeFollowBumps = []) {
			const rate = store.getState().dial.frameRate;
			const bumped = activeFollowBumps instanceof Set
				? activeFollowBumps.has(cameraId)
				: activeFollowBumps.includes(cameraId);
			return bumped ? Math.min(rate + BUMP_DELTA_FPS, capFps) : rate;
		},
	};
}
