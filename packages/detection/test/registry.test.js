// registry.test.js — provider pluggability seam (PORCH-128 ac-3).

import { test } from "node:test";
import assert from "node:assert/strict";

import { ProviderRegistry } from "../src/registry.js";

/** @param {string} name @returns {import("../src/types.js").InferenceProvider} */
function doublingProvider(name) {
	return { name, detect: async () => [] };
}

test("register/create roundtrip and duplicate naming", () => {
	const registry = new ProviderRegistry();
	assert.deepEqual(registry.names(), []);
	const swap = registry.register("coreml", () => doublingProvider("coreml"));
	assert.equal(swap.replaced, false);
	assert.equal(registry.has("coreml"), true);
	const again = registry.register("coreml", () => doublingProvider("coreml"));
	assert.equal(again.replaced, true);
	assert.deepEqual(registry.names(), ["coreml"]);
	const provider = registry.create("coreml", {});
	assert.equal(provider.name, "coreml");
});

test("create with an unregistered name throws with the registered set", () => {
	const registry = new ProviderRegistry();
	registry.register("vision", () => doublingProvider("vision"));
	assert.throws(() => registry.create("ollama"), /ollama.*vision/);
});

test("register invalid entries throws", () => {
	const registry = new ProviderRegistry();
	assert.throws(() => registry.register("", () => doublingProvider("x")), /name/);
	assert.throws(() => registry.register("bad", /** @type {any} */ (null)), /function/);
	assert.throws(() => registry.create("x", {}), /not registered/);
});

test("ac-3: a third-party provider registers and instantiates with zero core changes", () => {
	// A future Linux CUDA provider is exactly this shape — a factory closure,
	// registered under its own name. Nothing else in the package changes.
	const registry = new ProviderRegistry();
	/** @returns {import("../src/types.js").InferenceProvider} */
	const cudaTestDouble = () => ({
		name: "cuda-test-double",
		detect: async (frame) => [{ cls: "person", conf: 0.9, bbox: [0.1, 0.1, 0.2, 0.2], t: frame.t }],
		status: () => ({ engine: "cuda" }),
	});
	registry.register("cuda-test-double", cudaTestDouble);
	const provider = registry.create("cuda-test-double");
	assert.equal(provider.name, "cuda-test-double");
	assert.equal(registry.names().includes("cuda-test-double"), true);
});
