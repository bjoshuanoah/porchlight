// Pure frame geometry for the zone/mask/speed editors (PORCH-135).
//
// All editor polygons are percent frame coordinates (0–100) per the config
// domain law — they describe a *fraction of the frame*, so the same polygon
// covers an identical fractional region at any stream resolution. Pixel
// values exist only at the editor's edge: pointer events arrive in pixels
// of the on-screen snapshot, leaves as percents, and the SVG overlay maps
// percents back to screen pixels through its viewBox. Nothing here touches
// the DOM, so node --test exercises the math directly.

/** Clamps one coordinate into the 0–100 percent frame. */
export function clampPercent(value) {
  return Math.min(100, Math.max(0, value));
}

/** Percent point [x, y] for a pixel point on a frame of the given size. */
export function toPercentPoint([px, py], { width, height }) {
  return [(100 * px) / width, (100 * py) / height];
}

/** Pixel point [x, y] for a percent point on a frame of the given size. */
export function toPixelPoint([x, y], { width, height }) {
  return [(x / 100) * width, (y / 100) * height];
}

/** Percent polygon for a pixel polygon. */
export function polygonToPercent(polygon, frame) {
  return polygon.map((point) => toPercentPoint(point, frame));
}

/** Pixel polygon for a percent polygon. */
export function polygonToPixels(polygon, frame) {
  return polygon.map((point) => toPixelPoint(point, frame));
}

/** Ray-cast hit test: is the percent point inside the percent polygon? */
export function pointInPolygon([x, y], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** Straight-line distance between two percent points. */
export function pointDistance([ax, ay], [bx, by]) {
  return Math.hypot(bx - ax, by - ay);
}

/** Index of the polygon vertex nearest the percent point. */
export function nearestVertexIndex(point, polygon) {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const distance = pointDistance(point, polygon[i]);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Vertex drag math: moves vertex `index` to the percent point, clamped to
 * the frame. Returns a new polygon; the input is never mutated.
 */
export function dragVertex(polygon, index, point) {
  return polygon.map((vertex, i) =>
    i === index ? [clampPercent(point[0]), clampPercent(point[1])] : vertex,
  );
}

/** Shoelace area of a percent polygon, in percent² frame units. */
export function polygonAreaPercent(polygon) {
  let sum = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xj, yj] = polygon[j];
    const [xi, yi] = polygon[i];
    sum += xj * yi - xi * yj;
  }
  return Math.abs(sum) / 2;
}

/** Polygon area as a fraction (0–1) of the total frame area. */
export function polygonAreaNormalized(polygon) {
  return polygonAreaPercent(polygon) / 10_000;
}

/** Polygon area in pixels on a frame of the given size. */
export function polygonAreaPixels(polygon, { width, height }) {
  return polygonAreaNormalized(polygon) * width * height;
}

/**
 * Sutherland–Hodgman clip of convex `subject` against convex `clip` —
 * returns the percent polygon covering the shared region. The overlap
 * groups the composition inspector shows derive server-side, but the pure
 * clip keeps the "same region at any resolution" proof expressible without
 * a DOM.
 */
export function convexClipPolygon(subject, clip) {
  let output = subject;
  for (let edge = 0; edge < clip.length && output.length > 0; edge++) {
    const a = clip[edge];
    const b = clip[(edge + 1) % clip.length];
    const input = output;
    output = [];
    for (let i = 0; i < input.length; i++) {
      const current = input[i];
      const previous = input[(i + input.length - 1) % input.length];
      const currentInside = crossSign(a, b, current) >= 0;
      const previousInside = crossSign(a, b, previous) >= 0;
      if (currentInside !== previousInside) {
        output.push(lineIntersection(previous, current, a, b));
      }
      if (currentInside) output.push(current);
    }
  }
  return output;
}

function crossSign(a, b, p) {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

function lineIntersection(a, b, c, d) {
  const [x1, y1] = a;
  const [x2, y2] = b;
  const [x3, y3] = c;
  const [x4, y4] = d;
  const denominator = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (denominator === 0) return [x2, y2];
  const px = ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) / denominator;
  const py = ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) / denominator;
  return [px, py];
}

/** Shared area of two convex percent polygons, as a fraction of the frame. */
export function intersectAreaNormalized(a, b) {
  return polygonAreaNormalized(convexClipPolygon(a, b));
}
