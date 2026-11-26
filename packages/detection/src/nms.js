// nms.js — pure detection math: letterbox geometry, IoU suppression, and the
// ultralytics YOLO (v8/v11 detect head) output decode (PORCH-128).

/** @typedef {[number, number, number, number]} BBox */
/** @typedef {import("./types.js").RawDetection} RawDetection */

/**
 * Letterbox mapping from source frame to destination model input: the frame
 * scales uniformly and centers, padding with black.
 *
 * @param {number} srcW @param {number} srcH @param {number} dstW @param {number} dstH
 * @returns {{ scale: number, padX: number, padY: number }}
 */
export function letterbox(srcW, srcH, dstW, dstH) {
	const scale = Math.min(dstW / srcW, dstH / srcH);
	const padX = (dstW - srcW * scale) / 2;
	const padY = (dstH - srcH * scale) / 2;
	return { scale, padX, padY };
}

/**
 * Map a model-space box (pixels in the letterboxed input) back to the frame's
 * normalized [0,1] coordinates.
 *
 * @param {BBox} modelBox  pixels in model input space [x, y, w, h]
 * @param {{ scale: number, padX: number, padY: number }} lb
 * @param {number} srcW @param {number} srcH
 * @returns {BBox} normalized, clamped to [0,1]
 */
export function modelBoxToFrame(modelBox, lb, srcW, srcH) {
	const x = clamp01((modelBox[0] - lb.padX) / lb.scale / srcW);
	const y = clamp01((modelBox[1] - lb.padY) / lb.scale / srcH);
	const w = clamp01(modelBox[2] / lb.scale / srcW);
	const h = clamp01(modelBox[3] / lb.scale / srcH);
	return [x, y, w, h];
}

/**
 * Greedy NMS: keep indices of `scores` where the box does not overlap a
 * higher-scoring kept box beyond `iouThr`.
 *
 * @param {BBox[]} boxes
 * @param {number[]} scores
 * @param {number} iouThr
 * @returns {number[]}
 */
export function nms(boxes, scores, iouThr) {
	const order = scores.map((s, i) => [s, /** @type {number} */ (i)]).sort((a, b) => b[0] - a[0]).map((p) => p[1]);
	/** @type {number[]} */
	const kept = [];
	const suppressed = new Set();
	for (const i of order) {
		if (suppressed.has(i)) continue;
		kept.push(i);
		for (const j of order) {
			if (j === i || suppressed.has(j)) continue;
			if (boxesIou(boxes[i], boxes[j]) > iouThr) suppressed.add(j);
		}
	}
	return kept;
}

/**
 * Ultralytics YOLO decode: model output is [4 + numClasses, N] (boxes-first,
 * as exported by `yolo export format=onnx`) or [N, 4 + numClasses]
 * (sequence-first). Box coords cx, cy, w, h in model-input pixels; per-class
 * scores already sigmoided. One detection per class score, then NMS across
 * classes (class-agnostic suppression matches Frigate-class trackers).
 *
 * @param {Float32Array} data   raw output tensor data
 * @param {number[]} dims       [dim0, dim1, dim2]
 * @param {string[]} classNames
 * @param {{ inputSize: number, srcW: number, srcH: number, confThreshold: number, iouThreshold: number }} cfg
 * @returns {RawDetection[]}
 */
