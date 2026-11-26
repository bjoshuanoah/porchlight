// speed.js — per-camera speed calibration and track estimates (PORCH-135).
//
// Calibration (TS 11): an area polygon + calibration line (percent endpoints)
// + real-world meters. Pixels-per-meter = pixel length of the line at the
// stream resolution / meters. Speed = distance traveled in px / pxPerMeter /
// dt. Every result is estimate: true — output renders labeled as an estimate.

import {
	assertBoolean,
	assertCoordinate,
	assertObject,
	assertPositiveNumber,
	NotFoundError,
	ValidationError,
	validatePoint,
	validatePolygon,
} from "./types.js";
import { pixelDistance, trackPixelPathLength } from "./geometry.js";

// Quality thresholds set at build time (documented in the contract): a line
// resolving to >= 40 px/m tracks well at stream resolution, >= 15 is usable,
// anything less cannot resolve speed reliably.
export const PX_PER_METER_GOOD = 40;
export const PX_PER_METER_FAIR = 15;

/** Grade from pixels-per-meter at the current resolution. */
export function qualityGrade(pxPerMeter) {
	if (pxPerMeter >= PX_PER_METER_GOOD) return "good";
	if (pxPerMeter >= PX_PER_METER_FAIR) return "fair";
	return "poor";
}

export function createSpeedService({ store, cameras }) {
	const entry = (cameraId) => store.readDoc("speed").cameras?.[cameraId] ?? null;

	return {
		/** Stored calibration for a camera; `{ enabled: false }` when unset. */
		get(cameraId) {
			const stored = entry(cameraId);
			if (!stored) return { enabled: false };
			return structuredClone({ enabled: false, ...stored });
		},
		/** Upsert calibration fields (enabled / area / line / meters). */
		set(cameraId, patch) {
			assertObject(patch ?? {}, "speed body");
			const doc = store.readDoc("speed");
			doc.cameras = doc.cameras ?? {};
			const current = doc.cameras[cameraId] ?? { enabled: false };
			if (patch.enabled !== undefined) current.enabled = assertBoolean(patch.enabled, "speed enabled");
			if (patch.area !== undefined) current.area = validatePolygon(patch.area, "speed area");
			if (patch.line !== undefined) current.line = validateCalibrationLine(patch.line);
			if (patch.meters !== undefined) current.meters = assertPositiveNumber(patch.meters, "speed meters");
			// The line is the real-world distance reference: both halves of the
			// calibration must exist together or the math is meaningless.
			if (!!current.line !== (typeof current.meters === "number")) {
				throw new ValidationError("speed: line and meters must be calibrated together");
			}
			doc.cameras[cameraId] = current;
			store.writeDoc("speed", doc);
			return structuredClone(current);
		},
		/**
		 * Estimate speed for a track [{t: seconds, px, py: percent coords}].
		 * @returns {{ speedMps: number, estimate: true, quality: { grade: string, pxPerMeter: number } }}
		 */
		estimate(cameraId, track) {
			const camera = cameras.get(cameraId);
			if (!camera) throw new NotFoundError(`unknown camera "${cameraId}"`);
			const stored = entry(cameraId);
			if (!stored?.line || typeof stored.meters !== "number") {
				throw new ValidationError(`speed: no calibration stored for camera "${cameraId}" — set the calibration line and real-world meters first`);
			}
			const samples = validateTrack(track);
			const pxPerMeter = pixelDistance(stored.line.p1, stored.line.p2, camera.width, camera.height) / stored.meters;
			const pathPx = trackPixelPathLength(samples, camera.width, camera.height);
			const dt = samples[samples.length - 1].t - samples[0].t;
			return {
				speedMps: pathPx / pxPerMeter / dt,
				estimate: true,
				quality: { grade: qualityGrade(pxPerMeter), pxPerMeter },
			};
		},
	};
}

function validateCalibrationLine(line) {
	assertObject(line, "speed line");
	const p1 = validatePoint(line.p1, "speed line p1");
	const p2 = validatePoint(line.p2, "speed line p2");
	if (p1[0] === p2[0] && p1[1] === p2[1]) {
		throw new ValidationError("speed line: endpoints must differ — the line spans the real-world distance");
	}
	return { p1, p2 };
}

/** Validate + time-sort track samples ({t, px, py}); dt must be positive. */
function validateTrack(track) {
	if (!Array.isArray(track) || track.length < 2) {
		throw new ValidationError("speed test: track needs at least two samples");
	}
	const samples = track.map((sample, i) => {
		assertObject(sample, `speed test sample [${i}]`);
		if (typeof sample.t !== "number" || !Number.isFinite(sample.t)) {
			throw new ValidationError(`speed test sample [${i}]: t (seconds) must be a finite number`);
		}
		return {
			t: sample.t,
			px: assertCoordinate(sample.px, `speed test sample [${i}].px`),
			py: assertCoordinate(sample.py, `speed test sample [${i}].py`),
		};
	});
	samples.sort((a, b) => a.t - b.t);
	if (samples[samples.length - 1].t === samples[0].t) {
		throw new ValidationError("speed test: samples must span a positive time window");
	}
	return samples;
}
