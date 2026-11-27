import { ToolRegistry } from "@porchlight/agent-runtime";
import { fail } from "../services/errors.js";
import { HOME_TOOLS, createHomeTools } from "./home-tools.js";

/**
 * The delegation-law enforcement layer of the agent tool registry
 * (PORCH-149). The registry rides the agent runtime library's
 * tool-execution seam — composition seam 2 exactly: the runtime resolves
 * member-derived authority per call through `authorityFor` (this service),
 * and every tool execution passes exactly the frozen
 * `{ memberId, scopes }` the seam hands the tool. Nothing hub-specific is
 * re-implemented here — no loop, no memory, no inference.
 *
 * Enforcement resolves the acting member's identity, then their permission
 * surface of record, then executes the home-module service the UI route
 * resolves to (the injected home tool surface's callables — no hidden API).
 * The permission verdicts live at the home module's authorization
 * resolution (authorizeMember's one code path, re-resolved LIVE on every
 * call), so revocation, expiry, and parent distributions deny the very
 * next agent tool call exactly as they deny the member's own UI action.
 *
 * A call beyond the member's scopes refuses fail closed BEFORE the
 * underlying service runs: the refusal is plain language and lands an
 * agent-audit row carrying the agent attribution (via: "agent-tool", the
 * tool, the member it acted for).
 */
export class ToolDelegationService {
	#surface;
	#audit;
	#registry;

	/**
	 * @param {{
	 *   surface: import("./home-tools.js").HomeToolSurface,
	 *   audit: import("../services/audit.service.js").AgentAuditService,
	 *   registry?: import("@porchlight/agent-runtime").ToolRegistry,
	 * }} opts
	 */
	constructor({ surface, audit, registry = null } = {}) {
		if (!surface || typeof surface !== "object") {
			throw new TypeError("ToolDelegationService: the home tool surface is required (the MCP-for-the-home seams ride the home module's services)");
		}
		if (!audit || typeof audit.record !== "function") {
			throw new TypeError("ToolDelegationService: the agent audit service is required (refusals are audited, never silent)");
		}
		const missing = SURFACE_METHODS.filter((method) => typeof surface[method] !== "function");
		if (missing.length > 0) {
			throw new TypeError(`ToolDelegationService: the home tool surface is missing ${missing.join(", ")} — the tool seams resolve to the home module's actor services and refuse to build without them`);
		}
		this.#surface = surface;
		this.#audit = audit;
		this.#registry = registry ?? new ToolRegistry();
		for (const tool of createHomeTools({ surface })) {
			this.#registry.register({
				name: tool.name,
				description: tool.description,
				run: (args, authority) => this.#runTool(tool, args, authority),
			});
		}
	}

	/** @type {import("@porchlight/agent-runtime").ToolRegistry} */
	get registry() {
		return this.#registry;
	}

	/**
	 * Composition seam 2 (member-derived authority injections): resolve the
	 * acting member's permission surface of record live via the home module's
	 * authorization resolution — membership access blocks plus every live
	 * grant (individual or family-distributed). The scope strings carry
	 * `home:<homeId>:<accessClass>`; resource-level verdicts stay at the home
	 * services (never re-sliced here, never cached).
	 */
	async authorityFor(memberId) {
		if (typeof memberId !== "string" || memberId.length === 0) {
			throw new TypeError("authorityFor: memberId required — member-derived authority resolves from the acting member's identity");
		}
		const blocks = await this.#surface.homes({ did: memberId });
		if (!Array.isArray(blocks)) {
			throw new Error("the home authorization surface answered without an access list — refusing to derive authority from nothing");
		}
		return {
			memberId,
			scopes: blocks.map((block) => `home:${block.homeId}:${block.accessClass}`),
		};
	}

	/**
	 * One enforcement pass: scope check (fail closed, audited, the
	 * underlying home service never runs) then the tool's home call — the
	 * home service re-enforces the live verdicts (revocation, expiry,
	 * distributions) and refuses with its own plain-language failure, which
	 * this layer also audits with the agent attribution.
	 *
	 * @returns {Promise<unknown>} the tool's home service answer
	 */
	async #runTool(tool, args, authority) {
		if (!args || typeof args !== "object") {
			throw new Error("Porchlight needs the tool's arguments as named fields — the tool was called with none.");
		}
		const homeScope = homeScopeOf(tool, args);
		if (homeScope != null && !authority.scopes.some((scope) => scope.startsWith(homeScope))) {
			const message = "The agent can't act in that home — no access for this member is on record there.";
			await this.#auditRefusal({
				tool: tool.name,
				memberId: authority.memberId,
				homeId: args.homeId,
				detail: { reason: message, scope: homeScope },
			});
			return fail("E_TOOL_REFUSED", message);
		}
		try {
			return await tool.run(args, authority);
		} catch (cause) {
			if (cause?.code === "E_NOT_PERMITTED") {
				// The home service denied the call under the member's live
				// verdicts (grant control coverage, camera authorization, the
				// visitor's envelope). Refused beyond the member's scopes — the
				// refusal is plain language (the cause's message) and audited
				// with the agent attribution; the underlying action never
				// executed. A device command's refusal additionally lands the
				// home module's denied command row, the SAME audit family the
				// UI command refusal carries.
				await this.#auditRefusal({
					tool: tool.name,
					memberId: authority.memberId,
					homeId: args.homeId ?? null,
					detail: { reason: cause.message, serviceDenial: cause.code },
				});
			}
			throw cause;
		}
	}

	async #auditRefusal({ tool, memberId, homeId, detail }) {
		await this.#audit.record({
			type: "tool-refusal",
			actorIdentityRef: memberId,
			detail: {
				via: "agent-tool",
				tool,
				homeId: homeId ?? null,
				...(detail ?? {}),
			},
			outcome: "refused",
		});
	}
}

/** The scope prefix the registry pre-checks a tool's target home against. */
function homeScopeOf(tool, args) {
	if (tool.homeScope === false) return null; // the home resolves inside the service (scene run)
	if (args.homeId != null && args.homeId !== "") return `home:${args.homeId}:`;
	return null;
}

/** The home tool surface's callable bank of record (the home module's toolSurface). */
export const SURFACE_METHODS = Object.freeze([
	"homes", "status", "listDevices", "sendCommand", "runScene", "reviewEvents",
]);

export { HOME_TOOLS, createHomeTools };

