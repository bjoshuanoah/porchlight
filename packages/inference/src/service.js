// service.js — the inference tiering service (PORCH-133): the router, the
// gated-event description path, the with-the-event storage, and the
// never-silent status posture for the engine's `event-description` stage.
//
// Business law (PRD 5 / TS 5): the tier table routes local-first — tier 0
// free/always-on, tier 1 local Ollama gated by entity FSM transitions,
// tier 2 paid/only-opted-in. Every description it records carries its full
// provenance (tier, provider, providerClass, model) — a "likely reading",
// never a fact (the event surfaces' attribution law).

import { ValidationError, assertObject } from "./types.js";
import { TIERS, GATED_TRANSITIONS } from "./types.js";
import { gatedTransitionsFor } from "./config.js";
import { createTierRouter } from "./router.js";

/**
 * Create the tiering service.
 * @param {{
 *   config?: unknown,
 *   providers: import("./types.js").TierProvider[],
 *   store: ReturnType<typeof import("./store.js").createDescriptionStore>,
 *   log?: (...args: unknown[]) => void,
 * }} opts
 */
export function createTieringService({ config, providers, store, log = () => {} }) {
	if (!store || typeof store.record !== "function" || typeof store.forEvent !== "function") {
		throw new TypeError("tiering service: store must implement record/forEvent (createDescriptionStore)");
	}
	const router = createTierRouter({ config, providers });
	const tiers = router.tierConfig;

	return {
		/** The validated tier config of record. */
		get tierConfig() {
			return tiers;
		},
		/**
		 * The gated-event entry point (ac-1/ac-2): route across the tiers in
		 * order; a successful description is STORED WITH THE EVENT — keyed by
		 * the event's identity with full provenance.
		 * @param {{
		 *   event: { t: number, camera: string, cls?: string|null, trackId?: string|null, detections?: Array<{cls: string, conf: number}> },
		 *   transition: string,
		 *   image?: string,
		 * }} input
		 */
		async onEvent(input) {
			assertObject(input, "onEvent input");
			const event = input.event;
			assertObject(event, "onEvent event");
			if (typeof event.t !== "number" || !Number.isFinite(event.t) || event.t <= 0) {
				throw new ValidationError("onEvent: event.t must be a positive epoch time");
			}
			if (typeof event.camera !== "string" || event.camera.trim() === "") {
				throw new ValidationError("onEvent: event.camera must be a non-empty string");
			}
			const outcome = await router.route({
				camera: event.camera,
				t: event.t,
				cls: event.cls ?? null,
				trackId: event.trackId ?? null,
				transition: input.transition,
				detections: event.detections ?? [],
				image: input.image,
			});
			if (outcome.description === null) {
				// No tier answered: nothing is stored — absence of a description is
				// the explicit state the outcome carries, never an invented record.
				log(`inference: ${outcome.steps.map((s) => `${s.tier}:${s.kind}${s.reason ? `(${s.reason})` : ""}`).join(", ")} — no description for ${event.camera} @ ${event.t}`);
				return { outcome, stored: null };
			}
			const t = event.t >= 1e11 ? Math.floor(event.t / 1000) : Math.floor(event.t);
			const stored = store.record({
				event: { t, camera: event.camera, cls: event.cls ?? null, trackId: event.trackId ?? null },
				transition: input.transition,
				tier: outcome.steps.find((s) => s.kind === "invoked" && s.text !== null)?.tier ?? "tier0",
				provider: outcome.provider,
				providerClass: outcome.providerClass ?? "unknown",
				model: outcome.model ?? null,
				text: outcome.description,
			});
			log(`inference: ${outcome.provider} (${outcome.providerClass}${outcome.model ? `, ${outcome.model}` : ""}) described ${event.camera} @ ${t} — stored with the event`);
			return { outcome, stored };
		},
		/**
		 * The descriptions stored for one event identity (the event surfaces'
		 * read path: "both or neither" with the transcript, never a missing field).
		 * @param {{ t: number, camera: string, cls?: string|null, trackId?: string|null }} event
		 */
		forEvent(event) {
			return store.forEvent(event);
		},
		/**
		 * The never-silent compute posture: every tier's enablement, gating,
		 * provider and model, plus the stage-level status the compute surface
		 * renders for `event-description`.
		 */
		status() {
			return {
				stage: "event-description",
				tiers: TIERS.map((tier) => {
					const provider = providers.find((p) => p.tier === tier);
					return {
						tier,
						provider: provider?.name ?? null,
						providerClass: provider?.providerClass ?? null,
						model: provider?.status?.().model ?? null,
						alwaysOn: tier === "tier0",
						enabled: tier === "tier0" ? true : tier === "tier1" ? tiers.tier1.enabled : tiers.tier2.optIn === true,
						gatedTransitions: tier === "tier0" ? null : gatedTransitionsFor(tiers, /** @type {"tier1"|"tier2"} */ (tier)),
						optIn: tier === "tier2" ? tiers.tier2.optIn === true : null,
						gatedSet: GATED_TRANSITIONS,
					};
				}),
			};
		},
	};
}
