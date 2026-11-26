// index.js — the public surface of the agent runtime library (PORCH-147).
//
// The library's exported contract: the agent loop, the per-member memory
// stream, SOUL injection, topics, keysets, and the MCP client. Hub-specific
// integrations (profile routing, tool registry wiring, delegation
// enforcement) stay OUT of the library — this package imports nothing
// hub-specific, keeping the open-source boundary clean from day one.

export { AgentRuntime } from "./runtime.js";
export { AgentEntity } from "./agent.js";
export { PROVIDER_CLASSES } from "./constants.js";
export { ToolRegistry, assertMemberAuthority } from "./tools.js";
export { MemoryStream } from "./memory.js";
export { TopicsStore } from "./topics.js";
export { KeysetStore } from "./keyset.js";
export { MemberStore, MapBackend, createMemberStores, STORE_SCOPES } from "./store.js";
export { renderSoulInjection, normalizeSoul, DEFAULT_SOUL } from "./soul.js";
export { McpClient, StdioTransport, MCP_PROTOCOL_VERSION } from "./mcp/client.js";
export { AgentIsolationError } from "./errors.js";
