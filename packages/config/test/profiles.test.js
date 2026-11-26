// profiles.test.js — profile CRUD validation, layer resolution, schedule switching (PORCH-135).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NotFoundError } from "../src/types.js";
import { createConfigService } from "../src/index.js";

// Local-time dates (no Z) — the scheduler evaluates local HH:MM.
const clockAt = (iso) => () => new Date(iso);

function makeService(options = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "porch-profiles-"));
	const service = createConfigService({ root, consoleDist: null, ...options });
	return { root, service, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("profile CRUD validates the closed knob whitelist and scope rules", () => {
	const { service, cleanup } = makeService();
	try {
		const profile = service.profiles.create({
			name: "night",
			knobs: { recordingMode: "event", detectionClasses: ["person", "vehicle"] },
		});
		assert.match(profile.id, /^profile-/);
		assert.equal(profile.scope, "global"); // default scope
		assert.equal(profile.schedule, undefined);
		assert.deepEqual(service.profiles.list().map((p) => p.id), [profile.id]);

		assert.throws(() => service.profiles.create({ name: "x", knobs: { motionEnabled: true } }), /unknown knob "motionEnabled"/);
		assert.throws(() => service.profiles.create({ name: "x", knobs: { recordingMode: "turbo" } }), /"continuous" \| "event"/);
		assert.throws(() => service.profiles.create({ name: "x", knobs: { detectionClasses: ["ufo"] } }), /detectionClasses/);
		assert.throws(() => service.profiles.create({ name: "x", knobs: { alertRouting: "bus" } }), /alertRouting/);
		assert.throws(() => service.profiles.create({ name: "x", knobs: { detectionEnabled: "yes" } }), /detectionEnabled/);
		assert.throws(() => service.profiles.create({ name: "x", knobs: { audioDetectionEnabled: true }, scope: "camera" }), /cameraId: required/);
		assert.throws(() => service.profiles.create({ name: "" }), /profile name/);
		assert.throws(() => service.profiles.create({ name: "x", schedule: { start: "25:00", end: "06:00", days: [1] } }), /"HH:MM"/);
		assert.throws(() => service.profiles.create({ name: "x", schedule: { start: "09:00", end: "12:00", days: [7] } }), /weekdays 0–6/);
		assert.throws(() => service.profiles.create({ name: "x", schedule: { start: "09:00", end: "12:00", days: [] } }), /weekdays 0–6/);

		// Update merges: add a schedule, switch scope (stray cameraId ignored on global).
		const updated = service.profiles.update(profile.id, {
			knobs: { recordingMode: "continuous" },
			schedule: { start: "22:00", end: "06:00", days: [0, 1, 2, 3, 4, 5, 6] },
		});
		assert.deepEqual(updated.knobs, { recordingMode: "continuous" });
		assert.deepEqual(updated.schedule, { start: "22:00", end: "06:00", days: [0, 1, 2, 3, 4, 5, 6] });

		const scoped = service.profiles.create({ name: "front_night", scope: "camera", cameraId: "cam_a", knobs: { detectionEnabled: false } });
		const backToGlobal = service.profiles.update(scoped.id, { scope: "global", cameraId: "cam_a" });
		assert.equal(backToGlobal.scope, "global");
		assert.equal(backToGlobal.cameraId, undefined);
		assert.throws(() => service.profiles.update(scoped.id, { scope: "camera" }), /cameraId: required/);
		assert.throws(() => service.profiles.update("profile-nope", { knobs: {} }), NotFoundError);

		assert.equal(service.profiles.remove(profile.id), true);
		assert.deepEqual(service.profiles.list().map((p) => p.id), [scoped.id]);
		assert.throws(() => service.profiles.remove(profile.id), NotFoundError);
	} finally {
		cleanup();
	}
});

test("layer resolution: base camera > _default fallback, profile layer above base", () => {
	const { service, cleanup } = makeService();
	try {
		service.base.setScope("_default", { recordingMode: "event", detectionClasses: ["person"] });
		service.base.setScope("cam_a", { recordingMode: "continuous", alertRouting: ["bus"] });

		// Camera layer wins over _default; _default wins over built-in defaults.
		let knobs = service.profiles.inspectKnobs("cam_a").knobs;
		assert.equal(knobs.recordingMode.base, "continuous");
		assert.equal(knobs.recordingMode.value, "continuous");
		assert.equal(knobs.recordingMode.source, "base");
		assert.deepEqual(knobs.detectionClasses.base, ["person"]);
		assert.deepEqual(knobs.detectionClasses.value, ["person"]);
		assert.deepEqual(knobs.alertRouting.base, ["bus"]);
		assert.equal(knobs.zoneEnabled.base, true); // built-in default
		assert.equal(knobs.zoneEnabled.value, true);
		assert.equal(knobs.zoneEnabled.source, "base");

		// Another camera falls back to _default per knob.
		knobs = service.profiles.inspectKnobs("cam_b").knobs;
		assert.equal(knobs.recordingMode.base, "event");
		assert.deepEqual(knobs.detectionClasses.base, ["person"]);

		// A camera-scoped profile covers only its camera, knob-wise.
		const scoped = service.profiles.create({ name: "front_night", scope: "camera", cameraId: "cam_a", knobs: { detectionEnabled: false } });
		const event = service.profiles.activate(scoped.id);
		assert.deepEqual(event, {
			activeProfileId: scoped.id,
			changed: { cam_a: { detectionEnabled: { value: false, source: "profile" } } }, // recordingMode equals camera base → not changed
		});

		knobs = service.profiles.inspectKnobs("cam_a").knobs;
		assert.deepEqual(knobs.detectionEnabled, { base: true, value: false, source: "profile", profileId: scoped.id });
		assert.equal(knobs.recordingMode.source, "base"); // profile didn't touch it
		knobs = service.profiles.inspectKnobs("cam_b").knobs;
		assert.equal(knobs.detectionEnabled.value, true); // camera-scoped profile doesn't leak

		// Activating a global profile replaces the active profile; a global knob
		// overrides even a per-camera base layer (base → active profile → resolved).
		const global = service.profiles.create({ name: "fleet", knobs: { recordingMode: "event" } });
		const switchEvent = service.profiles.activate(global.id);
		assert.deepEqual(switchEvent, { activeProfileId: global.id, changed: {} }); // base._default is also "event"

		knobs = service.profiles.inspectKnobs("cam_a").knobs;
		assert.equal(knobs.recordingMode.value, "event");
		assert.equal(knobs.recordingMode.source, "profile");
		assert.equal(knobs.recordingMode.profileId, global.id);
		assert.equal(knobs.detectionEnabled.value, true); // camera profile gone
		assert.equal(knobs.detectionEnabled.source, "base");

		// Deactivation returns _default to base values with source "base".
		const home = service.profiles.deactivate();
		assert.deepEqual(home, { activeProfileId: null, changed: {} });
		knobs = service.profiles.inspectKnobs("cam_a").knobs;
		assert.equal(knobs.recordingMode.value, "continuous"); // camera base again
		assert.equal(knobs.recordingMode.source, "base");
	} finally {
		cleanup();
	}
});

test("deactivate publishes reverts for the profile's own layer", () => {
	const { service, cleanup } = makeService();
	try {
		service.base.setScope("_default", { recordingMode: "continuous" });
		const global = service.profiles.create({ name: "event_mode", knobs: { recordingMode: "event", detectionEnabled: false } });
		service.profiles.activate(global.id);
		const home = service.profiles.deactivate();
		assert.deepEqual(home, {
			activeProfileId: null,
			changed: { _default: { recordingMode: { value: "continuous", source: "base" }, detectionEnabled: { value: true, source: "base" } } },
		});
		// Deactivating with nothing active is a no-op.
		assert.deepEqual(service.profiles.deactivate(), { activeProfileId: null, changed: {} });
	} finally {
		cleanup();
	}
});

test("deleting the active profile clears the activation", () => {
	const { service, cleanup } = makeService();
	try {
		const profile = service.profiles.create({ name: "night", knobs: { recordingMode: "event" } });
		service.profiles.activate(profile.id);
		assert.equal(service.profiles.activeState().profileId, profile.id);
		service.profiles.remove(profile.id);
		assert.deepEqual(service.profiles.activeState(), { profileId: null, source: null });
	} finally {
		cleanup();
	}
});

test("schedule edge switching with an injected clock (midnight-crossing window)", () => {
	const { service, cleanup } = makeService({ now: clockAt("2026-06-15T12:00:00") }); // Monday noon
	try {
		service.base.setScope("_default", { recordingMode: "continuous" });
		const profile = service.profiles.create({
			name: "night_watch",
			knobs: { recordingMode: "event" },
			schedule: { start: "22:00", end: "06:00", days: [0, 1, 2, 3, 4, 5, 6] },
		});
		const seen = [];
		service.publisher.subscribe((e) => seen.push(e));

		// Ticks: the window edge crossing is what activates — not "any time inside".
		assert.deepEqual(service.scheduler.tick("2026-06-15T21:59:00"), { activated: null, deactivated: false });
		assert.deepEqual(service.profiles.activeState(), { profileId: null, source: null });

		const enter = service.scheduler.tick("2026-06-15T22:05:00");
		assert.deepEqual(enter.activated, {
			activeProfileId: profile.id,
			changed: { _default: { recordingMode: { value: "event", source: "profile" } } },
		});
		assert.equal(enter.deactivated, false);
		assert.deepEqual(service.profiles.activeState(), { profileId: profile.id, name: "night_watch", source: "schedule" });

		// Still inside the same window: no repeated switching.
		assert.deepEqual(service.scheduler.tick("2026-06-15T23:10:00"), { activated: null, deactivated: false });

		// Early-hours tail of the crossing window — attributed to the start day.
		assert.deepEqual(service.scheduler.tick("2026-06-16T05:30:00"), { activated: null, deactivated: false });

		// Window exit → home, base values with source "base".
		const exit = service.scheduler.tick("2026-06-16T06:30:00");
		assert.equal(exit.activated, null);
		assert.deepEqual(exit.deactivated, {
			activeProfileId: null,
			changed: { _default: { recordingMode: { value: "continuous", source: "base" } } },
		});
		assert.deepEqual(service.profiles.activeState(), { profileId: null, source: null });

		// Publisher saw exactly the two switch events.
		assert.deepEqual(seen, [enter.activated, exit.deactivated]);
	} finally {
		cleanup();
	}
});

test("schedule day membership filters activations", () => {
	const { service, cleanup } = makeService({ now: clockAt("2026-06-15T13:00:00") }); // Monday 13:00
	try {
		service.base.setScope("_default", { detectionEnabled: true });
		const weekday = service.profiles.create({
			name: "day_office",
			knobs: { detectionEnabled: false },
			schedule: { start: "09:00", end: "12:00", days: [1, 2, 3, 4, 5] },
		});
		// Saturday (day 6) inside the window but not in days → stays off.
		assert.deepEqual(service.scheduler.tick("2026-06-20T10:00:00"), { activated: null, deactivated: false });
		assert.deepEqual(service.profiles.activeState(), { profileId: null, source: null });
		// Monday (day 1) → the window edge with a matching day activates.
		const monday = service.scheduler.tick("2026-06-22T10:00:00");
		assert.deepEqual(monday, {
			activated: {
				activeProfileId: weekday.id,
				changed: { _default: { detectionEnabled: { value: false, source: "profile" } } },
			},
			deactivated: false,
		});
		// Leaving the window returns home with the base value.
		const exit = service.scheduler.tick("2026-06-22T12:30:00");
		assert.deepEqual(exit, {
			activated: null,
			deactivated: { activeProfileId: null, changed: { _default: { detectionEnabled: { value: true, source: "base" } } } },
		});
	} finally {
		cleanup();
	}
});

test("scheduled switching works for camera-scoped profiles", () => {
	const { service, cleanup } = makeService({ now: clockAt("2026-06-15T13:00:00") });
	try {
		service.base.setScope("cam_a", { recordingMode: "continuous" });
		const scoped = service.profiles.create({
			name: "front_night",
			scope: "camera",
			cameraId: "cam_a",
			knobs: { recordingMode: "event" },
			schedule: { start: "09:00", end: "12:00", days: [0, 1, 2, 3, 4, 5, 6] },
		});
		const enter = service.scheduler.tick("2026-06-16T09:01:00");
		assert.equal(enter.activated.activeProfileId, scoped.id);
		assert.deepEqual(enter.activated.changed, { cam_a: { recordingMode: { value: "event", source: "profile" } } });
		let knobs = service.profiles.inspectKnobs("cam_a").knobs;
		assert.equal(knobs.recordingMode.value, "event");
		knobs = service.profiles.inspectKnobs("cam_b").knobs;
		assert.equal(knobs.recordingMode.value, "continuous");

		const exit = service.scheduler.tick("2026-06-16T12:01:00");
		assert.deepEqual(exit.deactivated.changed, { cam_a: { recordingMode: { value: "continuous", source: "base" } } });
	} finally {
		cleanup();
	}
});

test("profiles persist and a restart resumes activation state", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "porch-profiles-"));
	try {
		const first = createConfigService({ root, consoleDist: null });
		const profile = first.profiles.create({ name: "night", knobs: { recordingMode: "event" } });
		first.profiles.activate(profile.id);

		const reborn = createConfigService({ root, consoleDist: null });
		assert.deepEqual(reborn.profiles.list(), first.profiles.list());
		assert.deepEqual(reborn.profiles.activeState(), { profileId: profile.id, name: "night", source: "manual" });
		const knobs = reborn.profiles.inspectKnobs("cam_any").knobs;
		assert.equal(knobs.recordingMode.value, "event");
		assert.equal(knobs.recordingMode.source, "profile");
		assert.equal(knobs.recordingMode.profileId, profile.id);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
