// geometry.js — pure percent-frame polygon math (PORCH-135).
//
// All coordinates are percent frame coordinates (0–100) per the TS 11/12 law,
// so composition results survive resolution changes by construction: pixel
// regions are derived only at the edges (rendering, speed calibration).

/**
 * Ray-casting point-in-polygon test.
 * @param {number} px percent x
 * @param {number} py percent y
 * @param {Array<[number, number]>} polygon
 * @returns {boolean}
 */
export function pointInPolygon(px, py, polygon) {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const [xi, yi] = polygon[i];
		const [xj, yj] = polygon[j];
		const crosses = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
		if (crosses) inside = !inside;
	}
	return inside;
}

function orientation(ax, ay, bx, by, cx, cy) {
	const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
	if (v > 1e-12) return 1;
	if (v < -1e-12) return -1;
	return 0;
}

function onSegment(ax, ay, bx, by, px, py) {
	return (
		px >= Math.min(ax, bx) - 1e-12 && px <= Math.max(ax, bx) + 1e-12 &&
		py >= Math.min(ay, by) - 1e-12 && py <= Math.max(ay, by) + 1e-12
	);
}

/**
 * Segment AB vs CD intersection (proper crossings, shared endpoints, and
 * collinear overlaps all count — shared edges are real overlaps).
 */
export function segmentsIntersect(a, b, c, d) {
	const o1 = orientation(a[0], a[1], b[0], b[1], c[0], c[1]);
	const o2 = orientation(a[0], a[1], b[0], b[1], d[0], d[1]);
	const o3 = orientation(c[0], c[1], d[0], d[1], a[0], a[1]);
	const o4 = orientation(c[0], c[1], d[0], d[1], b[0], b[1]);
	if (o1 !== o2 && o3 !== o4) return true;
	if (o1 === 0 && onSegment(a[0], a[1], b[0], b[1], c[0], c[1])) return true;
	if (o2 === 0 && onSegment(a[0], a[1], b[0], b[1], d[0], d[1])) return true;
	if (o3 === 0 && onSegment(c[0], c[1], d[0], d[1], a[0], a[1])) return true;
	if (o4 === 0 && onSegment(c[0], c[1], d[0], d[1], b[0], b[1])) return true;
	return false;
}

/**
 * Polygon intersection test: any edge pair crossing, or either polygon fully
 * containing the other (no edge crossings then).
 */
export function polygonIntersectsPolygon(a, b) {
	for (let i = 0; i < a.length; i++) {
		const a1 = a[i];
		const a2 = a[(i + 1) % a.length];
		for (let j = 0; j < b.length; j++) {
			if (segmentsIntersect(a1, a2, b[j], b[(j + 1) % b.length])) return true;
		}
	}
	if (pointInPolygon(a[0][0], a[0][1], b)) return true;
	if (pointInPolygon(b[0][0], b[0][1], a)) return true;
	return false;
}

/** Shoelace polygon area in percent² units (absolute value). */
export function polygonArea(polygon) {
	let sum = 0;
	for (let i = 0; i < polygon.length; i++) {
		const [x1, y1] = polygon[i];
		const [x2, y2] = polygon[(i + 1) % polygon.length];
		sum += x1 * y2 - x2 * y1;
	}
	return Math.abs(sum) / 2;
}

/** Fraction of the frame covered by the polygon (area / 100²). */
export function frameFraction(polygon) {
	return polygonArea(polygon) / 10000;
}

/** Map a percent point to stream pixel coordinates. */
export function toPixels(pt, width, height) {
	return [(pt[0] / 100) * width, (pt[1] / 100) * height];
}

/** Euclidean pixel distance between two percent points at a resolution. */
export function pixelDistance(p1, p2, width, height) {
	const [x1, y1] = toPixels(p1, width, height);
	const [x2, y2] = toPixels(p2, width, height);
	return Math.hypot(x2 - x1, y2 - y1);
}

/**
 * Total pixel path length of a sorted track ({t, px, py}) at a resolution —
 * the distance traveled used by the speed estimate.
 */
export function trackPixelPathLength(samples, width, height) {
	let total = 0;
	for (let i = 1; i < samples.length; i++) {
		total += pixelDistance([samples[i - 1].px, samples[i - 1].py], [samples[i].px, samples[i].py], width, height);
	}
	return total;
}
