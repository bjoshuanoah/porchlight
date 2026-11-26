import { Router } from "express";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { StoreLike } from "@porchlight/shared";
import {
  createAuditLog,
  createRecognitionPipeline,
  createRecognitionService,
  createRegistryService,
  createWatchlistService,
  VisionProviderRegistry,
} from "@porchlight/recognition";
import type { VisionProvider } from "@porchlight/recognition";
import { createRecognitionHandler } from "@porchlight/recognition/server";

/** The vision provider factory's product, re-typed for the hub's options. */
export type { VisionProvider as VisionProviderLike } from "@porchlight/recognition";

/**
 * PORCH-141: the hub-side People & Things transport adapter — thin by law.
 * The REST plane's behavior lives in @porchlight/recognition; this adapter
 * only (a) roots the audit file under the hub root, (b) rides the hub's
 * Mongo store of record for the registry collections, (c) supplies the
 * local vision pipeline's provider factory (the setup provisions the
 * models per stage — absent factory = the plane serves registry surfaces
 * and fails enrollment closed with plain language), and (d) translates the
 * hub identity seam into the plane's authorize callback.
 */

/** The identity seam subset the plane uses (the router's own identityAuth). */
export interface RecognitionIdentityAuth {
  verifyAccessToken: (token: string) => Promise<{ did: string; sessionId: unknown } | null>;
}

/** The home seam subset the plane uses (the router's assembled home module). */
export interface RecognitionHomeModule {
  homeService: {
    authorize(args: { accessToken: string; homeId: string }): Promise<{ role?: string; did?: string } & Record<string, unknown>>;
  };
}

export interface RecognitionPlaneOptions {
  /** The hub root of record; the audit file rides <root>/config/recognition/. */
  root: string;
  /** The hub Mongo store of record — the registry collections live here. */
  store: StoreLike;
  identityAuth: RecognitionIdentityAuth | null;
  homeModule: RecognitionHomeModule | null;
  /**
   * The local vision provider factory (setup provisions the actual models
   * per stage; absent = enrollment/recognition runs refuse closed with
   * plain language — never a silent fallback).
   */
  visionProviderFactory?: (() => VisionProvider) | null;
  providerName?: string;
  /** The engine-camera → { homeId } join the hub wires to the home module. */
  homeForCamera?: ((engineCameraId: string) => Promise<{ homeId: string; cameraId: string } | null>) | null;
  /** The built-in tracked classes of record (@porchlight/overwatch TRACKED_CLASSES). */
  trackedClasses?: string[];
  /**
   * PORCH-142: the trained-watchlist emission publisher (the hub's MQTT
   * seam of record — the same detections family the home module's bus
   * consumer subscribes). Absent = classification still runs and lands as
   * a detection row, but nothing is published.
   */
  publishDetection?: ((detection: { camera: string; trackId: string; cls: string; conf: number; t?: number; provider: string }) => Promise<void>) | null;
  /**
   * PORCH-142: fired best-effort after every watchlist mutation with the
   * fresh tracked-trained labels — the hub's extendTrackedVocabulary seam.
   */
  onVocabularyChanged?: (trackedTrainedLabels: string[]) => void | Promise<void>;
  log?: ((line: string) => void) | null;
}

export interface RecognitionPlane {
  /** The Express router mounted at the hub's /api/recognition prefix. */
  router: Router;
  /**
   * The engine-consumer ingest seam (PORCH-128's DetectedObject bus):
   * recognition runs only when the upstream produced recognition evidence —
   * a locally computed face descriptor rides the bus `reid` channel, a
   * locally read plate the `plateText` extension. The recognition switch of
   * record bites here before any run (upstream enforcement, ac-4/ac-6).
   */
  ingestEngineDetection: (detection: EngineDetection | null) => Promise<void>;
  /**
   * PORCH-142: the fresh tracked-trained vocabulary of record (every home).
   * The hub calls this at boot and the plane re-calls it through
   * onVocabularyChanged after every watchlist mutation.
   */
  refreshWatchlistVocabulary: () => Promise<string[]>;
}

/**
 * The engine bus facts recognition reads (the DetectedObject contract subset;
 * `plateText` is the recognition-owned extension upstream providers set).
 */
