// e2e.test.js — PORCH-135 TS 11/12 acceptance hooks, env-free (no real
// cameras/network beyond localhost): resolution-change, switch-away-home,
// restart resume. Drives the REST surface over HTTP like the console does.

import { test } from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import osDefault from "node:os";
import pathDefault from "node:path";

import { createConfigService } from "../src/index.js";
import { toPixels } from "../src/geometry.js";

const ZONE_POLYGON = [[10, 10], [50, 10], [50, 45], [10, 45]];

/** Boot a service + ephemeral HTTP server + fetch api helper over a temp root. */
async function boot({ root, now } = {}) {
	const r = root ?? fsDefault.mkdtempSync(pathDefault.join(osDefault.tmpdir(), "porch-e2e-"));
	const service = createConfigService({ root: r, consoleDist: null, ...(now ? { now } : {}) });
	const handle = await service.start(0);
	const api = async (method, pathname, body) => {
		const res = await fetch(`http://127.0.0.1:${handle.port}${pathname}`, {
			method,
			headers: body === undefined ? {} : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await res.text();
		return { status: res.status, body: text.trim() === "" ? null : JSON.parse(text) };
	};
	return {
		root: r,
		service,
		handle,
		api,
		cleanup: async () => {
			await handle.close();
		},
	};
}

function removeRoot(root) {
	fsDefault.rmSync(root, { recursive: true, force: true });
}

test("ac: resolution change leaves composition polygons and computed pixel regions identical", async () => {
	const ctx = await boot();
	try {
		let res = await ctx.api("PUT", "/api/cameras/street", { name: "Street", width: 1920, height: 1080 });
		assert.equal(res.status, 200);

		res = await ctx.api("POST", "/api/cameras/street/zones", { name: "curb", polygon: ZONE_POLYGON });
		assert.equal(res.status, 201);

		// Change the camera resolution through the same cameras endpoint.
		res = await ctx.api("PUT", "/api/cameras/street", { width: 1280, height: 720 });
		assert.equal(res.status, 200);
		assert.equal(res.body.width, 1280);
		assert.equal(res.body.height, 720);

		// The polygon is percent-based: composition returns it unchanged.
		const comp = await ctx.api("GET", "/api/cameras/street/composition");
		assert.equal(comp.status, 200);
		assert.deepEqual(comp.body.zones[0].polygon, ZONE_POLYGON);

		// The percent polygon maps to the identical fractional frame region at
		// both resolutions (derived pixel region, normalized by the frame).
		const regionAt = (width, height) => ZONE_POLYGON.map((pt) => {
			const [px, py] = toPixels(pt, width, height);
			return [px / width, py / height];
		});
		assert.deepEqual(regionAt(1280, 720), regionAt(1920, 1080));
	} finally {
		await ctx.cleanup();
		removeRoot(ctx.root);
	}
});

test("ac: switch-away-home reports exactly the changed knobs and returns home on window exit", async () => {
	const ctx = await boot({ now: () => new Date("2026-06-15T15:00:00") });
	try {
		const seen = [];
		ctx.service.publisher.subscribe((event) => seen.push(event));

		await ctx.api("PUT", "/api/config/base", { "_default": { recordingMode: "continuous", alertRouting: ["webhook"] } });
		const profile = await ctx.api("POST", "/api/profiles", {
			name: "night",
			knobs: { recordingMode: "event", alertRouting: ["bus"] },
			schedule: { start: "22:00", end: "06:00", days: [0, 1, 2, 3, 4, 5, 6] },
		});
		assert.equal(profile.status, 201);

		// Manual switch: exactly the two knobs that differ from base, nested
		// under the "_default" scope; the publisher got the identical object.
		const activate = await ctx.api("POST", `/api/profiles/${profile.body.id}/activate`);
		assert.deepEqual(activate.body, {
			activeProfileId: profile.body.id,
			changed: {
				_default: {
					recordingMode: { value: "event", source: "profile" },
					alertRouting: { value: ["bus"], source: "profile" },
				},
			},
		});
		assert.deepEqual(seen[0], activate.body);

		// Scheduled context: crossing into the profile's own window re-asserts
		// it with source "schedule" (values already applied → no knob deltas
		// but the activation source moves to schedule).
		await ctx.api("POST", "/api/config/tick", { now: "2026-06-15T22:10:00" });
		assert.deepEqual((await ctx.api("GET", "/api/config/active")).body, { profileId: profile.body.id, name: "night", source: "schedule" });

		// Window exit → home: base values with source "base", activation cleared.
		const tickOut = await ctx.api("POST", "/api/config/tick", { now: "2026-06-16T06:30:00" });
		assert.deepEqual(tickOut.body.deactivated, {
			activeProfileId: null,
			changed: {
				_default: {
					recordingMode: { value: "continuous", source: "base" },
					alertRouting: { value: ["webhook"], source: "base" },
				},
			},
		});
		assert.deepEqual((await ctx.api("GET", "/api/config/active")).body, { profileId: null, source: null });
		const knobs = await ctx.api("GET", "/api/config/knobs?cameraId=street_cam");
		assert.deepEqual(knobs.body.knobs.recordingMode, {
			base: "continuous",
			value: "continuous",
			source: "base",
		});
		assert.deepEqual(knobs.body.knobs.alertRouting, {
			base: ["webhook"],
			value: ["webhook"],
			source: "base",
		});

		// The publisher saw the full manual → schedule → home sequence.
		assert.equal(seen.length, 3);
		assert.equal(seen[0].activeProfileId, profile.body.id);
		assert.deepEqual(seen[1], { activeProfileId: profile.body.id, changed: {} });
		assert.deepEqual(seen[2], tickOut.body.deactivated);
	} finally {
		await ctx.cleanup();
		removeRoot(ctx.root);
	}
});

test("ac: restart — a new service instance over the same root resumes the active profile", async () => {
	const root = fsDefault.mkdtempSync(pathDefault.join(osDefault.tmpdir(), "porch-e2e-"));
	{
		const first = await boot({ root });
		try {
			await first.api("PUT", "/api/cameras/front_left", { name: "Front Left", width: 1920, height: 1080 });
			const zone = await first.api("POST", "/api/cameras/front_left/zones", { name: "driveway", polygon: ZONE_POLYGON });
			await first.api("PUT", "/api/config/base", { "_default": { recordingMode: "continuous" } });
			const profile = await first.api("POST", "/api/profiles", { name: "night", knobs: { recordingMode: "event" } });
			const activate = await first.api("POST", `/api/profiles/${profile.body.id}/activate`);
			assert.deepEqual(activate.body.changed, { _default: { recordingMode: { value: "event", source: "profile" } } });
			assert.equal(zone.status, 201);
		} finally {
			await first.cleanup(); // closes the HTTP server; the config dir persists
		}
	}

	const reborn = await boot({ root });
	try {
		const active = await reborn.api("GET", "/api/config/active");
		assert.deepEqual(active.body, { profileId: active.body.profileId, name: "night", source: "manual" });

		const knobs = await reborn.api("GET", "/api/config/knobs?cameraId=front_left");
		assert.deepEqual(knobs.body.knobs.recordingMode, {
			base: "continuous",
			value: "event",
			source: "profile",
			profileId: active.body.profileId,
		});

		const zones = await reborn.api("GET", "/api/cameras/front_left/zones");
		assert.equal(zones.body.length, 1);
		assert.equal(zones.body[0].name, "driveway");
		assert.deepEqual(zones.body[0].polygon, ZONE_POLYGON);
	} finally {
		await reborn.cleanup();
		removeRoot(root);
	}
});
