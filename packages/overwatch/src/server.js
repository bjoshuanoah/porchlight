// server.js — the overwatch REST plane (PORCH-140 wave 2).
//
// Zero-framework node:http surface in the repo's config-plane style
// (packages/config/src/server.js): JSON bodies, 422 { error } in plain
// language, 404 unknown resources, no CORS, no cookies. Routes stay thin —
// every behavior lives in the injected services; unknown method/path falls
// through to the plain 404.
//
// `services` — the design of record for this plane (all required):
//   {
//     store:          the overwatch config store (createConfigStore) —
//                     zones, adjacency, travelTime, dial, correlation doc
//     dial:           createDial({ store, audit }) — the audited rate dial
//     audit:          createAuditLog — every explicit state change lands here
//     trackedService: createTrackedObjectsService({ chainsProvider, followService })
//     followService:  createFollowService({ audit, chainsProvider, clipsProvider, ... })
//     visitService:   createVisitService({ store, chainsProvider, clipsProvider, ... })
//     now:            optional () => epoch-seconds clock; defaults to the
//                     host clock (drives tracked/timeline freshness)
//     entityService:  optional active EntityMergeService — when present, the
//                     association-flag route additionally applies
//                     entityService.vetoPair(signature) at runtime; the
//                     persisted store row is the restart-durable of record
//                     (fresh services re-seed their veto set from
//                     correlationConfig().separatePairs), so the plane is
//                     correct without this seam too.
//   }
//
// `authorize` — the owner seam of record. Null (tests) = allow-all. When
// provided, called as `authorize({ req, action, resource })`:
//   action   "read" (GET) | "write" (PUT/POST/DELETE)
//   resource one of "state" | `zones/<cameraId>` | "adjacency" |
//            "travel-time" | "dial" | "tracked" | `tracked/<entityId>` |
//            "visits" | `visits/<visitId>` | "association" | "audit"
//   Returns truthy to allow. Falsy denies with 403 E_NOT_PERMITTED. Thrown
//   errors pass through as the transport's own refusal (the hub adapter
//   throws 401-style errors — status and code ride err.status / err.code).

import httpDefault from "node:http";
import { ConfigValidationError } from "./config-store.js";
import { pairKey } from "./correlation.js";

/** Request body cap (plain JSON plane — no uploads ride these routes). */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Plain-language transport error: 422 E_INVALID shape by default; use the
 * factories below instead of instantiating codes ad hoc.
 */
export class OverwatchHttpError extends Error {
	/**
	 * @param {string} message plain-language explanation
	 * @param {{ status?: number, code?: string }} [meta]
	 */
	constructor(message, { status = 422, code = "E_INVALID" } = {}) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

/** @param {string} message */
function invalid(message) {
	return new OverwatchHttpError(message, { status: 422, code: "E_INVALID" });
}

/** @param {string} message */
function notFound(message) {
	return new OverwatchHttpError(message, { status: 404, code: "E_NOT_FOUND" });
}

function notPermitted() {
	return new OverwatchHttpError("E_NOT_PERMITTED", { status: 403, code: "E_NOT_PERMITTED" });
}

/** Service error codes of record ride their own transport status. */
const SERVICE_ERROR_STATUS = {
	E_NOT_FOUND: 404,
	E_NOT_FOLLOWABLE: 422,
	E_BAD_WINDOW: 422,
	E_BAD_CHAIN: 422,
};

function sendJson(res, status, body) {
	if (res.headersSent) return;
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

/**
 * Read + parse a JSON request body; `{}` when empty; plain-language 422s.
 * A pre-parsed body (the hub adapter path — Express may have already
 * consumed the stream) short-circuits the read.
 * @param {import("node:http").IncomingMessage} req
 * @param {{ body?: object | null }} [prepared]
 * @returns {Promise<Record<string, unknown>>}
 */
function readJsonBody(req, prepared = {}) {
	if (prepared.body !== undefined && prepared.body !== null) {
		if (typeof prepared.body !== "object" || Array.isArray(prepared.body)) {
			return Promise.reject(invalid("request body must be a JSON object"));
		}
		return Promise.resolve(prepared.body);
	}
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(invalid("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			if (raw.trim() === "") return resolve({});
			try {
				const parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
					return reject(invalid("request body must be a JSON object"));
				}
				resolve(parsed);
			} catch {
				reject(invalid("request body is not valid JSON"));
			}
		});
		req.on("error", reject);
	});
}

