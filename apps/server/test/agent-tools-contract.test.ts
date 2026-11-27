import { test } from "node:test";
import assert from "node:assert/strict";
import { sign, generateKeyPairSync, randomBytes } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { DEFAULT_CONFIG, createMemoryStore, normalizeConfig, canonicalJson } from "@porchlight/shared";
import type { PorchlightConfig, StoreLike } from "@porchlight/shared";
import { AgentRuntime, MapBackend } from "@porchlight/agent-runtime";
import type { ToolRegistry } from "@porchlight/agent-runtime";
import { assembleAgentModule } from "@porchlight/agent";
import { assembleHomeModule } from "@porchlight/home";
import { HOME_TOOLS } from "@porchlight/agent";
import { BootstrapService } from "../src/services/bootstrap.service.js";
import { createServer } from "../src/router.js";
import type { Router } from "express";
import type { Probe } from "../src/dependencies.js";

/**
 * PORCH-149 transport contract: the agent tool registry rides the REAL home
 * module's service verticals on the running hub — the delegation law
 * enforced hub-side (a member's agent produces exactly the member's
 * permission verdicts, including the visiting-member case resolved through
 * the parent distribution), refusals fail closed, plain language, audited
 * with agent attribution, and an agent's command lands the SAME audit
 * family row a UI command lands. The no-hidden-API check holds: every tool
 * resolves to a route the family app UI can also call.
 */

interface Json { [key: string]: unknown }

/** The wired world: the running hub, its two homes with devices, the family grant, and the registry wiring under contract. */
interface World {
	hub: { db: StoreLike; close(): void; port: Promise<number> };
	port: number;
	owner: { token: string; did: string };
	visitorDid: string;
	homeA: string;
	homeB: string;
	porchDevice: string;
	lampDevice: string;
	homeModule: {
		api: Router;
		toolSurface: Record<string, unknown>;
	};
	agentModule: {
		toolRegistry: ToolRegistry | null;
		authorityResolver: ((memberId: string) => Promise<{ memberId: string; scopes: string[] }>) | null;
	};
	call(path: string, method?: string, payload?: object | null, extra?: object | null): Promise<{ status: number; body: Json }>;
	signed(path: string, payload: object): Promise<{ status: number; body: Json }>;
}

const OK_PROBES: { mongo: Probe; redis: Probe } = { mongo: async () => "ok", redis: async () => "ok" };

function mutableConfig(): PorchlightConfig {
	return normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as PorchlightConfig);
}

function testHub() {
	const db = createMemoryStore() as StoreLike;
	const config = mutableConfig();
	const bootstrap = new BootstrapService(db, config, "/tmp/porchlight-agent-tools-test");
	const app = createServer({ store: db, readiness: OK_PROBES, config, bootstrap });
	const { promise, resolve } = Promise.withResolvers<number>();
	const listener = app.listen(0, () => {
		const address = listener.address();
		const port = typeof address === "object" && address ? address.port : 0;
		resolve(port);
	});
	return { db, close: () => { listener.closeIdleConnections(); listener.close(); }, port: promise };
}

type DevicePair = { deviceId: string; privateKey: KeyObject; publicKeyJwk: Json };

function homePair(deviceId: string): DevicePair {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	return { deviceId, privateKey, publicKeyJwk: publicKey.export({ format: "jwk" }) as Json };
}

/** Signature over canonicalJson(payload), base64url — the device-credential law. */
function homeSign(pair: DevicePair, payload: object): string {
	return sign(null, Buffer.from(canonicalJson(payload), "utf8"), pair.privateKey).toString("base64url");
}

/** The real identity flow: account birth → challenge proof → session token. */
async function homeSession(hub: { port: Promise<number> }, device: { deviceId: string; publicKeyJwk: Json; privateKey: KeyObject }): Promise<{ token: string; did: string }> {
	const port = await hub.port;
	const created = await fetch(`http://127.0.0.1:${port}/api/identity/bootstrap/account`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ firstName: "Porch", lastName: "Admin", device: { deviceId: device.deviceId, publicKeyJwk: device.publicKeyJwk } }),
	});
	assert.equal(created.status, 201);
	const body = (await created.json()) as Json;
	const did = ((body.account as Json) ?? body).did as string;
	const challenge = await fetch(`http://127.0.0.1:${port}/api/identity/session/challenge`, {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ did }),
	});
	assert.equal(challenge.status, 200);
	const nonce = ((await challenge.json()) as Json).nonce as string;
	const session = await fetch(`http://127.0.0.1:${port}/api/identity/session`, {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ did, deviceId: device.deviceId, nonce, signature: sign(null, Buffer.from(nonce, "utf8"), device.privateKey).toString("base64url") }),
	});
	assert.equal(session.status, 201);
	return { token: ((await session.json()) as Json).accessToken as string, did };
}

