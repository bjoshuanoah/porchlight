// server.test.js — fetch-based API contract tests on an ephemeral port (PORCH-135).
//
// Covers every REST endpoint of the contract table incl. 422/404 paths, the
// snapshot placeholder, and static dist serving with SPA fallback.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import osDefault from "node:os";
import pathDefault from "node:path";

import { createConfigService } from "../src/index.js";

describe("config server API contract", () => {
	const ctx = {};

	async function api(method, pathname, body) {
		const res = await fetch(`http://127.0.0.1:${ctx.port}${pathname}`, {
			method,
			headers: body === undefined ? {} : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await res.text();
		return { status: res.status, headers: res.headers, body: text.trim() === "" ? null : JSON.parse(text) };
	}

	before(async () => {
		const root = fsDefault.mkdtempSync(pathDefault.join(osDefault.tmpdir(), "porch-server-"));
		const service = createConfigService({ root, consoleDist: null });
		const handle = await service.start(0);
		ctx.root = root;
		ctx.port = handle.port;
		ctx.handle = handle;
	});

	after(async () => {
		await ctx.handle?.close();
		if (ctx.root) fsDefault.rmSync(ctx.root, { recursive: true, force: true });
	});

const rect = (x1, y1, x2, y2) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];

test("GET /api/health reports the service identity", async () => {
	const { status, body } = await api("GET", "/api/health");
	assert.equal(status, 200);
	assert.deepEqual(body, { ok: true, service: "config" });
});

test("cameras: PUT upsert validates ints > 0; GET lists the shape", async () => {
	const put = await api("PUT", "/api/cameras/front_left", { name: "Front Left", width: 1920, height: 1080, snapshotUrl: "http://cam/snap" });
	assert.equal(put.status, 200);
	assert.deepEqual(put.body, { id: "front_left", name: "Front Left", width: 1920, height: 1080, snapshotUrl: "http://cam/snap" });

	const list = await api("GET", "/api/cameras");
	assert.equal(list.status, 200);
	assert.deepEqual(list.body, [put.body]);

	// Partial update keeps the other fields.
	const patch = await api("PUT", "/api/cameras/front_left", { width: 1280, height: 720 });
	assert.equal(patch.status, 200);
	assert.deepEqual(patch.body, { id: "front_left", name: "Front Left", width: 1280, height: 720, snapshotUrl: "http://cam/snap" });

	await api("PUT", "/api/cameras/back_door", { name: "Back Door", width: 640, height: 480 });

	assert.equal((await api("PUT", "/api/cameras/bad", { name: "x", width: 0, height: 100 })).status, 422);
	assert.equal((await api("PUT", "/api/cameras/bad", { name: "x", width: 100.5, height: 100 })).status, 422);
	assert.equal((await api("PUT", "/api/cameras/bad", { width: 100, height: 100 })).status, 422); // create needs a name
	assert.equal((await api("PUT", "/api/cameras/bad%2F..%2Fetc", { name: "x", width: 1, height: 1 })).status, 422);
	assert.equal((await api("PUT", "/api/cameras/bad", "{not json")).status, 422);
});

test("zones/masks CRUD over HTTP incl. 422 and 404 paths", async () => {
	const created = await api("POST", "/api/cameras/front_left/zones", { name: "driveway", polygon: rect(10, 10, 40, 50) });
	assert.equal(created.status, 201);
	assert.deepEqual(created.body, { id: created.body.id, cameraId: "front_left", name: "driveway", enabled: true, polygon: rect(10, 10, 40, 50) });
	assert.match(created.body.id, /^zone-/);

	const list = await api("GET", "/api/cameras/front_left/zones");
	assert.equal(list.status, 200);
	assert.deepEqual(list.body, [created.body]);

	const updated = await api("PUT", `/api/zones/${created.body.id}`, { enabled: false, polygon: rect(1, 1, 2, 2) });
	assert.equal(updated.status, 200);
	assert.deepEqual(updated.body, { ...created.body, enabled: false, polygon: rect(1, 1, 2, 2) });

	assert.equal((await api("POST", "/api/cameras/front_left/zones", { name: "x", polygon: [[0, 0], [10, 10]] })).status, 422);
	assert.equal((await api("POST", "/api/cameras/front_left/zones", { name: "x", polygon: [[0, 0], [101, 0], [10, 10]] })).status, 422);
	assert.equal((await api("PUT", "/api/zones/zone-nope", { enabled: true })).status, 404);

	const mask = await api("POST", "/api/cameras/front_left/masks", { name: "mailbox", polygon: rect(0, 0, 5, 5), enabled: true });
	assert.equal(mask.status, 201);
	assert.match(mask.body.id, /^mask-/);
	assert.equal((await api("GET", "/api/cameras/front_left/masks")).body.length, 1);
	assert.equal((await api("PUT", "/api/masks/mask-nope", {})).status, 404);

	const del = await api("DELETE", `/api/masks/${mask.body.id}`);
	assert.equal(del.status, 200);
	assert.deepEqual(del.body, { ok: true });
	assert.equal((await api("DELETE", `/api/masks/${mask.body.id}`)).status, 404);
});

test("composition endpoint returns defs, contributors, and overlap unions", async () => {
	const a = await api("POST", "/api/cameras/back_door/zones", { name: "a", polygon: rect(0, 0, 30, 30) });
	const b = await api("POST", "/api/cameras/back_door/zones", { name: "b", polygon: rect(20, 0, 50, 30) });
	const comp = await api("GET", "/api/cameras/back_door/composition");
	assert.equal(comp.status, 200);
	assert.equal(comp.body.cameraId, "back_door");
	assert.deepEqual(comp.body.zones.map((z) => z.id).sort(), [a.body.id, b.body.id].sort());
	assert.deepEqual(comp.body.masks, []);
	assert.deepEqual(comp.body.contributors, [
		{ kind: "zone", id: a.body.id, name: "a", enabled: true },
		{ kind: "zone", id: b.body.id, name: "b", enabled: true },
	]);
	assert.deepEqual(comp.body.overlaps, [{ kind: "zone", ids: [a.body.id, b.body.id] }]);
	// Unknown camera composes empty per the resolver (permissive list surface).
	assert.deepEqual((await api("GET", "/api/cameras/ghost/composition")).body.contributors, []);
});

test("speed endpoints: validation, calibration, test estimate, 422 without calibration", async () => {
	assert.deepEqual((await api("GET", "/api/cameras/front_left/speed")).body, { enabled: false });
	assert.equal((await api("POST", "/api/cameras/front_left/speed/test", { track: [{ t: 0, px: 0, py: 0 }, { t: 1, px: 1, py: 1 }] })).status, 422);
	assert.equal((await api("PUT", "/api/cameras/ghost/speed", { meters: 5 })).status, 404);

	const put = await api("PUT", "/api/cameras/front_left/speed", {
		enabled: true,
		area: rect(0, 50, 100, 100),
		line: { p1: [0, 0], p2: [0, 50] },
		meters: 10,
	});
	assert.equal(put.status, 200);
	assert.deepEqual(put.body, {
		enabled: true,
		area: rect(0, 50, 100, 100),
		line: { p1: [0, 0], p2: [0, 50] },
		meters: 10,
	});
	assert.equal((await api("PUT", "/api/cameras/front_left/speed", { meters: -1 })).status, 422);
	assert.equal((await api("PUT", "/api/cameras/front_left/speed", { line: { p1: [5, 5], p2: [5, 5] }, meters: 1 })).status, 422);

	// front_left was reshaped to 1280x720 by the cameras test: 50% height is
	// now 360 px → 36 px/m (fair). Track walks 10% of height (72 px) in 10 s.
	const est = await api("POST", "/api/cameras/front_left/speed/test", {
		track: [{ t: 0, px: 10, py: 10 }, { t: 10, px: 10, py: 20 }],
	});
	assert.equal(est.status, 200);
	assert.equal(est.body.estimate, true);
	assert.equal(est.body.quality.grade, "fair");
	assert.equal(est.body.quality.pxPerMeter, 36);
	assert(Math.abs(est.body.speedMps - 0.2) < 1e-12);

	assert.equal((await api("POST", "/api/cameras/front_left/speed/test", { track: [{ t: 0, px: 0, py: 0 }] })).status, 422);
	assert.equal((await api("POST", "/api/cameras/ghost/speed/test", { track: [] })).status, 404);
});

test("profiles CRUD over HTTP, whitelist rejection, activate shape", async () => {
	const created = await api("POST", "/api/profiles", { name: "night", knobs: { recordingMode: "event", alertRouting: ["bus"] } });
	assert.equal(created.status, 201);
	assert.match(created.body.id, /^profile-/);

	assert.equal((await api("POST", "/api/profiles", { name: "x", knobs: { motionEnabled: true } })).status, 422);
	assert.equal((await api("POST", "/api/profiles", { name: "x", scope: "camera" })).status, 422);

	const cameraProfile = await api("POST", "/api/profiles", { name: "front_night", scope: "camera", cameraId: "front_left", knobs: { detectionEnabled: false } });
	assert.equal(cameraProfile.status, 201);
	assert.equal((await api("GET", "/api/profiles")).body.length, 2);

	// PUT merges top-level fields: adding a schedule leaves the knobs alone.
	const put = await api("PUT", `/api/profiles/${created.body.id}`, { schedule: { start: "22:00", end: "06:00", days: [0, 1, 2, 3, 4, 5, 6] } });
	assert.equal(put.status, 200);
	assert.deepEqual(put.body.schedule, { start: "22:00", end: "06:00", days: [0, 1, 2, 3, 4, 5, 6] });
	assert.deepEqual(put.body.knobs, { recordingMode: "event", alertRouting: ["bus"] });

	// Base is untouched so far → defaults apply: recordingMode ("event") and
	// alertRouting ([] → ["bus"]) both change; nested under the "_default" scope.
	const active = await api("POST", `/api/profiles/${created.body.id}/activate`);
	assert.equal(active.status, 200);
	assert.deepEqual(active.body, {
		activeProfileId: created.body.id,
		changed: {
			_default: {
				recordingMode: { value: "event", source: "profile" },
				alertRouting: { value: ["bus"], source: "profile" },
			},
		},
	});

	const state = await api("GET", "/api/config/active");
	assert.equal(state.status, 200);
	assert.deepEqual(state.body, { profileId: created.body.id, name: "night", source: "manual" });

	// Camera-scoped activation changes only that camera's scope key.
	const camActivate = await api("POST", `/api/profiles/${cameraProfile.body.id}/activate`);
	assert.deepEqual(camActivate.body.changed, { front_left: { detectionEnabled: { value: false, source: "profile" } } });

	assert.equal((await api("POST", "/api/profiles/profile-nope/activate")).status, 404);
	assert.equal((await api("PUT", "/api/profiles/profile-nope", { knobs: {} })).status, 404);
	assert.equal((await api("DELETE", "/api/profiles/profile-nope")).status, 404);

	const del = await api("DELETE", `/api/profiles/${cameraProfile.body.id}`);
	assert.deepEqual(del.body, { ok: true });
	assert.equal((await api("GET", "/api/profiles")).body.length, 1);

	// Deleting the ACTIVE profile clears activation (delete night too so the
	// later tests start from a clean default state).
	assert.equal((await api("DELETE", `/api/profiles/${created.body.id}`)).status, 200);
	assert.deepEqual((await api("GET", "/api/config/active")).body, { profileId: null, source: null });
	assert.equal((await api("GET", "/api/profiles")).body.length, 0);
});

test("base config GET/PUT per-scope upsert with whitelist validation", async () => {
	assert.deepEqual((await api("GET", "/api/config/base")).body, {});
	const put = await api("PUT", "/api/config/base", { "_default": { recordingMode: "event" }, back_door: { zoneEnabled: false } });
	assert.equal(put.status, 200);
	assert.deepEqual(put.body, { "_default": { recordingMode: "event" }, back_door: { zoneEnabled: false } });
	const got = await api("GET", "/api/config/base");
	assert.deepEqual(got.body, { "_default": { recordingMode: "event" }, back_door: { zoneEnabled: false } });

	// Merge semantics: an existing scope keeps untouched knobs.
	await api("PUT", "/api/config/base", { "_default": { detectionEnabled: false } });
	assert.deepEqual((await api("GET", "/api/config/base")).body._default, { recordingMode: "event", detectionEnabled: false });

	assert.equal((await api("PUT", "/api/config/base", { "_default": { motionEnabled: true } })).status, 422);
	assert.equal((await api("PUT", "/api/config/base", { back_door: { recordingMode: "turbo" } })).status, 422);
	assert.equal((await api("PUT", "/api/config/base", {})).status, 422);
});

test("knob inspector returns exactly the six whitelist knobs with base/value/source", async () => {
	const knobs = await api("GET", "/api/config/knobs?cameraId=front_left");
	assert.equal(knobs.status, 200);
	assert.deepEqual(Object.keys(knobs.body.knobs).sort(), [
		"alertRouting", "audioDetectionEnabled", "detectionClasses", "detectionEnabled", "recordingMode", "zoneEnabled",
	]);
	assert.equal(knobs.body.cameraId, "front_left");
	// Base resolves camera > _default > built-in default; nothing active here.
	assert.equal(knobs.body.knobs.recordingMode.base, "event"); // from the base test
	assert.equal(knobs.body.knobs.recordingMode.value, "event");
	assert.equal(knobs.body.knobs.recordingMode.source, "base");
	assert.equal(knobs.body.knobs.detectionEnabled.base, false); // from the base merge test
	assert.equal(knobs.body.knobs.zoneEnabled.base, true); // built-in default

	// Activating a camera-scoped profile flips source to "profile" with profileId.
	const profile = await api("POST", "/api/profiles", { name: "front_cont", scope: "camera", cameraId: "front_left", knobs: { recordingMode: "continuous" } });
	const active = await api("POST", `/api/profiles/${profile.body.id}/activate`);
	assert.deepEqual(active.body.changed, { front_left: { recordingMode: { value: "continuous", source: "profile" } } });

	const after = await api("GET", "/api/config/knobs?cameraId=front_left");
	assert.deepEqual(after.body.knobs.recordingMode, {
		base: "event",
		value: "continuous",
		source: "profile",
		profileId: profile.body.id,
	});
	assert.equal(after.body.knobs.detectionEnabled.source, "base"); // untouched by the profile

	assert.equal((await api("GET", "/api/config/knobs")).status, 422);
});

test("snapshot: generated test pattern placeholder, or 302 to a real snapshotUrl", async () => {
	// A camera WITHOUT snapshotUrl renders the deterministic SVG pattern.
	const camRes = await api("PUT", "/api/cameras/pattern_only", { name: "Pattern", width: 960, height: 540 });
	assert.equal(camRes.status, 200);
	const svg = await fetch(`http://127.0.0.1:${ctx.port}/api/cameras/pattern_only/snapshot?w=640&h=480`);
	assert.equal(svg.status, 200);
	assert.match(svg.headers.get("content-type"), /image\/svg\+xml/);
	const text = await svg.text();
	assert.match(text, /<svg /);
	assert.match(text, /pattern_only/);
	assert.match(text, /640×480/);
	assert.match(text, /generated test pattern/);

	// Resolution defaults to the camera's stored stream resolution.
	const def = await fetch(`http://127.0.0.1:${ctx.port}/api/cameras/pattern_only/snapshot`);
	assert.match(await def.text(), /960×540/);

	await api("PUT", "/api/cameras/real", { name: "Real", width: 640, height: 480, snapshotUrl: "http://cam.internal/snap.jpg" });
	const redirect = await fetch(`http://127.0.0.1:${ctx.port}/api/cameras/real/snapshot`, { redirect: "manual" });
	assert.equal(redirect.status, 302);
	assert.equal(redirect.headers.get("location"), "http://cam.internal/snap.jpg");

	assert.equal((await fetch(`http://127.0.0.1:${ctx.port}/api/cameras/ghost/snapshot`)).status, 404);
	assert.equal((await fetch(`http://127.0.0.1:${ctx.port}/api/cameras/pattern_only/snapshot?w=nope`)).status, 422);
});

test("tick endpoint runs the schedule evaluator with the injected time", async () => {
	await api("PUT", "/api/config/base", { "_default": { recordingMode: "continuous" } });
	const profile = await api("POST", "/api/profiles", {
		name: "sched_night",
		knobs: { recordingMode: "event" },
		schedule: { start: "22:00", end: "06:00", days: [0, 1, 2, 3, 4, 5, 6] },
	});
	const bad = await api("POST", "/api/config/tick", {});
	assert.equal(bad.status, 422);
	assert.equal((await api("POST", "/api/config/tick", { now: "nope" })).status, 422);

	const off = await api("POST", "/api/config/tick", { now: "2026-06-15T12:00:00" });
	assert.deepEqual(off.body, { activated: null, deactivated: false });

	const enter = await api("POST", "/api/config/tick", { now: "2026-06-15T22:10:00" });
	assert.deepEqual(enter.body.activated, {
		activeProfileId: profile.body.id,
		changed: { _default: { recordingMode: { value: "event", source: "profile" } } },
	});
	assert.deepEqual((await api("GET", "/api/config/active")).body, { profileId: profile.body.id, name: "sched_night", source: "schedule" });

	const exit = await api("POST", "/api/config/tick", { now: "2026-06-16T08:00:00" });
	assert.deepEqual(exit.body.deactivated, {
		activeProfileId: null,
		changed: { _default: { recordingMode: { value: "continuous", source: "base" } } },
	});
});

test("unknown API routes are JSON 404s", async () => {
	const res = await api("GET", "/api/definitely-not-a-route");
	assert.equal(res.status, 404);
	assert.match(res.body.error, /no route/);
	assert.equal((await api("DELETE", "/api/health")).status, 404);
});

test("static dist serving: MIME, cache headers, SPA fallback, traversal guard", async (t) => {
	const dist = fsDefault.mkdtempSync(pathDefault.join(osDefault.tmpdir(), "porch-dist-"));
	t.after(() => fsDefault.rmSync(dist, { recursive: true, force: true }));
	fsDefault.mkdirSync(pathDefault.join(dist, "assets"), { recursive: true });
	fsDefault.writeFileSync(pathDefault.join(dist, "index.html"), "<!doctype html><html><body>porch console</body></html>");
	fsDefault.writeFileSync(pathDefault.join(dist, "assets", "app-Ab12cd34.js"), "console.log('app')");
	fsDefault.writeFileSync(pathDefault.join(dist, "assets", "style.css"), "body { margin: 0 }");
	fsDefault.writeFileSync(pathDefault.join(dist, "logo.svg"), "<svg/>");

	const root = fsDefault.mkdtempSync(pathDefault.join(osDefault.tmpdir(), "porch-static-"));
	const service = createConfigService({ root, consoleDist: dist });
	const handle = await service.start(0);
	t.after(() => handle.close());
	const base = `http://127.0.0.1:${handle.port}`;

	const index = await fetch(`${base}/`);
	assert.equal(index.status, 200);
	assert.match(index.headers.get("content-type"), /text\/html/);
	assert.equal(index.headers.get("cache-control"), null); // no cache headers for html
	assert.match(await index.text(), /porch console/);

	const hashed = await fetch(`${base}/assets/app-Ab12cd34.js`);
	assert.equal(hashed.status, 200);
	assert.match(hashed.headers.get("content-type"), /javascript/);
	assert.equal(hashed.headers.get("cache-control"), "public, max-age=31536000, immutable");

	const plain = await fetch(`${base}/assets/style.css`);
	assert.equal(plain.status, 200);
	assert.match(plain.headers.get("content-type"), /text\/css/);
	assert.equal(plain.headers.get("cache-control"), null); // not hashed → not pinned

	const logo = await fetch(`${base}/logo.svg`);
	assert.match(logo.headers.get("content-type"), /svg/);

	const fallback = await fetch(`${base}/screens/profiles`);
	assert.equal(fallback.status, 200);
	assert.match(fallback.headers.get("content-type"), /text\/html/);

	// Unknown file paths fall back to the SPA shell.
	const missingFile = await fetch(`${base}/nope.svg`);
	assert.equal(missingFile.status, 200);
	assert.match(missingFile.headers.get("content-type"), /text\/html/);

	// Encoded traversal is refused by the root containment check.
	assert.equal((await fetch(`${base}/..%2Foutside.txt`)).status, 404);

	const rootRes = await fetch(`${base}/`);
	assert.equal(rootRes.status, 200);
});

});
