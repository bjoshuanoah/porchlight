// compute.js — the engine compute posture (PORCH-152).
//
// Per-stage model selection of record (PORCH-I-009 TS 1 / TS 5): every ML
// stage (detection, event description, audio classification, transcription,
// Overwatch evaluation, embedding) resolves to a stage plan under the
// InferenceProvider protocol. The stage list and provider classes are CLOSED
// enums — the Models/Compute settings surface re-points stages, and the
// switch applies live through the config Publisher (no restart, TS 12 live
// apply law; nothing here re-instantiates processes).
//
// Layer law (config-compose, never override): effective plan = highest
// non-empty layer of admin (compute.yaml, the console's Models/Compute
// edits) → setup (the platform config of record's compute.stages, written by
// the bootstrap) → built-in plan. Every reader returns the resolved value
// WITH its source layer, so inspection always shows which layer wins.
//
// Status law (never-silent): stages report their compute posture through
// registerStatus(); an unregistered stage renders "unknown" — an explorable
// state, never a silent blank. A throwing reporter renders "failed" with the
// error verbatim.

import fsDefault from "node:fs";
import { parse as parseYaml } from "yaml";
import { ValidationError, assertId, assertObject } from "./types.js";
import { validateConfig } from "@porchlight/recorder";

/** The engine's ML stages of record — closed list (TS 5). */
export const STAGES = Object.freeze([
	"detection",
	"event-description",
	"audio-classification",
	"transcription",
	"overwatch-evaluation",
	"embedding",
]);

/**
 * The engine's three compute classes of record (TS 5; the same ids the
 * @porchlight/agent-runtime PROVIDER_CLASSES carry — one vocabulary, two
 * packages, cross-referenced; never imported so the console plane stays
 * dependency-light).
 */
export const PROVIDER_CLASSES = Object.freeze(["native-mlx", "openai-spec", "local-server"]);

/**
 * The built-in stage plan (TS 1: "the setup wizard writes sane defaults
 * first"). Every stage defaults to the native class — native acceleration is
 * the default execution target, CPU is never a silent default. `model: null`
 * means "provisioned by the product's own setup" (green-field law), an
 * explicit state the setup flow and status surfaces render.
 */
export const DEFAULT_STAGE_PLAN = Object.freeze(Object.fromEntries(
	STAGES.map((stage) => [stage, Object.freeze({ providerClass: "native-mlx", model: null })]),
));

/** Endpoint classes need a configured endpoint reference; native refuses one. */
const ENDPOINT_CLASSES = new Set(["openai-spec", "local-server"]);

/** Closed compute states (never-silent law). */
export const COMPUTE_STATES = Object.freeze(["native", "cpu", "degraded", "failed", "unknown"]);

/**
 * Validate one stage plan value. Returns a normalized copy.
 * @param {unknown} value
 * @param {string} label
 */
export function validateStagePlan(value, label) {
	assertObject(value, label);
	const out = {};
	if (!PROVIDER_CLASSES.includes(value.providerClass)) {
		throw new ValidationError(`${label}: providerClass must be one of ${PROVIDER_CLASSES.map((c) => `"${c}"`).join(" | ")}`);
	}
	out.providerClass = value.providerClass;
	if (value.model !== undefined && value.model !== null) {
		if (typeof value.model !== "string" || value.model.trim() === "") {
			throw new ValidationError(`${label}: model must be a non-empty string or null (provisioned by setup)`);
		}
		out.model = value.model.trim();
	} else {
		out.model = null;
	}
	const hasEndpoint = value.endpointRef !== undefined && value.endpointRef !== null;
	if (hasEndpoint) {
		if (typeof value.endpointRef !== "string" || value.endpointRef.trim() === "") {
			throw new ValidationError(`${label}: endpointRef must be a non-empty string (a reference into the deployment's secret handling — never a literal address)`);
		}
	}
	if (ENDPOINT_CLASSES.has(out.providerClass) && !hasEndpoint) {
		throw new ValidationError(`${label}: providerClass "${out.providerClass}" requires an endpointRef (where the stage's endpoint is configured)`);
	}
	if (out.providerClass === "native-mlx" && hasEndpoint) {
		throw new ValidationError(`${label}: native stages ride the platform's own acceleration — endpointRef is not a native field`);
	}
	if (hasEndpoint) out.endpointRef = value.endpointRef.trim();
	return out;
}

