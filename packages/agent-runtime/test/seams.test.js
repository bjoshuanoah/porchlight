// seams.test.js — PORCH-147 ac-4: the runtime's inference-call seam accepts
// an injected inference implementation, and the tool-execution seam accepts
// registry-registered tools with member-derived authority — the consumption
// points the profiles machinery (PORCH-148) and tool registry (PORCH-149)
// start against.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AgentRuntime, ToolRegistry, MemoryStream, TopicsStore, KeysetStore, MemberStore, MapBackend } from "../src/index.js";

test("the inference seam consumes the injected InferenceProvider implementation", async () => {
	const seen = [];
	const runtime = new AgentRuntime({
		inference: {
			name: "ollama-glm",
			providerClass: "local-server",
			complete: async (request) => {
				seen.push(request);
				return { text: `hi ${request.memberId}`, modelId: "glm-5.3" };
			},
		},
	});
	const entity = runtime.agentFor("alice");
	const result = await entity.runTurn({ text: "hello" });

	assert.equal(result.text, "hi alice");
	assert.equal(seen.length, 1);
	assert.equal(seen[0].memberId, "alice");
	assert.equal(seen[0].sessionId, runtime.sessionId);
	assert.equal(seen[0].messages[0].role, "system", "SOUL injection rides first");
	assert.match(seen[0].messages[0].content, /the member's personal agent/);
	assert.deepEqual(seen[0].messages[seen[0].messages.length - 1], { role: "user", content: "hello" });

	// provenance line of record: which model answered, under which provider/class, when
	assert.deepEqual(result.provenance, {
		provider: "ollama-glm",
		providerClass: "local-server",
		modelId: "glm-5.3",
		at: result.provenance.at,
	});
	assert.match(result.provenance.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	assert.deepEqual(entity.lastProvenance, result.provenance);
	assert.ok(runtime.logsForMember("alice").some((l) => /inference: ollama-glm \(local-server\) model glm-5.3 answered/.test(l.line)));
});

test("native-mlx class rides the same inference seam", async () => {
	const runtime = new AgentRuntime({
		inference: { name: "mlx-native", providerClass: "native-mlx", complete: async () => ({ text: "on-device" }) },
	});
	const result = await runtime.agentFor("alice").runTurn({ text: "q" });
	assert.equal(result.provenance.providerClass, "native-mlx");
});

test("the tool-execution seam hands tools exactly member-derived authority", async () => {
	const seen = [];
	const registry = new ToolRegistry();
	registry.register({
		name: "dim_lights",
		description: "dim the porch lights",
		run: async (args, authority) => {
			seen.push({ args, authority });
			return { dimmed: true };
		},
	});

	const runtime = new AgentRuntime({
		inference: {
			name: "test",
			providerClass: "openai-spec",
			complete: async () => ({ text: "done", modelId: "x" }),
		},
		tools: registry,
		authority: async (memberId) => ({ memberId, scopes: memberId === "alice" ? ["home:lights:write"] : [] }),
	});
	runtime.agentFor("alice"); // entity exists; the tool seam is exercised through the registry

	await assert.rejects(
		() => registry.execute("dim_lights", {}, { memberId: "alice" }),
		/member-derived authority required/,
		"authority without scopes refuses before the tool runs",
	);
	await assert.rejects(
		() => registry.execute("dim_lights", {}, { memberId: "alice", scopes: "all" }),
		/member-derived authority required/,
	);
	await assert.rejects(() => registry.execute("dim_lights", {}, null), /member-derived authority required/);
	await assert.rejects(() => registry.execute("nope", {}, { memberId: "alice", scopes: [] }), /no tool registered/);
	assert.deepEqual(seen, [], "no authority-less or invalid call ever reached a tool");

	await registry.execute("dim_lights", { level: 30 }, { memberId: "alice", scopes: ["home:lights:write"] });
	assert.deepEqual(seen, [{ args: { level: 30 }, authority: { memberId: "alice", scopes: ["home:lights:write"] } }]);
	assert.ok(Object.isFrozen(seen[0].authority), "authority arrives sealed");
	assert.ok(Object.isFrozen(seen[0].authority.scopes));
});

test("duplicate tool registration refuses", () => {
	const registry = new ToolRegistry();
	registry.register({ name: "a", run: async () => ({}) });
	assert.throws(() => registry.register({ name: "a", run: async () => ({}) }), /already registered/);
	assert.ok(registry.has("a"));
	assert.deepEqual(registry.list(), [{ name: "a" }]);
});

test("the loop executes registry tools under the resolved member authority", async () => {
	const seen = [];
	const registry = new ToolRegistry();
	registry.register({
		name: "home_status",
		run: async (args, authority) => {
			seen.push({ args, authority });
			return { ok: true };
		},
	});
	let phase = 0;
	const runtime = new AgentRuntime({
		inference: {
			name: "test",
			providerClass: "openai-spec",
			complete: async () => {
				phase++;
				return phase === 1
					? { text: "checking", toolCalls: [{ name: "home_status", args: { area: "porch" } }], modelId: "x" }
					: { text: "porch is clear", modelId: "x" };
			},
		},
		tools: registry,
		authority: async (memberId) => ({ memberId, scopes: ["home:read"] }),
	});
	const result = await runtime.agentFor("alice").runTurn({ text: "anything on the porch?" });

	assert.deepEqual(seen, [{ args: { area: "porch" }, authority: { memberId: "alice", scopes: ["home:read"] } }]);
	assert.deepEqual(result.toolsUsed, ["home_status"]);
	assert.equal(result.text, "porch is clear");
	const entries = await runtime.agentFor("alice").memory.all();
	assert.deepEqual(
		entries.map((e) => e.role),
		["user", "agent", "tool", "agent"],
	);
	assert.equal(entries.filter((e) => e.role === "tool").length, 1);
	assert.deepEqual(JSON.parse(entries[2].text), { ok: true, result: { ok: true } });
});

test("no authority resolver: tools refuse fail closed and the refusal is logged", async () => {
	const registry = new ToolRegistry();
	registry.register({ name: "tool_a", run: async () => ({ ran: true }) });
	let phase = 0;
	const runtime = new AgentRuntime({
		inference: {
			name: "test",
			providerClass: "openai-spec",
			complete: async () => {
				phase++;
				return phase === 1
					? { text: "trying", toolCalls: [{ name: "tool_a" }], modelId: "x" }
					: { text: "couldn't run it", modelId: "x" };
			},
		},
		tools: registry,
	});
	const result = await runtime.agentFor("bob").runTurn({ text: "go" });
	assert.deepEqual(result.toolsUsed, []);
	const refusal = runtime.refusals().at(-1);
	assert.equal(refusal.kind, "tool");
	assert.match(refusal.reason, /no authority resolver configured/);
});

test("the library's member-scoped stores stand alone for consumers", async () => {
	const memory = new MemoryStream({ store: scopeStore("m1"), topics: new TopicsStore({ store: scopeStore("t1") }) });
	await memory.append({ role: "user", text: "note" });
	assert.equal((await memory.all())[0].text, "note");

	const keyset = new KeysetStore({ store: scopeStore("k1") });
	await keyset.set("hue-bridge", "token");
	assert.deepEqual(await keyset.names(), ["hue-bridge"]);

	const topics = new TopicsStore({ store: scopeStore("t2") });
	const topic = await topics.ensure("trips");
	assert.deepEqual((await topics.list()).map((t) => t.name), ["trips"]);
	await topics.touch(topic.id);
	assert.equal((await topics.get(topic.id)).entryCount, 1);
});

/** @returns {MemberStore} an independent scope store over its own backend */
function scopeStore(tag) {
	return new MemberStore({ memberId: `standalone-${tag}`, scope: "soul", backend: new MapBackend(), refuse: () => {} });
}

// PORCH-148: the profiles machinery presents itself as THE InferenceProvider
// the seam consumes — a multi-class profile router declares the compute
// classes it routes across, and every response carries the class that
// actually answered (the provenance line of record).
test("the inference seam consumes a multi-class profile router", async () => {
	const router = {
		name: "porchlight-profile-router",
		providerClasses: ["native-mlx", "openai-spec", "local-server"],
		complete: async (request) => {
			const providerClass = request.memberId === "kids" ? "native-mlx" : "local-server";
			return { text: `hi ${request.memberId}`, providerClass, modelId: providerClass === "native-mlx" ? "gemma4:e2b" : "glm-5.3" };
		},
	};
	const runtime = new AgentRuntime({ inference: router });
	const big = await runtime.agentFor("alice").runTurn({ text: "hello" });
	assert.equal(big.provenance.providerClass, "local-server", "the class that answered rides the provenance line");
	const kid = await runtime.agentFor("kids").runTurn({ text: "hi" });
	assert.equal(kid.provenance.providerClass, "native-mlx");
	assert.equal(kid.provenance.modelId, "gemma4:e2b");

	// An empty class declaration is not a router — refuse.
	assert.throws(() => new AgentRuntime({ inference: { ...router, providerClasses: [] } }), /declare the compute classes/);
	assert.throws(
		() => new AgentRuntime({ inference: { name: "x", providerClasses: ["bogus-class"], complete: async () => ({}) } }),
		/must be one of/,
	);
});