/** A scripted inference provider: pop the queued responses, settle after. */
function scriptedProvider(script: object[]) {
	const queue = [...script];
	return {
		name: "scripted",
		providerClass: "local-server" as const,
		complete: async () => queue.shift() ?? { text: "settled", toolCalls: [] },
	};
}

async function setupWorld(t: { after(fn: () => unknown): unknown }): Promise<World> {
	const hub = testHub();
	t.after(hub.close);
	const port = await hub.port;
	const pair = homePair("home-dev-1");
	const owner = await homeSession(hub, pair);
	const auth = { "content-type": "application/json", authorization: `Bearer ${owner.token}` };
	const call = async (path: string, method = "GET", payload: object | null = null, extra: object | null = null): Promise<{ status: number; body: Json }> => {
		const res = await fetch(`http://127.0.0.1:${port}${path}`, {
			method, headers: { ...auth, ...(extra as object ?? {}) },
			...(payload === null ? {} : { body: JSON.stringify(payload) }),
		});
		const text = await res.text();
		let body: Json = {};
		try {
			body = text ? JSON.parse(text) as Json : {};
		} catch {
			throw new Error(`${method} ${path} answered ${res.status} with non-JSON: ${text.slice(0, 120)}`);
		}
		return { status: res.status, body };
	};
	const signed = async (path: string, payload: object): Promise<{ status: number; body: Json }> =>
		call(path, "POST", { payload, signature: homeSign(pair, payload) });

	// Two homes: the granted one and one the visitor holds nothing for.
	const home1 = (((await signed("/api/home/homes", { name: "Fieldstone" })).body) as Json).home as Json;
	const homeA = home1._id as string;
	const homeB = ((((await signed("/api/home/homes", { name: "Lakeside" })).body) as Json).home as Json)._id as string;

	const porchArea = ((((await signed(`/api/home/homes/${homeA}/areas`, { name: "Porch", kind: "outdoor" })).body) as Json).area as Json)._id as string;
	const livingArea = ((((await signed(`/api/home/homes/${homeA}/areas`, { name: "Living room", kind: "room" })).body) as Json).area as Json)._id as string;

	const porchLight = { name: "Porch light", areaId: porchArea, capabilities: ["light"], adapter: { name: "unbound", binding: null } };
	const livingLamp = { name: "Living lamp", areaId: livingArea, capabilities: ["switch"], adapter: { name: "unbound", binding: null } };
	const porchDevice = ((((await signed(`/api/home/homes/${homeA}/devices`, porchLight)).body) as Json).device as Json)._id as string;
	const lampDevice = ((((await signed(`/api/home/homes/${homeA}/devices`, livingLamp)).body) as Json).device as Json)._id as string;

	// The visiting member rides a FAMILY grant resolved through the parent
	// distribution only (identity-plane family facts, never the envelope).
	const visitorDid = `did:porch:${randomBytes(20).toString("hex")}`;
	await hub.db.collection("families").insertOne({
		_id: "fam_test", name: "Noah", parentIdentityRefs: [owner.did],
		memberIdentityRefs: [visitorDid], createdBy: owner.did, createdAt: new Date().toISOString(),
	});
	const grantBody = ((await signed(`/api/home/homes/${homeA}/grants`, {
		familyId: "fam_test",
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		scopes: [{ resourceType: "device", resourceRef: porchDevice, verbs: ["view", "control"] }],
	})).body) as Json;
	const grantId = (grantBody.grant as Json)._id as string;
	await signed(`/api/home/grants/${grantId}/distributions`, {
		memberIdentityRef: visitorDid,
		// The parent distributes ONLY the porch light's control — the lamp
		// stays beyond the visitor's permitted set.
		scopes: [{ resourceType: "device", resourceRef: porchDevice, verbs: ["view", "control"] }],
	});

	// The registry wiring of record (router.ts): the agent module over the
	// home module's REAL tool surface, identity family facts through the
	// same rows the identity family service reads.
	const homeModule = assembleHomeModule(hub.db as unknown as { collection(name: string): unknown }, {
		// The registry's seams are session-free (identity already resolved by
		// the delegation seam) — the verifier only backstops REST paths this
		// assembly never serves, so it refuses closed.
		verifySession: async () => null,
		identityFacts: {
			resolveIdentity: async (did: string) => (did === owner.did ? { did, displayName: "Porch Admin" } : null),
			familyById: async (familyId: string) => hub.db.collection("families").findOne({ _id: familyId }) as never,
			familiesForMember: async (did: string) => {
				const rows = (await hub.db.collection("families").find({})) as Array<{ memberIdentityRefs?: string[] }>;
				return rows.filter((family) => (family.memberIdentityRefs ?? []).includes(did)) as never;
			},
		},
	});
	const agentModule = assembleAgentModule(hub.db as unknown as { collection(name: string): unknown }, { homeSurface: (homeModule as { toolSurface: Record<string, unknown> }).toolSurface });
	return { hub, port, owner, visitorDid, homeA, homeB, porchDevice, lampDevice, homeModule, agentModule, call, signed };
}

