// server.js — node:http REST surface for the config console (PORCH-135).
//
// Small hand-rolled router (repo convention: zero framework deps). JSON
// bodies; validation failures are 422 { error } in plain language; unknown
// resources 404; no CORS, no cookies, no analytics. When the console build
// exists (packages/console/dist) it is served at / with SPA fallback.

import httpDefault from "node:http";
import fsDefault from "node:fs";
import pathDefault from "node:path";
import { fileURLToPath } from "node:url";
import { NotFoundError, ValidationError, assertId } from "./types.js";
import { renderTestPattern } from "./snapshot.js";

const MIME_TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json",
	".map": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

// Vite emits hashed assets like `index-B3xY2qP1.js`; those are safe to pin
// at the edge for a year (immutable). HTML gets no cache headers.
const HASHED_ASSET_RE = /-[A-Za-z0-9_-]{6,}\.[A-Za-z0-9]+$/;
const MAX_BODY_BYTES = 1_000_000;

/** Default console dist (repo layout: packages/config/src → packages/console/dist). */
export function defaultConsoleDistPath() {
	return pathDefault.resolve(pathDefault.dirname(fileURLToPath(import.meta.url)), "..", "..", "console", "dist");
}

function sendJson(res, status, body) {
	if (res.headersSent) return;
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

/** Read + parse a JSON request body; `{}` when empty; plain-language 422s. */
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new ValidationError("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			if (raw.trim() === "") return resolve({});
			try {
				resolve(JSON.parse(raw));
			} catch {
				reject(new ValidationError("request body is not valid JSON"));
			}
		});
		req.on("error", reject);
	});
}

/**
 * Build the config console HTTP server.
 * @param {object} parts service parts: { cameras, zones, masks, compose, speed, profiles, base, scheduler, storage }
 * @param {{ consoleDist?: string | null }} [opts] static console dist override (null disables)
 */
