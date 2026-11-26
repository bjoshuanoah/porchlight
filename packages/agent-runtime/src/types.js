// types.js — contract types for the agent runtime library (PORCH-147).
//
// JSDoc typedefs of record. This file carries no executable code; the
// runtime's seams are documented here and mirrored in README.md.

/**
 * The engine's three compute classes (PORCH-I-009 TS 1): the same family the
 * engine's InferenceProvider pattern rides. A profile-selected model rides
 * an InferenceProvider implementation the runtime's inference seam consumes
 * (PORCH-147 composition seam 1 — profiles machinery, PORCH-148, plugs
 * profile resolution into exactly this seam; no parallel inference path).
 *
 * @typedef {"native-mlx" | "openai-spec" | "local-server"} ProviderClass
 */

/**
 * The inference seam of record (PORCH-147 composition seam 1).
 *
 * A provider is a plain object — the detection package's InferenceProvider
 * pattern (PORCH-I-009 TS 5) carried into the chat domain:
 *   - `name: string` — provider id (e.g. "ollama-glm", "mlx-native")
 *   - `providerClass: ProviderClass` — one of the engine's three compute
 *     classes
 *   - `complete(request): Promise<InferenceResponse>` — one inference call
 *
 * The request the seam receives:
 *   - `memberId: string` — the acting member (identity rides every call)
 *   - `sessionId: string` — the runtime session the entity belongs to
 *   - `messages: {role, content}[]` — SOUL injection first, then the
 *     member's chat history
 *   - `tools: {name, description}[]` — descriptors of the registered tools
 *     (the tool-execution seam; descriptors only — authority flows through
 *     the registry at execution, never through the inference seam)
 *
 * @typedef {object} InferenceProvider
 * @property {string} name
 * @property {ProviderClass} providerClass
 * @property {(request: {
 *   memberId: string,
 *   sessionId: string,
 *   messages: { role: string, content: string }[],
 *   tools: { name: string, description?: string }[],
 * }) => Promise<InferenceResponse>} complete
 */

/**
 * The response the inference seam returns:
 *   - `text: string` — this turn's answer
 *   - `toolCalls?: {name, args?}[]` — when present, the loop executes each
 *     named tool through the tool-execution seam with the member-derived
 *     authority, appends the outcomes as tool turns, and calls the seam
 *     again (up to the runTurn maxToolTurns guard)
 *   - `modelId?: string` — which model answered; recorded on the entity's
 *     provenance line (which model answered, under which provider/class,
 *     at which time)
 *
 * @typedef {object} InferenceResponse
 * @property {string} [text]
 * @property {{ name: string, args?: object }[]} [toolCalls]
 * @property {string} [modelId]
 */

/**
 * The tool-execution seam of record (PORCH-147 ac-4). Registry-registered
 * tools; the registry passes exactly member-derived authority to `run` — a
 * frozen `{ memberId, scopes }` resolved per call by the runtime's injected
 * authority resolver (the hub's delegation enforcement, PORCH-149, plugs the
 * home module's authorization service in as that resolver). A missing or
 * mismatched authority refuses fail closed.
 *
 * @typedef {object} AgentTool
 * @property {string} name
 * @property {string} [description]
 * @property {(args: object, authority: { memberId: string, scopes: string[] }) => Promise<unknown>} run
 */

/**
 * Member-derived authority: what the acting member is, no more. Never
 * fabricated inside the library — always resolved through the injected
 * authority resolver and passed verbatim to the tool.
 *
 * @typedef {object} MemberAuthority
 * @property {string} memberId
 * @property {string[]} scopes
 */

/**
 * The storage seam (PORCH-147 isolation contract). Backend-agnostic: the
 * library reads/writes only through these namespaced operations; the hub
 * module injects a Mongo-backed implementation. Every key the runtime emits
 * is already namespaced `member:<memberId>:<scope>:<key>` — one query
 * touches one member's records.
 *
 * @typedef {object} KeyValueBackend
 * @property {(key: string) => Promise<unknown>} get
 * @property {(key: string, value: unknown) => Promise<unknown>} set
 * @property {(key: string) => Promise<unknown>} delete
 * @property {(prefix: string) => Promise<{ key: string, value: unknown }[]>} list
 */

/**
 * A member's SOUL document (the per-member system-injection of record):
 * `identity` is the one required field; `voice` and `law` carry the member's
 * own discipline lines.
 *
 * @typedef {object} Soul
 * @property {string} identity
 * @property {string} [voice]
 * @property {string[]} [law]
 */

export {};
