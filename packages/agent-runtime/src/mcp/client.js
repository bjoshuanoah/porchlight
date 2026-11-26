// mcp/client.js — the MCP client of the runtime's public surface (PORCH-147).
//
// A Model Context Protocol client speaking JSON-RPC 2.0 over a message
// transport. The default transport is stdio (newline-delimited JSON — the
// MCP stdio transport); the transport is a seam, so the hub can re-point it
// (e.g. a stream transport) without the protocol core changing. The client
// is tool-consumer only: initialize → tools/list → tools/call. The agent
// module (PORCH-149) adapts homes' services onto the tool registry; the
// runtime library never hides an API the hub does not use.

import { spawn } from "node:child_process";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export class McpClient {
	#transport;
	#log;
	#pending = new Map();
	#nextId = 1;
	#serverInfo = null;
	#requestTimeoutMs;

	/**
	 * @param {{
	 *   transport: { start: (onMessage: (msg: object) => void) => Promise<void>,
	 *                send: (msg: object) => Promise<void>,
	 *                stop: () => Promise<void> },
	 *   log?: (line: string) => void,
	 *   requestTimeoutMs?: number,
	 * }} opts
	 */
	constructor({ transport, log, requestTimeoutMs = 30_000 }) {
		if (!transport || typeof transport.start !== "function" || typeof transport.send !== "function" || typeof transport.stop !== "function") {
			throw new TypeError("McpClient: transport must implement start(onMessage)/send(msg)/stop()");
		}
		this.#transport = transport;
		this.#log = log ?? (() => {});
		this.#requestTimeoutMs = requestTimeoutMs;
	}

	#onMessage(msg) {
		if (!msg || typeof msg !== "object") return;
		if (msg.id === undefined || msg.id === null) {
			this.#log(`server notification: ${JSON.stringify(msg)}`);
			return;
		}
		const pending = this.#pending.get(msg.id);
		if (!pending) return;
		this.#pending.delete(msg.id);
		pending(msg);
	}

	async #request(method, params) {
		const id = this.#nextId++;
		// The pending handler registers BEFORE the request is on the wire — a
		// transport that responds synchronously (or faster than a macrotask)
		// must not have its response dropped.
		const settled = new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`McpClient: ${method} timed out after ${this.#requestTimeoutMs}ms`));
			}, this.#requestTimeoutMs);
			this.#pending.set(id, (response) => {
				clearTimeout(timer);
				this.#pending.delete(id);
				if (response.error) {
					reject(new Error(`McpClient: ${method} failed: ${response.error.message ?? JSON.stringify(response.error)}`));
				} else {
					resolve(response.result ?? {});
				}
			});
		});
		await this.#transport.send({ jsonrpc: "2.0", id, method, params });
		return settled;
	}

	/**
	 * Connect + MCP initialize handshake.
	 * @returns {Promise<object|null>} the server's info
	 */
	async connect() {
		await this.#transport.start((msg) => this.#onMessage(msg));
		const init = await this.#request("initialize", {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "porchlight-agent-runtime", version: "0.5.3" },
		});
		this.#serverInfo = init.serverInfo ?? null;
		await this.#transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
		return this.#serverInfo;
	}

	/** @returns {Promise<{ name: string, description?: string }[]>} the server's tools */
	async listTools() {
		const result = await this.#request("tools/list", {});
		return Array.isArray(result.tools) ? result.tools : [];
	}

	/**
	 * Call one tool. MCP error shapes (isError/content) normalize to a
	 * thrown plain-language error — never a silent failure.
	 * @returns {Promise<object>} the tool's result envelope ({ content, ... })
	 */
	async callTool(name, args = {}) {
		const result = await this.#request("tools/call", { name, arguments: args });
		if (result.isError) {
			const text = Array.isArray(result.content)
				? result.content
					.filter((c) => c?.type === "text")
					.map((c) => c.text)
					.join("; ")
				: "unknown MCP error";
			throw new Error(`MCP tool ${name} failed: ${text}`);
		}
		return result;
	}

	/** @returns {Promise<void>} */
	async close() {
		await this.#transport.stop();
	}
}

/** The default transport: MCP stdio (newline-delimited JSON-RPC over child stdio). */
export class StdioTransport {
	#child = null;
	#lineBuf = "";
	#stderr = [];

	/**
	 * @param {{ command: string, args?: string[], env?: Record<string,string>, cwd?: string }} opts
	 */
	constructor({ command, args = [], env, cwd }) {
		this.command = command;
		this.args = args;
		this.env = env;
		this.cwd = cwd;
	}

	/**
	 * Spawn the MCP server process and begin parsing newline-delimited JSON.
	 * @returns {Promise<void>}
	 */
	async start(onMessage) {
		this.#child = spawn(this.command, this.args, {
			cwd: this.cwd,
			env: { ...process.env, ...this.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.#child.stdout.on("data", (chunk) => {
			this.#buffer(chunk, onMessage);
		});
		this.#child.stderr.on("data", (chunk) => {
			this.#stderr.push(String(chunk));
			if (this.#stderr.length > 200) this.#stderr.shift();
		});
	}

	#buffer(chunk, onMessage) {
		this.#lineBuf += String(chunk);
		let idx = this.#lineBuf.indexOf("\n");
		while (idx !== -1) {
			const line = this.#lineBuf.slice(0, idx).trim();
			this.#lineBuf = this.#lineBuf.slice(idx + 1);
			if (line) {
				try {
					onMessage(JSON.parse(line));
				} catch {
					// A malformed stdout line is server noise; MCP messages are
					// newline-delimited JSON — never parse-fail the transport.
				}
			}
			idx = this.#lineBuf.indexOf("\n");
		}
	}

	/** @returns {Promise<void>} */
	async send(msg) {
		if (!this.#child || !this.#child.stdin.writable) {
			throw new Error(`MCP stdio transport closed${this.#stderr.length ? ` — server stderr: ${this.#stderr.join("")}` : ""}`);
		}
		this.#child.stdin.write(JSON.stringify(msg) + "\n");
	}

	/** @returns {Promise<void>} */
	async stop() {
		if (this.#child) {
			this.#child.kill();
			this.#child = null;
		}
	}
}