interface EngineDetection {
  camera?: unknown;
  trackId?: unknown;
  t?: unknown;
  reid?: unknown;
  plateText?: unknown;
  /** The DetectedObject class of record (person/vehicle/…); recognition reads only reid/plateText. */
  cls?: unknown;
  conf?: unknown;
}

/** A typed refusal the plane's handler maps straight onto the transport. */
function refusal(status: number, code: string, message: string): Error {
  const error = new Error(message) as Error & { status: number; code: string };
  error.status = status;
  error.code = code;
  return error;
}

/** Bearer-token extraction (the hub's home surfaces accept nothing else). */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? null;
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token === "" ? null : token;
}

/**
 * Build the People & Things plane. It delegates every request to the
 * plain-JS node:http handler, restoring the full path (Express strips
 * prefixes per mount) and handing over the body Express already parsed
 * instead of letting the plane re-read the drained stream.
 */
export function createRecognitionPlaneRouter(options: RecognitionPlaneOptions): RecognitionPlane {
  const auditPath = `${options.root}/config/recognition/audit.jsonl`;
  const audit = createAuditLog({ path: auditPath });
  const registry = createRegistryService({ store: options.store, audit });
  const visionRegistry = new VisionProviderRegistry();
  if (options.visionProviderFactory) {
    const name = options.providerName ?? "local";
    visionRegistry.register(name, options.visionProviderFactory);
  }
  const pipeline = createRecognitionPipeline({ registry: visionRegistry });
  const recognition = createRecognitionService({ registry, pipeline, providerName: options.providerName ?? "local" });
  /**
   * PORCH-142: the watchlists service of record (trainable object classes).
   * NOT gated by the per-household recognition switch — the biometric
   * opt-in law governs faces/plates only; watchlists train on the raw
   * pixel crops the household itself teaches and never leave the hub. The
   * provider ref rides the same registered factory (absent factory =
   * training refuses closed with plain language).
   */
  const watchlists = createWatchlistService({
    store: options.store,
    audit,
    trackedClasses: options.trackedClasses ?? [],
    providerRef: options.visionProviderFactory
      ? async () => visionRegistry.create(options.providerName ?? "local")
      : null,
    providerName: options.providerName ?? "local",
  });

  /**
   * PORCH-142: the mutation hook Agent A's route plane fires best-effort
   * after create/retrain/corrections/delete — the hub re-extends the
   * entity layer's tracked vocabulary from the fresh tracked-trained
   * labels of record.
   */
  const hooks = {
    onWatchlistMutated: async () => {
      const labels = await watchlists.trackedTrainedLabels();
      await options.onVocabularyChanged?.(labels);
    },
  };

  const { homeModule } = options;
  const homeService = homeModule?.homeService ?? null;
  const homeForCamera = options.homeForCamera ?? null;

  /**
   * The owner seam: an access token → did → the home module's authorization
   * for the resolved homeId (the plane passes the query/body homeId in the
   * args). Anonymous or unverifiable tokens refuse 401 (the home surfaces'
   * own posture); a resolvable identity authorized for the home passes
   * reads, and owner-membership gates every mutation — and every EXPORT:
   * the biometric registry leaves the hub only through the owner's own
   * explicit act (the Tier-2 posture, off by default, ac-5).
   */
  const authorize = async ({ req, action, resource, homeId }: { req: unknown; action: string; resource: string; homeId?: string | null }): Promise<boolean> => {
    const request = req as IncomingMessage & { originalUrl?: string };
    const token = bearerToken(request);
    if (!token) {
      throw refusal(401, "E_MUST_SIGN_IN", "Sign in with your Porchlight identity to reach this home.");
    }
    const identity = options.identityAuth ? await options.identityAuth.verifyAccessToken(token) : null;
    if (!identity?.did) {
      throw refusal(401, "E_MUST_SIGN_IN", "Sign in with your Porchlight identity to reach this home.");
    }
    if (!homeService || !homeId) return false;
    // The single authorization seam every home surface rides (PORCH-137);
    // a non-member refusal throws and lands as the plane's 403.
    const authorized = await homeService.authorize({ accessToken: token, homeId });
    if (resource === "export") return authorized.role === "owner";
    if (action !== "read" && authorized.role !== "owner") return false;
    return true;
  };

  const handler = createRecognitionHandler({
    services: { registry, recognition, watchlists, hooks },
    authorize,
    log: options.log ?? null,
  });

  const plane = Router();
  plane.use((req, res, next) => {
    req.url = req.originalUrl ?? req.url;
    void handler(req as IncomingMessage, res as unknown as ServerResponse, { body: req.body as object | null }).catch(next);
  });

  /** The engine-camera → home join, fail closed. */
  async function resolveHome(detection: EngineDetection): Promise<{ homeId: string; cameraId: string } | null> {
    if (!homeForCamera) return null;
    const camera = typeof detection.camera === "string" ? detection.camera : "";
    if (camera === "") return null;
    try {
      return await homeForCamera(camera);
    } catch (error) {
      const logged = error as { message?: string };
      (options.log ?? console.error)?.(`[recognition] camera resolution failed for ${camera}: ${logged.message ?? String(error)}`);
      return null;
    }
  }

  /**
   * The consumer-side recognition run of record. Only recognition-bearing
   * evidence triggers a run — a bare detection computes nothing here and
   * runs nothing (the upstream providers' own compute gate consults
   * settingsOf().enabled before embedding, per TS 2's upstream law).
   */
  async function ingestEngineDetection(detection: EngineDetection | null): Promise<void> {
    if (!detection) return;
    const resolved = await resolveHome(detection);
    if (!resolved) return;
    const descriptor = Array.isArray(detection.reid) ? (detection.reid as number[]) : undefined;
    const plateText = typeof detection.plateText === "string" && detection.plateText.trim() !== "" ? detection.plateText : undefined;
    if (!descriptor && !plateText) return; // no recognition evidence upstream — nothing runs, nothing computes
    try {
      await recognition.recognize({
        homeId: resolved.homeId,
        kind: plateText ? "vehicle" : "face",
        descriptor,
        plateText,
        cameraId: resolved.cameraId,
        trackId: typeof detection.trackId === "string" && detection.trackId !== "" ? detection.trackId : undefined,
        at: typeof detection.t === "number" && Number.isFinite(detection.t) ? detection.t : undefined,
      });
    } catch (error) {
      const logged = error as { code?: string; message?: string };
      // Never silent, never fatal to the bus pipe: the refusal (switch off)
      // and any unexpected failure both land in the log.
      (options.log ?? console.error)?.(
        `[recognition] run skipped (${logged.code ?? "E_UNEXPECTED"}): ${logged.message ?? String(error)}`,
      );
    }
    /**
     * PORCH-142: classify-on-ingest against the home's trained classes.
     * NOT gated by the biometric recognition switch (watchlists train on
     * the household's own taught crops — the opt-in law governs faces and
     * plates only). The descriptor stays on the hub; only the plain
     * classification fact is emitted, deduped by the service's event
     * window, and NEVER fatal to the ingest pipe.
     */
    if (descriptor) {
      try {
        const classification = await watchlists.classify({
          homeId: resolved.homeId,
          descriptor,
          cameraId: resolved.cameraId,
          trackId: typeof detection.trackId === "string" && detection.trackId !== "" ? detection.trackId : undefined,
          t: typeof detection.t === "number" && Number.isFinite(detection.t) ? detection.t : undefined,
        });
        if (classification?.shouldEmit) {
          await options.publishDetection?.({
            camera: String(detection.camera),
            trackId: typeof detection.trackId === "string" && detection.trackId !== "" ? detection.trackId : "untracked",
            cls: classification.label,
            conf: classification.confidence,
            t: typeof detection.t === "number" && Number.isFinite(detection.t) ? detection.t : undefined,
            provider: "watchlist",
          });
        }
      } catch (error) {
        const logged = error as { code?: string; message?: string };
        // Classification refusal (no trained classes) and any unexpected
        // failure both land in the log; the pipe keeps moving.
        (options.log ?? console.error)?.(
          `[recognition] watchlist classify skipped (${logged.code ?? "E_UNEXPECTED"}): ${logged.message ?? String(error)}`,
        );
      }
    }
  }

  return { router: plane, ingestEngineDetection, refreshWatchlistVocabulary: () => watchlists.trackedTrainedLabels() };
}