/** @param {string} id @param {string} what */
function requireId(id, what) {
	if (typeof id !== "string" || id.trim() === "") {
		throw invalid(`${what} must be a non-empty string`);
	}
	return id;
}

/** @param {unknown} v @returns {v is number} */
function isFiniteNumber(v) {
	return typeof v === "number" && Number.isFinite(v);
}

/**
 * Build the overwatch route plane. The returned async handler speaks plain
 * node:http primitives (IncomingMessage + ServerResponse), fully
 * self-mapping its errors, so the zero-framework server and the hub's
 * Express adapter behave identically.
 *
 * @param {{
 *   services: {
 *     store: object,
 *     dial: object,
 *     audit: { record: (row: object) => unknown, list: (filters?: object) => object[] },
 *     trackedService: object,
 *     followService: object,
 *     visitService: object,
 *     now?: () => number,
 *     entityService?: { vetoPair: (signature: string) => unknown } | null,
 *   },
 *   authorize?: ((args: { req: unknown, action: string, resource: string }) => Promise<boolean|unknown>|boolean|unknown) | null,
 *   log?: ((line: string) => void) | null,
 * }} parts
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, prepared?: { body?: object | null }) => Promise<void>}
 */
export function createOverwatchHandler({ services, authorize = null, log = null }) {
	const { store, dial, audit, trackedService, followService, visitService } = services;
	for (const [name, service] of Object.entries({ store, dial, audit, trackedService, followService, visitService })) {
		if (!service) throw new TypeError(`createOverwatchServer: services.${name} is required`);
	}
	const now = services.now ?? (() => Date.now() / 1000);
	const entityService = services.entityService ?? null;

	/**
	 * The authorize seam: truthy allows; falsy denies 403; thrown errors are
	 * the adapter's own typed refusal (401-style) and pass through.
	 * @param {{ req: unknown, action: string, resource: string }} args
	 */
	async function authorizeOrThrow(args) {
		if (authorize == null) return;
		let granted;
		try {
			granted = await authorize(args);
		} catch (error) {
			const status = Number(error?.status) || 403;
			throw new OverwatchHttpError(String(error?.message ?? "E_NOT_PERMITTED"), {
				status,
				code: String(error?.code ?? "E_NOT_PERMITTED"),
			});
		}
		if (!granted) throw notPermitted();
	}

	async function handle(req, res, prepared = {}) {
		try {
			await dispatch(req, res, prepared);
		} catch (error) {
			if (error instanceof OverwatchHttpError) {
				return sendJson(res, error.status, { error: error.message, code: error.code });
			}
			if (error instanceof ConfigValidationError) {
				return sendJson(res, 422, { error: error.message, code: "E_INVALID" });
			}
			const status = SERVICE_ERROR_STATUS[/** @type {{ code?: string }} */ (error)?.code];
			if (status) {
				return sendJson(res, status, { error: error.message, code: error.code });
			}
			// Unexpected: the operator log gets the detail, the client stays generic.
			(log ?? console.error)?.(`[overwatch] internal error: ${error?.stack ?? error}`);
			return sendJson(res, 500, { error: "internal error", code: "E_INTERNAL" });
		}
	}

	/**
	 * @param {import("node:http").IncomingMessage} req
	 * @param {import("node:http").ServerResponse} res
	 * @param {{ body?: object | null }} prepared
	 */
	async function dispatch(req, res, prepared) {
		const url = new URL(req.url ?? "/", "http://localhost");
		const method = req.method ?? "GET";
		const segments = url.pathname.split("/").filter(Boolean).map((segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		});
		if (segments[0] !== "api" || segments[1] !== "overwatch") {
			throw notFound("not found");
		}
		const r = segments.slice(2);
		const needsBody = method === "POST" || method === "PUT" || method === "DELETE";
		const body = needsBody ? await readJsonBody(req, prepared) : undefined;

		if (r[0] === "state" && r.length === 1) {
			if (method === "GET") {
				await authorizeOrThrow({ req, action: "read", resource: "state" });
				return sendJson(res, 200, stateView());
			}
		}

		if (r[0] === "zones" && r.length === 2) {
			const cameraId = requireId(r[1], "camera id");
			if (method === "PUT") return putZone(res, cameraId, body, req);
			if (method === "DELETE") return deleteZone(res, cameraId, req);
		}

		if (r[0] === "adjacency" && r.length === 1 && method === "PUT") {
			await authorizeOrThrow({ req, action: "write", resource: "adjacency" });
			if (!Array.isArray(body.pairs)) {
				throw invalid("adjacency: pairs must be an array of [cameraId, cameraId] pairs");
			}
			const doc = store.update((draft) => {
				draft.adjacency = body.pairs.map((pair) => [pair[0], pair[1]]);
			});
			return sendJson(res, 200, { adjacency: doc.adjacency });
		}

		if (r[0] === "travel-time" && r.length === 1 && method === "PUT") {
			await authorizeOrThrow({ req, action: "write", resource: "travel-time" });
			if (!body.updates || typeof body.updates !== "object" || Array.isArray(body.updates)) {
				throw invalid("travel-time: updates must be an object keyed by sorted pair keys, e.g. { \"a|b\": { min, max } }");
			}
			const updates = body.updates;
			const doc = store.update((draft) => {
				for (const [key, value] of Object.entries(updates)) {
					draft.travelTime[key] = { min: value?.min, max: value?.max };
				}
			});
			return sendJson(res, 200, { travelTime: doc.travelTime });
		}

		if (r[0] === "dial" && r.length === 1) {
			if (method === "GET") {
				await authorizeOrThrow({ req, action: "read", resource: "dial" });
				return sendJson(res, 200, dial.get());
			}
			if (method === "PUT") {
				await authorizeOrThrow({ req, action: "write", resource: "dial" });
				if (!isFiniteNumber(body.frameRate)) {
					throw invalid("dial: frameRate must be a number between 1 and the cap");
				}
				const set = dial.set({ frameRate: body.frameRate, actorIdentityRef: body.actorIdentityRef ?? null });
				return sendJson(res, 200, { frameRate: set.frameRate, clamped: set.clamped, capFps: dial.capFps });
			}
		}

		if (r[0] === "tracked") {
			if (r.length === 1 && method === "GET") {
				await authorizeOrThrow({ req, action: "read", resource: "tracked" });
				return sendJson(res, 200, trackedService.list({ at: now() }));
			}
			if (r.length === 3) {
				const entityId = requireId(r[1], "entity id");
				if (r[2] === "follow") {
					if (method === "POST") return postFollow(res, entityId, body, req);
					if (method === "DELETE") return deleteFollow(res, entityId, body, req);
				}
				if (r[2] === "stream" && method === "GET") {
					await authorizeOrThrow({ req, action: "read", resource: `tracked/${entityId}` });
					const view = trackedService.get({ entityId, at: now() });
					if (!view) throw notFound(`Unknown tracked entity "${entityId}"`);
					return sendJson(res, 200, { entityId, cls: view.cls, state: view.state, clips: view.clips });
				}
			}
		}

		if (r[0] === "visits") {
			if (r.length === 1 && method === "GET") {
				await authorizeOrThrow({ req, action: "read", resource: "visits" });
				const fromRaw = url.searchParams.get("from");
				const toRaw = url.searchParams.get("to");
				if (fromRaw === null || toRaw === null) {
					throw invalid("visits: from and to are required epoch seconds");
				}
				const from = Number(fromRaw);
				const to = Number(toRaw);
				if (!isFiniteNumber(from) || !isFiniteNumber(to)) {
					throw invalid("visits: from and to must be epoch seconds");
				}
				const visits = visitService.listVisits({ from, to });
				return sendJson(res, 200, { visits });
			}
			if (r.length === 3 && r[2] === "timeline" && method === "GET") {
				const visitId = requireId(r[1], "visit id");
				await authorizeOrThrow({ req, action: "read", resource: `visits/${visitId}` });
				const timeline = visitService.timeline({ visitId, at: now() });
				return sendJson(res, 200, { visitId, timeline });
			}
		}

		if (r[0] === "association" && r[1] === "flag" && r.length === 2 && method === "POST") {
			return postAssociationFlag(res, body, req);
		}

		if (r[0] === "audit" && r.length === 1 && method === "GET") {
			await authorizeOrThrow({ req, action: "read", resource: "audit" });
			const type = url.searchParams.get("type") ?? undefined;
			const limitRaw = url.searchParams.get("limit");
			let limit;
			if (limitRaw !== null) {
				limit = Number(limitRaw);
				if (!Number.isInteger(limit) || limit <= 0) {
					throw invalid("audit: limit must be a positive integer");
				}
			}
			return sendJson(res, 200, { records: audit.list({ type: type || undefined, limit }) });
		}

		throw notFound("not found");
	}

	/** GET /state: zones, per-camera coverage, adjacency, travel priors, dial. */
	function stateView() {
		const doc = store.getState();
		const cameraIds = new Set();
		for (const zone of doc.coverageZones) cameraIds.add(zone.cameraId);
		for (const [a, b] of doc.adjacency) {
			cameraIds.add(a);
			cameraIds.add(b);
		}
		for (const key of Object.keys(doc.travelTime)) {
			for (const id of key.split("|")) cameraIds.add(id);
		}
		for (const activeCameraId of doc.dial.activeCameraIds) cameraIds.add(activeCameraId);
		const zoneByCamera = new Map(doc.coverageZones.map((zone) => [zone.cameraId, zone]));
		const cameras = [...cameraIds].sort().map((cameraId) => {
			const zone = zoneByCamera.get(cameraId);
			return {
				cameraId,
				zone: zone ? structuredClone(zone.polygon) : null,
				uncovered: !zone,
			};
		});
		return {
			zones: structuredClone(doc.coverageZones),
			cameras,
			adjacency: structuredClone(doc.adjacency),
			travelTime: structuredClone(doc.travelTime),
			dial: dial.get(),
		};
	}

	/** PUT /zones/:cameraId — owner-authored polygon for one camera (audited). */
	async function putZone(res, cameraId, body, req) {
		await authorizeOrThrow({ req, action: "write", resource: `zones/${cameraId}` });
		if (!Array.isArray(body?.polygon)) {
			throw invalid("zone save needs a polygon — an array of at least 3 [x, y] map points");
		}
		const doc = store.setZone(cameraId, body.polygon, { authoredBy: body.actorIdentityRef ?? null });
		const zone = doc.coverageZones.find((candidate) => candidate.cameraId === cameraId);
		audit.record({
			type: "zone-config-change",
			actorIdentityRef: body.actorIdentityRef ?? null,
			detail: { cameraId, action: "set" },
		});
		return sendJson(res, 200, { zone: structuredClone(zone) });
	}

	/** DELETE /zones/:cameraId — withdraw the camera's coverage zone (audited). */
	async function deleteZone(res, cameraId, req) {
		await authorizeOrThrow({ req, action: "write", resource: `zones/${cameraId}` });
		const before = store.getState();
		if (!before.coverageZones.some((zone) => zone.cameraId === cameraId)) {
			throw notFound(`Camera "${cameraId}" has no authored zone to remove`);
		}
		store.removeZone(cameraId);
		audit.record({
			type: "zone-config-change",
			actorIdentityRef: null,
			detail: { cameraId, action: "remove" },
		});
		return sendJson(res, 200, { cameraId, removed: true });
	}

	/** POST /tracked/:entityId/follow — persons and vehicles only (audited). */
	async function postFollow(res, entityId, body, req) {
		await authorizeOrThrow({ req, action: "write", resource: `tracked/${entityId}` });
		const view = trackedService.get({ entityId, at: now() });
		if (!view) throw notFound(`Unknown tracked entity "${entityId}"`);
		const subscription = followService.follow({
			entityId,
			cls: view.cls,
			activeCameraId: body?.activeCameraId ?? undefined,
			actorIdentityRef: body?.actorIdentityRef ?? undefined,
		});
		return sendJson(res, 200, { subscription: { ...subscription } });
	}

	/** DELETE /tracked/:entityId/follow — release the subscription (audited). */
	async function deleteFollow(res, entityId, body, req) {
		await authorizeOrThrow({ req, action: "write", resource: `tracked/${entityId}` });
		const view = trackedService.get({ entityId, at: now() });
		if (!view) throw notFound(`Unknown tracked entity "${entityId}"`);
		const removed = followService.unfollow({ entityId, actorIdentityRef: body?.actorIdentityRef ?? undefined });
		return sendJson(res, 200, { entityId, followed: false, removed });
	}

	/**
	 * POST /association/flag — "these two are separate": build the pair's
	 * occurrence signatures (the same `${camera}:${trackId}` pairKey rule the
	 * merger consults, checked in both directions), persist them into
	 * correlation.separatePairs, land an audit row, and veto the pair live on
	 * the active merge service when one is wired.
	 */
	async function postAssociationFlag(res, body, req) {
		await authorizeOrThrow({ req, action: "write", resource: "association" });
		const fromEntityId = requireId(body?.fromEntityId, "fromEntityId");
		const toEntityId = requireId(body?.toEntityId, "toEntityId");
		if (fromEntityId === toEntityId) {
			throw invalid("association flag: the two entities must differ");
		}
		const fromChain = trackedService.get({ entityId: fromEntityId, at: now() })?.chain ?? null;
		const toChain = trackedService.get({ entityId: toEntityId, at: now() })?.chain ?? null;
		if (!fromChain) throw notFound(`Unknown entity "${fromEntityId}"`);
		if (!toChain) throw notFound(`Unknown entity "${toEntityId}"`);

		const signatures = occurrenceSignatures(fromChain, toChain);
		const existing = store.getState().correlation.separatePairs;
		const added = signatures.filter((signature) => !existing.includes(signature));
		if (added.length === 0) {
			// Explicit state changes only — a re-flag changes nothing, records nothing.
			return sendJson(res, 200, { fromEntityId, toEntityId, added: [], separatePairs: existing });
		}
		const doc = store.update((draft) => {
			for (const signature of added) draft.correlation.separatePairs.push(signature);
		});
		audit.record({
			type: "association-flag",
			actorIdentityRef: body?.actorIdentityRef ?? null,
			detail: { fromEntityId, toEntityId, signatures: added },
		});
		if (entityService) {
			for (const signature of added) entityService.vetoPair(signature);
		}
		return sendJson(res, 200, {
			fromEntityId,
			toEntityId,
			added,
			separatePairs: structuredClone(doc.correlation.separatePairs),
		});
	}

	return handle;
}

