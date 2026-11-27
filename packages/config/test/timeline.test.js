// timeline.test.js — the recorded-media index of record + range serving (PORCH-130).
//
// Covers days/hour listings over a fixture store (real segment files, .part
// never listed), the segment-at hit/miss gap contract, the engine seams the
// hub's HttpEngineAdapter already calls (/segments /segment /evidence
// /media), byte-range serving (200 full / 206 slice / 416 unsatisfiable),
// component-refusal (traversal, .part), and the storage root of record
// resolved from the platform config of record.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import osDefault from "node:os";
import pathDefault from "node:path";

import { createConfigService } from "../src/index.js";
import { NotFoundError } from "../src/types.js";

const DAY = "2026-11-20";
const T = (h, m, s) => Date.UTC(2026, 10, 20, h, m, s) / 1000;

function tmpRoot(prefix) {
	return fsDefault.mkdtempSync(pathDefault.join(osDefault.tmpdir(), prefix));
}

/** Write one settled or in-progress segment file of record layout. */
function writeSegment(storeRoot, date, hour, camera, base, body) {
	const dir = pathDefault.join(storeRoot, date, hour, camera);
	fsDefault.mkdirSync(dir, { recursive: true });
	fsDefault.writeFileSync(pathDefault.join(dir, `${base}.mp4`), Buffer.from(body, "utf8"));
	return pathDefault.join(dir, `${base}.mp4`);
}

/** Fixture store: two settled segments in hour 14, a live part, a later hour, another camera. */
function writeFixtureStore(storeRoot) {
	fsDefault.mkdirSync(storeRoot, { recursive: true });
	writeSegment(storeRoot, DAY, "14", "front_left", "103022", "A".repeat(40));
	writeSegment(storeRoot, DAY, "14", "front_left", "103522", "B".repeat(96));
	writeSegment(storeRoot, DAY, "16", "front_left", "160000", "C".repeat(20));
	writeSegment(storeRoot, DAY, "15", "back_door", "150500", "D".repeat(8));
	const partDir = pathDefault.join(storeRoot, DAY, "14", "front_left");
	fsDefault.writeFileSync(pathDefault.join(partDir, "104001.part"), "in-progress");
}

