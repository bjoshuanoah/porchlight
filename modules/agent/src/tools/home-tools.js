/**
 * MCP-for-the-home: the five tool implementations of the agent tool
 * registry (PORCH-149), riding the home module's SERVICE verticals through
 * the injected `surface` (the home module's `toolSurface`) — the exact
 * session-free service paths the home module's UI routes resolve into. No
 * hidden API: every tool carries the REST route the family app UI can call
 * for the same action (`uiRoute`), and every call re-resolves the acting
 * member's authorizeMember verdicts live at the home services.
 *
 * The tools add NO authorization logic of their own — delegation stays
 * one-hub, one code path: identity + authority from the runtime's
 * composition seam 2, resource verdicts from the home module.
 */

/** The five home tools' static descriptors (names/descriptions of record). */
export const HOME_TOOLS = Object.freeze({
	deviceList: {
		name: "home_list_devices",
		description: "List the devices of one home exactly as the member sees them on the home's dashboard.",
		uiRoute: "GET /homes/:homeId/devices",
	},
	deviceCommand: {
		name: "home_device_command",
		description: "Send one command to one device, exactly as the member's dashboard control would.",
		uiRoute: "POST /devices/:deviceId/command",
	},
	sceneRun: {
		name: "home_run_scene",
		description: "Run one saved scene of a home, exactly as the member's scene runner would.",
		uiRoute: "POST /scenes/:sceneId/run",
	},
	homeStatus: {
		name: "home_status",
		description: "Read one home's current surfaces — areas, devices, scenes, automations — exactly as the home's app screen serves them.",
		uiRoute: "GET /homes/:homeId",
	},
	eventReview: {
		name: "home_review_events",
		description: "Review a bounded page of a home's recent detection events, exactly as the home's alert surface serves them.",
		uiRoute: "GET /homes/:homeId/events",
	},
});

/**
 * @typedef {object} HomeToolSurface
 * The home module's session-free actor seams (every callable re-resolves
 * the member's permission verdicts live — the home module's one
 * authorization path). Injected at assembly; the agent module imports no
 * home source.
 * @property {({ did }) => Promise<Array<{ homeId: string, name?: string, accessClass: string, scopes?: object[] | null }>>} homes
 * @property {({ did, homeId }) => Promise<object>} status
 * @property {({ did, homeId }) => Promise<{ devices: object[] }>} listDevices
 * @property {({ did, deviceId, command, detail? }) => Promise<object>} sendCommand
 * @property {({ did, sceneId, detail? }) => Promise<object>} runScene
 * @property {({ did, homeId, limit?, offset? }) => Promise<{ events: object[], total?, hasMore? }>} reviewEvents
 */

/**
 * Build the five tool implementations over the injected surface. Each
 * `run(args, authority)` validates its arguments in plain language and
 * calls exactly one surface callable with the acting member and the agent
 * attribution detail (the home service stamps `source: "agent"` and the
 * audit row carries `agentTool`).
 *
 * @param {{ surface: HomeToolSurface }} param
 * @returns {Array<{ name: string, description: string, uiRoute: string, homeScope?: boolean, run: (args: object, authority: { memberId: string, scopes: string[] }) => Promise<unknown> }>}
 */
export function createHomeTools({ surface }) {
	const attribution = (tool) => ({ agentTool: tool.name });
	return [
		{
			...HOME_TOOLS.deviceList,
			/**
			 * args: { homeId } — the home's device listing, member-visible
			 * slice only (grant scopes filter server-side, the same verdicts
			 * the dashboard resolves).
			 */
			run: async ({ homeId }, authority) => {
				if (typeof homeId !== "string" || homeId.length === 0) {
					throw new Error("Porchlight needs to know which home's devices to list — name the home id.");
				}
				return surface.listDevices({ did: authority.memberId, homeId });
			},
		},
		{
			...HOME_TOOLS.deviceCommand,
			/**
			 * args: { deviceId, command, homeId? } — the home resolves inside
			 * the service when homeId is omitted (the same refusal shape the
			 * UI command path answers).
			 */
			run: async ({ deviceId, command, homeId = null }, authority) => {
				if (typeof deviceId !== "string" || deviceId.length === 0 || typeof command !== "string" || command.length === 0) {
					throw new Error("Porchlight needs both a device and the command to send — name them and the device will be reached.");
				}
				return surface.sendCommand({
					did: authority.memberId,
					homeId,
					deviceId,
					command,
					detail: attribution(HOME_TOOLS.deviceCommand),
				});
			},
		},
		{
			...HOME_TOOLS.sceneRun,
			homeScope: false, // the scene's home resolves inside the service
			run: async ({ sceneId }, authority) => {
				if (typeof sceneId !== "string" || sceneId.length === 0) {
					throw new Error("Porchlight needs to know which scene to run — name the scene id.");
				}
				return surface.runScene({
					did: authority.memberId,
					sceneId,
					detail: attribution(HOME_TOOLS.sceneRun),
				});
			},
		},
		{
			...HOME_TOOLS.homeStatus,
			run: async ({ homeId }, authority) => {
				if (typeof homeId !== "string" || homeId.length === 0) {
					throw new Error("Porchlight needs to know which home to describe — name the home id.");
				}
				return surface.status({ did: authority.memberId, homeId });
			},
		},
		{
			...HOME_TOOLS.eventReview,
			run: async ({ homeId, limit, offset }, authority) => {
				if (typeof homeId !== "string" || homeId.length === 0) {
					throw new Error("Porchlight needs to know which home's events to review — name the home id.");
				}
				const page = {};
				if (limit !== undefined) page.limit = limit;
				if (offset !== undefined) page.offset = offset;
				return surface.reviewEvents({ did: authority.memberId, homeId, ...page });
			},
		},
	];
}
