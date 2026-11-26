// snapshot.js — deterministic placeholder snapshot source (PORCH-135).
//
// Cameras without a real snapshotUrl get a generated SVG test pattern
// (grid + camera id/name + resolution + explicit "generated test pattern"
// caption). This is a placeholder source, never fake camera imagery.

function escXml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

/**
 * Render the deterministic SVG test pattern for a camera.
 * @param {{ id: string, name?: string, width: number, height: number }} camera
 * @returns {string}
 */
export function renderTestPattern({ id, name, width, height }) {
	const parts = [];
	parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
	parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#14181d"/>`);
	// 10% grid — doubles as the percent-coordinate backdrop the editor draws against.
	for (let i = 1; i < 10; i++) {
		const x = (width * i) / 10;
		const y = (height * i) / 10;
		parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="#272e36" stroke-width="1"/>`);
		parts.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#272e36" stroke-width="1"/>`);
	}
	const big = Math.max(14, Math.round(width * 0.022));
	const small = Math.max(11, Math.round(width * 0.016));
	const cx = width / 2;
	parts.push(`<text x="${cx}" y="${height * 0.42}" text-anchor="middle" font-family="monospace" font-size="${big}" fill="#9adf9a">${escXml(name ?? id)}</text>`);
	parts.push(`<text x="${cx}" y="${height * 0.42 + big * 1.5}" text-anchor="middle" font-family="monospace" font-size="${small}" fill="#7f8c9b">${escXml(id)} — ${width}×${height}</text>`);
	parts.push(`<text x="${cx}" y="${height - big * 1.5}" text-anchor="middle" font-family="monospace" font-size="${small}" fill="#c8a24a">generated test pattern</text>`);
	parts.push("</svg>");
	return parts.join("");
}
