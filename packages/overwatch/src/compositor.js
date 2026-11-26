// compositor.js — the overwatch composite pass (PORCH-140 ac-4).
//
// One stitched image per pass: rows of all active-camera tiles are copied
// into a single Uint8Array and the interpreter is called EXACTLY ONCE per
// pass over that composite — never per camera. The interpreter never creates
// tracks; its annotations are descriptive and are mapped back to camera
// space via resolveAnnotation() using the layout that produced the pass.
//
// Layout is a pure function of (camera order, frame sizes): tiles are laid
// row-wise, each uniformly scaled so its width fits TILE_MAX_WIDTH. The
// layout carries a version; consumers holding a stale version refuse to
// evaluate (LayoutStabilityError) before any work, and the version moves
// only through an explicit, audited bump event — never silently.

/** Default layout schema version. */
export const DEFAULT_LAYOUT_VERSION = 1;

/** Max rendered width of one tile (px); wider sources downscale uniformly. */
export const TILE_MAX_WIDTH = 1280;

export class MissingFrameError extends Error {
	/**
	 * @param {string} message
	 */
	constructor(message) {
		super(message);
		this.name = "MissingFrameError";
	}
}

export class LayoutStabilityError extends Error {
	/**
	 * @param {string} message
	 */
	constructor(message) {
		super(message);
		this.name = "LayoutStabilityError";
	}
}

/** @param {unknown} v @returns {v is number} */
function isFiniteNumber(v) {
	return typeof v === "number" && Number.isFinite(v);
}

/**
 * The layout: pure function of (camera order, frame sizes). Tiles are laid
 * row-wise in camera-selection order; row y is 0 and each tile's x origin is
 * the sum of the preceding tile widths, so the composite is ONE image.
 * @param {string[]} cameraOrder selection order
 * @param {Record<string, { width: number, height: number }>} frameSizes
 */
export function buildLayout(cameraOrder, frameSizes) {
	if (!Array.isArray(cameraOrder) || cameraOrder.length === 0) {
		throw new RangeError("layout needs a non-empty camera order");
	}
	const tiles = [];
	let cursorX = 0;
	let rowHeight = 0;
	for (const cameraId of cameraOrder) {
		const source = frameSizes[cameraId];
		if (!source || !isFiniteNumber(source.width) || !isFiniteNumber(source.height)) {
			throw new RangeError(`no frame size available for camera "${cameraId}" — layout is a pure function of (camera order, frame sizes)`);
		}
		if (source.width <= 0 || source.height <= 0) {
			throw new RangeError(`frame size for camera "${cameraId}" must be positive`);
		}
		const scale = Math.min(1, TILE_MAX_WIDTH / source.width);
		const w = Math.round(source.width * scale);
		const h = Math.round(source.height * scale);
		tiles.push({
			cameraId,
			scale,
			origin: { x: cursorX, y: 0 },
			size: { w, h },
			source: { width: source.width, height: source.height },
		});
		cursorX += w;
		rowHeight = Math.max(rowHeight, h);
	}
	return {
		layoutVersion: DEFAULT_LAYOUT_VERSION,
		cameraOrder: [...cameraOrder],
		tiles,
		// Overlap masks are authored content (zone/mask plane), never derived
		// from camera order or frame sizes; none are authored here.
		overlapMaskSpec: { version: DEFAULT_LAYOUT_VERSION, regions: [] },
		width: cursorX,
		height: rowHeight,
	};
}

/**
 * Find the tile whose composite rect contains the annotation rect origin and
 * map the per-tile coordinates back to camera space (subtract origin, divide
 * scale). Unknown tile → null (annotation dropped).
 * @param {{ x: number, y: number, w?: number, h?: number }} annotation
 * @param {ReturnType<typeof buildLayout>} layout
 */
export function resolveAnnotation(annotation, layout) {
	const { x, y, w = 0, h = 0 } = annotation;
	if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
	const tile = layout.tiles.find(
		(t) =>
			x >= t.origin.x &&
			x < t.origin.x + t.size.w &&
			y >= t.origin.y &&
			y < t.origin.y + t.size.h,
	);
	if (!tile) return null;
	return {
		...annotation,
		cameraId: tile.cameraId,
		x: (x - tile.origin.x) / tile.scale,
		y: (y - tile.origin.y) / tile.scale,
		w: w / tile.scale,
		h: h / tile.scale,
	};
}

