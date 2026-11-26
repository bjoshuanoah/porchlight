/**
 * The profile-routed inference provider (PORCH-148 ac-4/ac-5). This IS the
 * InferenceProvider the agent runtime's inference seam consumes (PORCH-147
 * composition seam 1; no parallel inference path): at every call it
 * re-resolves the member's profile through the ONE resolution function —
 * that per-call re-resolution IS the live-apply — then rides the per-class
 * provider implementation of the resolved profile's compute class.
 *
 * Never silent:
 *  - unassigned / unavailable / parental-blocked resolutions refuse with
 *    plain-language typed errors (never a default model);
 *  - a provider that cannot answer names the degraded state: the failure is
 *    recorded on the provenance trail and rethrown typed, the session and
 *    admin surfaces carry it — no silent model fallback beyond an explicitly
 *    configured, rendered fallback (safetyFields.fallbackProfileRef). When
 *    the fallback preference is configured and passes the same gates, the
 *    fallback ride is provenance-marked as a fallback, always.
 */
import { PROVIDER_CLASSES } from "@porchlight/agent-runtime";
import { fail, typed } from "../services/errors.js";

export const PROFILE_PROVIDER_NAME = "porchlight-profile-router";

/** The one default agent type on the hub (Porchlight Agent TS 1: per member, a household-member agent). */
export const AGENT_TYPE_HOUSEHOLD_MEMBER = "household-member";

/**
 * @param {{
 *   resolve: ResolutionService["resolve"],
 *   providers: Partial<Record<ProviderClass, import("…types.js").InferenceProvider>>,
 *     The per-class provider implementations (the engine's InferenceProvider
 *     family: native MLX, OpenAI-spec, local server) injected by the hub;
 *     the resolved profile's modelId (and endpointRef reference, where one
 *     exists) rides the request as inference context.
 *   provenance: import("../services/provenance.service.js").ProvenanceService,
 *   profiles: import("../services/profiles.service.js").ProfileService,
 *     The profile store of record — the explicitly configured fallback
 *     profile (safetyFields.fallbackProfileRef) resolves through it.
 *   agentTypeFor?: (memberId: string) => string | Promise<string>,
 *   log?: (memberId: string, line: string) => void,
 *     The member-tagged log sink — the hub wires runtime.logLine here, and
 *     the profile identity lands in the agent's EXISTING inference logs.
 *   now?: () => string,
 * }}
 */
