// public-surface.test.js — PORCH-147 ac-1: the package exposes the agent
// runtime (loop, memory, SOUL injection, topics, MCP client) and imports
// nothing hub-specific — the in-package boundary sweep.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
	AgentRuntime,
	AgentEntity,
	ToolRegistry,
	MemoryStream,
	TopicsStore,
	KeysetStore,
	MapBackend,
	MemberStore,
	createMemberStores,
	renderSoulInjection,
	normalizeSoul,
	DEFAULT_SOUL,
	McpClient,
	StdioTransport,
	MCP_PROTOCOL_VERSION,
	AgentIsolationError,
	PROVIDER_CLASSES,
} from "../src/index.js";

test("public surface exposes the runtime of record", () => {
	assert.equal(typeof AgentRuntime, "function");
	assert.equal(typeof AgentEntity, "function");
	// loop — runTurn is the loop's entry
	assert.equal(typeof AgentEntity.prototype.runTurn, "function");
	// memory / topics / SOUL injection / keysets
	assert.equal(typeof MemoryStream, "function");
	assert.equal(typeof TopicsStore, "function");
	assert.equal(typeof KeysetStore, "function");
	assert.equal(typeof renderSoulInjection, "function");
	assert.equal(typeof normalizeSoul, "function");
	assert.ok(DEFAULT_SOUL.identity);
	// MCP client
	assert.equal(typeof McpClient, "function");
	assert.equal(typeof StdioTransport, "function");
	assert.match(MCP_PROTOCOL_VERSION, /^\d{4}-\d{2}-\d{2}$/);
	// seam furniture
	assert.equal(typeof ToolRegistry, "function");
	assert.equal(typeof MapBackend, "function");
	assert.equal(typeof MemberStore, "function");
	assert.equal(typeof createMemberStores, "function");
	assert.equal(typeof AgentIsolationError, "function");
	assert.deepEqual(PROVIDER_CLASSES, ["native-mlx", "openai-spec", "local-server"]);
});

test("boundary sweep: the library imports nothing hub-specific", () => {
	const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
	const files = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith(".js")) files.push(path);
		}
	};
	walk(srcDir);
	const srcFiles = files.filter((f) => !f.endsWith("types.js")); // typedefs only
	assert.ok(srcFiles.length >= 10, `expected the full source tree, found ${srcFiles.length} files`);

	const violations = [];
	let totalImports = 0;
	for (const file of srcFiles) {
		const text = readFileSync(file, "utf8");
		// static imports (single- or multi-line) and dynamic imports
		const imports = [
			...[...text.matchAll(/^\s*import\s[^;]*?["']([^"']+)["']/gm)].map((m) => m[1]),
			...[...text.matchAll(/import\(\s*["']([^"']+)["']/g)].map((m) => m[1]),
		];
		totalImports += imports.length;
		for (const spec of imports) {
			const hubSpecific =
				spec.startsWith("@porchlight/") || // any named Porchlight workspace (hub packages)
				spec.includes("mongodb") || // hub storage — rides the injected backend
				spec.startsWith("/") || // absolute repo paths
				spec.startsWith("~/Dev"); // local hub checkout
			if (!hubSpecific) {
				const inSeam = spec.startsWith("node:") || spec.startsWith(".") || spec.startsWith("..");
				if (!inSeam) violations.push(`${spec}`);
			} else {
				violations.push(`${spec}`);
			}
		}
	}
	assert.ok(totalImports >= 12, `expected the full import surface, found ${totalImports}`);
	assert.deepEqual(violations, [], `hub-specific or non-seam imports found: ${violations.join(", ")}`);
});

test("runtime consumes exactly the injected seams — no parallel inference path", async () => {
	assert.throws(() => new AgentRuntime({}), /inference must be an InferenceProvider/);
	assert.throws(
		() => new AgentRuntime({ inference: { name: "x", providerClass: "secret-cloud", complete: async () => ({}) } }),
		/providerClass must be one of native-mlx, openai-spec, local-server/,
	);
	assert.throws(
		() => new AgentRuntime({ inference: { name: "x", providerClass: "openai-spec" } }),
		/complete\(request\)/,
	);
});
