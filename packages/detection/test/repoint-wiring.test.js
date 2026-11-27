// repoint-wiring.test.js — the ac-2 live-apply chain, end to end (PORCH-152).
//
// The engine composition law in one test: the Models/Compute surface
// re-points a stage (the config plane's PUT → admin layer → compute-repoint
// publisher event), the composition-root wiring hands the resolved value to
// the stage's applier, and the running DetectionService swaps providers
// without a restart — the pipeline keeps publishing its normal contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import osDefault from "node:os";
import pathDefault from "node:path";

import { createConfigService, wireComputeRepoints } from "@porchlight/config";
import { DetectionService } from "../src/service.js";
import { DetectionTracker } from "../src/tracker.js";
import { NullDetectionSink } from "../src/sink.mqtt.js";

/** Immediate-confirm tracker: every detection publishes on its first frame. */
function makeIds() {
	let n = 0;
	return () => `t-${++n}`;
}

function frame(camera, t) {
	return { camera, w: 8, h: 8, t, format: "rgb", data: new Uint8Array(8 * 8 * 3).fill(200) };
}

/** A provider double whose name carries its provider class for assertions. */
function providerFor(value) {
	return {
		name: `${value.providerClass}-backed`,
		detect: async () => [
			{ cls: "person", conf: 0.9, bbox: [0.1, 0.1, 0.4, 0.4], t: frame("cam", 1).t },
		],
		status: () => ({ engine: "test", providerClass: value.providerClass, model: value.model ?? null, executionTarget: value.providerClass === "native-mlx" ? "gpu/ane" : "remote", state: "native", reason: null }),
		close: async () => {},
	};
}

test("Models/Compute re-point applies live through the wiring — no restart, contract continues", async () => {
	const root = fsDefault.mkdtempSync(pathDefault.join(osDefault.tmpdir(), "porch-wire-"));
	try {
		// The real console service of record: compute plane + publisher on one
		// freshly bootstrapped root (the setup wizard's first run).
		const configService = createConfigService({ root, consoleDist: null });
		const { compute, publisher } = configService;

		const service = new DetectionService({
			provider: providerFor(compute.resolve("detection").effective),
			sink: new NullDetectionSink(),
			trackerFactory: () => new DetectionTracker({ minHits: 1, nextId: makeIds() }),
		});

		// The composition root's one-line seam: re-point events drive appliers.
		const unsubscribe = wireComputeRepoints({
			publisher,
			appliers: { detection: (value) => void service.repoint(providerFor(value)) },
		});

		// Stage A: the built-in native plan backs the running stage.
		const before = await service.submit(frame("cam-front", 1));
		assert.equal(before.objects[0].provider, "native-mlx-backed");

		// Re-point: OpenAI-spec class, endpoint as a secret reference — applies
		// live on the next frame, base plan preserved beneath.
		compute.repoint("detection", { providerClass: "openai-spec", endpointRef: "secrets/engine-vision", model: "gpt-6-vision" });

		const after = await service.submit(frame("cam-front", 2));
		assert.equal(after.objects[0].provider, "openai-spec-backed", "the re-point applied without a restart");
		assert.equal(service.generation, 1);

		// The inspector still shows which layer wins and what sits beneath
		// (base preserved: built-in plan untouched).
		const detail = compute.detail("detection");
		assert.equal(detail.source, "admin");
		assert.equal(detail.layers.builtIn.providerClass, "native-mlx");

		// Revert (DELETE equivalent) restores the native default with the same
		// live mechanism.
		compute.reset("detection");
		const reverted = await service.submit(frame("cam-front", 3));
		assert.equal(reverted.objects[0].provider, "native-mlx-backed");
		assert.equal(service.generation, 2);

		unsubscribe();
	} finally {
		fsDefault.rmSync(root, { recursive: true, force: true });
	}
});
