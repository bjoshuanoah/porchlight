# @porchlight/agent-runtime

The Porchlight agent runtime library (PORCH-147): the agent loop, per-member memory streams, topics, SOUL injection, keysets, and the MCP client as one MIT-licensed open-source unit (Porchlight Agent PRD 3 / TS 3 — the future open-source module boundary, clean from day one). The library imports nothing hub-specific; hub-specific integrations (profile routing, the tool registry's home wiring, delegation enforcement) live in the consuming agent module, never here. No telemetry in this package.

## One agent entity per member

A runtime session instantiates exactly one agent entity per member (`runtime.agentFor(memberId)`, memoized). Each entity binds its own namespaced stores — memory stream, topics, keyset, SOUL — over the injected `KeyValueBackend`, so keysets, memory streams, topics, and logs carry the member identity and never mix. Entity resolution never leaks another member's identity: an entity carries only its own member.

## Isolation fails closed at the storage seam

Every member-scoped key is namespaced `member:<memberId>:<scope>:<key>` before it reaches the backend — one query touches one member's records. A key argument that tries to escape (a forged cross-member key, `..`, `/`, `member:`) refuses with `AgentIsolationError` and lands on the runtime's refusal trail (`runtime.refusals()`, `onRefusal` callback). The storage is cross-member fail closed by design.

## Composition seam 1 — the inference-call seam

The runtime's inference seam consumes the engine's `InferenceProvider` pattern with the engine's three provider classes (PORCH-I-009 TS 1): `native-mlx`, `openai-spec`, `local-server`. A profile-selected model rides an `InferenceProvider` implementation this seam consumes; the profiles machinery (PORCH-148) plugs profile resolution into exactly this seam. **No parallel inference path may appear.**

A provider is a plain object:

```js
{
  name: "ollama-glm",           // provider id
  providerClass: "local-server", // one of the three compute classes
  complete: async (request) => ({
    text: "…",                  // this turn's answer
    toolCalls: [],              // optional; loop executes via the registry
    modelId: "glm-5",           // recorded on the entity's provenance line
  }),
}
```

The seam receives `{ memberId, sessionId, messages, tools }` — the member identity rides every inference call; `messages` opens with the rendered SOUL injection followed by the member's own history; `tools` are descriptors only (authority flows through the registry at execution, never through the inference seam). Every inference records a member-tagged provenance line (`entity.lastProvenance`; runtime logs carry `which model answered, under which provider/class, at which time`).

## The agent loop

`entity.runTurn({ text, topic?, maxToolTurns? })`:

1. appends the member's input to their memory stream (topic ensured),
2. renders the SOUL injection fresh (a SOUL change applies next turn, no restart) and resolves the running history,
3. calls the injected inference provider with member identity, messages, and tool descriptors,
4. executes any returned `toolCalls` through the tool-execution seam under member-derived authority; outcomes append as `tool` turns and the seam is called again (bounded by `maxToolTurns`; exceeded → explicit thrown error, never silent),
5. settles the final `agent` turn into the member's stream and returns `{ text, provenance, toolsUsed }`.

## The tool-execution seam

A `ToolRegistry` holds registry-registered tools; `runtime.tools` receives it. `registry.execute(name, args, authority)` passes **exactly member-derived authority** — a frozen `{ memberId, scopes }` resolved per call by the runtime's injected `authority` resolver (the consuming module's delegation enforcement) — to the tool's `run(args, authority)`. The library never fabricates or widens authority: no resolver, a shape-invalid resolver answer, or an authority naming a different member than the acting entity refuses fail closed with the refusal logged. Unknown tools refuse. The hub's enforcement (PORCH-149) plugs in as this resolver.

## Storage seam

`createMemberStores({ memberId, backend, refuse })` opens the four member scopes (`memory`, `topics`, `keyset`, `soul`) over one injected `KeyValueBackend` `{ get, set, delete, list(prefix) }`. `MapBackend` is the standalone default; the hub module injects its own persistent backend. Keys are flat (`:`-separated); nothing crosses a member namespace.

## MCP client

`McpClient` speaks JSON-RPC 2.0 (initialize → `tools/list` → `tools/call`) over an injected transport; `StdioTransport` (newline-delimited JSON) is the default. Errors normalize to plain-language failures — never silent.

## Tests

```sh
node --test 'test/**/*.test.js'
```