/** One runtime session per actor, sharing the ONE registry + authority seam. */
function runtimeFor(world: World, script: object[]) {
	return new AgentRuntime({
		backend: new MapBackend(),
		inference: scriptedProvider(script),
		tools: world.agentModule.toolRegistry,
		authority: (memberId: string) => world.agentModule.authorityResolver!(memberId),
	});
}

test("PORCH-149: no-hidden-API — every registered tool resolves to a route the UI can also call", async (t) => {
	const world = await setupWorld(t);
	const registry = world.agentModule.toolRegistry!;
	assert.ok(registry, "the MCP-for-the-home registry built over the home module's toolSurface");
	// The home router's registered REST surface, read off the router stack.
	const paths = new Set<string>();
	for (const layer of (world.homeModule.api as unknown as { stack: Array<{ route?: { path?: string; methods?: Record<string, boolean> } }> }).stack) {
		if (layer.route?.path && layer.route.methods) {
			for (const method of Object.keys(layer.route.methods)) {
				paths.add(`${method.toUpperCase()} ${layer.route.path}`);
			}
		}
	}
	for (const [tool, uiRoute] of [
		[HOME_TOOLS.deviceList, "GET /homes/:homeId/devices"],
		[HOME_TOOLS.deviceCommand, "POST /devices/:deviceId/command"],
		[HOME_TOOLS.sceneRun, "POST /scenes/:sceneId/run"],
		[HOME_TOOLS.homeStatus, "GET /homes/:homeId"],
		[HOME_TOOLS.eventReview, "GET /homes/:homeId/events"],
	] as const) {
		assert.equal(registry.has(tool.name), true, `${tool.name} registered`);
		assert.equal(paths.has(uiRoute), true, `${tool.name} resolves to ${uiRoute}`);
	}
});

test("PORCH-149 delegation e2e: the visiting member's agent produces exactly the parent-distributed verdicts", async (t) => {
	const world = await setupWorld(t);
	const runtime = runtimeFor(world, [
		// Allowed where allowed: the porch light the parent distributed.
		{ text: "", toolCalls: [
			{ name: "home_list_devices", args: { homeId: world.homeA } },
			{ name: "home_device_command", args: { deviceId: world.porchDevice, command: "turnOn" } },
		] },
		// Denied where denied: the lamp beyond the visitor's permitted set.
		{ text: "", toolCalls: [
			{ name: "home_device_command", args: { deviceId: world.lampDevice, command: "turnOn" } },
		] },
		{ text: "visit turns reported." },
	]);
	const entity = runtime.agentFor(world.visitorDid);
	const turn = await entity.runTurn({ text: "check my visit" });
	// Only the listing settled ok — both commands answer as tool-turn
	// failures in the loop (the porch one: the honest device-side
	// E_NO_ADAPTER refusal; the lamp one: the scope refusal), yet BOTH land
	// their verdict rows — asserted against the home audit family below.
	assert.deepEqual(turn.toolsUsed, ["home_list_devices"]);

	// The device listing resolved the GRANT-scoped slice: only the porch
	// light shows — the lamp is beyond the distribution.
	const memory = [...(await entity.memory.all())];
	const listed = memory.filter((e) => e.role === "tool").map((e) => JSON.parse(e.text) as Json);
	const devices = (listed.map((l) => l.result as Json).find((r) => Array.isArray(r?.devices))?.devices ?? []) as Json[];
	assert.deepEqual(devices.map((d) => d.name), ["Porch light"]);

	// Verdicts of record in the home audit family:
	const homeRows = (await hubRows(world, "home_audit")) as Json[];
	const porchRow = homeRows.find((r) => r.deviceId === world.porchDevice && (r.detail as Json)?.source === "agent");
	const lampRow = homeRows.find((r) => r.deviceId === world.lampDevice && (r.detail as Json)?.source === "agent");
	assert.ok(porchRow, "the distributed device's command executed the service");
	assert.equal(porchRow.outcome, "failed", "passed scope enforcement (device-side failure: no adapter), never denied");
	assert.equal(porchRow.actorIdentityRef, world.visitorDid);
	assert.equal((porchRow.detail as Json).agentTool, "home_device_command");
	assert.ok(lampRow, "the beyond-envelope command was refused");
	assert.equal(lampRow.outcome, "denied", "refused beyond the member's scopes before any device contact");
	assert.equal(lampRow.actorIdentityRef, world.visitorDid);
});