/**
 * Render one composite image. Per-tile row copies into a single Uint8Array —
 * never per-camera interpreter calls, no intermediate images.
 * @param {ReturnType<typeof buildLayout>} layout
 * @param {Record<string, { width: number, height: number, data: Uint8Array }>} frames
 */
export function stitchComposite(layout, frames) {
	const { width, height, tiles } = layout;
	const composite = new Uint8Array(width * height * 3);
	for (const tile of tiles) {
		const frame = frames[tile.cameraId];
		const srcW = tile.source.width;
		const srcH = tile.source.height;
		for (let ty = 0; ty < tile.size.h; ty++) {
			const srcY = Math.min(srcH - 1, Math.floor(ty / tile.scale));
			const dstRowStart = ((tile.origin.y + ty) * width + tile.origin.x) * 3;
			if (tile.scale === 1) {
				composite.set(
					frame.data.subarray(srcY * srcW * 3, (srcY * srcW + tile.size.w) * 3),
					dstRowStart,
				);
			} else {
				for (let tx = 0; tx < tile.size.w; tx++) {
					const srcX = Math.min(srcW - 1, Math.floor(tx / tile.scale));
					const src = (srcY * srcW + srcX) * 3;
					const dst = dstRowStart + tx * 3;
					composite[dst] = frame.data[src];
					composite[dst + 1] = frame.data[src + 1];
					composite[dst + 2] = frame.data[src + 2];
				}
			}
		}
	}
	return composite;
}

/**
 * @typedef {{
 *   layoutVersion: number,
 *   cameraOrder: string[],
 *   tiles: Array<{ cameraId: string, scale: number, origin: {x: number, y: number}, size: {w: number, h: number}, source: {width: number, height: number} }>,
 *   overlapMaskSpec: { version: number, regions: unknown[] },
 *   width: number,
 *   height: number,
 * }} CompositeLayout
 */

/**
 * @param {{
 *   store: object,
 *   dial: object,
 *   interpreter?: ((input: { image: { width: number, height: number, data: Uint8Array }, layout: CompositeLayout }) => Array<object> | void) | null,
 *   frameProvider?: ((cameraId: string) => { width: number, height: number } | null) | null,
 *   audit: object,
 *   now?: () => Date,
 * }} options
 */
