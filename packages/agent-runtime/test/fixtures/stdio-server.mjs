// stdio-server.mjs — a minimal MCP stdio server fixture (PORCH-147):
// newline-delimited JSON-RPC; answers initialize, tools/list, tools/call.
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, terminal: false });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

rl.on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.method === "initialize") {
		send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, serverInfo: { name: "stdio-fixture", version: "1.0.0" } } });
	} else if (msg.method === "tools/list") {
		send({
			jsonrpc: "2.0",
			id: msg.id,
			result: { tools: [{ name: "ping", description: "answers pong", inputSchema: { type: "object" } }] },
		});
	} else if (msg.method === "tools/call") {
		const echo = msg.params.arguments?.echo ?? "pong";
		if (echo === "fail") {
			send({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "fixture asked to fail" }] } });
		} else {
			send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: echo }] } });
		}
	} else if (msg.method === "tools/unknown") {
		send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
	} else if (msg.id !== undefined && msg.id !== null) {
		send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unhandled method ${msg.method}` } });
	}
});
