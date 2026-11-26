// mcp-client.test.js — PORCH-147: the MCP client of the public surface —
// JSON-RPC 2.0 handshake, tools/list, tools/call, error normalization —
// over a scripted in-memory transport and over real stdio.

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpClient, StdioTransport, MCP_PROTOCOL_VERSION } from "../src/index.js";

/**
 * A deterministic in-memory transport backed by a scripted MCP server.
 * `options.toolsCallError` makes the tools/call answer an MCP error result;
 * `options.toolsListError` makes tools/list answer a protocol error.
 */
function scriptedTransport({ toolsCallError = false, toolsListError = false } = {}) {
	const sent = [];
	const respond = (method, params, id) => {
		if (method === "initialize") {
			return { jsonrpc: "2.0", id, result: { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: "scripted", version: "1.0.0" } } };
		}
		if (method === "tools/list") {
			return toolsListError
				? { jsonrpc: "2.0", id, error: { code: -32601, message: "no such method" } }
				: { jsonrpc: "2.0", id, result: { tools: [{ name: "echo", description: "echoes text" }] } };
		}
		if (method === "tools/call") {
			if (toolsCallError) {
				return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "tool blew up" }] } };
			}
			return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `echo:${params.arguments?.text ?? ""}` }] } };
		}
		return { jsonrpc: "2.0", id, error: { code: -32601, message: `unhandled method ${method}` } };
	};
	return {
		sent,
		async start(onMessage) {
			this.onMessage = onMessage;
		},
		async send(msg) {
			sent.push(msg);
			if (msg.method === undefined) return; // notifications
			this.onMessage?.(respond(msg.method, msg.params, msg.id));
		},
		async stop() {},
	};
}

test("handshake: initialize + then initialized notification rides the transport", async () => {
	const transport = scriptedTransport();
	const client = new McpClient({ transport });
	const serverInfo = await client.connect();

	assert.deepEqual(serverInfo, { name: "scripted", version: "1.0.0" });
	assert.deepEqual(transport.sent.map((m) => m.method), ["initialize", "notifications/initialized"]);
	assert.equal(transport.sent[0].params.protocolVersion, MCP_PROTOCOL_VERSION);
	assert.match(MCP_PROTOCOL_VERSION, /^20\d{2}-\d{2}-\d{2}$/);
});

test("tools/list and tools/call round-trip over the transport", async () => {
	const transport = scriptedTransport();
	const client = new McpClient({ transport });
	await client.connect();

	const tools = await client.listTools();
	assert.deepEqual(tools, [{ name: "echo", description: "echoes text" }]);

	const result = await client.callTool("echo", { text: "hello" });
	assert.deepEqual(result.content, [{ type: "text", text: "echo:hello" }]);
	const call = transport.sent.find((m) => m.method === "tools/call");
	assert.deepEqual(call.params, { name: "echo", arguments: { text: "hello" } });
});

test("MCP errors and protocol errors normalize to plain-language failures", async () => {
	const toolErrorClient = new McpClient({ transport: scriptedTransport({ toolsCallError: true }) });
	await toolErrorClient.connect();
	await assert.rejects(() => toolErrorClient.callTool("echo", { text: "hi" }), /MCP tool echo failed: tool blew up/);

	const protocolErrorClient = new McpClient({ transport: scriptedTransport({ toolsListError: true }) });
	await protocolErrorClient.connect();
	await assert.rejects(() => protocolErrorClient.listTools(), /tools\/list failed: no such method/);
});

test("request timeout refuses silently-waiting transports", async () => {
	const client = new McpClient({
		transport: { async start() {}, async send() {}, async stop() {} },
		requestTimeoutMs: 25,
	});
	await assert.rejects(() => client.connect(), /initialize timed out after 25ms/);
});

test("stdio transport: full handshake against the real fixture process", async () => {
	const transport = new StdioTransport({
		command: process.execPath,
		args: [new URL("./fixtures/stdio-server.mjs", import.meta.url).pathname],
	});
	const client = new McpClient({ transport, requestTimeoutMs: 15_000 });
	try {
		const serverInfo = await client.connect();
		assert.deepEqual(serverInfo, { name: "stdio-fixture", version: "1.0.0" });
		const tools = await client.listTools();
		assert.deepEqual(tools.map((t) => t.name), ["ping"]);
		const result = await client.callTool("ping", { echo: "hello hub" });
		assert.deepEqual(result.content, [{ type: "text", text: "hello hub" }]);
		await assert.rejects(() => client.callTool("ping", { echo: "fail" }), /MCP tool ping failed: fixture asked to fail/);
	} finally {
		await client.close();
	}
});
