// server.js — the People & Things REST plane (PORCH-141).
//
// Zero-framework node:http surface in the overwatch/config-plane style:
// JSON bodies, 422 { error } in plain language, 404 unknown resources, no
// CORS, no cookies. Routes stay thin — every behavior lives in the injected
// services; unknown method/path falls through to the plain 404.
//
// Route prefix: /api/recognition/*.
//
// `services` — the design of record (all required):
//   {
//     registry:    createRegistryService({ store, audit }) — entries, the
//                  recognition switch of record, annotations, purge, export
//     recognition: createRecognitionService({ registry, pipeline }) —
//                  enrollment, gallery match, metric counters
//   }
//
// `authorize` — the owner seam of record. Null (tests) = allow-all. When
// provided, called as `authorize({ req, action, resource })`:
//   action   "read" (GET) | "write" (PUT/POST/PATCH/DELETE)
//   resource one of "settings" | "entries" | `entries/<entryId>` |
//            "export" | "metrics" | "annotations"
//   Returns truthy to allow. Falsy denies with 403 E_NOT_PERMITTED. Thrown
//   errors pass through as the transport's own refusal (status/code ride
//   err.status / err.code).
//
// Biometric privacy law reflected here: exports ride an explicit GET the
// household itself performs; nothing on this plane pushes artifacts off the
// hub, and the Tier-2 egress policy is off by default.

import httpDefault from "node:http";
import { RegistryError } from "./registry.js";
import { assertFrame } from "./types.js";

/** Request body cap. Enrollment uploads ride base64 JPEG frames; 10 MiB. */
const MAX_BODY_BYTES = 10_000_000;

/** Service error codes of record ride their own transport status. */
const SERVICE_ERROR_STATUS = {
	E_RECOGNITION_DISABLED: 409,
};

/**
 * Plain-language transport error: 422 E_INVALID shape by default; use the
 * factories below instead of instantiating codes ad hoc.
 */
export class RecognitionHttpError extends Error {
	/**
	 * @param {string} message
	 * @param {{ status?: number, code?: string }} [options]
	 */
	constructor(message, { status = 422, code = "E_INVALID" } = {}) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

/** @param {string} message */
function invalid(message) {
	return new RecognitionHttpError(message, { status: 422, code: "E_INVALID" });
}

/** @param {string} message */
function notFound(message) {
	return new RecognitionHttpError(message, { status: 404, code: "E_NOT_FOUND" });
}

function sendJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

/**
 * Read + parse a JSON request body; `{}` when empty; plain-language 422s.
 * @param {import("node:http").IncomingMessage} req
 * @param {{ body?: object | null }} prepared
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

/** @param {string | undefined} id @param {string} what */
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
 * Decode the enrollment frames a request carries (base64 in JSON).
 * @param {unknown} raw
 * @returns {import("./types.js").RecognitionFrame[]}
 */
function decodeFrames(raw) {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) throw invalid("frames must be an array of { format, data } images");
	return raw.map((entry) => {
		if (!entry || typeof entry !== "object" || typeof entry.data !== "string") {
			throw invalid('each frame carries { format: "jpeg" | "rgba", data: <base64> }');
		}
		let bytes;
		try {
			bytes = Buffer.from(entry.data, "base64");
		} catch {
			throw invalid("frame data must be base64");
		}
		if (bytes.byteLength === 0) throw invalid("frame data must be base64");
		const frame = {
			format: entry.format === "rgba" ? "rgba" : "jpeg",
			data: new Uint8Array(bytes),
			...(isFiniteNumber(entry.w) ? { w: entry.w } : {}),
			...(isFiniteNumber(entry.h) ? { h: entry.h } : {}),
			...(isFiniteNumber(entry.t) ? { t: entry.t } : {}),
		};
		assertFrame(frame);
		return frame;
	});
}

/**
 * Build the People & Things route plane. The returned async handler speaks
 * plain node:http primitives, fully self-mapping its errors, so the
 * zero-framework server and the hub's Express adapter behave identically.
 *
 * @param {{
 *   services: {
 *     registry: object,
 *     recognition: object,
 *   },
 *   authorize?: ((args: { req: unknown, action: string, resource: string }) => Promise<boolean|unknown>|boolean|unknown) | null,
 *   log?: ((line: string) => void) | null,
 * }} parts
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, prepared?: { body?: object | null }) => Promise<void>}
 */