export function createCompositeEvaluator({
	store,
	dial: _dial,
	interpreter = null,
	frameProvider = null,
	audit,
	now: _now = () => new Date(),
}) {
	/** @type {number} */
	let layoutVersion = DEFAULT_LAYOUT_VERSION;
	/** @type {CompositeLayout | null} last built layout (selection or pass) */
	let layout = null;
	/** @type {Map<string, boolean>} cameraId → bump engaged */
	const followBumps = new Map();

	/** Effective follow-bumped cameras for dial.effectiveFrameRateFor. */
	function activeFollowBumps() {
		return [...followBumps.entries()].filter(([, engaged]) => engaged).map(([id]) => id);
	}

	return {
		/** Current layout version. */
		get layoutVersion() {
			return layoutVersion;
		},

		/** Last built layout, or null before the first complete layout. */
		get layout() {
			return layout === null ? null : structuredClone(layout);
		},

		/** Engaged follow-bump camera ids (drives scheduler cadence). */
		activeFollowBumps,

		/**
		 * Select the active cameras (persisted via the store so a restart
		 * rebuilds the same selection) and build the layout eagerly when frame
		 * sizes are resolvable (frameSizes arg or frameProvider); otherwise the
		 * layout materializes at the first evaluate from the actual frames.
		 * @param {string[]} cameraIds selection order of record
		 * @param {Record<string, { width: number, height: number }>} [frameSizes]
		 * @returns {CompositeLayout | null}
		 */
		selectCameras(cameraIds, frameSizes = {}) {
			if (!Array.isArray(cameraIds) || cameraIds.some((id) => typeof id !== "string" || id === "")) {
				throw new RangeError("selectCameras needs an array of non-empty camera ids");
			}
			store.update((draft) => {
				draft.dial.activeCameraIds = [...cameraIds];
			});
			const sizes = {};
			for (const cameraId of cameraIds) {
				const size = frameSizes[cameraId] ?? (frameProvider ? frameProvider(cameraId) : null);
				if (!size) return null;
				sizes[cameraId] = size;
			}
			layout = buildLayout(cameraIds, sizes);
			layout.layoutVersion = layoutVersion;
			return structuredClone(layout);
		},

		/**
		 * Explicit layout version bump — the version of record moves only
		 * through this audited event, never silently.
		 * @param {{ reason?: string, actorIdentityRef?: string | null, homeId?: string | null }} [meta]
		 */
		bumpLayoutVersion({ reason = "unspecified", actorIdentityRef = null, homeId = null } = {}) {
			const from = layoutVersion;
			layoutVersion += 1;
			if (layout !== null) layout.layoutVersion = layoutVersion;
			audit.record({
				type: "layout-version-bump",
				actorIdentityRef,
				homeId,
				detail: { from, to: layoutVersion, reason },
			});
			return { from, to: layoutVersion };
		},

		/**
		 * Engage/release this camera's follow bump. The bump is an explicit
		 * state change: transitions audit (engage = false→true, release =
		 * true→false); re-setting the same state is a no-op, not an event.
		 * @param {string} cameraId
		 * @param {boolean} engaged
		 * @param {{ actorIdentityRef?: string | null, homeId?: string | null }} [meta]
		 */
		setFollowBump(cameraId, engaged, meta = {}) {
			const was = followBumps.get(cameraId) ?? false;
			if (was === engaged) return false;
			followBumps.set(cameraId, engaged);
			audit.record({
				type: engaged ? "follow-bump-engage" : "follow-bump-release",
				actorIdentityRef: meta.actorIdentityRef ?? null,
				homeId: meta.homeId ?? null,
				detail: { cameraId },
			});
			return true;
		},

		/**
		 * Run one composite pass over the CURRENT frames.
		 * @param {{
		 *   frames: Record<string, { width: number, height: number, data: Uint8Array }>,
		 *   layoutVersion?: number,
		 * }} input
		 */
		evaluate({ frames, layoutVersion: callerVersion = layoutVersion } = {}) {
			if (!frames || typeof frames !== "object") {
				throw new TypeError("evaluate needs a frames map for the current pass");
			}
			if (callerVersion !== layoutVersion) {
				throw new LayoutStabilityError(
					`mixed layout versions: caller is at ${callerVersion} but the compositor is at ${layoutVersion} — re-select and re-render before evaluating; no pass ran`,
				);
			}
			const active = store.getState().dial.activeCameraIds;
			for (const cameraId of active) {
				if (!frames[cameraId]) {
					throw new MissingFrameError(`no frame for active camera "${cameraId}" — refusing to compose a partial pass`);
				}
			}
			const sizes = Object.fromEntries(
				active.map((cameraId) => [cameraId, { width: frames[cameraId].width, height: frames[cameraId].height }]),
			);
			if (active.length === 0) {
				layout = null;
				return { layout: null, image: null, annotations: [], interpreterCalls: 0, layoutVersion };
			}
			const passLayout = buildLayout(active, sizes);
			passLayout.layoutVersion = layoutVersion;
			layout = passLayout;
			const image = { width: passLayout.width, height: passLayout.height, data: stitchComposite(passLayout, frames) };
			let annotations = [];
			if (interpreter !== null) {
				annotations = interpreter({ image, layout: structuredClone(passLayout) }) ?? [];
			}
			const resolved = annotations
				.map((a) => resolveAnnotation(a, passLayout))
				.filter((a) => a !== null);
			return {
				layout: structuredClone(passLayout),
				image,
				annotations: resolved,
				interpreterCalls: interpreter === null ? 0 : 1,
				layoutVersion,
			};
		},
	};
}

/**
 * Push-driven cadence: the delay until this camera's next pass is the
 * reciprocal of its effective frame rate (bump → bumped rate), in
 * milliseconds. Math only — no timers.
 * @param {{
 *   evaluator: { activeFollowBumps(): string[] },
 *   dial: { effectiveFrameRateFor(cameraId: string, activeBumps?: string[]): number },
 *   now?: () => Date,
 * }} options
 */
export function createCompositeScheduler({ evaluator, dial, now: _now = () => new Date() }) {
	return {
		/**
		 * @param {string} cameraId
		 * @param {string[]} [activeBumps] defaults to the evaluator's engaged bumps
		 * @returns {number} ms until the next pass for this camera
		 */
		nextDelay(cameraId, activeBumps) {
			const bumps = activeBumps ?? evaluator.activeFollowBumps();
			return 1000 / dial.effectiveFrameRateFor(cameraId, bumps);
		},
	};
}