/**
 * The occurrenceSignature rule of record (src/service.js): a pair signature
 * is the sorted pairKey of the two `${camera}:${trackId}` occurrence names.
 * Built from the two entities' sightings; same-camera pairs skip (the merger
 * only unifies exit/entry tracks across cameras).
 * @param {object} fromChain PropertyEntity
 * @param {object} toChain PropertyEntity
 * @returns {string[]} deduped signatures
 */
export function occurrenceSignatures(fromChain, toChain) {
	const signatures = new Set();
	for (const fromSighting of fromChain.sightings ?? []) {
		for (const toSighting of toChain.sightings ?? []) {
			if (fromSighting.camera === toSighting.camera) continue;
			signatures.add(
				pairKey(
					`${fromSighting.camera}:${fromSighting.trackId}`,
					`${toSighting.camera}:${toSighting.trackId}`,
				),
			);
		}
	}
	return [...signatures];
}

/**
 * Build the zero-framework node:http server. The route plane is mounted at
 * /api/overwatch/* — exactly the contract's route list, nothing extra
 * (the map view IS the state read).
 *
 * @param {Parameters<typeof createOverwatchHandler>[0]} parts
 * @returns {import("node:http").Server}
 */
export function createOverwatchServer(parts) {
	const handle = createOverwatchHandler(parts);
	return httpDefault.createServer((req, res) => {
		void handle(req, res).catch(() => {
			// The handler maps its own errors; this net only guards a failure
			// after the response was consumed — keep the socket honest.
			if (!res.headersSent) sendJson(res, 500, { error: "internal error", code: "E_INTERNAL" });
			else res.destroy();
		});
	});
}
