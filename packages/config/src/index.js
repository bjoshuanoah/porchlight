// index.js — public surface of @porchlight/config (PORCH-135).
//
// createConfigService wires the console domain: YAML store, definition CRUD,
// composition (union semantics with contributor identity + overlap groups),
// speed calibration estimates, profiles with layer resolution and the
// schedule evaluator, the in-process publisher, and the HTTP server.

import { Store } from "./store.js";
import { Publisher } from "./publisher.js";
import { createZones } from "./zones.js";
import { createMasks } from "./masks.js";
import { createCameras, createBaseService } from "./baseconfig.js";
import { createSpeedService } from "./speed.js";
import { createProfileService } from "./profiles.js";
import { createScheduler } from "./scheduler.js";
import { createStorageService } from "./storage.js";
import { createComputeService } from "./compute.js";
import { createConfigServer } from "./server.js";
import { wireComputeRepoints } from "./compute.js";
import { polygonIntersectsPolygon } from "./geometry.js";

// Porchlight root default (contract): console docs land under
// <root>/config/console/.
const DEFAULT_ROOT = "/Library/Porchlight";

/**
 * Composition resolver for one camera (TS 11/12 config-compose law): zones
 * compose as a union, masks as a union of exclusions. Every definition is
 * returned with its contributor identity — overlap is never resolved as a
 * silent override; overlap groups list which enabled same-kind definitions
 * intersect (connected components with 2+ members).
 * @param {{ zones: object, masks: object }} defs
 */
function createCompose({ zones, masks }) {
	return (cameraId) => {
		const zoneDefs = zones.list(cameraId);
		const maskDefs = masks.list(cameraId);
		return {
			cameraId,
			zones: zoneDefs,
			masks: maskDefs,
			contributors: [
				...zoneDefs.map((z) => ({ kind: "zone", id: z.id, name: z.name, enabled: z.enabled })),
				...maskDefs.map((m) => ({ kind: "mask", id: m.id, name: m.name, enabled: m.enabled })),
			],
			overlaps: [
				...overlapGroups(zoneDefs, "zone"),
				...overlapGroups(maskDefs, "mask"),
				...crossKindPairs(zoneDefs, maskDefs),
			],
		};
	};
}

/** Connected-component overlap groups among enabled same-kind definitions. */
function overlapGroups(defs, kind) {
	const enabled = defs.filter((d) => d.enabled);
	const adjacent = new Map(enabled.map((_, i) => [i, new Set()]));
	for (let i = 0; i < enabled.length; i++) {
		for (let j = i + 1; j < enabled.length; j++) {
			if (polygonIntersectsPolygon(enabled[i].polygon, enabled[j].polygon)) {
				adjacent.get(i).add(j);
				adjacent.get(j).add(i);
			}
		}
	}
	const groups = [];
	const seen = new Set();
	for (let i = 0; i < enabled.length; i++) {
		if (seen.has(i)) continue;
		const component = [];
		const queue = [i];
		seen.add(i);
		while (queue.length > 0) {
			const cur = queue.pop();
			component.push(cur);
			for (const next of adjacent.get(cur) ?? []) {
				if (!seen.has(next)) {
					seen.add(next);
					queue.push(next);
				}
			}
		}
		if (component.length >= 2) {
			groups.push({ kind, ids: component.map((k) => enabled[k].id) });
		}
	}
	return groups;
}

/**
 * Zone↔mask intersection pairs. A mask excluding a region inside an enabled
 * zone is the highest-stakes composition case — it must render as an
 * inspectable overlap, never as a silent exclusion of either definition.
 */
function crossKindPairs(zoneDefs, maskDefs) {
	const enabledZones = zoneDefs.filter((d) => d.enabled);
	const enabledMasks = maskDefs.filter((d) => d.enabled);
	const groups = [];
	for (const zone of enabledZones) {
		for (const mask of enabledMasks) {
			if (polygonIntersectsPolygon(zone.polygon, mask.polygon)) {
				groups.push({ kind: "zone+mask", ids: [zone.id, mask.id] });
			}
		}
	}
	return groups;
}

/**
 * Create the config console service.
 * @param {{ root?: string, now?: () => Date, consoleDist?: string | null,
 *   recorderBase?: string }} [opts]
 *   root — Porchlight root dir (default /Library/Porchlight); docs under
 *   <root>/config/console/. now — injectable clock for the scheduler.
 *   consoleDist — static console build dir (default packages/console/dist;
 *   pass null to disable static serving).
 *   recorderBase — recorder supervisor base URL for the storage plane
 *   (default http://127.0.0.1:8971).
 * @returns {{ root, store, publisher, cameras, zones, masks, compose, speed,
 *   profiles, base, scheduler, storage, server, start(httpPort) }}
 */
export function createConfigService(opts = {}) {
	const root = opts.root ?? DEFAULT_ROOT;
	const now = opts.now ?? (() => new Date());
	const store = new Store(root);
	const publisher = new Publisher();
	const cameras = createCameras({ store });
	const zones = createZones(store);
	const masks = createMasks(store);
	const base = createBaseService({ store });
	const speed = createSpeedService({ store, cameras });
	const profiles = createProfileService({ store, publisher, now });
	const scheduler = createScheduler({ profiles, now });
	const compose = createCompose({ zones, masks });
	const storage = createStorageService({ store, recorderBase: opts.recorderBase });
	/** The engine compute posture (PORCH-152): per-stage plans + live statuses. */
	const compute = createComputeService({ store, publisher, root, fs: opts.fs, now });
	const parts = {
		store,
		publisher,
		cameras,
		zones,
		masks,
		compose,
		speed,
		profiles,
		base,
		scheduler,
		storage,
		compute,
	};
	const server = createConfigServer(parts, { consoleDist: opts.consoleDist, root, recorderBase: opts.recorderBase, probeImpl: opts.probeImpl });
	/** @type {any} */
	const service = {
		...parts,
		root,
		server,
		start: (httpPort) => start(service, httpPort),
	};
	return service;
}

export { wireComputeRepoints };

/**
 * Start the service's HTTP server on an ephemeral or fixed port.
 * Resolves { port, close() }.
 * @param {object} service a createConfigService result
 * @param {number} [httpPort] default 0 = ephemeral
 */
export async function start(service, httpPort = 0) {
	const server = service.server;
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(httpPort, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const { port } = server.address();
	return {
		port,
		close: () =>
			new Promise((resolve) => {
				// Close idle keep-alive sockets (fetch pools) so tests exit promptly.
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}