export function createConfigServer(parts, opts = {}) {
	const { cameras, zones, masks, compose, speed, profiles, base, scheduler, storage } = parts;
	const consoleDist = opts.consoleDist === undefined ? defaultConsoleDistPath() : opts.consoleDist;

	const server = httpDefault.createServer((req, res) => {
		handle(req, res).catch((err) => {
			if (err instanceof ValidationError) return sendJson(res, 422, { error: err.message });
			if (err instanceof NotFoundError) return sendJson(res, 404, { error: err.message });
			// Unexpected: operator log gets the detail, the client stays generic.
			console.error("[config] internal error:", err);
			sendJson(res, 500, { error: "internal error" });
		});
	});

	async function handle(req, res) {
		const url = new URL(req.url ?? "/", "http://localhost");
		const segments = url.pathname.split("/").filter(Boolean).map((s) => {
			try {
				return decodeURIComponent(s);
			} catch {
				return s;
			}
		});
		const method = req.method ?? "GET";
		if (segments[0] === "api") return handleApi(req, res, method, segments.slice(1), url);
		return handleStatic(req, res, method, url.pathname);
	}

	async function handleApi(req, res, method, r, url) {
		// `r` is the path after /api. Routes mirror the PORCH-135 contract table
		// exactly — no invented endpoints.
		const body = method === "POST" || method === "PUT" ? await readJsonBody(req) : undefined;

		if (r.length === 1 && r[0] === "health") {
			if (method === "GET") return sendJson(res, 200, { ok: true, service: "config" });
		}

		if (r[0] === "cameras") {
			if (r.length === 1) {
				if (method === "GET") return sendJson(res, 200, cameras.list());
			} else if (r.length === 2) {
				const cameraId = requireId(r[1]);
				if (method === "PUT") return sendJson(res, 200, cameras.upsert(cameraId, body));
			} else if (r.length === 3) {
				const cameraId = requireId(r[1]);
				if (method === "GET" && r[2] === "zones") return sendJson(res, 200, zones.list(cameraId));
				if (method === "POST" && r[2] === "zones") return sendJson(res, 201, zones.create(cameraId, body));
				if (method === "GET" && r[2] === "masks") return sendJson(res, 200, masks.list(cameraId));
				if (method === "POST" && r[2] === "masks") return sendJson(res, 201, masks.create(cameraId, body));
				if (method === "GET" && r[2] === "composition") return sendJson(res, 200, compose(cameraId));
				if (method === "GET" && r[2] === "snapshot") return handleSnapshot(res, cameraId, url);
				if (method === "GET" && r[2] === "speed") return sendJson(res, 200, speed.get(cameraId));
				if (method === "PUT" && r[2] === "speed") {
					if (!cameras.get(cameraId)) throw new NotFoundError(`unknown camera "${cameraId}"`);
					return sendJson(res, 200, speed.set(cameraId, body));
				}
			} else if (r.length === 4) {
				const cameraId = requireId(r[1]);
				if (method === "POST" && r[2] === "speed" && r[3] === "test") {
					if (!cameras.get(cameraId)) throw new NotFoundError(`unknown camera "${cameraId}"`);
					return sendJson(res, 200, speed.estimate(cameraId, body?.track));
				}
				if (method === "POST" && r[2] === "record") {
					return sendJson(res, 200, await storage.trigger(cameraId, r[3]));
				}
			}
		}

		if (r[0] === "storage") {
			if (r.length === 1) {
				if (method === "GET") return sendJson(res, 200, await storage.status());
				if (method === "PUT") return sendJson(res, 201, storage.configure(body));
			}
			if (r.length === 2 && r[1] === "test" && method === "POST") {
				return sendJson(res, 200, storage.testLocation(body?.location));
			}
			if (r.length === 2 && r[1] === "failback" && method === "POST") {
				return sendJson(res, 200, await storage.failback());
			}
			if (r[1] === "rules") {
				if (r.length === 2) {
					if (method === "GET") return sendJson(res, 200, storage.listRules());
					if (method === "POST") return sendJson(res, 201, storage.addRule(body));
				} else if (r.length === 3) {
					const ruleId = requireId(r[2]);
					if (method === "PUT") return sendJson(res, 200, storage.updateRule(ruleId, body));
					if (method === "DELETE") {
						storage.removeRule(ruleId);
						return sendJson(res, 200, { ok: true });
					}
				}
			}
		}

		if ((r[0] === "zones" || r[0] === "masks") && r.length === 2) {
			const service = r[0] === "zones" ? zones : masks;
			const id = requireId(r[1]);
			if (method === "PUT") return sendJson(res, 200, service.update(id, body));
			if (method === "DELETE") {
				service.remove(id);
				return sendJson(res, 200, { ok: true });
			}
		}

		if (r[0] === "profiles") {
			if (r.length === 1) {
				if (method === "GET") return sendJson(res, 200, profiles.list());
				if (method === "POST") return sendJson(res, 201, profiles.create(body));
			} else if (r.length === 2) {
				const profileId = requireId(r[1]);
				if (method === "PUT") return sendJson(res, 200, profiles.update(profileId, body));
				if (method === "DELETE") {
					profiles.remove(profileId);
					return sendJson(res, 200, { ok: true });
				}
			} else if (r.length === 3 && r[2] === "activate" && method === "POST") {
				return sendJson(res, 200, profiles.activate(requireId(r[1]), "manual"));
			}
		}

		if (r[0] === "config") {
			if (r.length === 2 && r[1] === "base") {
				if (method === "GET") return sendJson(res, 200, base.getAll());
				if (method === "PUT") {
					assertConfigBasePayload(body);
					const applied = {};
					for (const scopeKey of Object.keys(body)) {
						applied[scopeKey] = base.setScope(scopeKey, body[scopeKey]);
					}
					return sendJson(res, 200, applied);
				}
			}
			if (r.length === 2 && r[1] === "knobs" && method === "GET") {
				const cameraId = url.searchParams.get("cameraId");
				if (!cameraId) throw new ValidationError("knobs: cameraId query parameter is required");
				return sendJson(res, 200, profiles.inspectKnobs(cameraId));
			}
			if (r.length === 2 && r[1] === "active" && method === "GET") {
				return sendJson(res, 200, profiles.activeState());
			}
			if (r.length === 2 && r[1] === "tick" && method === "POST") {
				if (body?.now === undefined) throw new ValidationError("tick: body must be { now: \"ISO timestamp\" }");
				return sendJson(res, 200, scheduler.tick(body.now));
			}
		}

		throw new NotFoundError(`no route for ${method} ${url.pathname}`);
	}

	function handleSnapshot(res, cameraId, url) {
		const camera = cameras.get(cameraId);
		if (!camera) throw new NotFoundError(`unknown camera "${cameraId}"`);
		if (camera.snapshotUrl) {
			// Real source: redirect straight to it.
			res.writeHead(302, { location: camera.snapshotUrl });
			res.end();
			return;
		}
		const w = queryPositiveInt(url, "w") ?? camera.width;
		const h = queryPositiveInt(url, "h") ?? camera.height;
		const svg = renderTestPattern({ id: camera.id, name: camera.name, width: w, height: h });
		res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8" });
		res.end(svg);
	}

	function handleStatic(req, res, method, pathname) {
		if (method !== "GET" && method !== "HEAD") {
			return sendJson(res, 404, { error: "not found" });
		}
		// null disables static serving (tests without a console build).
		if (!consoleDist || !fsDefault.existsSync(consoleDist)) {
			return sendJson(res, 404, { error: "not found" });
		}
		const rootDir = pathDefault.resolve(consoleDist);
		let rel;
		try {
			rel = decodeURIComponent(pathname);
		} catch {
			rel = pathname;
		}
		rel = rel === "/" ? "/index.html" : rel;
		const file = pathDefault.resolve(rootDir, "." + rel);
		if (file !== rootDir && !file.startsWith(rootDir + pathDefault.sep)) {
			// Containment check runs on the DECODED path, so /..%2F stays out.
			return sendJson(res, 404, { error: "not found" });
		}
		if (fsDefault.existsSync(file) && fsDefault.statSync(file).isFile()) {
			return sendStaticFile(res, file);
		}
		// SPA fallback: unknown client paths render the shell.
		const indexFile = pathDefault.join(rootDir, "index.html");
		if (fsDefault.existsSync(indexFile) && fsDefault.statSync(indexFile).isFile()) {
			return sendStaticFile(res, indexFile);
		}
		return sendJson(res, 404, { error: "not found" });
	}

	function sendStaticFile(res, file) {
		const ext = pathDefault.extname(file).toLowerCase();
		const headers = { "content-type": MIME_TYPES[ext] ?? "application/octet-stream" };
		// No cache headers for html; immutable only for hashed assets.
		if (ext !== ".html" && HASHED_ASSET_RE.test(pathDefault.basename(file))) {
			headers["cache-control"] = "public, max-age=31536000, immutable";
		}
		res.writeHead(200, headers);
		fsDefault.createReadStream(file).pipe(res);
	}

	function queryPositiveInt(url, key) {
		const raw = url.searchParams.get(key);
		if (raw === null) return undefined;
		const value = Number(raw);
		if (!Number.isInteger(value) || value <= 0) {
			throw new ValidationError(`snapshot: ${key} must be a positive integer`);
		}
		return value;
	}

	function requireId(id) {
		return assertId(id, "path id");
	}

	/** PUT /api/config/base payload: { "_default": {knobs}, <cameraId>: {knobs} }. */
	function assertConfigBasePayload(body) {
		if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length === 0) {
			throw new ValidationError("base config: expected an object with `_default` and/or per-camera scope keys");
		}
	}

	return server;
}