export function createProfileInferenceProvider({ resolve, providers, provenance, profiles, agentTypeFor = null, log = null, now = defaultNow }) {
  if (typeof resolve !== "function") {
    throw new TypeError("createProfileInferenceProvider: resolve (the one resolution function) is required — no parallel path");
  }
  if (!provenance || typeof provenance.record !== "function") {
    throw new TypeError("createProfileInferenceProvider: provenance service required — every inference is recorded");
  }
  if (!profiles || typeof profiles.get !== "function") {
    throw new TypeError("createProfileInferenceProvider: profiles service required — the configured fallback resolves through the store of record");
  }
  const classes = Object.keys(providers ?? {});
  for (const providerClass of classes) {
    if (!PROVIDER_CLASSES.includes(providerClass)) {
      throw new TypeError(`createProfileInferenceProvider: unknown provider class "${providerClass}" (the engine's three compute classes)`);
    }
  }
  return {
    name: PROFILE_PROVIDER_NAME,
    providerClasses: [...PROVIDER_CLASSES],
    async complete(request) {
      const memberId = request?.memberId;
      if (typeof memberId !== "string" || memberId.length === 0) {
        throw fail("E_VALIDATION", "Every inference call carries the acting member's identity.");
      }
      const agentType = (agentTypeFor ? await agentTypeFor(memberId) : null) ?? AGENT_TYPE_HOUSEHOLD_MEMBER;
      const resolution = await resolve({ memberId, agentType });
      if (resolution.state === "unassigned") {
        throw fail("E_PROFILE_UNASSIGNED", resolution.reason);
      }
      if (resolution.state === "unavailable") {
        throw fail("E_PROFILE_UNAVAILABLE", resolution.reason);
      }
      if (resolution.state === "parental-blocked") {
        throw fail("E_PARENTAL_BLOCKED", resolution.reason);
      }

      const ride = async (profile, context = null) => {
        const provider = providers?.[profile.providerClass];
        if (!provider || typeof provider.complete !== "function") {
          const message = `No provider implementation is configured for this profile's class (${profile.providerClass}) — naming the state, never degrading silently.`;
          await recordDegraded(provenance, request, profile, message);
          throw typed("E_PROVIDER_UNCONFIGURED", message);
        }
        // The seam request the per-class provider receives: identity rides every
        // call, plus the profile's inference context (model, and the endpoint
        // REFERENCE only — refs resolve in the server's secrets handling).
        const call = {
          memberId: request.memberId,
          sessionId: request.sessionId ?? null,
          messages: request.messages ?? [],
          tools: request.tools ?? [],
          modelId: profile.modelId,
          endpointRef: profile.endpointRef ?? null,
          profileId: profile._id,
        };
        const response = await provider.complete(call);
        const modelId = response?.modelId ?? profile.modelId ?? null;
        const at = now();
        await provenance.record({
          memberId: request.memberId,
          sessionId: call.sessionId,
          profile,
          providerName: provider.name,
          providerClass: profile.providerClass,
          modelId,
          fallback: context,
        });
        const line = context
          ? `profiles: ${request.memberId} rode fallback profile ${profile.name} (${profile.providerClass}) model ${modelId ?? "unspecified"} — primary provider down, fallback explicitly configured`
          : `profiles: ${request.memberId} rode profile ${profile.name} (${profile.providerClass} model ${profile.modelId}) — profile ${profile._id}`;
        if (log) log(request.memberId, line);
        return { ...response, text: response?.text ?? "", providerClass: profile.providerClass, modelId, profileId: profile._id, at };
      };

      const primary = resolution.profile;
      try {
        return await ride(primary);
      } catch (error) {
        if (error?.code) throw error; // already a typed, named domain verdict
        const reason = `This profile's provider (${primary.providerClass} model ${primary.modelId}) could not answer: ${String(error?.message ?? "unreachable")}`;
        const fallbackRef = primary.safetyFields?.fallbackProfileRef;

        // No silent fallback: the degradation is recorded and rethrown. The ONLY
        // fallback ride is an explicitly configured preference that passes the
        // same member gates — and it is provenance-marked as a fallback.
        if (typeof fallbackRef !== "string" || fallbackRef === primary._id) {
          await recordDegraded(provenance, request, primary, reason);
          throw fail("E_PROVIDER_DEGRADED", reason);
        }
        const fallbackProfile = await profiles.get(fallbackRef);
        if (!fallbackProfile) {
          const full = `${reason} The configured fallback profile does not exist — naming the state, not switching models.`;
          await recordDegraded(provenance, request, primary, full);
          throw fail("E_PROVIDER_DEGRADED", full);
        }
        try {
          return await ride(fallbackProfile, { profileId: fallbackProfile._id, profileName: fallbackProfile.name, reason });
        } catch {
          // The fallback ride itself failed: the explicit preference is named
          // in the degradation — it never switches models silently.
          const both = `${reason} The explicitly configured fallback (${fallbackProfile.name}) also could not answer.`;
          await recordDegraded(provenance, request, primary, both);
          throw fail("E_PROVIDER_DEGRADED", both);
        }
      }
    },
  };
}

async function recordDegraded(provenance, request, profile, reason) {
  await provenance.record({
    memberId: request.memberId,
    sessionId: request.sessionId ?? null,
    profile,
    providerName: null,
    providerClass: profile.providerClass,
    modelId: null,
    degraded: { reason },
  });
}

function defaultNow() {
  return new Date().toISOString();
}
