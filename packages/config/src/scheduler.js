// scheduler.js — schedule-driven profile switching (PORCH-135).
//
// Profiles may carry a schedule window { start: "HH:MM", end: "HH:MM",
// days:[0-6] } (midnight-crossing allowed). Every evaluated tick, if a window
// edge crosses, the scheduled profile activates (source "schedule"); when the
// last in-window profile's edge exits, activation clears (back to home/base).
// Manual activation persists with source "manual" and is only disturbed by a
// real edge crossing. The clock is injectable so tests are deterministic.

import { ValidationError } from "./types.js";

function toMinutes(hhmm) {
	const [h, m] = hhmm.split(":").map(Number);
	return h * 60 + m;
}

/**
 * Is `date` inside the schedule window? Windows are [start, end); a
 * midnight-crossing window (start > end) covers start → end-of-day plus the
 * early-hours tail, attributed to the weekday the window started on.
 */
export function scheduleContains(schedule, date) {
	const minutes = date.getHours() * 60 + date.getMinutes();
	const start = toMinutes(schedule.start);
	const end = toMinutes(schedule.end);
	const day = date.getDay();
	const days = schedule.days ?? [];
	const crossing = start > end;
	// Early-hours tail of a crossing window: the window started yesterday.
	const attributedDay = crossing && minutes < end ? (day + 6) % 7 : day;
	if (days.length > 0 && !days.includes(attributedDay)) return false;
	if (crossing) return minutes >= start || minutes < end;
	return minutes >= start && minutes < end;
}

export function createScheduler({ profiles, now = () => new Date() }) {
	// The previous evaluated tick — the "edge" baseline. Injectable clock keeps
	// this fully deterministic in tests (no wall-clock dependence).
	let previous = now();

	return {
		/**
		 * Run one evaluation at `nowOverride` (Date or ISO string). Returns
		 * { activated, deactivated } where each is null/false or the
		 * { activeProfileId, changed } switch event.
		 */
		tick(nowOverride) {
			const t = nowOverride === undefined ? now() : new Date(nowOverride);
			if (Number.isNaN(t.getTime())) throw new ValidationError("scheduler: now must be a valid Date or ISO timestamp");
			const was = previous;
			previous = t;

			const scheduled = profiles.list().filter((p) => p.schedule);
			const inNow = scheduled.filter((p) => scheduleContains(p.schedule, t));
			const inWas = scheduled.filter((p) => scheduleContains(p.schedule, was));

			// Entering edge: a window contains the new time but not the previous.
			for (const profile of inNow) {
				if (!inWas.some((p) => p.id === profile.id)) {
					const activated = profiles.activate(profile.id, "schedule");
					return { activated, deactivated: false };
				}
			}
			// Exiting edge: the window(s) we were in have all ended → home.
			if (inWas.length > 0 && inNow.length === 0) {
				const deactivated = profiles.deactivate();
				return { activated: null, deactivated };
			}
			return { activated: null, deactivated: false };
		},
	};
}
