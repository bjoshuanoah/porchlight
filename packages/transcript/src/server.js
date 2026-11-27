// server.js — the transcript REST surface of record (PORCH-155). Hand-rolled
// node:http handlers in the config-server style (repo convention: zero
// framework deps; plain-language 422/404; no CORS, no analytics). The
// handlers mount in the config console server as an injected part (the
// console talks only to its own same-origin /api — the config service owns
// that origin), and run standalone in tests.
//
// Surfaces:
//   GET    /api/transcription/method         the method doc of record (3 scopes)
//   PUT    /api/transcription/method         replace scopes (validated, live)
//   GET    /api/transcription/method/inspect?cameraId=&type=  effective method + winning layer
//   GET    /api/transcription/status         the stage's never-silent posture
//   GET    /api/transcripts?cameraId=&sourceType=&limit=      stored records (explicit states)
//   POST   /api/transcripts/search           semantic audio search ("find where someone said X")
//   GET    /api/transcripts/cascade/audit    orphan-check posture (countable)

import { ValidationError } from "./types.js";
import { createTranscriptCascade } from "./cascade.js";

const MAX_BODY_BYTES = 1_000_000;

/**
 * @param {import("./service.js").TranscriptionService} service
 * @returns {{ handle: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, method: string, segments: string[], url: URL) => Promise<boolean> }}
 */
export function createTranscriptRoutes(service) {
	if (!service || typeof service.inspectMethod !== "function") {
		throw new ValidationError("createTranscriptRoutes: a TranscriptionService is required");
	}
	const cascade = createTranscriptCascade({ store: service.store, vectorStore: service.vectorStore, log: service.log });

	/**
	 * The compute applier entry the config plane wires (PORCH-155): a
	 * Models/Compute re-point of the transcription stage applies live to the
	 * service's provider cache — no restart.
	 * @returns {{generation: number}}
	 */
	const repoint = () => (service.repoint(), { generation: service.generation() });

	/** @param {import("node:http").ServerResponse} res @param {number} code @param {unknown} body */
	function sendJson(res, code, body) {
		if (res.headersSent) return;
		res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify(body));
	}

	/** @param {import("node:http").IncomingMessage} req @returns {Promise<unknown>} */
	function readJsonBody(req) {
		return new Promise((resolve, reject) => {
			const chunks = [];
			let size = 0;
			req.on("data", (c) => {
				size += c.length;
				if (size > MAX_BODY_BYTES) {
					reject(new ValidationError("request body too large"));
					req.destroy();
					return;
				}
				chunks.push(c);
			});
			req.on("end", () => {
				if (chunks.length === 0) return resolve(null);
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				} catch {
					reject(new ValidationError("request body is not valid JSON"));
				}
			});
			req.on("error", reject);
		});
	}

	return {
		repoint,
		/**
		 * @returns {Promise<boolean>} true when the request belonged here
		 */
		async handle(req, res, method, segments, url) {
			// segments are relative to /api (the config server strips "api").
			if (segments[0] === "transcription" || segments[0] === "transcripts") {
				return this.dispatch(req, res, method, segments, url);
			}
			return false;
		},

		/** @returns {Promise<boolean>} */
		async dispatch(req, res, method, segments, url) {
			const s = segments[0] === "transcription"
				? segments.slice(1)
				: ["transcripts", ...segments.slice(1)];

			if (s[0] === "method") {
				if (s.length === 1 && method === "GET") {
					return sendJson(res, 200, service.methodDoc()), true;
				}
				if (s.length === 1 && method === "PUT") {
					const body = await readJsonBody(req);
					return sendJson(res, 200, { method: service.setMethodDoc(body) }), true;
				}
				if (s.length === 2 && s[1] === "inspect" && method === "GET") {
					const cameraId = url.searchParams.get("cameraId");
					const type = url.searchParams.get("type");
					if (!cameraId) throw new ValidationError("cameraId: required — inspection is per camera (the layer-visibility pattern needs the camera's own scope)");
					if (type !== "rolling" && type !== "event") throw new ValidationError("type: must be one of rolling, event");
					return sendJson(res, 200, service.inspectMethod(cameraId, type)), true;
				}
			}

			if (s[0] === "status" && s[1] === undefined && method === "GET") {
				return sendJson(res, 200, service.status()), true;
			}

			if (s[0] === "transcripts") {
				if (s.length === 1 && method === "GET") {
					const limitRaw = url.searchParams.get("limit");
					const limit = limitRaw === null ? undefined : Number(limitRaw);
					if (limitRaw !== null && (!Number.isInteger(limit) || /** @type {number} */ (limit) <= 0)) {
						throw new ValidationError("limit: must be a positive integer");
					}
					const sourceType = url.searchParams.get("sourceType");
					if (sourceType !== null && sourceType !== "rolling" && sourceType !== "event") {
						throw new ValidationError("sourceType: must be one of rolling, event");
					}
					return sendJson(res, 200, {
						records: service.store.list({
							cameraId: url.searchParams.get("cameraId") ?? undefined,
							sourceType: sourceType ?? undefined,
							limit,
						}),
					}), true;
				}
				if (s.length === 2 && s[1] === "search" && method === "POST") {
					const body = /** @type {any} */ (await readJsonBody(req));
					const results = await service.search(body?.query, {
						k: body?.k,
						cameraId: body?.cameraId,
						sourceType: body?.sourceType,
					});
					return sendJson(res, 200, { results }), true;
				}
				if (s.length === 3 && s[1] === "cascade" && s[2] === "audit" && method === "GET") {
					return sendJson(res, 200, cascade.audit()), true;
				}
			}

			throw new ValidationError(`no such transcription surface: ${method} /api/${segments.join("/")}`);
		},
	};
}