/**
 * The platform config of record reader (setup layer): <root>/config/config.yaml.
 * @param {string} platformFile
 * @param {{ fs?: typeof import("node:fs") }} [opts]
 */
export function readPlatformConfig(platformFile, opts = {}) {
	const fs = opts.fs ?? fsDefault;
	if (!fs.existsSync(platformFile)) return null;
	const raw = fs.readFileSync(platformFile, "utf8");
	return parseYaml(raw) ?? {};
}

/**
 * Atomically rewrite the platform config cameras list (POST /cameras
 * registration): validate the FULL document through the recorder contract
 * first, then tmp+rename. Returns the validated document.
 * @param {string} platformFile
 * @param {Record<string, unknown>} doc
 * @param {{ fs?: typeof import("node:fs") }} [opts]
 */
export function writePlatformConfig(platformFile, doc, opts = {}) {
	const fs = opts.fs ?? fsDefault;
	const validated = validateConfig(doc);
	fs.mkdirSync(pathDirname(platformFile), { recursive: true });
	const tmp = `${platformFile}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(validated, null, "\t") + "\n", "utf8");
	fs.renameSync(tmp, platformFile);
	return validated;
}

function pathDirname(file) {
	const idx = file.lastIndexOf("/");
	return idx === -1 ? "." : file.slice(0, idx);
}

/**
 * The compute posture service.
 * @param {{
 *   store: import("./store.js").Store,
 *   publisher: import("./publisher.js").Publisher,
 *   root?: string,
 *   fs?: typeof import("node:fs"),
 *   now?: () => Date,
 * }} opts
 */
export function createComputeService({ store, publisher, root, fs = fsDefault, now = () => new Date() }) {
	/** Platform config of record: setup layer source. */
	const platformFile = root
		? (root.endsWith("/") ? `${root}config/config.yaml` : `${root}/config/config.yaml`)
		: null;
	/** @type {Map<string, () => Record<string, unknown>>} status reporters by stage */
	const reporters = new Map();

	/** Read the admin layer doc: { stages: { <stage>: plan } }. */
	function adminDoc() {
		const doc = store.readDoc("compute");
		return doc?.stages && typeof doc.stages === "object" ? doc.stages : {};
	}

	/** Read the setup layer: platform config of record compute.stages. */
	function setupStages() {
		if (!platformFile) return {};
		const cfg = readPlatformConfig(platformFile, { fs });
		const stages = cfg?.compute?.stages;
		return stages && typeof stages === "object" ? stages : {};
	}

	/**
	 * Resolve one stage: admin > setup > built-in. A malformed stored plan is
	 * never adopted (the next layer wins) and is surfaced as a layerIssue —
	 * never silently repaired, never silently dropped.
	 */
	function resolve(stage) {
		assertKnownStage(stage);
		const adminRaw = adminDoc()[stage];
		const setupRaw = setupStages()[stage];
		const issues = [];
		const adminPlan = planOf(adminRaw, stage, "admin", issues);
		const setupPlan = planOf(setupRaw, stage, "setup", issues);
		if (adminPlan) {
			return { effective: adminPlan, source: "admin", layers: { setup: setupRaw ?? null, builtIn: DEFAULT_STAGE_PLAN[stage] }, layerIssues: issues };
		}
		if (setupPlan) {
			return { effective: setupPlan, source: "setup", layers: { setup: setupRaw, builtIn: DEFAULT_STAGE_PLAN[stage] }, layerIssues: issues };
		}
		return { effective: { ...DEFAULT_STAGE_PLAN[stage] }, source: "built-in", layers: { setup: setupRaw ?? null, builtIn: DEFAULT_STAGE_PLAN[stage] }, layerIssues: issues };
	}

	/**
	 * A stored plan (installer-written setup layer or REST-written admin
	 * layer) resolves only when well-formed; malformed values report their
	 * state in layerIssues — the effective plan never guesses.
	 */
	function planOf(raw, stage, layer, issues) {
		if (raw === undefined || raw === null) return null;
		try {
			return validateStagePlan(raw, `compute ${layer} layer for "${stage}"`);
		} catch (err) {
			issues.push(`${layer} layer value for "${stage}" is not a valid stage plan: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	/** The full stage detail record (list + single detail share this shape). */
	function detail(stage) {
		const resolved = resolve(stage);
		return {
			stage,
			effective: resolved.effective,
			source: resolved.source,
			layers: resolved.layers,
			layerIssues: resolved.layerIssues,
			status: statusOf(stage),
			providerClasses: [...PROVIDER_CLASSES],
		};
	}

	/** Status record for one stage (never-silent: unknown is a stated state). */
	function statusOf(stage) {
		const reporter = reporters.get(stage);
		const at = now().toISOString();
		if (!reporter) {
			return { stage, state: "unknown", providerClass: null, model: null, executionTarget: null, reason: "stage is not reporting — service wiring pending", updatedAt: at };
		}
		try {
			const raw = reporter();
			return normalizeStatus(raw, stage, at);
		} catch (err) {
			return { stage, state: "failed", providerClass: null, model: null, executionTarget: null, reason: err instanceof Error ? err.message : String(err), updatedAt: at };
		}
	}

	function normalizeStatus(raw, stage, at) {
		const state = raw?.state ?? "unknown";
		if (!COMPUTE_STATES.includes(state)) {
			return { stage, state: "unknown", providerClass: null, model: null, executionTarget: null, reason: `stage reporter returned unknown state ${JSON.stringify(state)}`, updatedAt: at };
		}
		return {
			stage,
			state,
			providerClass: raw.providerClass ?? null,
			model: raw.model ?? null,
			executionTarget: raw.executionTarget ?? null,
			reason: raw.reason ?? null,
			updatedAt: at,
		};
	}

	return {
		stages: [...STAGES],
		providerClasses: [...PROVIDER_CLASSES],
		resolve,
		detail,
		list() {
			return STAGES.map((stage) => detail(stage));
		},
		statusOf,
		/** Register the live reporter for one stage (service wiring seam). */
		registerStatus(stage, reporter) {
			assertKnownStage(stage);
			if (typeof reporter !== "function") throw new ValidationError(`compute.registerStatus("${stage}"): reporter must be a function`);
			reporters.set(stage, reporter);
		},
		/**
		 * Re-point one stage from the Models/Compute settings surface. Writes
		 * the admin layer and publishes the changed value — live apply, no
		 * restart. Returns the updated detail.
		 */
		repoint(stage, value) {
			assertKnownStage(stage);
			const plan = validateStagePlan(value, `compute stage "${stage}"`);
			const doc = store.readDoc("compute");
			const stages = doc.stages && typeof doc.stages === "object" ? { ...doc.stages } : {};
			for (const key of Object.keys(stages)) assertId(key, "compute stage key");
			stages[stage] = plan;
			store.writeDoc("compute", { ...doc, stages });
			const updated = detail(stage);
			publisher.publish({ type: "compute-repoint", stage, value: updated.effective, source: "admin" });
			return updated;
		},
		/**
		 * Reset one stage to its setup/built-in default (base preserved): the
		 * admin-layer entry is removed and the fallback layer wins.
		 */
		reset(stage) {
			assertKnownStage(stage);
			const doc = store.readDoc("compute");
			const stages = doc.stages && typeof doc.stages === "object" ? { ...doc.stages } : {};
			if (stage in stages) {
				delete stages[stage];
				store.writeDoc("compute", { ...doc, stages });
			}
			const updated = detail(stage);
			publisher.publish({ type: "compute-repoint", stage, value: updated.effective, source: updated.source });
			return updated;
		},
	};
}

/** @param {string} stage */
function assertKnownStage(stage) {
	if (typeof stage !== "string" || !STAGES.includes(stage)) {
		throw new ValidationError(`compute: unknown stage ${JSON.stringify(stage)} — the stage list is ${STAGES.map((s) => `"${s}"`).join(", ")}`);
	}
}

/**
 * The composition seam for live re-pointing (PORCH-152 ac-2): wire stage
 * re-points to the services that own them. The engine's composition root
 * registers one applier per stage it runs — the applier re-instantiates that
 * stage's provider from the (already resolved) value and swaps it in live.
 * No restart: the publisher event drives everything.
 *
 * @param {{
 *   publisher: import("./publisher.js").Publisher,
 *   appliers: Record<string, (value: Record<string, unknown>) => void>,
 * }} opts
 * @returns {() => void} unsubscribe
 */
export function wireComputeRepoints({ publisher, appliers }) {
	return publisher.subscribe((event) => {
		if (!event || event.type !== "compute-repoint") return;
		const apply = appliers[event.stage];
		if (apply) apply(event.value);
	});
}
