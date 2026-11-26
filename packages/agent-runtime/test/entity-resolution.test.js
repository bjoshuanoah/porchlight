// entity-resolution.test.js — PORCH-147 ac-2: two members on one hub; a
// member's session runs exactly one agent entity with its own keyset,
// memory stream, and topics; entity resolution never leaks another member's
// identity.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AgentRuntime, MapBackend } from "../src/index.js";

const provider = {
	name: "test-glm",
	providerClass: "openai-spec",
	complete: async ({ memberId, messages }) => ({
		text: `answered for ${memberId} (${messages.length} messages)`,
		modelId: "glm-test",
	}),
};

test("exactly one agent entity per member per runtime session", () => {
	const runtime = new AgentRuntime({ inference: provider });
	const alice = runtime.agentFor("alice");
	assert.equal(runtime.agentFor("alice"), alice, "re-resolution returns the same entity");
	const bob = runtime.agentFor("bob");
	assert.notEqual(alice, bob);
	assert.deepEqual(runtime.members(), ["alice", "bob"]);
});

test("each member's entity carries its own memory stream and topics", async () => {
	const runtime = new AgentRuntime({ inference: provider });
	const alice = runtime.agentFor("alice");
	const bob = runtime.agentFor("bob");

	await alice.runTurn({ text: "hello from alice", topic: "garden" });
	await bob.runTurn({ text: "hello from bob", topic: "fishing" });

	const aliceEntries = await alice.memory.all();
	const bobEntries = await bob.memory.all();
	assert.equal(aliceEntries.length, 2);
	assert.ok(aliceEntries.every((e) => e.text.includes("alice") || e.text.includes("glm")), JSON.stringify(aliceEntries));
	assert.ok(!aliceEntries.some((e) => e.text.includes("bob")), "alice's stream never shows bob's turns");
	assert.equal(bobEntries.length, 2);
	assert.ok(!bobEntries.some((e) => e.text.includes("alice")), "bob's stream never shows alice's turns");

	const aliceTopics = await alice.topics.list();
	assert.deepEqual(aliceTopics.map((t) => t.name), ["garden"]);
	assert.equal(aliceTopics[0].entryCount, 2);
	const bobTopics = await bob.topics.list();
	assert.deepEqual(bobTopics.map((t) => t.name), ["fishing"]);
});

test("each member's entity carries its own keyset", async () => {
	const runtime = new AgentRuntime({ inference: provider });
	const alice = runtime.agentFor("alice");
	const bob = runtime.agentFor("bob");

	await alice.keyset.set("weather-station", "s3cr3t-alice");
	const bobNames = await bob.keyset.names();
	assert.deepEqual(bobNames, [], "bob's keyset never shows alice's keys");
	assert.equal(await bob.keyset.get("weather-station"), null);

	// a key name re-used across members stays separated (per-member keyset)
	await bob.keyset.set("weather-station", "s3cr3t-bob");
	assert.equal(await alice.keyset.get("weather-station"), "s3cr3t-alice");
	assert.equal(await bob.keyset.get("weather-station"), "s3cr3t-bob");
});

test("entity resolution never leaks another member's identity", async () => {
	const runtime = new AgentRuntime({ inference: provider });
	const alice = runtime.agentFor("alice");
	runtime.agentFor("bob");

	assert.deepEqual(Object.keys(alice.member), ["id"], "the entity carries only its own member");
	assert.equal(alice.member.id, "alice");
	assert.equal(alice.memberId, "alice");

	await alice.runTurn({ text: "hi" });

	// log lines carry member identity — bob's log holds only bob's lines,
	// none of alice's activity
	const bobLogs = runtime.logsForMember("bob");
	assert.ok(bobLogs.every((l) => l.memberId === "bob"));
	assert.ok(!bobLogs.some((l) => l.line.includes("alice")), JSON.stringify(bobLogs));
	const bobRefusal = runtime.refusalsForMember("bob");
	assert.deepEqual(bobRefusal, []);
	assert.ok(runtime.logsForMember("alice").length >= 2, "alice's own lines carry her identity");
	assert.ok(runtime.logsForMember("alice").every((l) => l.memberId === "alice"));
});

test("entity uniqueness holds over one shared backend", () => {
	const backend = new MapBackend();
	const runtime = new AgentRuntime({ inference: provider, backend });
	const a1 = runtime.agentFor("alice");
	const a2 = runtime.agentFor("alice");
	assert.equal(a1, a2);
});