async function boot(root, opts = {}, fleet = ["front_left", "back_door"]) {
	const service = createConfigService({ root, consoleDist: null, ...opts });
	for (const id of fleet) await service.cameras.upsert(id, { name: id, width: 640, height: 480 });
	const handle = await service.start(0);
	return { service, handle, api };
	async function api(method, pathname, body, headers = {}) {
		const res = await fetch(`http://127.0.0.1:${handle.port}${pathname}`, {
			method,
			headers: {
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...headers,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await res.text();
		return { status: res.status, headers: res.headers, body: text.trim() === "" ? null : JSON.parse(text), text };
	}
}

describe("segment index service (days/hour/at over the store of record)", () => {
	test("days lists hours holding settled segments only, per camera", async (t) => {
		const root = tmpRoot("porch-timeline-");
		t.after(() => fsDefault.rmSync(root, { recursive: true, force: true }));
		writeFixtureStore(root);
		const { service, handle } = await boot(root, {}, ["front_left", "back_door", "empty_cam"]);
		t.after(() => handle.close());

		assert.deepEqual(service.segments.days("front_left"), { days: [{ date: DAY, hours: ["14", "16"] }] });
		assert.deepEqual(service.segments.days("back_door"), { days: [{ date: DAY, hours: ["15"] }] });
		assert.deepEqual(service.segments.days("empty_cam"), { days: [] });
	});

	test("hour lists the settled segments sorted by start with the span of record", async (t) => {
		const root = tmpRoot("porch-timeline-");
		t.after(() => fsDefault.rmSync(root, { recursive: true, force: true }));
		writeFixtureStore(root);
		const { service, handle } = await boot(root);
		t.after(() => handle.close());

		const answer = service.segments.hour("front_left", DAY, "14");
		assert.equal(answer.cameraId, "front_left");
		assert.equal(answer.date, DAY);
		assert.equal(answer.hour, "14");
		assert.deepEqual(answer.segments, [
			{ start: T(14, 30, 22), end: T(14, 35, 22), ref: `seg:front_left/${DAY}/14/103022`, path: `/api/media/front_left/${DAY}/14/103022` },
			// Span model of record: end = next segment's start (next hour allowed).
			{ start: T(14, 35, 22), end: T(14, 45, 22), ref: `seg:front_left/${DAY}/14/103522`, path: `/api/media/front_left/${DAY}/14/103522` },
		]);
		// The tail hour's last segment closes at the recorder's own span budget
		// (cfg.segmentSeconds default 600), capped at the current time — never
		// zero-length, because a zero-length span renders recorded hours empty.
		assert.deepEqual(service.segments.hour("front_left", DAY, "16").segments, [
			{ start: T(16, 0, 0), end: T(16, 10, 0), ref: `seg:front_left/${DAY}/16/160000`, path: `/api/media/front_left/${DAY}/16/160000` },
		]);
	});

	test("unknown camera 404s in plain language; date/hour refuse 422", async (t) => {
		const root = tmpRoot("porch-timeline-");
		t.after(() => fsDefault.rmSync(root, { recursive: true, force: true }));
		writeFixtureStore(root);
		const { service, api, handle } = await boot(root);
		t.after(() => handle.close());

		assert.throws(() => service.segments.days("nope"), NotFoundError);
		try {
			service.segments.days("nope");
			assert.fail("expected NotFoundError");
		} catch (err) {
			assert.equal(err.message, 'unknown camera "nope"');
		}
		assert.throws(() => service.segments.hour("front_left", "2026-02-30", "14"), /must be a real calendar date/);
		assert.throws(() => service.segments.hour("front_left", "2026-1-1", "14"), /date must be a UTC date/);
		assert.throws(() => service.segments.hour("front_left", DAY, "24"), /hour must be a UTC hour/);
		assert.throws(() => service.segments.hour("front_left", DAY, "7"), /hour must be a UTC hour/);

		// REST mirrors the contract: 404 plain language for an unknown camera,
		// 422 for a non-date/non-hour.
		const unknownDays = await api("GET", "/api/segments/days?cameraId=nope");
		assert.equal(unknownDays.status, 404);
		assert.deepEqual(unknownDays.body, { error: 'unknown camera "nope"' });
		const badDate = await api("GET", "/api/segments?cameraId=front_left&date=2026-02-30&hour=14");
		assert.equal(badDate.status, 422);
		assert.match(badDate.body.error, /must be a real calendar date/);
		const badHour = await api("GET", "/api/segments?cameraId=front_left&date=2026-11-20&hour=24");
		assert.equal(badHour.status, 422);
		assert.match(badHour.body.error, /hour must be a UTC hour/);
	});

	test("at over REST answers the hit, the plain gap body, and never 404s an unknown camera", async (t) => {
		const root = tmpRoot("porch-timeline-");
		t.after(() => fsDefault.rmSync(root, { recursive: true, force: true }));
		writeFixtureStore(root);
		const { api, handle } = await boot(root);
		t.after(() => handle.close());

		const hit = await api("GET", `/api/segment?cameraId=front_left&at=${T(14, 36, 0)}`);
		assert.equal(hit.status, 200);
		assert.equal(hit.body.kind, "segment");
		assert.equal(hit.body.ref, `seg:front_left/${DAY}/14/103522`);
		const miss = await api("GET", `/api/segment?cameraId=front_left&at=${T(13, 0, 0)}`);
		assert.equal(miss.status, 200);
		assert.deepEqual(miss.body, { gap: "unavailable" });
		// Unknown camera rides the adapter's catch path: the gap, never a 404.
		const unknown = await api("GET", `/api/segment?cameraId=nope&at=${T(14, 36, 0)}`);
		assert.equal(unknown.status, 200);
		assert.deepEqual(unknown.body, { gap: "unavailable" });
	});

	test("at: exact hit and gap bodies over the span of record", async (t) => {
		const root = tmpRoot("porch-timeline-");
		t.after(() => fsDefault.rmSync(root, { recursive: true, force: true }));
		writeFixtureStore(root);
		const { service, api, handle } = await boot(root);
		t.after(() => handle.close());

		const hit = service.segments.at("front_left", T(14, 36, 0));
		assert.deepEqual(hit, {
			ref: `seg:front_left/${DAY}/14/103522`,
			path: `/api/media/front_left/${DAY}/14/103522`,
			start: T(14, 35, 22),
			end: T(14, 45, 22),
			kind: "segment",
		});
		// The gap body verbatim — 200 shape, mirrors the hub adapter's gap contract.
		assert.deepEqual(service.segments.at("front_left", T(13, 0, 0)), { gap: "unavailable" });
		assert.deepEqual(service.segments.at("front_left", T(16, 30, 0)), { gap: "unavailable" });
		assert.deepEqual(service.segments.at("nope", T(14, 36, 0)), { gap: "unavailable" });
		const rest = await api("GET", `/api/segment?cameraId=front_left&at=${T(14, 36, 0)}`);
		assert.equal(rest.status, 200);
		assert.equal(rest.body.kind, "segment");
	});
});

describe("engine seams (/segments /segment /evidence /media)", () => {
	let ctx;
	before(async () => {
		const root = tmpRoot("porch-timeline-seam-");
		writeFixtureStore(root);
		ctx = await boot(root);
		ctx.root = root;
	});
	after(async () => {
		await ctx.handle.close();
		fsDefault.rmSync(ctx.root, { recursive: true, force: true });
	});

	test("GET /segments filters the ordered listing to the window once", async () => {
		const wholeHour = await ctx.api("GET", `/segments?camera=front_left&from=${T(14, 0, 0)}&to=${T(15, 0, 0)}`);
		assert.equal(wholeHour.status, 200);
		assert.deepEqual(wholeHour.body.segments, [
			{ start: T(14, 30, 22), end: T(14, 35, 22), ref: `seg:front_left/${DAY}/14/103022`, path: `/media/front_left/${DAY}/14/103022` },
			{ start: T(14, 35, 22), end: T(14, 45, 22), ref: `seg:front_left/${DAY}/14/103522`, path: `/media/front_left/${DAY}/14/103522` },
		]);
		// The tail hour's open span counts by its start point within its
		// window — [16:00, 16:30] holds exactly the tail, while the bounded
		// segment ending exactly at `from` is adjacent, not overlapping.
		const tail = await ctx.api("GET", `/segments?camera=front_left&from=${T(16, 0, 0)}&to=${T(16, 30, 0)}`);
		assert.deepEqual(tail.body.segments.map((s) => s.ref), [`seg:front_left/${DAY}/16/160000`]);
		// A window inside one bounded segment returns exactly it.
		const slice = await ctx.api("GET", `/segments?camera=front_left&from=${T(14, 32, 0)}&to=${T(14, 34, 0)}`);
		assert.deepEqual(slice.body.segments.map((s) => s.ref), [`seg:front_left/${DAY}/14/103022`]);
		const nothing = await ctx.api("GET", `/segments?camera=front_left&from=${T(9, 0, 0)}&to=${T(10, 0, 0)}`);
		assert.deepEqual(nothing.body.segments, []);
	});

	test("GET /segment answers the exact seam shape; /evidence answers the clip", async () => {
		const segment = await ctx.api("GET", `/segment?camera=front_left&at=${T(14, 36, 0)}`);
		assert.equal(segment.status, 200);
		assert.deepEqual(segment.body, {
			ref: `seg:front_left/${DAY}/14/103522`,
			path: `/media/front_left/${DAY}/14/103522`,
			start: T(14, 35, 22),
			end: T(14, 45, 22),
			kind: "segment",
		});
		const evidence = await ctx.api("GET", `/evidence?camera=front_left&at=${T(14, 36, 0)}`);
		assert.equal(evidence.status, 200);
		assert.deepEqual(evidence.body, { kind: "clip", ref: `seg:front_left/${DAY}/14/103522`, path: `/media/front_left/${DAY}/14/103522` });
		const miss = await ctx.api("GET", `/segment?camera=front_left&at=${T(9, 0, 0)}`);
		assert.equal(miss.status, 200);
		assert.deepEqual(miss.body, { gap: "unavailable" });
		const unknown = await ctx.api("GET", `/segment?camera=who_dis&at=${T(14, 36, 0)}`);
		assert.equal(unknown.status, 200);
		assert.deepEqual(unknown.body, { gap: "unavailable" });
	});

	test("GET /media range serving: 200 full, 206 slice with Content-Range, 416 unsatisfiable", async () => {
		const mediaPath = `/media/front_left/${DAY}/14/103522`;
		const full = await fetch(`http://127.0.0.1:${ctx.handle.port}${mediaPath}`);
		const fullBody = await full.text();
		assert.equal(full.status, 200);
		assert.equal(full.headers.get("content-type"), "video/mp4");
		assert.equal(full.headers.get("accept-ranges"), "bytes");
		assert.equal(full.headers.get("content-length"), "96");
		assert.equal(fullBody, "B".repeat(96));

		const slice = await fetch(`http://127.0.0.1:${ctx.handle.port}${mediaPath}`, { headers: { range: "bytes=4-7" } });
		const sliceBody = await slice.text();
		assert.equal(slice.status, 206);
		assert.equal(slice.headers.get("content-range"), "bytes 4-7/96");
		assert.equal(slice.headers.get("content-length"), "4");
		assert.equal(slice.headers.get("content-type"), "video/mp4");
		assert.equal(sliceBody, "BBBB");

		const unsat = await fetch(`http://127.0.0.1:${ctx.handle.port}${mediaPath}`, { headers: { range: "bytes=96-99" } });
		assert.equal(unsat.status, 416);
		assert.equal(unsat.headers.get("content-range"), "bytes */96");

		const suffix = await fetch(`http://127.0.0.1:${ctx.handle.port}${mediaPath}`, { headers: { range: "bytes=-4" } });
		assert.equal(suffix.status, 206);
		assert.equal(suffix.headers.get("content-range"), "bytes 92-95/96");
		assert.equal(await suffix.text(), "BBBB");
	});

	test("no/whole/invalid ranges ride the full 200; traversal and .part refuse 404", async () => {
		const mediaPath = `/media/front_left/${DAY}/14/103522`;
		const whole = await fetch(`http://127.0.0.1:${ctx.handle.port}${mediaPath}`, { headers: { range: "bytes=0-" } });
		assert.equal(whole.status, 200);
		assert.equal(await whole.text(), "B".repeat(96));

		const bogus = await fetch(`http://127.0.0.1:${ctx.handle.port}${mediaPath}`, { headers: { range: "bytes=7-5" } });
		assert.equal(bogus.status, 200);

		const multi = await fetch(`http://127.0.0.1:${ctx.handle.port}${mediaPath}`, { headers: { range: "bytes=0-1,3-4" } });
		assert.equal(multi.status, 200);

		const head = await fetch(`http://127.0.0.1:${ctx.handle.port}${mediaPath}`, { method: "HEAD" });
		assert.equal(head.status, 200);
		assert.equal(head.headers.get("content-length"), "96");

		const traversal = await fetch(`http://127.0.0.1:${ctx.handle.port}/api/media/front_left/${DAY}/14/..%2F..%2F..%2Fetc%2Fpasswd`);
		assert.equal(traversal.status, 404);
		assert.deepEqual(await traversal.json(), { error: "segment file not found" });

		const part = await ctx.api("GET", `/api/media/front_left/${DAY}/14/104001`);
		assert.equal(part.status, 404);
		assert.deepEqual(part.body, { error: "segment file not found" });

		const missingFile = await ctx.api("GET", `/api/media/front_left/${DAY}/14/109999`);
		assert.equal(missingFile.status, 404);
	});
});

describe("storage root of record", () => {
	test("the store root rides the platform config of record, no override needed", async (t) => {
		const root = tmpRoot("porch-timeline-cfg-");
		t.after(() => fsDefault.rmSync(root, { recursive: true, force: true }));
		const storeRoot = pathDefault.join(root, "recordings");
		writeFixtureStore(storeRoot);
		fsDefault.mkdirSync(pathDefault.join(root, "config"), { recursive: true });
		fsDefault.writeFileSync(
			pathDefault.join(root, "config", "config.yaml"),
			JSON.stringify({ version: 1, storageRoot: storeRoot, cameras: [] }, null, "\t") + "\n",
			"utf8",
		);
		const { service, handle } = await boot(root);
		t.after(() => handle.close());
		assert.deepEqual(service.segments.days("front_left"), { days: [{ date: DAY, hours: ["14", "16"] }] });
	});
});