export function decodeYolo(data, dims, classNames, cfg) {
	const numClasses = classNames.length;
	const stride = 4 + numClasses;
	const boxesFirst = dims[1] === stride; // [1, 4+C, N]
	const seqFirst = dims[2] === stride; // [1, N, 4+C]
	if (!seqFirst && !boxesFirst) {
		throw new Error(`decodeYolo: expected output dims with stride ${stride} on axis 1 or 2, got [${dims.join(", ")}]`);
	}
	const n = boxesFirst ? dims[2] : dims[1];
	const lb = letterbox(cfg.srcW, cfg.srcH, cfg.inputSize, cfg.inputSize);
	/** @type {BBox[]} */
	const boxes = [];
	/** @type {number[]} */
	const scores = [];
	/** @type {number[]} */
	const classes = [];
	for (let i = 0; i < n; i++) {
		let best = -1;
		let bestScore = 0;
		for (let c = 0; c < numClasses; c++) {
			const s = valueAt(data, dims, stride, seqFirst, i, 4 + c);
			if (s > bestScore) {
				bestScore = s;
				best = c;
			}
		}
		if (bestScore < cfg.confThreshold) continue;
		const cx = valueAt(data, dims, stride, seqFirst, i, 0);
		const cy = valueAt(data, dims, stride, seqFirst, i, 1);
		const w = valueAt(data, dims, stride, seqFirst, i, 2);
		const h = valueAt(data, dims, stride, seqFirst, i, 3);
		boxes.push([cx - w / 2, cy - h / 2, w, h]);
		scores.push(bestScore);
		classes.push(best);
	}
	const keep = nms(boxes, scores, cfg.iouThreshold);
	/** @type {RawDetection[]} */
	const out = [];
	for (const i of keep) {
		const frameBox = modelBoxToFrame(boxes[i], lb, cfg.srcW, cfg.srcH);
		out.push({
			cls: classNames[classes[i]],
			conf: scores[i],
			bbox: frameBox,
		});
	}
	return out;
}

/**
 * @param {Float32Array} data
 * @param {number[]} dims
 * @param {number} stride
 * @param {boolean} seqFirst
 * @param {number} i
 * @param {number} offset
 */
function valueAt(data, dims, stride, seqFirst, i, offset) {
	return seqFirst ? data[i * stride + offset] : data[offset * dims[2] + i];
}
/** @param {BBox} a @param {BBox} b @returns {number} */
export function boxesIou(a, b) {
	const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
	const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
	const inter = ix * iy;
	if (inter <= 0) return 0;
	return inter / (Math.max(0, a[2]) * Math.max(0, a[3]) + Math.max(0, b[2]) * Math.max(0, b[3]) - inter);
}

/** @param {number} x */
function clamp01(x) {
	return Math.min(1, Math.max(0, x));
}

/**
 * Bilinear-resize a packed rgb/rgba buffer into an RGB Float32Array laid out
 * CHW (channels-first), values scaled to [0,1] — the layout YOLO ONNX inputs
 * expect. `srcStride` bytes per source pixel (3 for rgb, 4 for rgba).
 *
 * @param {Uint8Array} src
 * @param {number} srcW @param {number} srcH @param {number} srcStride
 * @param {number} dstW @param {number} dstH
 * @param {{ scale: number, padX: number, padY: number }} lb
 * @returns {Float32Array} length 3 * dstW * dstH
 */
export function toModelInput(src, srcW, srcH, srcStride, dstW, dstH, lb) {
	const out = new Float32Array(3 * dstW * dstH);
	const plane = dstW * dstH;
	const rW = Math.round(srcW * lb.scale);
	const rH = Math.round(srcH * lb.scale);
	for (let y = 0; y < dstH; y++) {
		const sy = Math.min(srcH - 1, Math.max(0, Math.floor((y - lb.padY) / lb.scale)));
		const inRow = y >= lb.padY && y < lb.padY + rH;
		for (let x = 0; x < dstW; x++) {
			const di = y * dstW + x;
			if (!inRow || x < lb.padX || x >= lb.padX + rW) {
				out[di] = 0;
				out[plane + di] = 0;
				out[2 * plane + di] = 0;
				continue;
			}
			const sx = Math.min(srcW - 1, Math.max(0, Math.floor((x - lb.padX) / lb.scale)));
			const si = (sy * srcW + sx) * srcStride;
			out[di] = src[si] / 255;
			out[plane + di] = src[si + 1] / 255;
			out[2 * plane + di] = src[si + 2] / 255;
		}
	}
	return out;
}