async function hubRows(world: Awaited<ReturnType<typeof setupWorld>>, name: string): Promise<unknown[]> {
	return world.hub.db.collection(name).find({});
}

test("PORCH-149: a member's agent produces the member's own membership verdicts, and a refusal beyond scopes never touches the service", async (t) => {
	const world = await setupWorld(t);
	const runtime = runtimeFor(world, [
		// The member's own home: full member surface — listing answers.
		{ text: "", toolCalls: [
			{ name: "home_list_devices", args: { homeId: world.homeA } },
		] },
		{ text: "listed." },
	]);
	const entity = runtime.agentFor(world.owner.did);
	const turn = await entity.runTurn({ text: "what devices do I have?" });
	assert.deepEqual(turn.toolsUsed, ["home_list_devices"]);

	// A call beyond the acting member's scopes (the visitor asking the home
	// they hold nothing for) refuses BEFORE the underlying service runs and
	// lands the agent-audit refusal row with the agent attribution.
	const visitorRuntime = runtimeFor(world, [
		{ text: "", toolCalls: [{ name: "home_status", args: { homeId: world.homeB } }] },
		{ text: "refused." },
	]);
	const visitorEntity = visitorRuntime.agentFor(world.visitorDid);
	const visitorTurn = await visitorEntity.runTurn({ text: "describe the other home" });
	assert.deepEqual(visitorTurn.toolsUsed, [], "the refused tool never contributed an outcome");

	const agentRows = (await hubRows(world, "agent_audit")) as Json[];
	const refusal = agentRows.find((r) => r.type === "tool-refusal");
	assert.ok(refusal, "the refusal landed an agent audit row");
	assert.equal(refusal.actorIdentityRef, world.visitorDid);
	assert.equal((refusal.detail as Json).via, "agent-tool");
	assert.equal((refusal.detail as Json).tool, "home_status");
	assert.match(String((refusal.detail as Json).reason), /no access for this member/);
	// The underlying service never ran: no home surfaces answered for
	// homeB — its home reads only ever show the refused state of record.
	const lakesideRows = agentRows.filter((r) => (r.detail as Json)?.tool === "home_status");
	assert.equal(lakesideRows.length, 1);
});

test("PORCH-149 ac-5: a UI command and an agent tool command under the same member land the SAME audit family, indistinguishable in class", async (t) => {
	const world = await setupWorld(t);
	// The member's UI command (signed device write; no adapter → the honest
	// device-side failure the audit carries).
	const ui = await world.signed(`/api/home/devices/${world.lampDevice}/command`, { command: "turnOn" });
	assert.equal(ui.status, 409); // E_NO_ADAPTER — the command machinery, not the perimeter

	// The agent performing the SAME action under the SAME member.
	const runtime = runtimeFor(world, [
		{ text: "", toolCalls: [{ name: "home_device_command", args: { deviceId: world.lampDevice, command: "turnOn" } }] },
		{ text: "attempt reported." },
	]);
	const entity = runtime.agentFor(world.owner.did);
	await entity.runTurn({ text: "turn on the lamp" });

	const homeRows = (await hubRows(world, "home_audit")) as Json[];
	const commandRows = homeRows.filter((r) => r.type === "command" && r.deviceId === world.lampDevice);
	assert.equal(commandRows.length, 2, "both issuers landed their command row in the home audit");
	const uiRow = commandRows.find((r) => (r.detail as Json)?.source === "member")!;
	const agentRow = commandRows.find((r) => (r.detail as Json)?.source === "agent")!;
	assert.ok(uiRow && agentRow);
	// Indistinguishable in class: same type, same actor, same command, same
	// outcome — only the issuer attribution differs in actor detail.
	assert.equal(uiRow.type, agentRow.type);
	assert.equal(uiRow.actorIdentityRef, world.owner.did);
	assert.equal(agentRow.actorIdentityRef, world.owner.did);
	assert.equal((uiRow.detail as Json).command, (agentRow.detail as Json).command);
	assert.equal(uiRow.outcome, agentRow.outcome);
	assert.equal((agentRow.detail as Json).agentTool, "home_device_command");
});
