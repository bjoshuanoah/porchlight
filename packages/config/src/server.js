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
import { validateStreamUrl } from "./stream-validate.js";
import { registerStreamCamera, requireStreamUrl } from "./engine-cameras.js";

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
	const { cameras, zones, masks, compose, speed, profiles, base, scheduler, storage, compute } = parts;
	const consoleDist = opts.consoleDist === undefined ? defaultConsoleDistPath() : opts.consoleDist;
	const probeImpl = opts.probeImpl ?? validateStreamUrl;
	const root = opts.root ?? null;
	const recorderBase = opts.recorderBase ?? "http://127.0.0.1:8971";

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
		// Engine guest-surface guarantee (PORCH-152 ac-4): a camera-view engine
		// token (the "peng1." family minted by the home bridge) is definitionally
		// NOT an admin credential. Presenting one anywhere on this admin plane
		// refuses in plain language — the engine's side of the family/guest/admin
		// boundary; guest members are also refused upstream at the hub.
		if (segments[0] === "api") {
			const auth = req.headers.authorization ?? "";
			if (auth.startsWith("peng1.")) {
				return sendJson(res, 403, { error: "This surface belongs to the deployment's administrators — camera-view sessions never carry NVR/admin access." });
			}
			return handleApi(req, res, method, segments.slice(1), url);
		}
		return handleEngineSeam(req, res, method, segments, url);
	}

	/**
	 * The hub-facing engine seams (PORCH-I-009 TS 7 landing, PORCH-152): the
	 * paths the hub's HttpEngineAdapter already calls, now served by the
	 * engine. /live, /segments, /segment, /evidence stay unimplemented — the
	 * stream-serving plane lands with the stream manager (PORCH-154/155) and
	 * the adapter answers those gaps in plain language for now.
	 */
	async function handleEngineSeam(req, res, method, segments, url) {
		if (segments[0] === "cameras") {
			if (segments.length === 1 && method === "POST") {
				const body = await readJsonBody(req);
				const streamUrl = requireStreamUrl(body);
				return sendJson(res, 200, await registerStreamCamera({
					root, url: streamUrl, cameras, recorderBase,
				}));
			}
			if (segments.length === 2 && method === "GET") {
				const cameraId = requireId(segments[1]);
				return sendJson(res, 200, await engineCameraHealth(cameraId));
			}
		}
		if (segments[0] === "service" && segments.length === 1 && method === "GET") {
			return sendJson(res, 200, await proxySupervisorJson("/health", { map: supervisorServiceView }));
		}
		if (segments[0] === "storage" && segments.length === 1 && method === "GET") {
			return sendJson(res, 200, await proxySupervisorJson("/api/storage", { map: supervisorStorageView }));
		}
		return handleStatic(req, res, method, url.pathname);
	}

	/** The recorder supervisor health plane is loopback + same host by contract. */
	async function proxySupervisorJson(path, { map }) {
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 3000);
			const response = await fetch(`${recorderBase.replace(/\/+$/, "")}${path}`, { signal: controller.signal });
			clearTimeout(timer);
			const body = await response.json();
			return map(body);
		} catch {
			return { state: "unavailable", detail: "the recorder supervisor isn't reachable" };
		}
	}

	function supervisorServiceView(body) {
		if (!body || typeof body !== "object") return { state: "unavailable", detail: null };
		return {
			state: body.health === "ok" && !body.stopping ? "ok" : "degraded",
			detail: body.stopping ? "the recorder is shutting down" : `recording ${Array.isArray(body.cameras) ? body.cameras.length : 0} camera(s)`,
		};
	}

	function supervisorStorageView(body) {
		if (!body || typeof body !== "object") return { state: "unavailable", detail: null };
		return { state: body.state ?? "unknown", detail: body.reason ?? (body.activeLocation ? `recording to ${body.activeLocation}` : null) };
	}

	/** The health planes of a camera (PORCH-I-009 health contract; the audio
	 * plane joins in PORCH-153). The DETECTION plane maps the detection
	 * stage's compute status; the AUDIO plane first consults the camera's
	 * audioDetectionEnabled knob (off by default) — a disabled camera states
	 * its own disabled plane, and an enabled one reports the audio stage's
	 * never-silent posture with its explained reason. */
	async function engineCameraHealth(cameraId) {
		const detection = parts.compute.statusOf("detection");
		const detectionView = detection.state === "unknown"
			? { state: "unavailable", detail: detection.reason }
			: { state: detection.state, detail: detection.reason };
		const audioView = await audioPlaneFor(cameraId);
		const playback = { state: "unavailable", detail: "stream serving lands with the stream manager (PORCH-154)" };
		const body = await fetchSupervisorHealth();
		if (!body) {
			return {
				recording: { state: "unavailable", detail: "the recorder supervisor isn't reachable" },
				playback,
				detection: detectionView,
				audio: audioView,
			};
		}
		const cams = Array.isArray(body.cameras) ? body.cameras : [];
		const cam = cams.find((/** @type {any} */ c) => (c.name ?? c.camera) === cameraId);
		if (!cam) throw new NotFoundError(`unknown camera "${cameraId}"`);
		return {
			recording: { state: cam.state ?? "unknown", detail: cam.reason ?? null },
			playback,
			detection: detectionView,
			audio: audioView,
		};
	}

	/**
	 * The audio plane of one camera (PORCH-153 ac-4's explained-state
	 * surface): disabled (knob off), or the audio-classification stage's
	 * never-silent status mapped onto the health contract — native stays ok,
	 * cpu/degraded/failed stay degraded WITH their reason verbatim, unknown
	 * reads unavailable.
	 */
	async function audioPlaneFor(cameraId) {
		let enabled = false;
		try {
			const inspected = /** @type {any} */ (parts.profiles).inspectKnobs(cameraId);
			enabled = inspected?.knobs?.audioDetectionEnabled?.value === true;
		} catch {
			enabled = false;
		}
		if (!enabled) return { state: "disabled", detail: null };
		const status = parts.compute.statusOf("audio-classification");
		if (status.state === "unknown") {
			return { state: "unavailable", detail: status.reason };
		}
		if (status.state === "native") {
			return { state: "ok", detail: status.reason };
		}
		return { state: "degraded", detail: status.reason };
	}

	async function fetchSupervisorHealth() {
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 3000);
			const response = await fetch(`${recorderBase.replace(/\/+$/, "")}/health`, { signal: controller.signal });
			clearTimeout(timer);
			return await response.json();
		} catch {
			return null;
		}
	}

	async function handleApi(req, res, method, r, url) {
		// `r` is the path after /api. Routes mirror the PORCH-135 contract table
		// exactly — no invented endpoints.
		const body = method === "POST" || method === "PUT" ? await readJsonBody(req) : undefined;

		if (r.length === 1 && r[0] === "health") {
			if (method === "GET") return sendJson(res, 200, { ok: true, service: "config" });
		}

		// Compute posture (PORCH-152): the Models/Compute settings surface —
		// per-stage plans, source layers, never-silent statuses; PUT re-points
		// live (publisher event), DELETE restores the setup/built-in layer.
		if (r[0] === "compute" && r[1] === "stages") {
			if (r.length === 2 && method === "GET") return sendJson(res, 200, { stages: compute.list() });
			if (r.length === 3) {
				const stage = requireId(r[2]);
				if (method === "GET") return sendJson(res, 200, compute.detail(stage));
				if (method === "PUT") return sendJson(res, 200, compute.repoint(stage, body));
				if (method === "DELETE") return sendJson(res, 200, compute.reset(stage));
			}
		}

		if (r[0] === "cameras") {
			if (r.length === 1) {
				if (method === "GET") return sendJson(res, 200, cameras.list());
			} else if (r.length === 2) {
				if (method === "POST" && r[1] === "validate") {
					return sendJson(res, 200, await probeImpl({ url: requireStreamUrl(body) }));
				}
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
