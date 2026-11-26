// loop.test.js — PORCH-147: the agent loop end-to-end over the public
// surface — SOUL injection rendered fresh, memory stream of record, topic
// bookkeeping, tool flow, maxToolTurns guard, and per-session entity
// separation.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AgentRuntime, ToolRegistry } from "../src/index.js";

test("runTurn: SOUL injection, provenance, memory, and topics of record", async () => {
	const runtime = new AgentRuntime({
		inference: {
			name: "ollama-glm",
			providerClass: "local-server",
			complete: async ({ messages }) => ({ text: `the ${messages[0].content.includes("Sunny") ? "sunny" : "plain"} answer`, modelId: "glm-5.3" }),
		},
	});
	const entity = runtime.agentFor("alice");
	await entity.setSoul({
		identity: "Sunny, Alice's porch agent",
		voice: "Plainspoken, never fussy.",
		law: ["Never share one member's things with another.", "Plain language over jargon."],
	});

	const result = await entity.runTurn({ text: "what should I know?", topic: "evening" });
	assert.equal(result.text, "the sunny answer");
	assert.match(result.provenance.at, /^\d{4}-\d{2}-\d{2}T/);

	const entries = await entity.memory.all();
	assert.deepEqual(
		entries.map((e) => e.role),
		["user", "agent"],
	);
	assert.equal(entries[0].topic, "evening");
	const topics = await entity.topics.list();
	assert.deepEqual(topics.map((t) => t.name), ["evening"]);
	assert.equal(topics[0].entryCount, 2);
});

test("a SOUL change applies on the next turn with no restart", async () => {
	const runtime = new AgentRuntime({
		inference: {
			name: "ollama-glm",
			providerClass: "local-server",
			complete: async ({ messages }) => ({ text: messages[0].content, modelId: "glm-5.3" }),
		},
	});
	const entity = runtime.agentFor("alice");
	const first = await entity.runTurn({ text: "who are you?" });
	assert.match(first.text, /the member's personal agent/);

	await entity.setSoul({ identity: "Sunny, Alice's porch agent" });
	const second = await entity.runTurn({ text: "who are you now?" });
	assert.match(second.text, /Sunny, Alice's porch agent/);
});

test("runTurn guards an un-setting tool loop with an explicit error", async () => {
	let calls = 0;
	const runtime = new AgentRuntime({
		inference: {
			name: "test",
			providerClass: "openai-spec",
			complete: async () => {
				calls++;
				return { text: `call ${calls}`, toolCalls: [{ name: "always" }] };
			},
		},
		tools: new ToolRegistry().register({ name: "always", run: async () => ({ ok: true }) }),
		authority: async (memberId) => ({ memberId, scopes: [] }),
	});
	await assert.rejects(() => runtime.agentFor("alice").runTurn({ text: "go", maxToolTurns: 2 }), /maxToolTurns \(2\)/);
	assert.ok(calls > 0);
});

test("a tool error lands as the refused tool outcome, and the loop settles", async () => {
	const registry = new ToolRegistry();
	registry.register({
		name: "boom",
		run: async () => {
			throw new Error("device unreachable");
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
					? { text: "let me check", toolCalls: [{ name: "boom" }] }
					: { text: "it failed and I will not hide it" };
			},
		},
		tools: registry,
		authority: async (memberId) => ({ memberId, scopes: [] }),
	});
	const result = await runtime.agentFor("alice").runTurn({ text: "check it" });
	assert.deepEqual(result.toolsUsed, []);
	const refusal = runtime.refusals().at(-1);
	assert.match(refusal.reason, /device unreachable/);
	const entries = await runtime.agentFor("alice").memory.all();
	const toolEntry = entries.find((e) => e.role === "tool");
	assert.deepEqual(JSON.parse(toolEntry.text), { ok: false, error: "device unreachable" });
	assert.ok(entries.at(-1).role === "agent");
});

test("two members keep wholly separate turns over one runtime", async () => {
	const runtime = new AgentRuntime({
		inference: {
			name: "test",
			providerClass: "local-server",
			complete: async ({ memberId, messages }) => ({
				text: `for ${memberId}: ${messages.at(-1).content}`,
				modelId: "x",
			}),
		},
	});
	const a = runtime.agentFor("alice");
	const b = runtime.agentFor("bob");
	await a.runTurn({ text: "my question", topic: "shared-name" });
	await b.runTurn({ text: "bob's question", topic: "shared-name" });

	// same topic name, two members: nothing mixes
	const aTopic = await a.topics.list();
	const bTopic = await b.topics.list();
	assert.equal(aTopic[0].entryCount, 2);
	assert.equal(bTopic[0].entryCount, 2);
	for (const e of await a.memory.all()) {
		assert.ok(!e.text.includes("bob"), "alice's stream is clean of bob");
	}
});

test("runTurn input validation refuses before any inference", async () => {
	const runtime = new AgentRuntime({
		inference: { name: "t", providerClass: "openai-spec", complete: async () => ({ text: "x" }) },
	});
	const entity = runtime.agentFor("alice");
	await assert.rejects(() => entity.runTurn({ text: "" }), TypeError);
	await assert.rejects(() => entity.runTurn({ text: 7 }), TypeError);
	await assert.rejects(() => entity.runTurn({}), TypeError);
	assert.deepEqual(runtime.logsForMember("alice").filter((l) => l.line.startsWith("inference:")), []);
});