export function createRecognitionHandler({ services, authorize = null, log = null }) {
	const { registry, recognition } = services;
	for (const [name, service] of Object.entries({ registry, recognition })) {
		if (!service) throw new TypeError(`createRecognitionHandler: services.${name} is required`);
	}

	/**
	 * The authorize seam: truthy allows; falsy denies 403; thrown errors are
	 * the adapter's own typed refusal (401-style) and pass through. The
	 * homeId the homeId-scoped resources authorize against is resolved by
	 * the plane itself (query param or, on writes, the enrollment body) —
	 * the adapter owns the bearer → did + home-owner translation.
	 * @param {{ req: unknown, action: string, resource: string, homeId?: string | null }} args
	 */
	async function authorizeOrThrow(args) {
		if (authorize == null) return;
		let granted;
		try {
			granted = await authorize(args);
		} catch (error) {
			const status = Number(error?.status) || 403;
			throw new RecognitionHttpError(String(error?.message ?? "E_NOT_PERMITTED"), {
				status,
				code: String(error?.code ?? "E_NOT_PERMITTED"),
			});
		}
		if (!granted) throw new RecognitionHttpError("E_NOT_PERMITTED", { status: 403, code: "E_NOT_PERMITTED" });
	}

	async function handle(req, res, prepared = {}) {
		try {
			await dispatch(req, res, prepared);
		} catch (error) {
			if (error instanceof RecognitionHttpError) {
				return sendJson(res, error.status, { error: error.message, code: error.code });
			}
			if (error instanceof RegistryError) {
				const status = SERVICE_ERROR_STATUS[error.code] ?? (error.status === 404 ? 404 : 422);
				const code = error.code === "E_RECOGNITION_DISABLED" ? "E_RECOGNITION_DISABLED" : error.status === 404 ? "E_NOT_FOUND" : "E_INVALID";
				return sendJson(res, status, { error: error.message, code });
			}
			// Typed shape refusals (plain-language TypeErrors carrying their own
			// status) ride that status; anything else stays generic.
			if (typeof error?.status === "number") {
				return sendJson(res, error.status, { error: error.message, code: error.code ?? "E_INVALID" });
			}
			// Unexpected: the operator log gets the detail, the client stays generic.
			(log ?? console.error)?.(`[recognition] internal error: ${error?.stack ?? error}`);
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
		if (segments[0] !== "api" || segments[1] !== "recognition") {
			throw notFound("not found");
		}
		const r = segments.slice(2);
		const needsBody = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
		const body = needsBody ? await readJsonBody(req, prepared) : undefined;
		// The home authorization target: the query param, or on writes the
		// enrollment body (POST carries homeId there). Entries routes accept
		// it either way; the adapter owns the owner-seam translation.
		const authHomeId = url.searchParams.get("homeId")
			?? (body && typeof body === "object" && !Array.isArray(body) && typeof body.homeId === "string" ? body.homeId : null);

		// ---- the recognition switch of record (ac-6) ----
		if (r[0] === "settings" && r.length === 1) {
			const homeId = url.searchParams.get("homeId") ?? "";
			if (method === "GET") {
				await authorizeOrThrow({ req, homeId: authHomeId, action: "read", resource: "settings" });
				return sendJson(res, 200, { settings: await registry.settingsOf(homeId) });
			}
			if (method === "PUT") {
				await authorizeOrThrow({ req, homeId: authHomeId, action: "write", resource: "settings" });
				if (typeof body.enabled !== "boolean" && body.assertThreshold === undefined) {
					throw invalid("settings: the switch of record is enabled: true | false (or a calibrated assertThreshold)");
				}
				if (typeof body.enabled === "boolean") {
					await registry.setEnabled({ homeId, enabled: body.enabled, actorDid: body.actorDid ?? null });
				}
				if (body.assertThreshold !== undefined) {
					await registry.setThreshold({ homeId, assertThreshold: body.assertThreshold, actorDid: body.actorDid ?? null });
				}
				return sendJson(res, 200, { settings: await registry.settingsOf(homeId) });
			}
		}

		// ---- the registry entries (ac-1/ac-3) ----
		if (r[0] === "entries") {
			if (r.length === 1 && method === "GET") {
				await authorizeOrThrow({ req, homeId: authHomeId, action: "read", resource: "entries" });
				const homeId = url.searchParams.get("homeId") ?? "";
				const kind = url.searchParams.get("kind") ?? undefined;
				if (kind !== undefined && kind !== "face" && kind !== "vehicle") {
					throw invalid('entries: kind is "face" or "vehicle"');
				}
				const entries = await registry.listEntries(homeId, kind);
				return sendJson(res, 200, { entries, count: entries.length });
			}
			if (r.length === 1 && method === "POST") {
				await authorizeOrThrow({ req, homeId: authHomeId, action: "write", resource: "entries" });
				const entry = await recognition.enroll({
					homeId: /** @type {string} */ (body.homeId ?? url.searchParams.get("homeId") ?? ""),
					kind: body.kind,
					name: body.name,
					frames: decodeFrames(body.frames),
					plateText: body.plateText,
					enrolledFor: body.enrolledFor,
					accountabilityNote: body.accountabilityNote,
					actorDid: body.actorDid ?? null,
				});
				return sendJson(res, 201, { entry });
			}
			if (r.length === 2) {
				const entryId = requireId(r[1], "entry id");
				if (method === "GET") {
					await authorizeOrThrow({ req, homeId: authHomeId, action: "read", resource: `entries/${entryId}` });
					return sendJson(res, 200, {
						entry: await registry.getEntry(url.searchParams.get("homeId") ?? "", entryId),
					});
				}
				if (method === "PATCH") {
					await authorizeOrThrow({ req, homeId: authHomeId, action: "write", resource: `entries/${entryId}` });
					return sendJson(res, 200, {
						entry: await registry.updateEntry({
							homeId: url.searchParams.get("homeId") ?? "",
							entryId,
							name: body.name,
							plateText: body.plateText,
						}),
					});
				}
				if (method === "DELETE") {
					await authorizeOrThrow({ req, homeId: authHomeId, action: "write", resource: `entries/${entryId}` });
					const purged = await registry.purgeEntry({
						homeId: url.searchParams.get("homeId") ?? "",
						entryId,
						actorDid: body.actorDid ?? null,
					});
					return sendJson(res, 200, purged);
				}
			}
		}

		// ---- the household's export (ac-3 privacy: the household owns its data) ----
		if (r[0] === "export" && r.length === 1 && method === "GET") {
			await authorizeOrThrow({ req, homeId: authHomeId, action: "read", resource: "export" });
			const homeId = url.searchParams.get("homeId") ?? "";
			const bundle = await registry.exportRegistry(homeId);
			res.writeHead(200, {
				"content-type": "application/json; charset=utf-8",
				"content-disposition": `attachment; filename="porchlight-registry-${requireId(homeId, "home id")}.json"`,
			});
			res.end(JSON.stringify(bundle, null, 2));
			return;
		}

		// ---- the zero-computation audit surface (ac-4) ----
		if (r[0] === "metrics" && r.length === 1 && method === "GET") {
			await authorizeOrThrow({ req, homeId: authHomeId, action: "read", resource: "metrics" });
			return sendJson(res, 200, { metrics: recognition.metrics() });
		}

		// ---- by-reference annotations (event/entity/track/visit surfaces) ----
		if (r[0] === "annotations" && r.length === 1 && method === "GET") {
			await authorizeOrThrow({ req, homeId: authHomeId, action: "read", resource: "annotations" });
			const homeId = url.searchParams.get("homeId") ?? "";
			const annotations = await registry.listAnnotations({
				homeId,
				entryId: url.searchParams.get("entryId") ?? undefined,
				targetKind: url.searchParams.get("targetKind") ?? undefined,
				targetId: url.searchParams.get("targetId") ?? undefined,
				cameraId: url.searchParams.get("cameraId") ?? undefined,
				trackId: url.searchParams.get("trackId") ?? undefined,
			});
			return sendJson(res, 200, { annotations, count: annotations.length });
		}

		throw notFound("not found");
	}

	return handle;
}

/**
 * Build the zero-framework node:http server. The route plane is mounted at
 * the given prefix; the tests use it directly.
 *
 * @param {{
 *   services: object,
 *   authorize?: object | null,
 *   log?: ((line: string) => void) | null,
 *   port?: number,
 *   host?: string,
 * }} parts
 */
export function createRecognitionServer(parts) {
	const handler = createRecognitionHandler({ services: parts.services, authorize: parts.authorize ?? null, log: parts.log ?? null });
	const server = httpDefault.createServer((req, res) => {
		void handler(req, res).catch(() => {
			if (!res.writableEnded) sendJson(res, 500, { error: "internal error", code: "E_INTERNAL" });
		});
	});
	server.listen(parts.port ?? 0, parts.host ?? "127.0.0.1");
	return { server, handler };
}
