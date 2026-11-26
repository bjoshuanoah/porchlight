// isolation.test.js — PORCH-147 ac-3: code running as member B's agent
// attempting to read or write member A's memory/topics/session state fails
// closed at the storage seam, and every refusal is logged.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AgentRuntime, MapBackend, AgentIsolationError, createMemberStores } from "../src/index.js";

/** forge the shape of member A's namespaced key from member B's store */
function forgedKey(member) {
	return `member:${member}:memory:entry:e000000001`;
}

test("forged cross-member namespaced keys refuse fail closed at the storage seam", async () => {
	const backend = new MapBackend();
	const refusals = [];
	const stores = createMemberStores({
		memberId: "bob",
		backend,
		refuse: (attempt) => refusals.push(attempt),
	});

	await assert.rejects(() => stores.memory.get(forgedKey("alice")), AgentIsolationError);
	await assert.rejects(() => stores.memory.set(forgedKey("alice"), "bob was here"), AgentIsolationError);
	await assert.rejects(() => stores.memory.delete(forgedKey("alice")), AgentIsolationError);
	await assert.rejects(() => stores.memory.list(forgedKey("alice").slice(0, "member:alice".length)), AgentIsolationError);
	await assert.rejects(() => stores.keyset.get(`member:alice:keyset:weather`), AgentIsolationError);
	await assert.rejects(() => stores.topics.get("../../member/alice/soul/doc".replace("topic:", "")), AgentIsolationError);

	assert.equal(refusals.length, 6, "every refused attempt lands on the refusal trail");
	for (const r of refusals) {
		assert.equal(r.memberId, "bob");
		assert.ok(r.scope, "refusal carries the scope");
		assert.ok(r.op, "refusal carries the operation");
	}
	// nothing landed outside bob's namespace
	assert.deepEqual(await backend.list("member:alice:"), [], "member A's namespace never saw a write from B");
});

test("path traversal and separator escapes refuse fail closed", async () => {
	const refusals = [];
	const stores = createMemberStores({ memberId: "bob", backend: new MapBackend(), refuse: (a) => refusals.push(a) });

	for (const bad of ["..", "a/../../member:alice/memory:x", "entry/../member/alice", "x/y", "entry:e1/../../../../member/alice"]) {
		await assert.rejects(() => stores.memory.get(bad), AgentIsolationError, `expected refusal for ${bad}`);
	}
	await assert.rejects(() => stores.memory.get(""), AgentIsolationError);
	await assert.rejects(() => stores.memory.get(42), AgentIsolationError);
	assert.equal(refusals.length, 7);
});

test("list cannot widen past the member namespace", async () => {
	const backend = new MapBackend();
	const refusalsA = [];
	const aliceStores = createMemberStores({
		memberId: "alice",
		backend,
		refuse: (a) => refusalsA.push(a),
	});
	await aliceStores.memory.set("entry:e1", { text: "alice private" });

	const bobStores = createMemberStores({ memberId: "bob", backend, refuse: () => {} });
	// even a "root" list inside bob's store stays inside bob's namespace
	assert.deepEqual(await bobStores.memory.list(), []);
	// alice's list sees only alice's entries
	// alice's list sees only alice's entries — scope-relative keys
	const rows = await aliceStores.memory.list();
	assert.equal(rows.length, 1);
	// the backing keys themselves stay namespaced (one query, one member)
	const raw = await backend.list("member:alice:memory:");
	assert.equal(raw.length, 1);
	assert.ok(raw[0].key.startsWith("member:alice:memory:"));
	assert.ok(!raw[0].key.includes("bob"));
});

test("the loop refuses tool calls with mismatched cross-member authority and logs it", async () => {
	const calls = [];
	let phase = 0;
	const runtime = new AgentRuntime({
		inference: {
			name: "test-glm",
			providerClass: "openai-spec",
			complete: async ({ tools }) => {
				calls.push(tools.length);
				phase++;
				return phase === 1
					? { text: "checking", toolCalls: [{ name: "dim_lights", args: {} }], modelId: "glm-test" }
					: { text: "checked", modelId: "glm-test" };
			},
		},
		tools: {
			list: () => [{ name: "dim_lights" }],
			execute: async (_name, _args, authority) => ({ dimmed: authority.memberId }),
		},
		authority: async () => ({ memberId: "alice", scopes: ["home:lights"] }),
	});
	const bob = runtime.agentFor("bob");
	const result = await bob.runTurn({ text: "dim the lights" });

	// the tool never ran as alice: the outcome is the logged refusal
	assert.deepEqual(result.toolsUsed, []);
	const refusal = runtime.refusals()[runtime.refusals().length - 1];
	assert.equal(refusal.kind, "tool");
	assert.equal(refusal.memberId, "bob");
	assert.equal(refusal.tool, "dim_lights");
	assert.match(refusal.reason, /does not match the acting member/);
	const toolEntry = (await bob.memory.all()).find((e) => e.role === "tool");
	assert.ok(JSON.parse(toolEntry.text).ok === false);
	assert.match(JSON.parse(toolEntry.text).error, /does not match the acting member/);
});
