// publisher.test.js — in-process live apply bus (PORCH-135).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Publisher } from "../src/publisher.js";
import { createConfigService } from "../src/index.js";

function makeService() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "porch-pub-"));
	const service = createConfigService({ root, consoleDist: null });
	service.base.setScope("_default", { recordingMode: "continuous", alertRouting: ["webhook"] });
	return { service, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("subscribers receive changed knobs on activate, synchronously and fully", () => {
	const { service, cleanup } = makeService();
	try {
		const seen = [];
		let calls = 0;
		service.publisher.subscribe((event) => {
			calls += 1;
			seen.push(event);
		});

		const profile = service.profiles.create({
			name: "night",
			knobs: { recordingMode: "event", alertRouting: ["bus", "webhook"] },
		});

		// The switch event must reach the subscriber before activate() returns
		// (synchronous live apply — no restart, no deferred queue).
		const result = service.profiles.activate(profile.id);
		assert.equal(calls, 1);
		assert.deepEqual(seen[0], result);
		assert.deepEqual(seen[0].changed, {
			_default: {
				recordingMode: { value: "event", source: "profile" },
				alertRouting: { value: ["bus", "webhook"], source: "profile" },
			},
		});
		assert.equal(seen[0].activeProfileId, profile.id);
	} finally {
		cleanup();
	}
});

test("deactivation events reach subscribers with base-source reverts", () => {
	const { service, cleanup } = makeService();
	try {
		const seen = [];
		service.publisher.subscribe((e) => seen.push(e));
		const profile = service.profiles.create({ name: "event_mode", knobs: { recordingMode: "event" } });
		service.profiles.activate(profile.id);
		service.profiles.deactivate();

		assert.equal(seen.length, 2);
		assert.deepEqual(seen[1], {
			activeProfileId: null,
			changed: { _default: { recordingMode: { value: "continuous", source: "base" } } },
		});
	} finally {
		cleanup();
	}
});

test("unsubscribed listeners stop receiving events; multiple listeners all fire", () => {
	const { service, cleanup } = makeService();
	try {
		const a = [];
		const b = [];
		const unsubA = service.publisher.subscribe((e) => a.push(e));
		service.publisher.subscribe((e) => b.push(e));
		unsubA();

		const profile = service.profiles.create({ name: "x", knobs: { detectionEnabled: false } });
		const result = service.profiles.activate(profile.id);
		assert.deepEqual(a, []);
		assert.deepEqual(b, [result]);
	} finally {
		cleanup();
	}
});

test("the standalone Publisher class behaves as documented", () => {
	const publisher = new Publisher();
	const events = [];
	const unsub = publisher.subscribe((e) => events.push(e));
	publisher.publish({ activeProfileId: "p1", changed: { _default: {} } });
	assert.deepEqual(events, [{ activeProfileId: "p1", changed: { _default: {} } }]);
	unsub();
	publisher.publish({ activeProfileId: "p2", changed: {} });
	assert.equal(events.length, 1); // no post-unsubscribe delivery
	assert.equal(typeof unsub, "function");
});
